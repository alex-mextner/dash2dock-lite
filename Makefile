all: build install lint

.PHONY: build install publish check-devkit check-install-dir test-shell test-shell2 check smoke lint check-settings build-g44

RUNTIME_DIR ?= $(or $(XDG_RUNTIME_DIR),/run/user/$(shell id -u))
# gnome-shell writes this at startup as a crash marker; if it is left behind
# (e.g. nested shell killed early) the next run starts with all extensions off.
DISABLE_EXT_FLAG = $(RUNTIME_DIR)/gnome-shell-disable-extensions
MUTTER_DEVKIT ?= /usr/libexec/mutter-devkit
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/dash2dock-lite@icedman.github.com

# GNOME 49+: `gnome-shell --devkit` runs headless and spawns mutter-devkit as
# the viewer window. Without it the shell runs but no window ever appears.
check-devkit:
	@test -x $(MUTTER_DEVKIT) || { \
		echo "error: $(MUTTER_DEVKIT) not found - nested shell would run with no window."; \
		echo "       install it: sudo dnf install mutter-devkit"; \
		exit 1; }

# A symlinked EXT_DIR is a live checkout (e.g. the ubuntu-tweaks submodule):
# `rm -rf $(EXT_DIR)/` follows the link and empties that checkout. The
# install targets stop here instead; remove the link to install a copy.
check-install-dir:
	@if [ -L "$(EXT_DIR)" ]; then \
		echo "error: $(EXT_DIR) is a symlink to $$(readlink -f "$(EXT_DIR)")"; \
		echo "       refusing to install over it; rm the link (not the target) first"; \
		exit 1; fi

build:
	glib-compile-schemas --strict --targetdir=schemas/ schemas

install: build check-install-dir
	echo "installing..."
	rm -rf "$(EXT_DIR)/"
	mkdir -p "$(EXT_DIR)/"
	cp -R ./* "$(EXT_DIR)/"
	rm -rf "$(EXT_DIR)/build"
	rm -rf "$(EXT_DIR)/Makefile"
	rm -rf "$(EXT_DIR)/tests"
	rm -rf "$(EXT_DIR)/tools"
	rm -rf "$(EXT_DIR)/screenshots"
	rm -rf "$(EXT_DIR)/node_modules"
	rm -rf "$(EXT_DIR)/agents"
	rm -rf "$(EXT_DIR)/eslint.config.js"
	rm -rf "$(EXT_DIR)/package.json"
	rm -rf "$(EXT_DIR)/package-lock.json"

clean:
	rm -rf ./build

publish:
	./tools/publish.sh $(VERSION)

install-zip: check-install-dir
	echo "installing zip..."
	rm -rf "$(EXT_DIR)"
	mkdir -p "$(EXT_DIR)/"
	unzip -q dash2dock-lite@icedman.github.com.zip -d "$(EXT_DIR)/"

test-prefs:
	gnome-extensions prefs dash2dock-lite@icedman.github.com

test-shell: check-devkit install
	rm -f $(DISABLE_EXT_FLAG)
	-env GNOME_SHELL_SLOWDOWN_FACTOR=1 \
		MUTTER_DEBUG_DUMMY_MODE_SPECS=1200x800 \
	 	MUTTER_DEBUG_DUMMY_MONITOR_SCALES=1 \
		dbus-run-session -- gnome-shell --devkit --wayland
	rm -f $(DISABLE_EXT_FLAG)

test-shell2: check-devkit install
	rm -f $(DISABLE_EXT_FLAG)
	-env GNOME_SHELL_SLOWDOWN_FACTOR=2 \
		MUTTER_DEBUG_DUMMY_MODE_SPECS=1200x800 \
	 	MUTTER_DEBUG_DUMMY_MONITOR_SCALES=2 \
		dbus-run-session -- gnome-shell --devkit --wayland
	rm -f $(DISABLE_EXT_FLAG)

# GNOME 42-44 copy in ./build only; `g44` also installs it
build-g44: build
	rm -rf ./build
	mkdir -p ./build
	mkdir -p ./build/apps
	mkdir -p ./build/effects
	mkdir -p ./build/preferences
	python3 ./tools/transpile.py
	cp -R ./schemas ./build
	cp -R ./themes ./build
	cp -R ./ui ./build
	cp -R apps/*.sh ./build/apps
	cp -R apps/*.desktop ./build/apps
	rm -rf build/apps/mount-dash2dock-lite.desktop
	cp ./effects/*.glsl ./build/effects
	cp ./LICENSE* ./build
	-cp ./CHANGELOG* ./build 2>/dev/null || true
	cp ./README* ./build
	cp ./stylesheet.css ./build
	cp ./apps/recents.js ./build/apps
	cp ./apps/trash-render.js ./build/apps
	cp ./apps/file-drops.js ./build/apps

g44: build-g44 check-install-dir
	rm -rf "$(EXT_DIR)/"
	mkdir -p "$(EXT_DIR)/"
	cp -r ./build/* "$(EXT_DIR)/"

publish-g44: build-g44
	echo "publishing..."
	cd build ; \
	zip -qr ../dash2dock-lite@icedman.github.com.zip .

test-prefs-g44: g44
	gnome-extensions prefs dash2dock-lite@icedman.github.com

test-shell-g44: g44
	env GNOME_SHELL_SLOWDOWN_FACTOR=2 \
		MUTTER_DEBUG_DUMMY_MODE_SPECS=1200x800 \
	 	MUTTER_DEBUG_DUMMY_MONITOR_SCALES=1 \
		dbus-run-session -- gnome-shell --nested --wayland
	rm -f $(DISABLE_EXT_FLAG)

lint:
	npx eslint .

# Fast parse-only syntax check of all shipped JS (ESLint: `make lint`).
check:
	find . -path ./node_modules -prune -o -path ./build -prune -o -path ./tests -prune \
		-o -path ./tools -prune -o -name '*.js' -print \
		| xargs -n1 node --experimental-default-type=module --check
	@echo "check: OK"

# schema <-> preferences/keys.js <-> ui/*.ui <-> runtime refs. Exits 1 on
# error-class issues (shared adjustment, duplicate case, missing schema key).
check-settings:
	python3 tools/check-settings.py

# Headless nested shell: extension ACTIVE, N enable/disable cycles, no new
# error signatures vs agents/smoke-baseline.txt. See tools/smoke-shell.sh.
smoke: install
	tools/smoke-shell.sh 5

xml-lint:
	cd ui ; \
	find . -name "*.ui" -type f -exec xmllint --output '{}' --format '{}' \;

pretty: xml-lint
	rm -rf ./build/*
	prettier --single-quote --write "**/*.js"

todo:
	python ./tools/todo.py > ./TODO.md
