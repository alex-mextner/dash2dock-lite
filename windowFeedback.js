'use strict';

// Window <-> dock feedback: how window life-cycle events show on the dock and
// how the dock shows in window animations.
//
// * minimize-to-icon: every app window gets its dock icon's on-screen rect as
//   its Meta icon geometry. Shell's minimize/unminimize animation and the
//   Magic Lamp extension aim at that rect; without it they shrink the window
//   into the monitor's top-left corner. The rect is refreshed when the dock
//   settles after a change (Dock._endAnimation), never per frame.

import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';

import { DockPosition } from './dock.js';

export class WindowFeedback {
  constructor(extension) {
    this._extension = extension;
    this._geometryIdleId = 0;
    // windows we gave an icon geometry, so turning the setting off (or
    // disabling) can clear exactly those
    this._geometryWindows = new Set();
  }

  enable() {
    this._tracker = Shell.WindowTracker.get_default();
    this.update();
  }

  disable() {
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
