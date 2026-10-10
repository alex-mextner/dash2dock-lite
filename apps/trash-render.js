#!/usr/bin/env -S gjs -m
'use strict';

// Glass Trash picture (trash-style = 1): a macOS 26 style frosted, translucent
// bin with the Trash's real contents inside, written as a PNG to stdout.
//
// What the picture shows:
// * fill level: how many items the Trash holds, on a log scale (full at ~50);
// * the newest few items on top of the pile: pictures, videos and PDFs as
//   their real thumbnails (freedesktop thumbnail cache, else a small scaled
//   decode for images), everything else as a card coloured by its type;
// * the pile under them coloured by the type mix of all the other items.
//
// Why a separate process: thumbnails must be decoded and composited, which
// needs GdkPixbuf + Cairo + Gdk.cairo_set_source_pixbuf. Doing that inside
// gnome-shell would stall the compositor's main loop and drag GTK's Gdk into
// it. The shell (apps/trash.js) runs this only when the Trash changes and
// shows the PNG as an ordinary icon texture, so drawing the dock costs nothing
// extra per frame.
//
// usage: gjs -m trash-render.js <size-px>

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const FULL_AT = 50; // item count drawn as a full bin
const TOP_CARDS = 5; // newest items drawn as recognisable cards
const MAX_FILLER = 36; // pile cards under them; more adds nothing at icon size
// no thumbnail: decode pictures up to this size, show bigger ones as a card
const MAX_DECODE_BYTES = 64 * 1024 * 1024;
const THUMB_DIRS = ['xx-large', 'x-large', 'large', 'normal'];
const ATTRS = [
  'standard::name',
  'standard::type',
  'standard::content-type',
  'standard::target-uri',
  'standard::size',
  'trash::deletion-date',
  'trash::orig-path',
].join(',');

const ARCHIVE_RE = new RegExp(
  'zip|x-tar|compressed|gzip|bzip|x-xz|zstd|x-7z|rar|x-cpio|x-lzma|x-lzip|' +
    'x-deb|x-rpm|x-archive|x-iso9660|x-apple-diskimage'
);

// card colours per type family: [main, accent]
const COLORS = {
  folder: [[0.42, 0.72, 0.96], [0.3, 0.6, 0.9]],
  image: [[0.86, 0.92, 0.98], [0.36, 0.7, 0.38]],
  video: [[0.17, 0.18, 0.22], [1, 1, 1]],
  audio: [[1.0, 0.37, 0.54], [0.98, 0.18, 0.3]],
  archive: [[0.86, 0.66, 0.38], [0.55, 0.38, 0.18]],
  pdf: [[0.98, 0.98, 0.98], [0.9, 0.24, 0.24]],
  sheet: [[0.98, 0.98, 0.98], [0.2, 0.66, 0.36]],
  slides: [[0.98, 0.98, 0.98], [0.96, 0.55, 0.16]],
  doc: [[0.98, 0.98, 0.98], [0.3, 0.52, 0.92]],
  other: [[0.9, 0.9, 0.92], [0.55, 0.56, 0.6]],
};

function familyOf(info) {
  if (info.get_file_type() === Gio.FileType.DIRECTORY) return 'folder';
  let t = info.get_content_type() ?? '';
  if (t === 'inode/directory') return 'folder';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (ARCHIVE_RE.test(t)) return 'archive';
  if (t === 'application/pdf') return 'pdf';
  if (/spreadsheet|excel|csv/.test(t)) return 'sheet';
  if (/presentation|powerpoint/.test(t)) return 'slides';
  if (
    t.startsWith('text/') ||
    /document|msword|rtf|epub|json|xml|x-tex|markdown/.test(t)
  ) {
    return 'doc';
  }
  return 'other';
}

// newest first; a trashed folder is one item, as in Finder
function listTrash() {
  let items = [];
  let enumerator = null;
  try {
    enumerator = Gio.File.new_for_uri('trash:///').enumerate_children(
      ATTRS,
      Gio.FileQueryInfoFlags.NONE,
      null
    );
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
      let date = info.get_deletion_date();
      items.push({
        info,
        name: info.get_name(),
        time: date ? date.to_unix() : 0,
        family: familyOf(info),
      });
    }
  } catch (e) {
    printerr(`trash-render: ${e.message}`);
  } finally {
    enumerator?.close(null);
  }
  items.sort((a, b) => b.time - a.time || (a.name < b.name ? -1 : 1));
  return items;
}

// freedesktop thumbnail of the trashed file, or of the file where it used to
// live (trashing keeps the mtime, so that thumbnail still matches)
function thumbnailPath(info) {
  let uris = [];
  let target = info.get_attribute_string('standard::target-uri');
  if (target) uris.push(target);
  let orig = info.get_attribute_byte_string('trash::orig-path');
  if (orig) uris.push(Gio.File.new_for_path(orig).get_uri());
  let cache = GLib.build_filenamev([GLib.get_user_cache_dir(), 'thumbnails']);
  for (let uri of uris) {
    let md5 = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, uri, -1);
    for (let dir of THUMB_DIRS) {
      let path = GLib.build_filenamev([cache, dir, `${md5}.png`]);
      if (GLib.file_test(path, GLib.FileTest.EXISTS)) return path;
    }
  }
  return null;
}

function loadPicture(item, px) {
  let path = thumbnailPath(item.info);
  if (!path && item.family === 'image') {
    let target = item.info.get_attribute_string('standard::target-uri');
    let local = target ? Gio.File.new_for_uri(target).get_path() : null;
    if (local && item.info.get_size() <= MAX_DECODE_BYTES) path = local;
  }
  if (!path) return null;
  try {
    let pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, px, px, true);
    return pixbuf.apply_embedded_orientation() ?? pixbuf;
  } catch {
    return null;
  }
}

// deterministic jitter: the same Trash always draws the same pile
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundedRect(cr, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  cr.newSubPath();
  cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
  cr.closePath();
}

function rgb(cr, c, a = 1) {
  cr.setSourceRGBA(c[0], c[1], c[2], a);
}

// card outline for the shadow pass, centred on the origin
function cardShape(cr, family, c, aspect) {
  let [w, h] = cardSize(family, c, aspect);
  roundedRect(cr, -w / 2, -h / 2, w, h, c * 0.07);
}

function cardSize(family, c, aspect) {
  if (aspect) {
    return aspect >= 1 ? [c, c / aspect] : [c * aspect, c];
  }
  switch (family) {
    case 'folder':
      return [c, c * 0.78];
    case 'video':
      return [c, c * 0.68];
    case 'audio':
      return [c * 0.86, c * 0.86];
    case 'archive':
      return [c * 0.8, c * 0.92];
    case 'image':
      return [c, c * 0.76];
    default:
      return [c * 0.76, c];
  }
}

function drawPicture(cr, pixbuf, w, h, r) {
  cr.save();
  roundedRect(cr, -w / 2, -h / 2, w, h, r);
  cr.clip();
  cr.translate(-w / 2, -h / 2);
  cr.scale(w / pixbuf.get_width(), h / pixbuf.get_height());
  Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
  cr.paint();
  cr.restore();
}

function drawPlay(cr, s) {
  cr.arc(0, 0, s, 0, 2 * Math.PI);
  cr.setSourceRGBA(0, 0, 0, 0.45);
  cr.fill();
  cr.moveTo(-s * 0.35, -s * 0.5);
  cr.lineTo(s * 0.55, 0);
  cr.lineTo(-s * 0.35, s * 0.5);
  cr.closePath();
  cr.setSourceRGBA(1, 1, 1, 0.95);
  cr.fill();
}

function drawPage(cr, family, w, h, c) {
  let [main, accent] = COLORS[family];
  let fold = w * 0.26;
  let x = -w / 2;
  let y = -h / 2;
  cr.moveTo(x, y + c * 0.05);
  cr.arc(x + c * 0.05, y + c * 0.05, c * 0.05, Math.PI, 1.5 * Math.PI);
  cr.lineTo(x + w - fold, y);
  cr.lineTo(x + w, y + fold);
  cr.lineTo(x + w, y + h - c * 0.05);
  cr.arc(x + w - c * 0.05, y + h - c * 0.05, c * 0.05, 0, Math.PI / 2);
  cr.arc(x + c * 0.05, y + h - c * 0.05, c * 0.05, Math.PI / 2, Math.PI);
  cr.closePath();
  rgb(cr, main);
  cr.fillPreserve();
  cr.setSourceRGBA(0, 0, 0, 0.18);
  cr.setLineWidth(c * 0.025);
  cr.stroke();
  // folded corner
  cr.moveTo(x + w - fold, y);
  cr.lineTo(x + w - fold, y + fold);
  cr.lineTo(x + w, y + fold);
  cr.closePath();
  cr.setSourceRGBA(0.82, 0.83, 0.86, 1);
  cr.fill();

  let ix = x + w * 0.16;
  let iw = w * 0.68;
  if (family === 'pdf') {
    roundedRect(cr, x + w * 0.1, y + h * 0.5, w * 0.8, h * 0.28, c * 0.03);
    rgb(cr, accent);
    cr.fill();
  } else if (family === 'sheet') {
    rgb(cr, accent);
    cr.rectangle(ix, y + h * 0.34, iw, h * 0.48);
    cr.fill();
    cr.setSourceRGBA(1, 1, 1, 0.9);
    cr.setLineWidth(c * 0.02);
    for (let i = 1; i < 4; i++) {
      cr.moveTo(ix, y + h * (0.34 + i * 0.12));
      cr.lineTo(ix + iw, y + h * (0.34 + i * 0.12));
    }
    cr.moveTo(ix + iw / 2, y + h * 0.34);
    cr.lineTo(ix + iw / 2, y + h * 0.82);
    cr.stroke();
    return;
  } else if (family === 'slides') {
    roundedRect(cr, ix, y + h * 0.36, iw, h * 0.34, c * 0.02);
    rgb(cr, accent);
    cr.fill();
  }
  // text lines: a full page of them for text, a caption for the others
  let text = family === 'doc' || family === 'other';
  rgb(cr, text ? accent : [0.6, 0.62, 0.66], 0.85);
  let lines = text ? 5 : 2;
  let top = text ? 0.34 : 0.2;
  if (family === 'slides') top = 0.76;
  for (let i = 0; i < lines; i++) {
    let lw = i === lines - 1 ? iw * 0.6 : iw;
    roundedRect(cr, ix, y + h * (top + i * 0.11), lw, h * 0.05, h * 0.025);
    cr.fill();
  }
}

function drawGlyphCard(cr, family, w, h, c) {
  let [main, accent] = COLORS[family];
  let x = -w / 2;
  let y = -h / 2;
  switch (family) {
    case 'folder': {
      // back with tab, then the front flap
      roundedRect(cr, x, y, w * 0.45, h * 0.3, c * 0.05);
      roundedRect(cr, x, y + h * 0.1, w, h * 0.9, c * 0.07);
      rgb(cr, accent);
      cr.fill();
      roundedRect(cr, x, y + h * 0.24, w, h * 0.76, c * 0.07);
      rgb(cr, main);
      cr.fill();
      return;
    }
    case 'image': {
      roundedRect(cr, x, y, w, h, c * 0.07);
      rgb(cr, main);
      cr.fill();
      cr.arc(x + w * 0.72, y + h * 0.3, h * 0.12, 0, 2 * Math.PI);
      cr.setSourceRGBA(1, 0.78, 0.2, 1);
      cr.fill();
      cr.moveTo(x, y + h);
      cr.lineTo(x + w * 0.35, y + h * 0.42);
      cr.lineTo(x + w * 0.6, y + h * 0.75);
      cr.lineTo(x + w * 0.75, y + h * 0.58);
      cr.lineTo(x + w, y + h * 0.9);
      cr.lineTo(x + w, y + h);
      cr.closePath();
      rgb(cr, accent);
      cr.fill();
      return;
    }
    case 'video': {
      roundedRect(cr, x, y, w, h, c * 0.07);
      rgb(cr, main);
      cr.fill();
      cr.setSourceRGBA(1, 1, 1, 0.55);
      for (let i = 0; i < 6; i++) {
        let px = x + w * (0.08 + i * 0.16);
        cr.rectangle(px, y + h * 0.06, w * 0.07, h * 0.08);
        cr.rectangle(px, y + h * 0.86, w * 0.07, h * 0.08);
      }
      cr.fill();
      drawPlay(cr, h * 0.24);
      return;
    }
    case 'audio': {
      let g = new Cairo.LinearGradient(0, y, 0, y + h);
      g.addColorStopRGBA(0, main[0], main[1], main[2], 1);
      g.addColorStopRGBA(1, accent[0], accent[1], accent[2], 1);
      roundedRect(cr, x, y, w, h, c * 0.16);
      cr.setSource(g);
      cr.fill();
      // two beamed eighth notes
      cr.setSourceRGBA(1, 1, 1, 1);
      cr.arc(x + w * 0.33, y + h * 0.7, w * 0.1, 0, 2 * Math.PI);
      cr.arc(x + w * 0.68, y + h * 0.63, w * 0.1, 0, 2 * Math.PI);
      cr.fill();
      cr.setLineWidth(w * 0.07);
      cr.moveTo(x + w * 0.41, y + h * 0.7);
      cr.lineTo(x + w * 0.41, y + h * 0.28);
      cr.lineTo(x + w * 0.76, y + h * 0.21);
      cr.lineTo(x + w * 0.76, y + h * 0.63);
      cr.stroke();
      return;
    }
    case 'archive': {
      roundedRect(cr, x, y, w, h, c * 0.07);
      rgb(cr, main);
      cr.fill();
      rgb(cr, accent);
      cr.rectangle(-w * 0.07, y, w * 0.14, h * 0.62);
      cr.fill();
      cr.setSourceRGBA(1, 1, 1, 0.75);
      for (let i = 0; i < 5; i++) {
        let zx = i % 2 ? 0 : -w * 0.07;
        cr.rectangle(zx, y + h * (0.04 + i * 0.11), w * 0.07, h * 0.06);
      }
      cr.fill();
      roundedRect(cr, -w * 0.11, y + h * 0.6, w * 0.22, h * 0.16, c * 0.03);
      rgb(cr, accent);
      cr.fill();
      return;
    }
    default:
      drawPage(cr, family, w, h, c);
  }
}

// one item, centred on the origin, `c` = card size
function drawCard(cr, item, c, angle, pixbuf, detailed) {
  let aspect = pixbuf ? pixbuf.get_width() / pixbuf.get_height() : 0;
  let [w, h] = cardSize(item.family, c, aspect);
  cr.save();
  cr.rotate(angle);

  // soft drop shadow so cards stay apart from each other and the glass
  cr.save();
  cr.translate(c * 0.02, c * 0.05);
  for (let i = 3; i >= 1; i--) {
    cardShape(cr, item.family, c + c * 0.03 * i, aspect);
    cr.setSourceRGBA(0, 0, 0, detailed ? 0.07 : 0.05);
    cr.fill();
  }
  cr.restore();

  if (pixbuf) {
    // a photo print: white border round the real thumbnail
    let b = c * 0.05;
    roundedRect(cr, -w / 2 - b, -h / 2 - b, w + 2 * b, h + 2 * b, c * 0.08);
    cr.setSourceRGBA(0.99, 0.99, 0.99, 1);
    cr.fill();
    drawPicture(cr, pixbuf, w, h, c * 0.04);
    if (item.family === 'video') drawPlay(cr, Math.min(w, h) * 0.22);
  } else {
    drawGlyphCard(cr, item.family, w, h, c);
  }
  cr.restore();
}

function drawTrash(items, S) {
  let surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, S, S);
  let cr = new Cairo.Context(surface);

  let cx = S / 2;
  // proportions of the macOS 26 bin, filling the icon like theme icons do
  let rim = {
    top: 0.075 * S,
    bottom: 0.185 * S,
    half: 0.405 * S,
    r: 0.055 * S,
  };
  let body = {
    top: 0.13 * S,
    bottom: 0.945 * S,
    topHalf: 0.385 * S,
    botHalf: 0.31 * S,
    r: 0.085 * S,
  };
  let halfAt = (y) =>
    body.topHalf +
    ((body.botHalf - body.topHalf) * (y - body.top)) / (body.bottom - body.top);

  let bodyPath = () => {
    let { top, bottom, topHalf, botHalf, r } = body;
    cr.newPath();
    cr.moveTo(cx - topHalf, top);
    cr.lineTo(cx + topHalf, top);
    cr.lineTo(cx + halfAt(bottom - r), bottom - r);
    let rx = cx + botHalf;
    cr.curveTo(rx, bottom - r * 0.2, rx - r * 0.2, bottom, rx - r, bottom);
    cr.lineTo(cx - botHalf + r, bottom);
    let lx = cx - botHalf;
    let ly = bottom - r;
    cr.curveTo(lx + r * 0.2, bottom, lx, ly + r * 0.8, cx - halfAt(ly), ly);
    cr.closePath();
  };
  let rimPath = (inset) =>
    roundedRect(
      cr,
      cx - rim.half + inset,
      rim.top + inset,
      2 * (rim.half - inset),
      rim.bottom - rim.top - 2 * inset,
      rim.r - inset * 0.5
    );

  // contact shadow on the dock
  cr.save();
  cr.translate(cx, body.bottom);
  cr.scale(1, 0.13);
  let shadow = new Cairo.RadialGradient(0, 0, 0, 0, 0, body.botHalf * 1.25);
  shadow.addColorStopRGBA(0, 0, 0, 0, 0.22);
  shadow.addColorStopRGBA(1, 0, 0, 0, 0);
  cr.setSource(shadow);
  cr.arc(0, 0, body.botHalf * 1.25, 0, 2 * Math.PI);
  cr.fill();
  cr.restore();

  // back wall, seen through the front glass
  bodyPath();
  cr.setSourceRGBA(1, 1, 1, 0.1);
  cr.fill();

  // the opening: inside of the bin, darker towards the back rim
  rimPath(0);
  let inside = new Cairo.LinearGradient(0, rim.top, 0, rim.bottom);
  inside.addColorStopRGBA(0, 0.55, 0.57, 0.62, 0.55);
  inside.addColorStopRGBA(1, 0.88, 0.89, 0.92, 0.45);
  cr.setSource(inside);
  cr.fill();

  // contents, clipped to the inside of the bin
  let n = items.length;
  if (n > 0) {
    cr.save();
    bodyPath();
    rimPath(S * 0.012);
    cr.setFillRule(Cairo.FillRule.WINDING);
    cr.clip();

    let floor = body.bottom - 0.035 * S;
    let level = 0.22 + (0.78 * Math.log1p(n)) / Math.log1p(FULL_AT);
    level = Math.min(1, level);
    let pileTop = floor - level * (floor - (rim.top + 0.03 * S));
    let rand = rng(hashString(`${n}:${items[0].name}`));

    // the pile: one paper card per older item, coloured by its type
    let shown = Math.min(n, TOP_CARDS);
    let rest = items.slice(shown, shown + MAX_FILLER);
    if (rest.length) {
      let mass = new Cairo.LinearGradient(0, pileTop, 0, floor);
      mass.addColorStopRGBA(0, 0.96, 0.95, 0.92, 0.0);
      mass.addColorStopRGBA(0.25, 0.96, 0.95, 0.92, 0.55);
      mass.addColorStopRGBA(1, 0.92, 0.91, 0.88, 0.75);
      cr.setSource(mass);
      cr.rectangle(0, pileTop, S, floor - pileTop + 0.05 * S);
      cr.fill();
      let fc = 0.2 * S;
      // the oldest at the bottom of the pile, filling it evenly
      rest
        .slice()
        .reverse()
        .forEach((item, i, all) => {
          let t = all.length > 1 ? i / (all.length - 1) : 0;
          let y =
            floor -
            fc * 0.2 -
            t * (floor - pileTop - fc * 0.55) +
            (rand() - 0.5) * fc * 0.35;
          let span = halfAt(y) - fc * 0.3;
          let x = cx + (rand() * 2 - 1) * span;
          cr.save();
          cr.translate(x, y);
          let size = fc * (0.85 + rand() * 0.3);
          drawCard(cr, item, size, (rand() - 0.5) * 1.6, null, false);
          cr.restore();
        });
    }

    // the newest items on top, oldest of them drawn first
    let c = (n === 1 ? 0.44 : n <= 3 ? 0.36 : 0.31) * S;
    let slots = [
      [0.0, 0.22, 0.12],
      [-0.5, 0.4, -0.26],
      [0.5, 0.36, 0.22],
      [-0.2, 0.72, 0.16],
      [0.3, 0.8, -0.12],
    ];
    for (let i = shown - 1; i >= 0; i--) {
      let item = items[i];
      let [sx, sy, sa] = slots[i];
      let y = Math.min(pileTop + sy * c, floor - c * 0.36);
      let x = cx + sx * (halfAt(y) - c * 0.42);
      let angle = sa + (rand() - 0.5) * 0.18;
      let pixbuf = loadPicture(item, Math.ceil(c * 1.5));
      cr.save();
      cr.translate(x, y);
      drawCard(cr, item, c, angle, pixbuf, true);
      cr.restore();
    }
    cr.restore();
  }

  // front glass: frosted, a little denser towards the bottom
  bodyPath();
  let frost = new Cairo.LinearGradient(0, body.top, 0, body.bottom);
  frost.addColorStopRGBA(0, 1, 1, 1, 0.24);
  frost.addColorStopRGBA(0.6, 1, 1, 1, 0.34);
  frost.addColorStopRGBA(1, 1, 1, 1, 0.56);
  cr.setSource(frost);
  cr.fillPreserve();
  // curved sides: slightly grey edges, a bright sheen left of centre
  let side = new Cairo.LinearGradient(
    cx - body.topHalf,
    0,
    cx + body.topHalf,
    0
  );
  side.addColorStopRGBA(0, 0.45, 0.48, 0.54, 0.22);
  side.addColorStopRGBA(0.1, 1, 1, 1, 0.0);
  side.addColorStopRGBA(0.22, 1, 1, 1, 0.16);
  side.addColorStopRGBA(0.34, 1, 1, 1, 0.0);
  side.addColorStopRGBA(0.88, 1, 1, 1, 0.0);
  side.addColorStopRGBA(1, 0.45, 0.48, 0.54, 0.24);
  cr.setSource(side);
  cr.fill();

  // outline: a faint dark edge so it reads on light backdrops, then the
  // bright glass edge on top
  bodyPath();
  cr.setLineWidth(0.03 * S);
  cr.setSourceRGBA(0, 0, 0, 0.1);
  cr.strokePreserve();
  cr.setLineWidth(0.014 * S);
  cr.setSourceRGBA(1, 1, 1, 0.6);
  cr.stroke();

  // rim: one solid bright lip, like the dock's glass rim
  rimPath(0);
  cr.setLineWidth(0.02 * S);
  cr.setSourceRGBA(0, 0, 0, 0.12);
  cr.stroke();
  rimPath(0);
  rimPath(0.03 * S);
  cr.setFillRule(Cairo.FillRule.EVEN_ODD);
  let lip = new Cairo.LinearGradient(0, rim.top, 0, rim.bottom);
  lip.addColorStopRGBA(0, 1, 1, 1, 0.98);
  lip.addColorStopRGBA(0.5, 0.93, 0.94, 0.96, 0.92);
  lip.addColorStopRGBA(1, 1, 1, 1, 0.98);
  cr.setSource(lip);
  cr.fill();
  cr.setFillRule(Cairo.FillRule.WINDING);
  // the lip's inner edge casts a little shade into the opening
  rimPath(0.03 * S);
  cr.setLineWidth(0.008 * S);
  cr.setSourceRGBA(0.3, 0.32, 0.38, 0.35);
  cr.stroke();

  return surface;
}

let size = parseInt(ARGV[0] ?? '256', 10);
if (!(size >= 16 && size <= 1024)) size = 256;

let surface = drawTrash(listTrash(), size);
// cairo writes straight into the pipe the shell reads
surface.writeToPNG('/dev/stdout');
System.exit(0);
