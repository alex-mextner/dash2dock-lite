'use strict';

// Window <-> dock feedback: how window life-cycle events show on the dock and
// how the dock shows in window animations.
//
// * minimize-to-icon: every app window gets its dock icon's on-screen rect as
//   its Meta icon geometry. Shell's minimize/unminimize animation and the
//   Magic Lamp extension aim at that rect; without it they shrink the window
//   into the monitor's top-left corner. The rect is refreshed when the dock
//   settles after a change (Dock._endAnimation), never per frame.
// * launch-bounce-anywhere: a pinned app bounces however it was launched
//   (Super+N, app grid, a terminal), not only from a dock click.
// * urgent-bounce: while an app wants attention (a window demands attention
//   or is urgent, or its LauncherEntry is urgent via onAppAttention) and is
//   not focused, its icon keeps bouncing and an autohidden dock stays shown,
//   as on macOS. Focusing the app or the request ending stops it.

import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';

import * as Fav from 'resource:///org/gnome/shell/ui/appFavorites.js';

import { DockPosition } from './dock.js';

// A dock click bounces before Shell reports STARTING; a second trigger within
// this window belongs to the same launch.
const LAUNCH_BOUNCE_DEDUPE_MS = 1500;

// One hop lasts about 1 s (animator.bounceIcon); a pause between hops keeps
// them readable. macOS bounces until the app is activated: the cap keeps a
// forgotten request from animating forever.
const ATTENTION_PERIOD_MS = 1500;
const ATTENTION_MAX_HOPS = 10;

export class WindowFeedback {
  constructor(extension) {
    this._extension = extension;
    this._geometryIdleId = 0;
    // windows we gave an icon geometry, so turning the setting off (or
    // disabling) can clear exactly those
    this._geometryWindows = new Set();
    // ids of apps seen STARTING: their RUNNING is the same launch
    this._starting = new Set();
    // Shell.App -> { windows: Set<Meta.Window>, external, hops, sourceId }
    this._attention = new Map();
  }

  enable() {
    this._tracker = Shell.WindowTracker.get_default();
    Shell.AppSystem.get_default().connectObject(
      'app-state-changed',
      (appSystem, app) => this._onAppStateChanged(app),
      this
    );
    global.display.connectObject(
      'window-demands-attention',
      (display, window) => this._onWindowAttention(window),
      'window-marked-urgent',
      (display, window) => this._onWindowAttention(window),
      'notify::focus-window',
      () => this._onFocusWindow(),
      this
    );
    this.update();
  }

  disable() {
    Shell.AppSystem.get_default().disconnectObject(this);
    global.display.disconnectObject(this);
    this._starting.clear();
    this._endAllAttention();
    if (this._geometryIdleId) {
      GLib.source_remove(this._geometryIdleId);
      this._geometryIdleId = 0;
    }
    this._clearIconGeometry();
    this._tracker = null;
  }

  // settings changed
  update() {
    if (this._extension.minimize_to_icon) {
      this.queueIconGeometry();
    } else {
      this._clearIconGeometry();
    }
    if (!this._extension.urgent_bounce) {
      this._endAllAttention();
    }
  }

  // Docks call this whenever they settle; several docks settling in the same
  // main-loop iteration share one update.
  queueIconGeometry() {
    if (!this._extension.minimize_to_icon || this._geometryIdleId) return;
    this._geometryIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._geometryIdleId = 0;
      this._updateIconGeometry();
      return GLib.SOURCE_REMOVE;
    });
  }

  _onAppStateChanged(app) {
    let id = app.get_id();
    switch (app.state) {
      case Shell.AppState.STARTING:
        this._starting.add(id);
        this._launchBounce(app);
        break;
      case Shell.AppState.RUNNING:
        // Launched outside the Shell (a terminal, another app): no STARTING,
        // the app turns RUNNING when its first window maps.
        if (!this._starting.delete(id)) this._launchBounce(app);
        break;
      default:
        this._starting.delete(id);
    }
  }

  // Bounce honours open-app-animation like a dock click does. Only pinned
  // apps: an unpinned app gets a new icon, which already bounces as it
  // appears (animator.js).
  _launchBounce(app) {
    let ext = this._extension;
    if (!ext.launch_bounce_anywhere || !ext.open_app_animation) return;
    if (!Fav.getAppFavorites().isFavorite(app.get_id())) return;
    let now = Date.now();
    for (let [dock, container] of this._appIcons(app)) {
      if (now - (container._appwell._bounceAt ?? 0) < LAUNCH_BOUNCE_DEDUPE_MS)
        continue;
      dock._maybeBounce(container, true);
    }
  }

  // [dock, icon container] for each dock showing the app
  _appIcons(app) {
    let found = [];
    for (let dock of this._extension.docks ?? []) {
      let icons = dock._icons ?? dock._findIcons();
      let container = icons.find((c) => c._appwell?.app === app);
      if (container) found.push([dock, container]);
    }
    return found;
  }

  // Entry point for app-level urgency (Unity LauncherEntry `urgent`):
  // true starts the bounce, false withdraws this request.
  setAppAttention(app, urgent) {
    if (!app) return;
    if (urgent) {
      if (!this._extension.urgent_bounce || this._isFocused(app)) return;
      let entry = this._attentionEntry(app);
      entry.external = true;
      this._startAttention(app, entry);
    } else {
      let entry = this._attention.get(app);
      if (!entry) return;
      entry.external = false;
      this._maybeEndAttention(app, entry);
    }
  }

  // Same filter as Shell's WindowAttentionHandler: a focused window or a
  // skip-taskbar one (tool palettes) asks for nothing.
  _onWindowAttention(window) {
    if (!this._extension.urgent_bounce) return;
    if (!window || window.has_focus() || window.is_skip_taskbar()) return;
    let app = this._tracker?.get_window_app(window);
    if (!app) return;
    let entry = this._attentionEntry(app);
    if (!entry.windows.has(window)) {
      entry.windows.add(window);
      window.connectObject(
        'notify::demands-attention',
        () => this._syncWindowAttention(window, app),
        'notify::urgent',
        () => this._syncWindowAttention(window, app),
        'unmanaged',
        () => this._dropWindowAttention(window, app),
        this
      );
    }
    this._startAttention(app, entry);
  }

  _syncWindowAttention(window, app) {
    if (!window.demands_attention && !window.urgent) {
      this._dropWindowAttention(window, app);
    }
  }

  _dropWindowAttention(window, app) {
    window.disconnectObject(this);
    let entry = this._attention.get(app);
    if (!entry) return;
    entry.windows.delete(window);
    this._maybeEndAttention(app, entry);
  }

  // the user went to the app: whatever it asked for has been seen
  _onFocusWindow() {
    let window = global.display.focus_window;
    let app = window ? this._tracker?.get_window_app(window) : null;
    if (app && this._attention.has(app)) this._endAttention(app);
  }

  _isFocused(app) {
    let window = global.display.focus_window;
    return !!window && this._tracker?.get_window_app(window) === app;
  }

  _attentionEntry(app) {
    let entry = this._attention.get(app);
    if (!entry) {
      entry = { windows: new Set(), external: false, hops: 0, sourceId: 0 };
      this._attention.set(app, entry);
    }
    return entry;
  }

  _startAttention(app, entry) {
    // already bouncing, or done bouncing for this request
    if (entry.sourceId || entry.hops >= ATTENTION_MAX_HOPS) return;
    this._revealDocks();
    this._attentionHop(app, entry);
    entry.sourceId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      ATTENTION_PERIOD_MS,
      () => {
        if (this._attentionHop(app, entry)) return GLib.SOURCE_CONTINUE;
        // capped: stop animating and let autohide have the dock back; the
        // entry stays so the same request does not restart the bounce
        entry.sourceId = 0;
        this._releaseDocks();
        return GLib.SOURCE_REMOVE;
      }
    );
  }

  _attentionHop(app, entry) {
    if (entry.hops >= ATTENTION_MAX_HOPS) return false;
    entry.hops++;
    for (let [dock, container] of this._appIcons(app)) {
      if (container.child) dock.animator?.bounceIcon(container.child, 1);
    }
    return true;
  }

  _maybeEndAttention(app, entry) {
    if (entry.windows.size === 0 && !entry.external) this._endAttention(app);
  }

  _endAttention(app) {
    let entry = this._attention.get(app);
    if (!entry) return;
    this._attention.delete(app);
    if (entry.sourceId) GLib.source_remove(entry.sourceId);
    entry.sourceId = 0;
    for (let window of entry.windows) window.disconnectObject(this);
    entry.windows.clear();
    this._releaseDocks();
  }

  _endAllAttention() {
    for (let app of [...this._attention.keys()]) this._endAttention(app);
  }

  // autohide.js keeps a dock shown while this is true
  get revealsDock() {
    for (let entry of this._attention.values()) {
      if (entry.sourceId) return true;
    }
    return false;
  }

  _revealDocks() {
    for (let dock of this._extension.docks ?? []) {
      if (dock.autohider?._enabled) dock.autohider.show();
    }
  }

  // hand the dock back to autohide once nothing bounces any more
  _releaseDocks() {
    if (this.revealsDock) return;
    for (let dock of this._extension.docks ?? []) {
      dock.autohider?._debounceCheckHide();
    }
  }

  // The on-screen rect (stage px) of the app's icon at rest and the dock
  // side, or null when no dock shows the app. Prefers the dock on the
  // window's monitor, as each monitor's dock is the one the user sees.
  iconTarget(window, app = null) {
    app ??= this._tracker?.get_window_app(window);
    if (!app) return null;
    let docks = this._extension.docks ?? [];
    let monitor = window.get_monitor();
    let preferred = docks.find((d) => d._monitorIndex === monitor);
    let target = preferred ? this._iconRect(preferred, app) : null;
    for (let i = 0; !target && i < docks.length; i++) {
      if (docks[i] !== preferred) target = this._iconRect(docks[i], app);
    }
    return target;
  }

  _iconRect(dock, app) {
    let icons = dock._icons;
    if (!icons || !dock.dash) return null;
    let container = icons.find((c) => c._appwell?.app === app);
    if (!container) return null;

    let [x, y] = container.get_transformed_position();
    if (isNaN(x) || isNaN(y)) return null;

    // the icon at rest: unmagnified, centred in its dash slot, shifted along
    // the dock by the animator's spacing offset (_icon.translation, as the
    // renderer is placed in animator.js)
    let size = (dock._iconSizeScaledDown || 0) * (dock._scaleFactor || 1);
    if (!size) return null;
    x += (container.width - size) / 2;
    y += (container.height - size) / 2;
    let vertical = dock.isVertical();
    if (vertical) {
      y += container._icon?.translationY || 0;
    } else {
      x += container._icon?.translationX || 0;
    }

    // The dash slides off-screen while autohidden. Aim at where the icon is
    // when shown, so a window minimized meanwhile still lands on its icon.
    let toEdge =
      dock._position === DockPosition.BOTTOM ||
      dock._position === DockPosition.RIGHT
        ? 1
        : -1;
    let shown = -(dock._edge_distance || 0) * toEdge;
    if (vertical) {
      x += shown - dock.dash.translationX;
    } else {
      y += shown - dock.dash.translationY;
    }

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(size),
      height: Math.round(size),
      side: dock._position,
    };
  }

  _updateIconGeometry() {
    if (!this._tracker) return;
    let seen = new Set();
    for (let actor of global.get_window_actors()) {
      let window = actor.meta_window;
      if (!window || window.is_skip_taskbar()) continue;
      let target = this.iconTarget(window);
      if (target) {
        window.set_icon_geometry(
          new Mtk.Rectangle({
            x: target.x,
            y: target.y,
            width: target.width,
            height: target.height,
          })
        );
        seen.add(window);
      } else if (this._geometryWindows.has(window)) {
        // its icon left the dock: drop the stale target
        window.set_icon_geometry(null);
      }
    }
    this._geometryWindows = seen;
  }

  _clearIconGeometry() {
    for (let window of this._geometryWindows) {
      // unmanaged windows have no actor and must not be touched
      if (window.get_compositor_private()) window.set_icon_geometry(null);
    }
    this._geometryWindows.clear();
  }
}
