'use strict';

// Window views of the dock, each an opt-in setting (macOS / Ubuntu Dock parity):
//
// * isolate-workspaces: running apps, dots and window cycling only count
//   windows on the active workspace (sticky windows count everywhere).
// * WindowEvents: the few window/workspace signals the window views need,
//   connected only while one of them is on.
// * MinimizedTile (macOS "Minimize windows into application icon" = off): a
//   dock item showing a live Clutter.Clone of a minimized window with the app
//   icon as an emblem, placed between the folder stacks and the Trash.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

export function onActiveWorkspace(metaWindow) {
  return metaWindow.located_on_workspace(
    global.workspace_manager.get_active_workspace()
  );
}

function hasWindowOnActiveWorkspace(app) {
  return app
    .get_windows()
    .some((w) => !w.skip_taskbar && onActiveWorkspace(w));
}

// Running apps as the dock lists them: with isolation, only apps that have a
// window on the active workspace (Ubuntu Dock isolate-workspaces).
export function runningApps(isolated) {
  let running = Shell.AppSystem.get_default().get_running();
  return isolated ? running.filter(hasWindowOnActiveWorkspace) : running;
}

// The Shell Dash builds its running-apps section from this._appSystem
// .get_running() in _redisplay(); swap in a view that applies the isolation
// filter. Everything else is forwarded to the real AppSystem.
export function filterDashRunningApps(dash, isIsolated) {
  let appSystem = dash?._appSystem;
  if (!appSystem) return;
  let getRunning = () => runningApps(isIsolated());
  dash._appSystem = new Proxy(appSystem, {
    get(target, prop) {
      if (prop === 'get_running') return getRunning;
      let value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// Window/workspace changes the window views depend on.
export class WindowEvents {
  constructor(onChange) {
    this._onChange = onChange;
    this._workspace = null;
    this._enabled = false;
  }

  enable() {
    if (this._enabled) return;
    this._enabled = true;
    let changed = () => this._onChange?.();
    global.workspace_manager.connectObject(
      'active-workspace-changed',
      () => {
        this._watchActiveWorkspace();
        changed();
      },
      this
    );
    // ShellWM signals: every minimize/unminimize of a shown window
    global.window_manager.connectObject(
      'minimize',
      changed,
      'unminimize',
      changed,
      this
    );
    this._watchActiveWorkspace();
  }

  // windows entering/leaving the active workspace (opened, closed, moved)
  _watchActiveWorkspace() {
    this._workspace?.disconnectObject(this);
    this._workspace = global.workspace_manager.get_active_workspace();
    let changed = () => this._onChange?.();
    this._workspace?.connectObject(
      'window-added',
      changed,
      'window-removed',
      changed,
      this
    );
  }

  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    global.workspace_manager.disconnectObject(this);
    global.window_manager.disconnectObject(this);
    this._workspace?.disconnectObject(this);
    this._workspace = null;
  }

  destroy() {
    this.disable();
    this._onChange = null;
  }
}

// share of the tile left free around the window clone
const TILE_PADDING = 0.08;
// emblem size relative to the tile
const TILE_EMBLEM = 0.42;

function minimizedWindows(dock) {
  let isolated = dock.extension.isolate_workspaces;
  let perMonitor = (dock.extension.docks?.length ?? 1) > 1;
  let monitor = dock._monitor?.index;
  return global
    .get_window_actors()
    .map((actor) => actor.meta_window)
    .filter(
      (w) =>
        w.minimized &&
        !w.skip_taskbar &&
        w.get_window_type() !== Meta.WindowType.DESKTOP &&
        (!isolated || onActiveWorkspace(w)) &&
        (!perMonitor || w.get_monitor() === monitor)
    );
}

// Brings the dock's tiles in line with the minimized windows; returns the map
// (window -> tile) to keep. New tiles go last, next to the Trash, as on macOS.
export function syncMinimizedTiles(dock, tiles) {
  if (!dock._extraIcons) return null;
  if (!dock.extension.minimized_window_tiles && !tiles?.size) return tiles;

  tiles = tiles ?? new Map();
  let wanted = dock.extension.minimized_window_tiles
    ? minimizedWindows(dock)
    : [];
  let changed = false;

  tiles.forEach((tile, w) => {
    if (wanted.includes(w)) return;
    // out of the map first: destroying an item can re-enter a relayout
    tiles.delete(w);
    tile.destroy();
    changed = true;
  });
  wanted.forEach((w) => {
    if (tiles.has(w) || !w.get_compositor_private()) return;
    tiles.set(w, new MinimizedTile(dock, w));
    changed = true;
  });

  // macOS order: stacks, minimized windows, Trash
  let box = dock._extraIcons;
  let anchor =
    dock._trashIcon?.get_parent() === box ? dock._trashIcon : null;
  let ordered = [...tiles.values()];
  for (let i = ordered.length - 1; i >= 0; i--) {
    let item = ordered[i].item;
    if (!item) continue;
    if (anchor) {
      if (item.get_next_sibling() !== anchor) {
        box.set_child_below_sibling(item, anchor);
        changed = true;
      }
    } else if (box.last_child !== item) {
      box.set_child_above_sibling(item, null);
      changed = true;
    }
    anchor = item;
  }

  if (changed) {
    dock._icons = null;
    dock._needsLayout = true;
  }
  return tiles;
}

class MinimizedTile {
  constructor(dock, metaWindow) {
    this.window = metaWindow;
    let app = Shell.WindowTracker.get_default().get_window_app(metaWindow);
    let title = () => metaWindow.get_title() || app?.get_name() || '';

    // DockItemContainer wants an app-like object; this one has no windows, so
    // the dock draws no dots/badges for it and does not cycle anything
    let tileApp = {
      get_id: () => null,
      get_name: title,
      get_icon: () => app?.get_icon() ?? null,
      can_open_new_window: () => false,
      create_icon_texture: () => null,
      activate: () => {},
      connectObject: () => {},
      disconnectObject: () => {},
    };
    this.item = dock.createItem(
      tileApp,
      `_minimizedTile:${metaWindow.get_id()}`
    );
    // its "Open Window" menu would launch the fake app
    this.item._destroyMenu();
    this.item._minimizedTile = this;
    this.item._onClick = () => {
      Main.activateWindow(metaWindow);
    };

    // drawn over the item's renderer (see sync), like the clock widget
    this.actor = new St.Widget({ name: 'd2daMinimizedTile' });
    this._frame = new St.Widget({ clip_to_allocation: true });
    this._clone = new Clutter.Clone({
      source: metaWindow.get_compositor_private(),
    });
    this._frame.add_child(this._clone);
    this._emblem = new St.Icon({
      gicon: app?.get_icon() ?? null,
      fallback_icon_name: 'application-x-executable',
    });
    this.actor.add_child(this._frame);
    this.actor.add_child(this._emblem);
    this.actor.connect('destroy', () => (this.actor = null));
    dock.renderArea.add_child(this.actor);
    // dock._cleanupIcon destroys it with the item; the animator moves it on bounce
    this.item._image = this.actor;
    this._size = 0;

    let changed = () => dock._onWindowsChanged?.();
    metaWindow.connectObject(
      'notify::title',
      () => this.item?.setLabelText(title()),
      'notify::minimized',
      changed,
      'unmanaged',
      changed,
      this
    );
  }

  // Fit the window's frame (not its shadow margins) into a size x size tile.
  _layout(size) {
    this._size = size;
    this.actor.set_size(size, size);
    let frame = this.window.get_frame_rect();
    let buffer = this.window.get_buffer_rect();
    let avail = size * (1 - 2 * TILE_PADDING);
    let scale = Math.min(
      avail / Math.max(1, frame.width),
      avail / Math.max(1, frame.height)
    );
    let width = frame.width * scale;
    let height = frame.height * scale;
    this._frame.set_size(width, height);
    this._frame.set_position((size - width) / 2, (size - height) / 2);
    this._clone.set_scale(scale, scale);
    this._clone.set_position(
      (buffer.x - frame.x) * scale,
      (buffer.y - frame.y) * scale
    );
    let emblem = Math.round(size * TILE_EMBLEM);
    this._emblem.set_icon_size(emblem);
    this._emblem.set_size(emblem, emblem);
    this._emblem.set_position(size - emblem, size - emblem);
  }

  // Per frame: follow the item's renderer (position, magnification) and hide
  // the renderer's icon underneath. No allocation here.
  sync(icon) {
    let renderer = icon._renderer;
    if (!this.actor || !renderer) return;
    if (renderer.width !== this._size) this._layout(renderer.width);
    this.actor.set_position(renderer.x, renderer.y);
    this.actor.set_scale(renderer.scale_x, renderer.scale_y);
    this.actor.opacity = renderer.opacity;
    this.actor.visible = renderer.visible;
    renderer.opacity = 0;
  }

  destroy() {
    this.window.disconnectObject(this);
    let { item, actor } = this;
    this.item = null;
    this.actor = null;
    if (item) {
      // the item's destroy runs dock._cleanupIcon, which destroys its _image:
      // detach the overlay first so it is destroyed exactly once, here
      item._minimizedTile = null;
      if (item._image === actor) item._image = null;
      // a tile is usually destroyed right after a click on it, with the
      // pointer still on its icon: if Clutter re-picks onto that icon while
      // its St.Bin is being disposed, BaseIcon re-adds a child inside
      // destroy_all_children and the shell aborts. Unhover it first.
      let icon = item.child?._iconActor;
      if (icon) icon.reactive = false;
      item.destroy();
    }
    actor?.destroy();
  }
}
