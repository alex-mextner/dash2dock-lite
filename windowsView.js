'use strict';

// Window views of the dock, each an opt-in setting (macOS / Ubuntu Dock parity):
//
// * isolate-workspaces: running apps, dots and window cycling only count
//   windows on the active workspace (sticky windows count everywhere).
// * WindowEvents: the few window/workspace signals the window views need,
//   connected only while one of them is on.

import Shell from 'gi://Shell';

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
    this._workspace?.disconnectObject(this);
    this._workspace = null;
  }

  destroy() {
    this.disable();
    this._onChange = null;
  }
}
