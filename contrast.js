/* contrast.js
 *
 * Adaptive contrast for the dock's symbolic marks (Apps grid icon,
 * separators, running dots): light marks over a dark backdrop, dark marks
 * over a light one, the way macOS keeps its dock glyphs legible.
 *
 * The backdrop tone comes from the wallpaper file, not from the screen.
 * Reading pixels back from the GPU would stall the compositor, and the glass
 * shows the blurred wallpaper by default anyway. The image is decoded once per
 * wallpaper change, at thumbnail size, in GdkPixbuf's worker thread; dock
 * moves and monitor changes re-sample the cached thumbnail (a few hundred
 * reads on the main loop). Nothing here runs during animation frames.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Decoded size of the wallpaper. Blur already averages the backdrop, so only
// the strip's mean matters; 256 px keeps the copy ~100 KB even for 4K images.
const THUMB_WIDTH = 256;
const SAMPLES_X = 48;
const SAMPLES_Y = 12;

// picture-uri and picture-uri-dark are usually written together; settle
// before loading so one change decodes once.
const SETTLE_MS = 200;

// Monitor strip behind the dock as fractions (x0, y0, x1, y1). Fixed rather
// than the dock's live bounds: those change with every magnification frame,
// and a centred strip about the dock's resting size gives the same mean.
const DOCK_STRIPS = {
  bottom: [0.3, 0.9, 0.7, 1.0],
  top: [0.3, 0.0, 0.7, 0.1],
  left: [0.0, 0.25, 0.06, 0.75],
  right: [0.94, 0.25, 1.0, 0.75],
};

// Relative luminance where marks flip from light to dark. WCAG 2's crossover
// (0.18) would put black glyphs on mid-tones, where macOS keeps them white;
// the APCA flip point (~0.36) matches that: only clearly light backdrops get
// dark marks.
const FLIP_LUMINANCE = 0.36;

const LIGHT_MARK = Object.freeze([1, 1, 1, 0.9]);
const DARK_MARK = Object.freeze([0, 0, 0, 0.7]);

function linear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function parseHexColor(s) {
  let m = /^#?([0-9a-f]{6})$/i.exec(s ?? '');
  if (m) {
    let v = parseInt(m[1], 16);
    return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  m = /^#?([0-9a-f]{3})$/i.exec(s ?? '');
  if (m) {
    return [...m[1]].map((h) => parseInt(h + h, 16) / 255);
  }
  return [0, 0, 0];
}

/**
 * Mark colours for a backdrop.
 *
 * The dock background (glass tint or plain background-color) is composited
 * over the wallpaper in sRGB space, as the glass shader and Clutter blend, so
 * the tint is mixed the same way before taking luminance.
 *
 * @param {number[]} rgb mean sRGB colour of the wallpaper strip (0..1)
 * @param {number[]} tint dock background-color rgba (0..1)
 * @param {number} separatorAlpha separator-color alpha: the hairline's
 *   strength is a style choice, so only its colour adapts
 * @returns {{luminance: number, light: boolean, icon: number[],
 *   indicator: number[], separator: number[]}}
 */
export function markColors(rgb, tint, separatorAlpha) {
  const a = tint?.[3] ?? 0;
  const mix = (i) => rgb[i] * (1 - a) + (tint?.[i] ?? 0) * a;
  const luminance =
    0.2126 * linear(mix(0)) + 0.7152 * linear(mix(1)) + 0.0722 * linear(mix(2));
  const light = luminance < FLIP_LUMINANCE;
  const mark = light ? LIGHT_MARK : DARK_MARK;
  const v = light ? 1 : 0;
  return {
    luminance,
    light,
    icon: mark,
    indicator: mark,
    separator: [v, v, v, separatorAlpha ?? mark[3]],
  };
}

/**
 * Mean colour of the wallpaper behind the dock on the primary monitor.
 * `rgb` is null until the wallpaper has been read, or when it cannot be
 * (XML slideshows, unsupported formats, missing files): callers then keep
 * their fixed colours.
 */
export class WallpaperTone {
  constructor(onChanged) {
    this._onChanged = onChanged;
    this._position = 'bottom';
    this._thumb = null;
    this._cancellable = null;
    this._settleId = 0;
    this.rgb = null;

    this._bgSettings = new Gio.Settings({
      schema_id: 'org.gnome.desktop.background',
    });
    this._interfaceSettings = new Gio.Settings({
      schema_id: 'org.gnome.desktop.interface',
    });
    const reload = () => this._queueLoad();
    this._bgSettings.connectObject(
      'changed::picture-uri', reload,
      'changed::picture-uri-dark', reload,
      'changed::picture-options', reload,
      'changed::primary-color', reload,
      this
    );
    this._interfaceSettings.connectObject(
      'changed::color-scheme', reload,
      this
    );
    Main.layoutManager.connectObject(
      'monitors-changed', () => this._resample(),
      this
    );

    this._load();
  }

  destroy() {
    this._onChanged = null;
    if (this._settleId) {
      GLib.source_remove(this._settleId);
      this._settleId = 0;
    }
    this._cancellable?.cancel();
    this._cancellable = null;
    this._bgSettings.disconnectObject(this);
    this._interfaceSettings.disconnectObject(this);
    Main.layoutManager.disconnectObject(this);
    this._bgSettings = null;
    this._interfaceSettings = null;
    this._thumb = null;
    this.rgb = null;
  }

  setPosition(position) {
    if (!DOCK_STRIPS[position] || position === this._position) return;
    this._position = position;
    this._resample();
  }

  _queueLoad() {
    if (this._settleId) {
      GLib.source_remove(this._settleId);
    }
    this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
      this._settleId = 0;
      this._load();
      return GLib.SOURCE_REMOVE;
    });
  }

  // Same choice as the Shell's BackgroundSource: the dark picture only when
  // the interface asks for prefer-dark.
  _currentUri() {
    const dark =
      this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
    return this._bgSettings.get_string(dark ? 'picture-uri-dark' : 'picture-uri');
  }

  _load() {
    this._cancellable?.cancel();
    this._cancellable = null;

    const style = this._bgSettings.get_string('picture-options');
    this._primary = parseHexColor(this._bgSettings.get_string('primary-color'));
    this._style = style;

    if (style === 'none') {
      // the background is just primary-color
      this._thumb = { none: true };
      this._resample();
      return;
    }

    const file = Gio.File.new_for_commandline_arg(this._currentUri());
    const path = file.get_path();
    if (!path || path.toLowerCase().endsWith('.xml')) {
      this._fail(null);
      return;
    }

    const cancellable = new Gio.Cancellable();
    this._cancellable = cancellable;
    // The original size only matters for 'centered' and 'wallpaper' (tiled),
    // where one image pixel is one screen pixel; reading it is a header parse
    // in GdkPixbuf's worker thread.
    GdkPixbuf.Pixbuf.get_file_info_async(path, cancellable, (_s, infoRes) => {
      let width, height;
      try {
        [, width, height] = GdkPixbuf.Pixbuf.get_file_info_finish(infoRes);
      } catch (err) {
        this._fail(err);
        return;
      }
      if (cancellable.is_cancelled()) return;
      file.read_async(GLib.PRIORITY_LOW, cancellable, (_f, readRes) => {
        let stream;
        try {
          stream = file.read_finish(readRes);
        } catch (err) {
          this._fail(err);
          return;
        }
        // decodes (and, for JPEG, scales while decoding) off the main loop
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
          stream,
          THUMB_WIDTH,
          -1,
          true,
          cancellable,
          (_p, pixRes) => {
            let pixbuf;
            try {
              pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(pixRes);
            } catch (err) {
              this._fail(err);
              return;
            } finally {
              stream.close_async(GLib.PRIORITY_LOW, null, null);
            }
            if (cancellable.is_cancelled() || !this._onChanged) return;
            this._cancellable = null;
            this._thumb = {
              pixels: pixbuf.get_pixels(),
              w: pixbuf.get_width(),
              h: pixbuf.get_height(),
              stride: pixbuf.get_rowstride(),
              channels: pixbuf.get_n_channels(),
              alpha: pixbuf.get_has_alpha(),
              width: width || pixbuf.get_width(),
              height: height || pixbuf.get_height(),
            };
            this._resample();
          }
        );
      });
    });
  }

  _fail(err) {
    if (err?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
    if (!this._onChanged) return;
    if (err) {
      console.log(`d2da: adaptive contrast: wallpaper unreadable: ${err.message}`);
    }
    this._cancellable = null;
    this._thumb = null;
    this._resample();
  }

  // Maps the dock strip on the primary monitor into the thumbnail the way
  // picture-options lays the image out, and averages it.
  _resample() {
    if (!this._onChanged) return;
    const rgb = this._sample();
    const old = this.rgb;
    if (
      old === rgb ||
      (old && rgb && old[0] === rgb[0] && old[1] === rgb[1] && old[2] === rgb[2])
    ) {
      return;
    }
    this.rgb = rgb;
    this._onChanged(rgb);
  }

  _sample() {
    const t = this._thumb;
    const monitor = Main.layoutManager.primaryMonitor;
    if (!t || !monitor) return null;
    const primary = this._primary;
    if (t.none) return primary.slice();

    // device pixels: what 'centered' and tiled layouts are measured in
    const scale = monitor.geometry_scale || 1;
    const mw = monitor.width * scale;
    const mh = monitor.height * scale;
    const W = t.width;
    const H = t.height;

    let kx = 1;
    let ky = 1;
    switch (this._style) {
      case 'scaled':
        kx = ky = Math.min(mw / W, mh / H);
        break;
      case 'stretched':
        kx = mw / W;
        ky = mh / H;
        break;
      case 'centered':
      case 'wallpaper':
        break;
      default:
        // 'zoom'; 'spanned' too (approximated: it zooms across all monitors)
        kx = ky = Math.max(mw / W, mh / H);
        break;
    }
    const tiled = this._style === 'wallpaper';
    const offX = tiled ? 0 : (mw - W * kx) / 2;
    const offY = tiled ? 0 : (mh - H * ky) / 2;
    const toThumbX = t.w / W;
    const toThumbY = t.h / H;

    const [fx0, fy0, fx1, fy1] = DOCK_STRIPS[this._position];
    const px = t.pixels;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let j = 0; j < SAMPLES_Y; j++) {
      const my = (fy0 + ((fy1 - fy0) * (j + 0.5)) / SAMPLES_Y) * mh;
      for (let i = 0; i < SAMPLES_X; i++) {
        const mx = (fx0 + ((fx1 - fx0) * (i + 0.5)) / SAMPLES_X) * mw;
        let ix = (mx - offX) / kx;
        let iy = (my - offY) / ky;
        if (tiled) {
          ix %= W;
          iy %= H;
        }
        if (ix < 0 || iy < 0 || ix >= W || iy >= H) {
          // letterbox / around a centred image: the background colour shows
          r += primary[0];
          g += primary[1];
          b += primary[2];
          continue;
        }
        const tx = Math.min(t.w - 1, Math.floor(ix * toThumbX));
        const ty = Math.min(t.h - 1, Math.floor(iy * toThumbY));
        const o = ty * t.stride + tx * t.channels;
        // translucent wallpapers are drawn over primary-color
        const a = t.alpha ? px[o + 3] / 255 : 1;
        r += (px[o] / 255) * a + primary[0] * (1 - a);
        g += (px[o + 1] / 255) * a + primary[1] * (1 - a);
        b += (px[o + 2] / 255) * a + primary[2] * (1 - a);
      }
    }
    const n = SAMPLES_X * SAMPLES_Y;
    return [r / n, g / n, b / n];
  }
}
