'use strict';

// Folder stack options (view / sort / display) and the macOS-style Grid and
// List panels a stack opens in when it is not shown as the classic fan.
// The panel is plain St widgets styled by CSS, so it renders on the GPU; its
// thumbnails come from the freedesktop cache through St.TextureCache (async).

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';
import St from 'gi://St';

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
    extension.animate?.({ refresh: true });
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

// A full-monitor transparent backdrop (a click outside closes, as in macOS)
// with the panel anchored over the stack's dock icon.
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
      this._panel = new St.BoxLayout({
        name: 'd2daStackPanel',
        orientation: Clutter.Orientation.VERTICAL,
        reactive: true,
        style:
          'background-color: rgba(40,40,46,0.72); border-radius: 18px;' +
          'border: 1px solid rgba(255,255,255,0.22); padding: 10px;' +
          'box-shadow: 0 8px 24px rgba(0,0,0,0.35);',
      });
      // clicks inside the panel do not reach the backdrop
      this._panel.connect('button-press-event', () => Clutter.EVENT_STOP);
      this.add_child(this._panel);

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
    }

    // above the icon for a bottom dock, beside it for side docks, below for top
    _place() {
      let [, , pw, ph] = this._panel.get_preferred_size();
      let [tx, ty] = this._target.get_transformed_position();
      let [tw, th] = this._target.get_transformed_size();
      let m = this.dock._monitor;
      let gap = 8;
      let x = tx + tw / 2 - pw / 2;
      let y = ty - ph - gap;
      switch (this.dock._position) {
        case 'top':
          y = ty + th + gap;
          break;
        case 'left':
          x = tx + tw + gap;
          y = ty + th / 2 - ph / 2;
          break;
        case 'right':
          x = tx - pw - gap;
          y = ty + th / 2 - ph / 2;
          break;
      }
      x = Math.max(m.x + gap, Math.min(x, m.x + m.width - pw - gap));
      y = Math.max(m.y + gap, Math.min(y, m.y + m.height - ph - gap));
      this._panel.set_position(Math.round(x - m.x), Math.round(y - m.y));
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

    _open(f) {
      this.dock._maybeBounce(this._target);
      this._spawn(openCommand(f, this._fileExplorer));
    }

    _spawn(cmd) {
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
      this.destroy();
    }
  }
);
