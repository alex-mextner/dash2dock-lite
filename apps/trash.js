'use strict';

// Glass Trash (trash-style = 1): the dock's Trash item shows a frosted bin
// with the Trash's real contents inside; apps/trash-render.js draws it.
//
// Cost model, by design:
// * the picture is redrawn only when the Trash changes (services.js debounces
//   the trash:/// monitor), in a separate gjs process, so thumbnail decoding
//   and Cairo never run on the compositor's main loop;
// * it arrives as PNG bytes wrapped in a Gio.BytesIcon, which the dock's
//   renderer shows like any other icon texture (St decodes it off the main
//   thread). Nothing is drawn, decoded or allocated per frame and no GPU pixels
//   are read back;
// * a BytesIcon (unlike a FileIcon) has no string form, so St's texture cache
//   does not pin every old picture forever, and no temp files are left behind.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// drawn once at a size that stays sharp when the dock magnifies the icon
const PICTURE_SIZE = 256;

export const GlassTrash = class {
  constructor(extensionPath, onChanged) {
    this._argv = [
      GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs',
      '-m',
      GLib.build_filenamev([extensionPath, 'apps', 'trash-render.js']),
      `${PICTURE_SIZE}`,
    ];
    this._onChanged = onChanged;
    this._cancellable = new Gio.Cancellable();
    this._proc = null;
    this._dirty = false;
    this.gicon = null;
  }

  // a request while a picture is being drawn draws once more afterwards, so
  // the last Trash state always wins
  render() {
    if (!this._cancellable) return;
    if (this._proc) {
      this._dirty = true;
      return;
    }
    this._dirty = false;
    try {
      this._proc = Gio.Subprocess.new(
        this._argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
      );
    } catch (e) {
      console.error('d2da: glass trash', e);
      return;
    }
    this._proc.communicate_async(null, this._cancellable, (proc, res) => {
      let png = null;
      try {
        let [, stdout] = proc.communicate_finish(res);
        if (proc.get_successful() && stdout && stdout.get_size() > 0) {
          png = stdout;
        }
      } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
          console.error('d2da: glass trash', e);
        }
      }
      if (this._proc === proc) this._proc = null;
      if (!this._cancellable) return;
      if (png) {
        this.gicon = Gio.BytesIcon.new(png);
        this._onChanged?.();
      }
      if (this._dirty) this.render();
    });
  }

  destroy() {
    this._cancellable?.cancel();
    this._cancellable = null;
    this._proc?.force_exit();
    this._proc = null;
    this._onChanged = null;
    this.gicon = null;
  }
};
