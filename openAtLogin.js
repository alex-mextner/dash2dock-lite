// "Open at Login" switch for the app icon menu (macOS Dock > Options >
// Open at Login). Autostart is the XDG way: a copy of the app's .desktop
// file in ~/.config/autostart. All file IO is async so opening the menu or
// toggling never blocks the compositor.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

function autostartFile(app) {
  return Gio.File.new_for_path(
    GLib.build_filenamev([GLib.get_user_config_dir(), 'autostart', app.get_id()])
  );
}

// A file with Hidden=true or X-GNOME-Autostart-enabled=false is the
// "disabled" form GNOME Tweaks writes: treat it as off
function isEnabledEntry(bytes) {
  let text = new TextDecoder().decode(bytes);
  return !/^\s*(Hidden\s*=\s*true|X-GNOME-Autostart-enabled\s*=\s*false)\s*$/im.test(text);
}

function readState(app, callback) {
  autostartFile(app).load_contents_async(null, (file, res) => {
    let enabled = false;
    try {
      let [, bytes] = file.load_contents_finish(res);
      enabled = isEnabledEntry(bytes);
    } catch {
      // missing file: not autostarted
    }
    callback(enabled);
  });
}

function setEnabled(app, enabled, done) {
  let target = autostartFile(app);
  if (!enabled) {
    target.delete_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
      try {
        file.delete_finish(res);
      } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
          console.error('d2da: open at login delete', e);
      }
      readState(app, done);
    });
    return;
  }

  let source = app.get_app_info()?.get_filename();
  if (!source) {
    done(false);
    return;
  }
  // one-time mkdir on a user click; there is no async make-parents call
  GLib.mkdir_with_parents(target.get_parent().get_path(), 0o755);
  Gio.File.new_for_path(source).copy_async(
    target,
    Gio.FileCopyFlags.OVERWRITE,
    GLib.PRIORITY_DEFAULT,
    null,
    null,
    (file, res) => {
      try {
        file.copy_finish(res);
      } catch (e) {
        console.error('d2da: open at login copy', e);
      }
      readState(app, done);
    }
  );
}

/**
 * Add (once) and refresh the switch in an AppIcon's menu; called each time
 * the menu opens, so the state follows edits made elsewhere (Tweaks, a
 * second dock).
 *
 * @param {object} appIcon Shell AppIcon with an open _menu
 */
export function syncOpenAtLogin(appIcon) {
  let menu = appIcon?._menu;
  let app = appIcon?.app;
  if (!menu || !app?.get_app_info?.()) return;

  let item = menu._d2daOpenAtLogin;
  if (!item) {
    item = new PopupMenu.PopupSwitchMenuItem(_('Open at Login'), false);
    // async callbacks may land after the menu (and item) is destroyed
    item.connect('destroy', () => {
      item._d2daDestroyed = true;
    });
    item.connect('toggled', (_item, state) => {
      item.reactive = false;
      setEnabled(app, state, (enabled) => {
        if (item._d2daDestroyed) return;
        item.setToggleState(enabled);
        item.reactive = true;
      });
    });
    // with the pin toggle, the app-level options group in AppMenu
    let anchor = menu._toggleFavoriteItem;
    let pos = anchor ? menu._getMenuItems().indexOf(anchor) + 1 : undefined;
    menu.addMenuItem(item, pos);
    menu._d2daOpenAtLogin = item;
  }
  item.visible = true;
  readState(app, (enabled) => {
    if (!item._d2daDestroyed) item.setToggleState(enabled);
  });
}

/**
 * Hide the switch again when the setting is turned off.
 *
 * @param {object} appIcon Shell AppIcon
 */
export function hideOpenAtLogin(appIcon) {
  let item = appIcon?._menu?._d2daOpenAtLogin;
  if (item) item.visible = false;
}
