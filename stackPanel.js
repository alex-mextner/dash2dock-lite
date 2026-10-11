'use strict';

// Folder stack options (view / sort / display) and the macOS-style Grid and
// List panels a stack opens in when it is not shown as the classic fan.
// The panel is a popover like the Dock's: it stands clear of the dock on the
// screen side, with a pointer at its dock edge aimed at the stack's icon, and
// grows from / shrinks into that pointer. Its background is the dock's Liquid
// Glass (one GLSL pass, the pointer part of the same SDF) or, with the glass
// material off, the same shape as a flat translucent platter. Thumbnails come
// from the freedesktop cache through St.TextureCache (async).

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { GlassPlatter } from './effects/glass.js';
import { trySpawnCommandLine } from './utils.js';

// index order = the int value of the downloads-stack-* settings; index 0 is the
// upstream behaviour
export const STACK_VIEWS = ['fan', 'grid', 'list', 'automatic'];
export const STACK_SORTS = [
  'date-modified',
  'name',
  'date-added',
  'date-created',
  'kind',
];
export const STACK_DISPLAYS = ['folder', 'stack'];

export const STACK_VIEW_LABELS = {
  fan: 'Fan',
  grid: 'Grid',
  list: 'List',
  automatic: 'Automatic',
};
export const STACK_SORT_LABELS = {
  name: 'Name',
  'date-added': 'Date Added',
  'date-modified': 'Date Modified',
  'date-created': 'Date Created',
  kind: 'Kind',
};
export const STACK_DISPLAY_LABELS = { folder: 'Folder', stack: 'Stack' };

export function pick(value, choices) {
  return choices.includes(value) ? value : choices[0];
}

// largest images decoded directly when no thumbnail exists yet
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;

// The freedesktop thumbnail of an image file, or the image itself if small
// enough; null for anything that is not an image.
export function previewFile(item) {
  if (!item.path || !item.type?.startsWith('image/')) {
    return null;
  }
  let file = Gio.File.new_for_path(item.path);
  let md5 = GLib.compute_checksum_for_string(
    GLib.ChecksumType.MD5,
    file.get_uri(),
    -1
  );
  for (let size of ['large', 'normal']) {
    let thumb = GLib.build_filenamev([
      GLib.get_user_cache_dir(),
      'thumbnails',
      size,
      `${md5}.png`,
    ]);
    if (GLib.file_test(thumb, GLib.FileTest.EXISTS)) {
      return Gio.File.new_for_path(thumb);
    }
  }
  let bytes = item.fileInfo?.get_size?.() ?? 0;
  return bytes > 0 && bytes <= MAX_PREVIEW_BYTES ? file : null;
}

// The icon a stack shows when "Display as Stack": the top file's picture (or
// its type icon), like the Dock showing the newest download.
export function stackGicon(item) {
  if (!item) return null;
  let preview = previewFile(item);
  if (preview) return new Gio.FileIcon({ file: preview });
  return item.fileInfo?.get_icon?.() ?? null;
}

function openCommand(item, fileExplorer) {
  if (item.type?.includes('directory')) {
    return `${fileExplorer} ${GLib.shell_quote(item.path)}`;
  }
  return `xdg-open ${GLib.shell_quote(item.path)}`;
}

// Persist one option of a stack: Downloads has its own int keys, the other
// stacks keep theirs in their folder-stacks JSON entry. The write rebuilds the
// stacks (and this item with its menu), so it runs after the menu activation
// has finished instead of under it.
function saveStackOption(extension, stack, field, value, choices) {
  GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    let settings = extension._settings;
    if (!settings) return GLib.SOURCE_REMOVE;
    if (stack.isDownloads) {
      settings.set_int(`downloads-stack-${field}`, choices.indexOf(value));
      return GLib.SOURCE_REMOVE;
    }
    let entries;
    try {
      entries = JSON.parse(settings.get_string('folder-stacks'));
    } catch {
      return GLib.SOURCE_REMOVE;
    }
    let entry = entries[stack.entryIndex];
    if (entry === undefined) return GLib.SOURCE_REMOVE;
    entries[stack.entryIndex] = {
      ...(typeof entry === 'string' ? { path: entry } : entry),
      [field]: value,
    };
    settings.set_string('folder-stacks', JSON.stringify(entries));
    return GLib.SOURCE_REMOVE;
  });
}

function addRadioSubmenu(menu, title, current, choices, labels, onPick) {
  let sub = new PopupMenu.PopupSubMenuMenuItem(title);
  choices.forEach((choice) => {
    let item = sub.menu.addAction(labels[choice], () => onPick(choice));
    item.setOrnament(
      choice === current
        ? PopupMenu.Ornament.DOT
        : (PopupMenu.Ornament.NO_DOT ?? PopupMenu.Ornament.NONE)
    );
  });
  menu.addMenuItem(sub);
}

// The macOS stack context menu (Sort by, Display as, View content as,
// Open "<Title>") on a stack's dock item, and its "Display as Stack" icon.
export function setupStackItem(dock, item, stack) {
  let extension = dock.extension;
  let menu = item._menu;
  if (menu) {
    let open = menu._newWindowItem;
    if (open) open.label.text = `Open "${stack.title}"`;
    let save = (field, choices) => (value) =>
      saveStackOption(extension, stack, field, value, choices);
    let first = new PopupMenu.PopupSeparatorMenuItem();
    menu.addMenuItem(first, 0);
    addRadioSubmenu(menu, 'Sort by', stack.sort,
      ['name', 'date-added', 'date-modified', 'date-created', 'kind'],
      STACK_SORT_LABELS, save('sort', STACK_SORTS));
    addRadioSubmenu(menu, 'Display as', stack.display, STACK_DISPLAYS,
      STACK_DISPLAY_LABELS, save('display', STACK_DISPLAYS));
    addRadioSubmenu(menu, 'View content as', stack.view, STACK_VIEWS,
      STACK_VIEW_LABELS, save('view', STACK_VIEWS));
    // macOS lists the options first and the Open item last
    menu.moveMenuItem(first, menu.numMenuItems - 1);
    if (open) menu.moveMenuItem(open, menu.numMenuItems - 1);
  }

  if (stack.display !== 'stack') return;
  let dashIcon = item.child;
  let applyDisplay = () => {
    dashIcon?.setStackGicon?.(stackGicon(stack.files?.[0]));
    // The renderer copies the icon's gicon on its next frame, so starting
    // the animation is enough. A refresh would relayout synchronously, and
    // as this also runs while a relayout creates the item, that recursed.
    extension.animate?.();
  };
  // one listener per dock showing this stack (multi-monitor)
  stack.fileListeners = stack.fileListeners ?? new Set();
  stack.fileListeners.add(applyDisplay);
  item.connect('destroy', () => stack.fileListeners.delete(applyDisplay));
  if (stack.files) applyDisplay();
}

const GRID_COLUMNS = 5;
const GRID_CELL = 96;
const GRID_THUMB = 64;
const LIST_THUMB = 24;
const MAX_ROWS_VISIBLE = 4;
const LIST_ROW = 36;
const LIST_ROWS_VISIBLE = 12;
const LIST_ROW_STYLE = 'border-radius: 8px; padding: 4px 8px;';
const HOVER = 'background-color: rgba(255,255,255,0.16);';

// popover geometry, logical px
const PANEL_RADIUS = 16;
const NOTCH_HALF = 11; // half the pointer's base
const NOTCH_DEPTH = 10;
const DOCK_GAP = 6; // between the dock's edge and the pointer's tip
const SCREEN_MARGIN = 8;
const MIN_SCROLL = 96; // the panel never shrinks its files below this
// the glass is darker than the dock's for the white labels on it
const GLASS_TINT = [0.1, 0.1, 0.12, 0.5];
const GLASS_MIN_BLUR = 24;
// glass-material off: the former CSS panel (rgba(40,40,46,0.72), 18px corners)
const FLAT_TINT = [40 / 255, 40 / 255, 46 / 255, 0.72];
const FLAT_RADIUS = 18;
const FLAT_RIM = 0.5;
const OPEN_MS = 220;
const CLOSE_MS = 160;
const START_SCALE = 0.2;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(v, hi));
}

// A full-monitor transparent backdrop (a click outside closes, as in macOS)
// holding the popover beside the dock.
export const StackPanel = GObject.registerClass(
  {},
  class StackPanel extends St.Widget {
    _init(dock, target, stack, files, view) {
      super._init({
        name: 'd2daStackBackdrop',
        reactive: true,
        x: dock._monitor.x,
        y: dock._monitor.y,
        width: dock._monitor.width,
        height: dock._monitor.height,
      });
      this.dock = dock;
      this._target = target;
      this._fileExplorer = dock.extension.file_explorer();

      this.connect('button-press-event', () => {
        this.close();
        return Clutter.EVENT_STOP;
      });
      this.connect('key-press-event', (actor, evt) => {
        if (evt.get_key_symbol() === Clutter.KEY_Escape) {
          this.close();
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
      this._scale = scale;
      // the background, the content above it; both scale from the pointer
      this._popover = new St.Widget({ reactive: true });
      // clicks inside the panel do not reach the backdrop
      this._popover.connect('button-press-event', () => Clutter.EVENT_STOP);
      this.add_child(this._popover);
      this._glass = new GlassPlatter();
      this._popover.add_child(this._glass);
      this._panel = new St.BoxLayout({
        name: 'd2daStackPanel',
        orientation: Clutter.Orientation.VERTICAL,
        style: 'padding: 10px;',
      });
      this._popover.add_child(this._panel);

      this._panel.add_child(
        new St.Label({
          text: stack.title,
          style: 'font-weight: bold; color: white; padding: 2px 8px 8px 8px;',
          x_align: Clutter.ActorAlign.CENTER,
        })
      );

      let scroll = new St.ScrollView({
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        overlay_scrollbars: true,
      });
      this._scroll = scroll;
      let content;
      if (view === 'list') {
        content = new St.BoxLayout({
          orientation: Clutter.Orientation.VERTICAL,
        });
        files.forEach((f) => content.add_child(this._listRow(f, scale)));
        let rows = Math.min(files.length, LIST_ROWS_VISIBLE);
        scroll.set_size(300 * scale, rows * LIST_ROW * scale);
      } else {
        let grid = new Clutter.GridLayout({
          column_homogeneous: true,
          row_homogeneous: true,
        });
        // St.ScrollView needs an St.Scrollable child
        content = new St.Viewport({ layout_manager: grid });
        files.forEach((f, i) =>
          grid.attach(
            this._gridCell(f, scale),
            i % GRID_COLUMNS,
            Math.floor(i / GRID_COLUMNS),
            1,
            1
          )
        );
        let cols = Math.min(files.length, GRID_COLUMNS);
        let rows = Math.min(
          Math.ceil(files.length / GRID_COLUMNS),
          MAX_ROWS_VISIBLE
        );
        scroll.set_size(
          cols * GRID_CELL * scale,
          rows * (GRID_CELL + 12) * scale
        );
      }
      scroll.set_child(content);
      this._panel.add_child(scroll);

      let open = new St.Button({
        label: 'Open in Files',
        style_class: 'button',
        x_align: Clutter.ActorAlign.END,
        style: 'margin-top: 8px;',
      });
      open.connect('clicked', () =>
        this._spawn(
          `${this._fileExplorer} ${GLib.shell_quote(stack.path)}`
        )
      );
      this._panel.add_child(open);

      Main.uiGroup.add_child(this);
      this._place();
      // modal like a real popup: Escape reaches us and a click anywhere else
      // lands on the backdrop and closes the panel
      this._grab = Main.pushModal(this);
      this.grab_key_focus();

      this._popover.set_scale(START_SCALE, START_SCALE);
      this._popover.opacity = 0;
      this._popover.ease({
        scale_x: 1,
        scale_y: 1,
        opacity: 255,
        duration: OPEN_MS,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      });
    }

    // The panel stands DOCK_GAP + NOTCH_DEPTH off the dock's edge, on the
    // screen side (above a bottom dock, beside a side dock), centred on the
    // stack's icon but kept on the work area; the pointer follows the icon.
    _place() {
      let dock = this.dock;
      let m = dock._monitor;
      let wa = Main.layoutManager.getWorkAreaForMonitor(dock._monitorIndex);
      let s = this._scale;
      let depth = NOTCH_DEPTH * s;
      let gap = DOCK_GAP * s;
      let margin = SCREEN_MARGIN * s;
      let glassOn = dock.extension.glass_material;
      this._radius = (glassOn ? PANEL_RADIUS : FLAT_RADIUS) * s;

      // the dock's edge is its background's, so the panel never covers it
      let [bx, by] = dock._background.get_transformed_position();
      let [bw, bh] = dock._background.get_transformed_size();
      let [cx, cy] = this._iconCenter();

      let pos = dock._position;
      let vertical = pos === 'left' || pos === 'right';
      // room between the pointer's base and the far screen edge
      let room;
      let tip;
      switch (pos) {
        case 'top':
          tip = by + bh + gap;
          room = wa.y + wa.height - margin - (tip + depth);
          break;
        case 'left':
          tip = bx + bw + gap;
          room = wa.height - 2 * margin;
          break;
        case 'right':
          tip = bx - gap;
          room = wa.height - 2 * margin;
          break;
        default:
          tip = by - gap;
          room = tip - depth - (wa.y + margin);
      }

      // too tall for the room: give up file rows, never the dock
      let [, pw] = this._panel.get_preferred_width(-1);
      let [, ph] = this._panel.get_preferred_height(pw);
      if (ph > room) {
        let [, sh] = this._scroll.get_preferred_height(-1);
        this._scroll.height = Math.max(MIN_SCROLL * s, sh - (ph - room));
        [, ph] = this._panel.get_preferred_height(pw);
      }

      let x, y;
      if (vertical) {
        x = pos === 'left' ? tip + depth : tip - depth - pw;
        y = clamp(cy - ph / 2, wa.y + margin, wa.y + wa.height - margin - ph);
      } else {
        x = clamp(cx - pw / 2, m.x + margin, m.x + m.width - margin - pw);
        y = pos === 'top' ? tip + depth : tip - depth - ph;
      }
      this._rect = {
        x: Math.round(x),
        y: Math.round(y),
        w: pw,
        h: ph,
        tip: Math.round(tip),
        vertical,
        // unit direction from the pointer's tip into the panel
        dx: pos === 'left' ? 1 : pos === 'right' ? -1 : 0,
        dy: pos === 'top' ? 1 : pos === 'bottom' ? -1 : 0,
      };
      let r = this._rect;
      this._popover.set_position(r.x - m.x, r.y - m.y);
      this._popover.set_size(pw, ph);
      this._panel.set_size(pw, ph);

      let ext = dock.extension;
      let glass = this._glass;
      if (glassOn) {
        // The windows behind, whatever the dock's glass-backdrop: the panel
        // floats over them (the dock's usual wallpaper-only backdrop would
        // show the wallpaper through a window). It is a still view, blurred
        // once while they do not change.
        glass.setBackdrop('windows', dock._monitorIndex);
        glass.setMaterial(
          this._radius,
          Math.max(ext.glass_blur, GLASS_MIN_BLUR) * s,
          ext.glass_refraction * s,
          ext.glass_rim,
          ...GLASS_TINT,
          s
        );
      } else {
        glass.setBackdrop('none', dock._monitorIndex);
        glass.setMaterial(this._radius, 0, 0, FLAT_RIM, ...FLAT_TINT, s);
      }
      this._aim(cx, cy);
    }

    // Where the stack's icon is drawn: the animator's renderer, which the
    // dock packs apart from the item's own (layout) box.
    _iconCenter() {
      let icon = this._target._renderer ?? this._target;
      let [x, y] = icon.get_transformed_position();
      let [w, h] = icon.get_transformed_size();
      return [x + w / 2, y + h / 2];
    }

    // Points the pointer at (cx, cy), kept on the panel's straight edge.
    _aim(cx, cy) {
      let r = this._rect;
      let half = NOTCH_HALF * this._scale;
      let inset = this._radius + half;
      let tipX = r.vertical ? r.tip : clamp(cx, r.x + inset, r.x + r.w - inset);
      let tipY = r.vertical ? clamp(cy, r.y + inset, r.y + r.h - inset) : r.tip;
      tipX = Math.round(tipX) - r.x;
      tipY = Math.round(tipY) - r.y;
      this._popover.set_pivot_point(tipX / r.w, tipY / r.h);
      let depth = NOTCH_DEPTH * this._scale;
      this._glass.setNotch(tipX, tipY, r.dx, r.dy, half, depth);
      // the backdrop mirrors only the windows under the panel
      this._glass.setGeometry(0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
    }

    // The dock settled after the click (its magnification is off while the
    // panel is open): aim the pointer at where the icon rests.
    aimAtIcon() {
      if (this._closed || !this._rect) return;
      let [cx, cy] = this._iconCenter();
      this._aim(cx, cy);
    }

    _thumb(f, size, scale) {
      let preview = previewFile(f);
      if (preview) {
        let bin = new St.Bin({ width: size * scale, height: size * scale });
        // bound only the longer side (bounding both stretches the picture);
        // the texture cache decodes it downscaled off the main loop
        let [, pw, ph] = GdkPixbuf.Pixbuf.get_file_info(preview.get_path());
        let landscape = pw >= ph;
        let picture = St.TextureCache.get_default().load_file_async(
          preview,
          landscape ? size : -1,
          landscape ? -1 : size,
          scale,
          1
        );
        picture.x_align = Clutter.ActorAlign.CENTER;
        picture.y_align = Clutter.ActorAlign.CENTER;
        bin.set_child(picture);
        return bin;
      }
      let gicon = f.fileInfo?.get_icon?.();
      return new St.Icon(
        gicon
          ? { gicon, icon_size: size }
          : { icon_name: f.icon || 'text-x-generic', icon_size: size }
      );
    }

    _gridCell(f, scale) {
      let base =
        'border-radius: 10px; padding: 4px;' +
        `width: ${GRID_CELL - 8}px; height: ${GRID_CELL + 4}px;`;
      let cell = new St.Button({ style: base, track_hover: true });
      let box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
      });
      let thumb = this._thumb(f, GRID_THUMB, scale);
      thumb.x_align = Clutter.ActorAlign.CENTER;
      box.add_child(thumb);
      let label = new St.Label({
        text: f.name,
        style: 'color: white; font-size: 9pt; text-align: center;',
        x_align: Clutter.ActorAlign.CENTER,
      });
      // Finder keeps both ends of long names ("Screenshot…10-04.png")
      label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
      box.add_child(label);
      cell.set_child(box);
      cell.connect('clicked', () => this._open(f));
      cell.connect('notify::hover', () => {
        cell.style = cell.hover ? base + HOVER : base;
      });
      return cell;
    }

    _listRow(f, scale) {
      let row = new St.Button({
        style: LIST_ROW_STYLE,
        track_hover: true,
        x_expand: true,
      });
      let box = new St.BoxLayout({ x_expand: true });
      box.add_child(this._thumb(f, LIST_THUMB, scale));
      let label = new St.Label({
        text: f.name,
        style: 'color: white; padding-left: 10px;',
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      box.add_child(label);
      row.set_child(box);
      row.connect('clicked', () => this._open(f));
      row.connect('notify::hover', () => {
        row.style = row.hover ? LIST_ROW_STYLE + HOVER : LIST_ROW_STYLE;
      });
      return row;
    }

    // Buttons stay clickable while the panel shrinks away after close();
    // by then the dock reference is gone, so activation is ignored.
    _open(f) {
      if (this._closed) return;
      this.dock._maybeBounce(this._target);
      this._spawn(openCommand(f, this._fileExplorer));
    }

    _spawn(cmd) {
      if (this._closed) return;
      this.close();
      trySpawnCommandLine(cmd).catch((err) => console.log(err));
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      if (this.dock?._stackPanel === this) {
        this.dock._stackPanel = null;
        // the dock stayed up for the panel; let autohide decide again
        this.dock.autohider?._debounceCheckHide?.();
      }
      this.dock = null;
      if (this._grab) {
        Main.popModal(this._grab);
        this._grab = null;
      }
      // shrink back into the pointer; clicks already pass through
      this.reactive = false;
      this._popover.reactive = false;
      let destroyed = false;
      this.connect('destroy', () => (destroyed = true));
      this._popover.ease({
        scale_x: START_SCALE,
        scale_y: START_SCALE,
        opacity: 0,
        duration: CLOSE_MS,
        mode: Clutter.AnimationMode.EASE_IN_CUBIC,
        onStopped: () => {
          if (!destroyed) this.destroy();
        },
      });
    }
  }
);
