// File drops onto the dock (setting file-drops): a file dragged from Files or
// any other client onto the Trash moves it to the trash, onto an app opens it
// with that app, onto a folder stack or a mounted volume moves or copies it
// there, as in the macOS Dock.
//
// On Wayland a client drag delivers its drop and data only to a Wayland
// surface; Shell actors get hover positions but never the drop. So a helper
// client (apps/file-drops.js) maps a transparent window over each dock while
// a drag is in progress. Its window actor is moved into a layer above the
// docks, so Mutter picks its surface as the drop target wherever the dock
// is; it paints nothing, so the dock looks unchanged. Hover feedback stays
// the dock's own: Meta.Dnd positions drive the usual magnification and
// label. Outside drags the helper has no window mapped, so it can never
// steal a click or block direct scanout.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HELPER = 'apps/file-drops.js';
// the dock reacts this far around its strut (dock.js _isWithinDash)
const HOVER_MARGIN = 20;
// a helper that dies within this time of its start counts as a crash
const CRASH_WINDOW_US = 30 * GLib.USEC_PER_SEC;
const MAX_CRASHES = 5;
const RESTART_BASE_MS = 1000;

const NAUTILUS_BUS = 'org.gnome.Nautilus';
const NAUTILUS_PATH = '/org/gnome/Nautilus/FileOperations2';
const NAUTILUS_IFACE = 'org.gnome.Nautilus.FileOperations2';

// Mutter 49+ types the window itself; 46-48 do it through the client and 45
// has no dock type (make_above keeps it over normal windows there).
function spawnClient(argv) {
  const launcher = new Gio.SubprocessLauncher({
    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
  });
  if (Meta.WaylandClient.new_subprocess) {
    const client = Meta.WaylandClient.new_subprocess(
      global.context,
      launcher,
      argv
    );
    return [client, client.get_subprocess()];
  }
  const client = Meta.WaylandClient.new(global.context, launcher);
  return [client, client.spawnv(global.display, argv)];
}

function makeDockWindow(client, window) {
  if (window.set_type) {
    window.set_type(Meta.WindowType.DOCK);
    window.hide_from_window_list();
  } else {
    if (client.make_dock) client.make_dock(window);
    else window.make_above();
    client.hide_from_window_list(window);
  }
  window.stick();
}

function nautilusCall(method, args) {
  return new Promise((resolve, reject) => {
    Gio.DBus.session.call(
      NAUTILUS_BUS,
      NAUTILUS_PATH,
      NAUTILUS_IFACE,
      method,
      args,
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (conn, res) => {
        try {
          conn.call_finish(res);
          resolve();
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

function platformData() {
  return {
    'parent-handle': new GLib.Variant('s', ''),
    timestamp: new GLib.Variant('u', global.get_current_time()),
    'window-position': new GLib.Variant('s', 'center'),
  };
}

function filesystemId(file) {
  return new Promise((resolve) => {
    file.query_info_async(
      'id::filesystem',
      Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT,
      null,
      (f, res) => {
        try {
          resolve(f.query_info_finish(res).get_attribute_string('id::filesystem'));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

export class FileDrops {
  constructor(extension) {
    this.extension = extension;
    this._client = null;
    this._proc = null;
    this._stdin = null;
    this._cancellable = null;
    this._crashes = 0;
    this._restartId = 0;
    this._windows = [];
    this._targets = []; // [{dock, rect}] for the current drag
    this._activeDock = null;
    this._target = null;
    this._hoverItem = null;
    this._drag = 0; // id of the current or last drag, echoed by the helper
    this._dragTargets = new Map(); // drag id -> target it ended on
    this._dropDelivered = false;
    this._layer = null;
  }

  enable() {
    // GNOME 49+ is Wayland only and dropped the check
    if (Meta.is_wayland_compositor && !Meta.is_wayland_compositor()) {
      console.log('d2da: file-drops needs a Wayland session');
      return;
    }
    const dnd = global.backend.get_dnd();
    dnd.connectObject(
      'dnd-enter',
      () => this._onDragBegin(),
      'dnd-position-change',
      (_dnd, x, y) => this._onDragMotion(x, y),
      'dnd-leave',
      () => this._onDragEnd(),
      this
    );
    global.display.connectObject(
      'window-created',
      (_d, w) => this._onWindowCreated(w),
      this
    );
    // the dock re-creates reactive icon actors while it magnifies, so the
    // drop surface goes above the docks rather than the docks stepping aside
    this._layer = new Clutter.Actor({ name: 'd2daFileDropLayer' });
    this._layer.add_constraint(
      new Clutter.BindConstraint({
        source: global.stage,
        coordinate: Clutter.BindCoordinate.ALL,
      })
    );
    Main.layoutManager.uiGroup.add_child(this._layer);
    this._spawn();
  }

  disable() {
    global.backend.get_dnd().disconnectObject(this);
    global.display.disconnectObject(this);
    if (this._restartId) {
      GLib.source_remove(this._restartId);
      this._restartId = 0;
    }
    this._kill();
    // a window actor must not die with the layer while Mutter still
    // manages its window (the helper exits asynchronously)
    this._layer?.get_children().forEach((actor) => {
      this._layer.remove_child(actor);
      global.window_group.add_child(actor);
    });
    this._layer?.destroy();
    this._layer = null;
    if (this._activeDock) this._leaveDock(this._activeDock);
    this._activeDock = null;
    this._target = null;
    this._hoverItem = null;
    this._dragTargets.clear();
    this._dropDelivered = false;
  }

  //---------------------
  // helper process
  //---------------------

  _spawn() {
    const path = `${this.extension.path}/${HELPER}`;
    const gjs = GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs';
    let client, proc;
    try {
      [client, proc] = spawnClient([gjs, '-m', path]);
    } catch (e) {
      console.error('d2da: file-drops helper', e);
      return;
    }
    this._client = client;
    this._proc = proc;
    this._startedAt = GLib.get_monotonic_time();
    this._stdin = proc.get_stdin_pipe();
    this._cancellable = new Gio.Cancellable();
    this._readLines(
      new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() }),
      this._cancellable
    );
    proc.wait_async(this._cancellable, (p, res) => {
      try {
        p.wait_finish(res);
      } catch {
        return; // cancelled: disabled or killed on purpose
      }
      if (this._proc !== p) return;
      this._onHelperExit();
    });
  }

  _kill() {
    this._cancellable?.cancel();
    this._cancellable = null;
    // EOF on stdin ends the helper; SIGTERM covers a wedged one
    try {
      this._stdin?.close(null);
    } catch {
      // already closed
    }
    this._proc?.send_signal(15);
    this._stdin = null;
    this._proc = null;
    this._client = null;
    this._windows.forEach((w) => w.disconnectObject(this));
    this._windows = [];
    this._targets = [];
  }

  _onHelperExit() {
    const quick =
      GLib.get_monotonic_time() - this._startedAt < CRASH_WINDOW_US;
    this._crashes = quick ? this._crashes + 1 : 1;
    this._kill();
    this._activeDock = null;
    if (this._crashes > MAX_CRASHES) {
      console.error('d2da: file-drops helper keeps exiting; giving up');
      return;
    }
    const delay = RESTART_BASE_MS * 2 ** (this._crashes - 1);
    console.warn(`d2da: file-drops helper exited; restarting in ${delay} ms`);
    this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      this._restartId = 0;
      this._spawn();
      return GLib.SOURCE_REMOVE;
    });
  }

  _send(line) {
    if (!this._stdin) return;
    try {
      this._stdin.write_all(new TextEncoder().encode(`${line}\n`), null);
    } catch (e) {
      console.error('d2da: file-drops helper write', e);
    }
  }

  _readLines(stream, cancellable) {
    stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
      let line;
      try {
        [line] = s.read_line_finish_utf8(res);
      } catch {
        return; // cancelled
      }
      if (line === null) return; // helper exited; wait_async restarts it
      try {
        const msg = JSON.parse(line);
        if (msg.drop) this._onDrop(msg.drop.uris ?? [], msg.drop.drag);
      } catch (e) {
        console.error('d2da: file-drops helper message', e);
      }
      this._readLines(stream, cancellable);
    });
  }

  //---------------------
  // drag tracking
  //---------------------

  _dropRect(dock) {
    const [x, y] = dock.struts.get_transformed_position();
    const [w, h] = dock.struts.get_transformed_size();
    const [dx, dy] = dock.dash.get_transformed_position();
    const [dw, dh] = dock.dash.get_transformed_size();
    // the strut spans the monitor edge; keep to the icons plus one icon of
    // magnification spread on each end so drops beside the dock still reach
    // the windows there
    const vertical = dock.isVertical();
    const spread = vertical ? dw : dh;
    let r = vertical
      ? [x, dy - spread, w, dh + 2 * spread]
      : [dx - spread, y, dw + 2 * spread, h];
    r = [
      r[0] - HOVER_MARGIN,
      r[1] - HOVER_MARGIN,
      r[2] + 2 * HOVER_MARGIN,
      r[3] + 2 * HOVER_MARGIN,
    ];
    const m = dock.getMonitor();
    const x0 = Math.max(r[0], m.x);
    const y0 = Math.max(r[1], m.y);
    const x1 = Math.min(r[0] + r[2], m.x + m.width);
    const y1 = Math.min(r[1] + r[3], m.y + m.height);
    return [x0, y0, x1 - x0, y1 - y0].map(Math.round);
  }

  _onDragBegin() {
    if (!this._proc) return;
    this._drag++;
    this._dropDelivered = false;
    this._target = null;
    this._hoverItem = null;
    this._activeDock = null;
    this._targets = (this.extension.docks ?? [])
      .filter((d) => d.visible && d.dash && !d.getMonitor()?.inFullscreen)
      .map((dock) => ({ dock, rect: this._dropRect(dock), window: null }));
    if (!this._targets.length) return;
    this._send('target 0');
    this._send(`show ${this._targets.length} ${this._drag}`);
    // above whatever chrome was added since
    Main.layoutManager.uiGroup.set_child_above_sibling(this._layer, null);
  }

  _onWindowCreated(window) {
    if (!this._client?.owns_window(window)) return;
    makeDockWindow(this._client, window);
    this._windows.push(window);
    const t = this._targets.find((t) => !t.window);
    if (t) t.window = window;
    // a size set before the first map sticks, the position does not: Mutter
    // places a new window when it is shown, so move it again then. Mutter
    // restacks window actors within whatever parent they have, so in the
    // layer the actor stays above the docks.
    const place = () => {
      const target = this._targets.find((t) => t.window === window);
      if (target) window.move_resize_frame(false, ...target.rect);
      const actor = window.get_compositor_private();
      const parent = actor?.get_parent();
      if (parent && parent !== this._layer) {
        parent.remove_child(actor);
        this._layer.add_child(actor);
      }
    };
    window.connectObject(
      'shown',
      place,
      'unmanaged',
      () => {
        window.disconnectObject(this);
        this._windows = this._windows.filter((w) => w !== window);
        this._targets.forEach((t) => {
          if (t.window === window) t.window = null;
        });
      },
      this
    );
    place();
  }

  // Meta.Dnd emits a position per pointer motion: this does what the dock's
  // own motion handler does (keep the animator running), reads the item the
  // animator found under the pointer, and only builds a target and messages
  // the helper when that item changes.
  _onDragMotion(x, y) {
    let dock = null;
    for (let i = 0; i < this._targets.length; i++) {
      const r = this._targets[i].rect;
      if (x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3]) {
        dock = this._targets[i].dock;
        break;
      }
    }
    if (this._activeDock && this._activeDock !== dock) {
      this._leaveDock(this._activeDock);
    }
    this._activeDock = dock;
    if (dock) {
      // no pointer events reach the autohide dwell during a drag; reveal
      // the dock like the Dock does for a drag to the screen edge
      dock.autohider?.holdForDrag(this, true);
      dock._beginAnimation();
    }
    this._updateTarget();
  }

  _leaveDock(dock) {
    dock._debounceEndAnimation();
    dock.autohider?.holdForDrag(this, false);
  }

  _onDragEnd() {
    if (!this._targets.length) return;
    // the drop data usually arrives later from the helper, possibly after
    // the next drag began; keep what this drag landed on under its id,
    // unless _onDrop already took this drag's drop
    this._updateTarget();
    if (!this._dropDelivered && this._target) {
      this._dragTargets.set(this._drag, this._target);
    }
    // a drag whose drop never came (cancelled, refused) must not pile up
    for (const id of this._dragTargets.keys()) {
      if (id < this._drag - 4) this._dragTargets.delete(id);
    }
    this._send('hide');
    if (this._activeDock) this._leaveDock(this._activeDock);
    this._activeDock = null;
    this._targets = [];
    this._target = null;
    this._hoverItem = null;
  }

  _updateTarget() {
    const dock = this._activeDock;
    const item = dock?.animated ? dock._hoveredIcon : null;
    if (item === this._hoverItem) return;
    this._hoverItem = item;
    const prev = this._target;
    this._target = item ? this._targetFor(dock, item) : null;
    if (!!prev !== !!this._target) {
      this._send(`target ${this._target ? 1 : 0}`);
    }
  }

  // what a drop on this dock item does, or null when it takes no files
  _targetFor(dock, item) {
    if (item === dock._trashIcon) return { item, dock, kind: 'trash' };
    if (item._folderStack) {
      const dir = Gio.File.new_for_path(item._folderStack.path);
      return { item, dock, kind: 'folder', dir };
    }
    if (item._mountType) {
      const mount = this.extension.services?._mounts?.[item._mountId];
      const dir = mount?.get_root();
      return dir ? { item, dock, kind: 'folder', dir } : null;
    }
    const app = item._appwell?.app;
    if (!item.custom_icon && app instanceof Shell.App) {
      const info = app.get_app_info();
      if (info?.supports_uris() || info?.supports_files()) {
        return { item, dock, kind: 'app', app, info };
      }
    }
    return null;
  }

  //---------------------
  // drop actions
  //---------------------

  _onDrop(uris, drag) {
    // The helper's drop line and Meta.Dnd's dnd-leave travel unrelated
    // channels in no fixed order: a drop reported while its drag is still
    // live lands on what the pointer is over now; a later one on what that
    // drag ended on, even if another drag has begun since.
    let target;
    if (drag === this._drag && this._targets.length) {
      this._updateTarget();
      target = this._target;
      this._dropDelivered = true;
    } else {
      target = this._dragTargets.get(drag);
      this._dragTargets.delete(drag);
    }
    if (!target || !uris.length) return;
    this._perform(target, uris).catch((e) => {
      console.error(`d2da: file-drops ${target.kind}`, e);
    });
  }

  async _perform(target, uris) {
    switch (target.kind) {
      case 'trash':
        await this._trash(uris);
        break;
      case 'app':
        // async: a D-Bus activated app must not block the compositor
        target.info.launch_uris_async(
          uris,
          global.create_app_launch_context(0, -1),
          null,
          (info, res) => {
            try {
              info.launch_uris_finish(res);
            } catch (e) {
              console.error(`d2da: file-drops open with ${info.get_id()}`, e);
            }
          }
        );
        target.dock._maybeBounce?.(target.item);
        break;
      case 'folder':
        await this._transfer(uris, target.dir);
        break;
    }
  }

  // Files performs these when it is installed, so they show its progress,
  // conflict dialogs and Undo; plain GIO is the fallback.
  async _trash(uris) {
    try {
      await nautilusCall(
        'TrashURIs',
        new GLib.Variant('(asa{sv})', [uris, platformData()])
      );
    } catch {
      await Promise.all(
        uris.map(
          (uri) =>
            new Promise((resolve) => {
              Gio.File.new_for_uri(uri).trash_async(
                GLib.PRIORITY_DEFAULT,
                null,
                (f, res) => {
                  try {
                    f.trash_finish(res);
                  } catch (e) {
                    console.error(`d2da: file-drops trash ${uri}`, e);
                  }
                  resolve();
                }
              );
            })
        )
      );
    }
  }

  // Finder semantics: move on the same filesystem, copy across them; Ctrl
  // or Alt (Option) forces a copy, Shift a move, as in Files.
  async _transfer(uris, dir) {
    const [, , mods] = global.get_pointer();
    const SHIFT = Clutter.ModifierType.SHIFT_MASK;
    const CONTROL = Clutter.ModifierType.CONTROL_MASK;
    const ALT = Clutter.ModifierType.MOD1_MASK;
    const destFs = await filesystemId(dir);
    const move = [];
    const copy = [];
    for (const uri of uris) {
      const file = Gio.File.new_for_uri(uri);
      // already in this folder: nothing to do
      if (file.get_parent()?.equal(dir)) continue;
      let doMove;
      if (mods & (CONTROL | ALT)) doMove = false;
      else if (mods & SHIFT) doMove = true;
      else doMove = destFs !== null && (await filesystemId(file)) === destFs;
      (doMove ? move : copy).push(uri);
    }
    const dest = dir.get_uri();
    for (const [method, list] of [
      ['MoveURIs', move],
      ['CopyURIs', copy],
    ]) {
      if (!list.length) continue;
      try {
        await nautilusCall(
          method,
          new GLib.Variant('(assa{sv})', [list, dest, platformData()])
        );
      } catch {
        await this._gioTransfer(method === 'MoveURIs', list, dir);
      }
    }
  }

  async _gioTransfer(move, uris, dir) {
    for (const uri of uris) {
      const src = Gio.File.new_for_uri(uri);
      const dst = dir.get_child(src.get_basename());
      await new Promise((resolve) => {
        const done = (f, res) => {
          try {
            if (move) f.move_finish(res);
            else f.copy_finish(res);
          } catch (e) {
            console.error(`d2da: file-drops ${move ? 'move' : 'copy'} ${uri}`, e);
          }
          resolve();
        };
        if (move) {
          src.move_async(
            dst,
            Gio.FileCopyFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            null,
            done
          );
        } else {
          src.copy_async(
            dst,
            Gio.FileCopyFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            null,
            done
          );
        }
      });
    }
  }
}
