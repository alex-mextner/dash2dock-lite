// File-drop helper for Dash2Dock: transparent GTK4 windows that the extension
// lays over its docks while a file drag is in progress.
//
// Why a separate client: on Wayland a drag that starts in a client (Files, a
// browser) delivers its drop and its data only to a Wayland surface. GNOME
// Shell actors see hover positions (XdndHandler) but never the drop, so the
// dock itself cannot receive a file list. The extension starts this process
// through Meta.WaylandClient, which lets it type, stack and place the
// windows; this process only accepts the drop and reports the URIs.
//
// Protocol, one line per message:
//   stdin   "show <n> <drag>"  map n drop windows (one per dock) for drag
//                         id <drag>
//           "hide"        unmap them once any drop in flight is delivered
//           "target 0|1"  whether the pointer is over a dock item that takes
//                         files; decides the drag cursor and whether a drop
//                         is accepted
//   stdout  {"ready":true}  once commands are read; the Shell sends no "show"
//           before it
//           {"accepted":<drag>}  a drop of that drag was taken; its "drop"
//           line follows once the data is read, so the Shell keeps where
//           the drag ended however many drags begin meanwhile
//           {"drop":{"uris":[...],"drag":<drag>}}  the drag id is the one
//           shown when the drop entered, so the Shell can route a drop read
//           after the next drag began; uris is empty when reading failed
//           {"leave":<drag>}  the drag left a drop window without dropping
//           (moved off the dock, or ended or was cancelled over it)
// EOF on stdin ends the process, so it never outlives the extension.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

// GioUnix split out of Gio in GLib 2.80 (GNOME 46); the GNOME 44/45 builds
// still find the unix streams on Gio itself. Looked up synchronously: a
// top-level await would leave loop.run() inside a promise job, where the
// awaits in deliver() never resume and every drop is lost.
let GioUnix;
try {
  GioUnix = imports.gi.GioUnix;
} catch {
  GioUnix = {InputStream: Gio.UnixInputStream, OutputStream: Gio.UnixOutputStream};
}

const URI_LIST = 'text/uri-list';
// the extension runs the trash / open / move itself: COPY keeps the source
// from deleting its file after the drop
const ACTION = Gdk.DragAction.COPY;
// "hide" is sent when the Shell sees the drag end, which can be before this
// process has read the Wayland drop event; unmapping then would lose it
const HIDE_GRACE_MS = 400;

Gtk.init();

const css = new Gtk.CssProvider();
// Adwaita outlines a widget under a drag (:drop(active)); the dock's own
// magnification and label are the feedback, so nothing is drawn here
const CSS = `
  window.d2d-file-drops, window.d2d-file-drops * {
    background: none; box-shadow: none; outline: none; border: none;
  }
  window.d2d-file-drops *:drop(active) { box-shadow: none; outline: none; }
`;
// load_from_string is GTK 4.12+; GNOME 44 ships GTK 4.10
if (css.load_from_string) css.load_from_string(CSS);
else css.load_from_data(CSS, -1);
Gtk.StyleContext.add_provider_for_display(
  Gdk.Display.get_default(),
  css,
  Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
);

const stdout = new Gio.DataOutputStream({
  base_stream: new GioUnix.OutputStream({fd: 1, close_fd: false}),
});
function send(obj) {
  stdout.put_string(`${JSON.stringify(obj)}\n`, null);
  stdout.flush(null);
}

let overTarget = false;
let currentDrop = null;
let currentDrag = 0;
const dragOf = new WeakMap(); // Gdk.Drop -> drag id when it entered
let pendingReads = 0;
let hideId = 0;
const windows = [];

function status(drop) {
  const action = overTarget ? ACTION : 0;
  drop.status(action, action);
  return action;
}

function parseUriList(text) {
  // RFC 2483: CRLF separated, '#' starts a comment line
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length && !l.startsWith('#'));
}

function readUris(drop) {
  return new Promise((resolve, reject) => {
    drop.read_async([URI_LIST], GLib.PRIORITY_DEFAULT, null, (d, res) => {
      try {
        const [stream] = d.read_finish(res);
        const out = Gio.MemoryOutputStream.new_resizable();
        out.splice_async(
          stream,
          Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
            Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
          GLib.PRIORITY_DEFAULT,
          null,
          (o, r) => {
            try {
              o.splice_finish(r);
              const bytes = o.steal_as_bytes().toArray();
              resolve(parseUriList(new TextDecoder().decode(bytes)));
            } catch (e) {
              reject(e);
            }
          }
        );
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Sandboxed sources may offer only the portal file list; GTK converts it
function readFileList(drop) {
  return new Promise((resolve, reject) => {
    drop.read_value_async(
      Gdk.FileList.$gtype,
      GLib.PRIORITY_DEFAULT,
      null,
      (d, res) => {
        try {
          const list = d.read_value_finish(res);
          resolve(list.get_files().map((f) => f.get_uri()));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

async function deliver(drop, drag) {
  pendingReads++;
  let uris = [];
  try {
    const formats = drop.get_formats();
    uris = formats.contain_mime_type(URI_LIST)
      ? await readUris(drop)
      : await readFileList(drop);
  } catch (e) {
    printerr(`d2da file-drops: reading the drop failed: ${e.message}`);
  }
  drop.finish(uris.length ? ACTION : 0);
  // also when empty: it releases the drop the Shell holds since "accepted"
  send({drop: {uris, drag}});
  pendingReads--;
  if (hideId === -1) hideNow();
}

function createWindow() {
  const win = new Gtk.Window({
    title: 'dash2dock-lite-file-drops',
    decorated: false,
    default_width: 64,
    default_height: 64,
    css_classes: ['d2d-file-drops'],
  });
  // GTK commits no buffer for an empty render tree and Mutter never maps a
  // surface without one; painting transparent pixels gives it a buffer
  const area = new Gtk.DrawingArea({hexpand: true, vexpand: true});
  area.set_draw_func((_a, cr) => {
    cr.setSourceRGBA(0, 0, 0, 0);
    cr.paint();
    cr.$dispose();
  });
  const target = new Gtk.DropTargetAsync({
    actions: ACTION,
    formats: Gdk.ContentFormats.new([URI_LIST]).union(
      Gdk.ContentFormats.new_for_gtype(Gdk.FileList.$gtype)
    ),
  });
  target.connect('drag-enter', (_t, drop) => {
    currentDrop = drop;
    dragOf.set(drop, currentDrag);
    return status(drop);
  });
  target.connect('drag-motion', (_t, drop) => status(drop));
  target.connect('drag-leave', (_t, drop) => {
    if (currentDrop === drop) currentDrop = null;
    send({leave: dragOf.get(drop) ?? currentDrag});
  });
  target.connect('drop', (_t, drop) => {
    currentDrop = null;
    if (!overTarget) return false;
    const drag = dragOf.get(drop) ?? currentDrag;
    send({accepted: drag});
    deliver(drop, drag);
    return true;
  });
  area.add_controller(target);
  win.set_child(area);
  win.connect('close-request', () => true);
  return win;
}

function show(n) {
  if (hideId > 0) GLib.source_remove(hideId);
  hideId = 0;
  while (windows.length < n) windows.push(createWindow());
  while (windows.length > n) windows.pop().destroy();
  windows.forEach((w) => w.present());
}

function hideNow() {
  hideId = 0;
  overTarget = false;
  windows.forEach((w) => w.set_visible(false));
}

function hide() {
  if (hideId) return;
  hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_GRACE_MS, () => {
    // a drop still being read hides when it is delivered
    if (pendingReads > 0) {
      hideId = -1;
    } else {
      hideNow();
    }
    return GLib.SOURCE_REMOVE;
  });
}

const loop = new GLib.MainLoop(null, false);

const stdin = new Gio.DataInputStream({
  base_stream: new GioUnix.InputStream({fd: 0, close_fd: false}),
});
function readCommand() {
  stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
    let line = null;
    try {
      [line] = s.read_line_finish_utf8(res);
    } catch {
      // treated as EOF
    }
    if (line === null) {
      loop.quit();
      return;
    }
    const [cmd, arg, arg2] = line.trim().split(' ');
    if (cmd === 'show') {
      currentDrag = parseInt(arg2) || 0;
      show(Math.max(1, parseInt(arg) || 1));
    } else if (cmd === 'hide') {
      hide();
    } else if (cmd === 'target') {
      overTarget = arg === '1';
      if (currentDrop) status(currentDrop);
    }
    readCommand();
  });
}
readCommand();
send({ready: true});
loop.run();
