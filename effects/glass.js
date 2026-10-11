'use strict';

// Liquid Glass dock platter (macOS 26 "Tahoe" look) for GNOME Shell 50.
//
// The platter renders its own backdrop instead of using the obvious
// Shell.BlurEffect in BACKGROUND mode:
//
// * BACKGROUND mode blurs whatever is already in the current framebuffer. The
//   dock is offscreen-redirected (dock.js), so that framebuffer is the dock's
//   own offscreen, which holds nothing of the desktop: the blur comes out
//   empty. GNOME 50's BlurEffect also has no corner radius.
// * So the platter holds clones of what lies behind the dock, blurs them with
//   Shell.BlurEffect in ACTOR mode (cached until the clones change) and draws
//   the result through one GLSL pass (GlassEffect): rounded shape, edge lens
//   with a slight colour split, tint, specular rims and a soft drop shadow.
// * A Clutter.Clone of global.window_group paints nothing: MetaWindowGroup is
//   allocated 0x0, so the clone's scale is size / 0. WindowGroupMirror clones
//   the group's children instead, and only those near the dock, so windows
//   elsewhere on screen do not invalidate the blur.
// * The folder stack panel (stackPanel.js) is the same platter with a popover
//   pointer: a triangle merged into the SDF (setNotch), so its outline, rim
//   and shadow are one shape; without the glass material it runs with no
//   backdrop, as a flat translucent platter.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DECLARATIONS = `
uniform sampler2D tex;
uniform vec2  size;        // platter size, px; the texture covers it exactly
uniform vec4  rect;        // the glass inside the platter: x, y, w, h (px)
uniform float radius;      // corner radius, px
uniform float bezel;       // width of the refracting edge band, px
uniform float refraction;  // edge displacement, px
uniform float chroma;      // colour split at the edge, px
uniform float rim;         // specular rim strength
uniform vec4  tint;        // rgb + amount
uniform float shadow;      // drop shadow alpha
uniform float scale;       // device pixels per logical pixel
uniform vec4  notch;       // pointer tip (px) and unit direction tip -> glass
uniform vec2  notchSize;   // pointer half base width and depth, px; 0 = none

float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Isosceles triangle, apex at the origin, base (half width q.x) at y = q.y.
float sdTriangle(vec2 p, vec2 q) {
    p.x = abs(p.x);
    vec2 a = p - q * clamp(dot(p, q) / dot(q, q), 0.0, 1.0);
    vec2 b = p - q * vec2(clamp(p.x / q.x, 0.0, 1.0), 1.0);
    float s = -sign(q.y);
    vec2 d = min(vec2(dot(a, a), s * (p.x * q.y - p.y * q.x)),
                 vec2(dot(b, b), s * (p.y - q.y)));
    return -sqrt(d.x) * sign(d.y);
}

// The glass outline, p relative to the rect centre: the rounded rect, plus
// the popover pointer when notchSize is set. The pointer runs on into the
// rect so the two merge, with a smooth union filleting the joints and a
// rounded apex that still ends on the tip.
float shape(vec2 p, vec2 hb, float r) {
    float d = sdRoundBox(p, hb, r);
    if (notchSize.y <= 0.0) return d;
    vec2 t = p + rect.xy + hb - notch.xy;
    vec2 u = notch.zw;
    vec2 l = vec2(dot(t, vec2(-u.y, u.x)), dot(t, u));
    vec2 q = notchSize * 2.0;
    float tipR = 1.5 * scale;
    float lift = tipR * length(notchSize) / notchSize.x;
    float dt = sdTriangle(l - vec2(0.0, lift), q) - tipR;
    float k = notchSize.y * 0.6;
    float h = clamp(0.5 + 0.5 * (dt - d) / k, 0.0, 1.0);
    return mix(dt, d, h) - k * h * (1.0 - h);
}
`;

const CODE = `
vec2 px = cogl_tex_coord_in[0].st * size;
vec2 hb = rect.zw * 0.5;
vec2 p = px - (rect.xy + hb);
float r = min(radius, min(hb.x, hb.y));
float d = shape(p, hb, r);                             // < 0 inside the glass
float cover = clamp(0.5 - d, 0.0, 1.0);                // 1px anti-aliased edge

// Outward normal from the SDF gradient. The lens follows the rounded rect
// alone: a pointer has no room for a bezel, and its sharp sides would split
// the refraction along seams. Inside the pointer the rect's edge refraction
// just carries on.
float dl = sdRoundBox(p, hb, r);
vec2 e = vec2(0.5, 0.0);
vec2 n = vec2(sdRoundBox(p + e.xy, hb, r) - sdRoundBox(p - e.xy, hb, r),
              sdRoundBox(p + e.yx, hb, r) - sdRoundBox(p - e.yx, hb, r));
n = n / max(length(n), 1e-4);

// Convex bezel: flat in the middle, bending harder towards the rim. Sampling
// inward compresses the backdrop into the edge, as a thick lens does.
float t = clamp(1.0 + dl / max(bezel, 1.0), 0.0, 1.0);
float lens = t * t * t;
vec2 uv = (px - n * lens * refraction) / size;
vec2 ca = n * lens * chroma / size;
vec4 g = texture2D(tex, uv);
vec4 bg = vec4(texture2D(tex, uv + ca).r, g.g, texture2D(tex, uv - ca).b, g.a);

// All colours are premultiplied. Where there is no backdrop (overview), the
// glass falls back to a translucent tinted platter.
vec4 col = bg * (1.0 - tint.a) + vec4(tint.rgb, 1.0) * tint.a;

// Specular rims, lit from above: a bright 1px line along the top edge, a
// fainter one along the bottom, dimmer still on the sides, and a faint glow
// fading in from the top edge.
float lineWidth = 1.25 * max(scale, 1.0);
float line = 1.0 - smoothstep(0.0, lineWidth, -d);
float top = pow(max(-n.y, 0.0), 1.5);
float bottom = pow(max(n.y, 0.0), 2.0);
float glow = (1.0 - smoothstep(0.0, bezel, -d)) * top;
float spec = rim * (line * (0.28 + 0.50 * top + 0.22 * bottom) + 0.10 * glow);
// white over the glass: a screen blend where the backdrop is opaque
col = col * (1.0 - clamp(spec, 0.0, 1.0)) + vec4(clamp(spec, 0.0, 1.0));

// Soft drop shadow outside the glass, offset downward.
float ds = shape(p - vec2(0.0, 3.0 * scale), hb, r);
float sh = shadow * (1.0 - smoothstep(-4.0 * scale, 16.0 * scale, ds)) * (1.0 - cover);

cogl_color_out = (col * cover + vec4(0.0, 0.0, 0.0, sh)) * cogl_color_in.a;
`;

const UNIFORMS = {
  size: 2,
  rect: 4,
  radius: 1,
  bezel: 1,
  refraction: 1,
  chroma: 1,
  rim: 1,
  tint: 4,
  shadow: 1,
  scale: 1,
  notch: 4,
  notchSize: 2,
};

export const GlassEffect = GObject.registerClass(
  {},
  class D2DAGlassEffect extends Shell.GLSLEffect {
    _init(params = {}) {
      super._init(params);
      this._locations = {};
      for (const name of Object.keys(UNIFORMS)) {
        this._locations[name] = this.get_uniform_location(name);
      }
    }

    vfunc_build_pipeline() {
      this.add_glsl_snippet(
        Cogl.SnippetHook.FRAGMENT,
        DECLARATIONS,
        CODE,
        false
      );
    }

    // values: { name: number | number[] } for the names in UNIFORMS
    setUniforms(values) {
      for (const [name, n] of Object.entries(UNIFORMS)) {
        const v = values[name];
        this.set_uniform_float(
          this._locations[name],
          n,
          Array.isArray(v) ? v : [v]
        );
      }
      this.queue_repaint();
    }
  }
);

// Clones of global.window_group's children, in stacking order and bound to
// their sources' geometry. Only the wallpaper and the visible windows that
// reach into the region are cloned. The set is recomputed (once per frame at
// most) when windows are added, removed, restacked, moved or resized, and
// only while the mirror is mapped; existing clones are kept and reordered.
const WindowGroupMirror = GObject.registerClass(
  {},
  class D2DAWindowGroupMirror extends Clutter.Actor {
    _init() {
      super._init();
      // stage rect the glass can sample from; x1 < x0 means "everything"
      this._x0 = 0;
      this._y0 = 0;
      this._x1 = -1;
      this._y1 = -1;
      this._clones = new Map(); // source -> clone
      this._laterId = 0;
      this._dirty = false;

      const group = global.window_group;
      group.connectObject(
        'child-added',
        (_group, child) => {
          this._watch(child);
          this._queueUpdate();
        },
        'child-removed',
        (_group, child) => {
          child.disconnectObject(this);
          this._queueUpdate();
        },
        // hidden while the overview is shown
        'notify::visible',
        () => this._queueUpdate(),
        this
      );
      group.get_children().forEach((child) => this._watch(child));
      global.display.connectObject(
        'restacked',
        () => this._queueUpdate(),
        this
      );
      // no work while unmapped (dock hidden); catch up when shown again
      this.connect('notify::mapped', () => {
        if (this.mapped && this._dirty) this._queueUpdate();
      });

      this.connect('destroy', () => this._onDestroy());
      this._update();
    }

    setRegion(x0, y0, x1, y1) {
      if (
        x0 === this._x0 &&
        y0 === this._y0 &&
        x1 === this._x1 &&
        y1 === this._y1
      ) {
        return;
      }
      this._x0 = x0;
      this._y0 = y0;
      this._x1 = x1;
      this._y1 = y1;
      this._queueUpdate();
    }

    _watch(child) {
      child.connectObject(
        'notify::allocation',
        () => this._queueUpdate(),
        'notify::visible',
        () => this._queueUpdate(),
        this
      );
    }

    _queueUpdate() {
      if (!this.mapped) {
        this._dirty = true;
        return;
      }
      if (this._laterId) return;
      this._laterId = global.compositor
        .get_laters()
        .add(Meta.LaterType.BEFORE_REDRAW, () => {
          this._laterId = 0;
          this._update();
          return GLib.SOURCE_REMOVE;
        });
    }

    _reaches(actor) {
      if (this._x1 < this._x0) return true;
      const e = actor.get_transformed_extents();
      return (
        e.origin.x < this._x1 &&
        e.origin.x + e.size.width > this._x0 &&
        e.origin.y < this._y1 &&
        e.origin.y + e.size.height > this._y0
      );
    }

    _update() {
      this._dirty = false;
      const group = global.window_group;
      const sources = group.get_children().filter((child) => {
        // a clone of a 0x0 actor scales by size / 0
        if (child.width < 1 || child.height < 1) return false;
        if (child instanceof Meta.BackgroundGroup) return true;
        // clones paint hidden sources too, so filter them here
        return group.visible && child.visible && this._reaches(child);
      });

      const wanted = new Set(sources);
      for (const [source, clone] of this._clones) {
        if (!wanted.has(source)) {
          clone.destroy();
          this._clones.delete(source);
        }
      }
      sources.forEach((source, i) => {
        let clone = this._clones.get(source);
        if (!clone) {
          clone = new Clutter.Clone({ source });
          clone.add_constraint(
            new Clutter.BindConstraint({
              source,
              coordinate: Clutter.BindCoordinate.ALL,
            })
          );
          this._clones.set(source, clone);
          this.insert_child_at_index(clone, i);
        } else if (this.get_child_at_index(i) !== clone) {
          this.set_child_at_index(clone, i);
        }
      });
    }

    _onDestroy() {
      if (this._laterId) {
        global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
      }
      global.window_group.get_children().forEach((child) => {
        child.disconnectObject(this);
      });
      global.window_group.disconnectObject(this);
      global.display.disconnectObject(this);
      this._clones.clear();
    }
  }
);

// The wallpaper of one monitor, laid out from (0, 0).
function createWallpaper(monitorIndex) {
  const group = new Meta.BackgroundGroup();
  const manager = new Background.BackgroundManager({
    container: group,
    monitorIndex,
    controlPosition: false,
  });
  // 'destroy' handlers run before the children go, so the manager can still
  // release its background actors
  group.connect('destroy', () => manager.destroy());
  return group;
}

export const GlassPlatter = GObject.registerClass(
  {},
  class D2DAGlassPlatter extends St.Widget {
    _init() {
      super._init({
        name: 'd2daGlass',
        reactive: false,
        // the GLSL effect's texture then covers exactly the allocation
        clip_to_allocation: true,
      });

      this._wrapper = new Clutter.Actor({ clip_to_allocation: true });
      this._blur = new Shell.BlurEffect({
        mode: Shell.BlurMode.ACTOR,
        radius: 0,
        brightness: 1.0,
      });
      this._wrapper.add_effect(this._blur);
      this.add_child(this._wrapper);

      this._glass = new GlassEffect();
      this.add_effect(this._glass);

      this._source = null;
      this._backdrop = null;
      this._monitorIndex = -1;
      // last applied values; setMaterial()/setGeometry() return early while
      // they hold, so the per-frame call costs no allocation or GL work
      this._m = {
        radius: -1, blur: -1, refraction: -1, rim: -1,
        r: -1, g: -1, b: -1, a: -1, scale: -1,
      };
      this._g = { x: NaN, y: NaN, w: NaN, h: NaN, ox: NaN, oy: NaN, rw: NaN, rh: NaN };
      // popover pointer (setNotch); depth 0 = none, as on the dock
      this._n = { x: 0, y: 0, dx: 0, dy: 1, half: 0, depth: 0 };
      this._materialChanged = true;

      // The overview hides the window group and draws its own background;
      // the desktop backdrop would be wrong there, so show none (the glass
      // then shows as a translucent tinted platter).
      const syncBackdropVisible = () => {
        this._wrapper.visible = global.window_group.visible;
      };
      global.window_group.connectObject(
        'notify::visible',
        syncBackdropVisible,
        this
      );
      syncBackdropVisible();
      this.connect('destroy', () => global.window_group.disconnectObject(this));
    }

    // backdrop: 'windows' (wallpaper + windows near the dock, live),
    // 'wallpaper' (the monitor's wallpaper only; cheapest) or 'none' (no
    // backdrop: a translucent tinted platter, as in the overview)
    setBackdrop(backdrop, monitorIndex) {
      if (backdrop === 'none') {
        this._source?.destroy();
        this._source = null;
        this._backdrop = backdrop;
        return;
      }
      if (
        this._source &&
        backdrop === this._backdrop &&
        (backdrop === 'windows' || monitorIndex === this._monitorIndex)
      ) {
        return;
      }
      this._source?.destroy();
      this._backdrop = backdrop;
      this._monitorIndex = monitorIndex;
      this._source =
        backdrop === 'wallpaper'
          ? createWallpaper(monitorIndex)
          : new WindowGroupMirror();
      this._wrapper.add_child(this._source);
      this._g.x = NaN; // force the next sync to place the new source
    }

    // Stage position of the backdrop source's origin.
    _sourceOriginX() {
      return this._backdrop === 'wallpaper' ? this._monitor().x : 0;
    }

    _sourceOriginY() {
      return this._backdrop === 'wallpaper' ? this._monitor().y : 0;
    }

    _monitor() {
      return (
        Main.layoutManager.monitors[this._monitorIndex] ??
        Main.layoutManager.primaryMonitor
      );
    }

    // Material, in px except rim (0..1) and tint (r, g, b, amount). Called
    // every frame; does nothing unless a value changed.
    setMaterial(radius, blur, refraction, rim, r, g, b, a, scale) {
      const m = this._m;
      if (
        m.radius === radius &&
        m.blur === blur &&
        m.refraction === refraction &&
        m.rim === rim &&
        m.r === r &&
        m.g === g &&
        m.b === b &&
        m.a === a &&
        m.scale === scale
      ) {
        return;
      }
      m.radius = radius;
      m.blur = blur;
      m.refraction = refraction;
      m.rim = rim;
      m.r = r;
      m.g = g;
      m.b = b;
      m.a = a;
      m.scale = scale || 1;
      this._blur.radius = Math.max(0, Math.round(blur));
      this._materialChanged = true;
    }

    // A popover pointer: its tip (x, y) relative to the glass rect's origin,
    // the unit direction (dx, dy) from the tip into the glass, its half base
    // width and its depth, in px. Applied by the next setGeometry().
    setNotch(x, y, dx, dy, half, depth) {
      const n = this._n;
      if (
        n.x === x &&
        n.y === y &&
        n.dx === dx &&
        n.dy === dy &&
        n.half === half &&
        n.depth === depth
      ) {
        return;
      }
      n.x = x;
      n.y = y;
      n.dx = dx;
      n.dy = dy;
      n.half = half;
      n.depth = depth;
      this._materialChanged = true;
    }

    // Geometry: the glass rect (x, y, w, h) in the parent's coordinates, the
    // parent's stage position, and the parent's size, which bounds the
    // windows worth mirroring. Called every frame; does nothing unless a
    // value or the material changed.
    setGeometry(x, y, w, h, ox, oy, rw, rh) {
      const gm = this._g;
      if (
        !this._materialChanged &&
        gm.x === x &&
        gm.y === y &&
        gm.w === w &&
        gm.h === h &&
        gm.ox === ox &&
        gm.oy === oy &&
        gm.rw === rw &&
        gm.rh === rh
      ) {
        return;
      }
      const sizeChanged = this._materialChanged || gm.w !== w || gm.h !== h;
      gm.x = x;
      gm.y = y;
      gm.w = w;
      gm.h = h;
      gm.ox = ox;
      gm.oy = oy;
      gm.rw = rw;
      gm.rh = rh;
      const m = this._m;
      const scale = m.scale;
      const pad = Math.ceil(24 * scale); // drop shadow room
      const margin = Math.ceil(m.blur + 8 * scale); // blur fringe, kept outside

      this.set_position(x - pad, y - pad);
      this.set_size(w + 2 * pad, h + 2 * pad);

      if (this._source) {
        this._wrapper.set_position(-margin, -margin);
        this._wrapper.set_size(w + 2 * (pad + margin), h + 2 * (pad + margin));
        // place the source so the stage point under the platter's origin
        // lands at the platter's origin
        this._source.set_position(
          this._sourceOriginX() - (ox + x - pad) + margin,
          this._sourceOriginY() - (oy + y - pad) + margin
        );
        if (this._backdrop !== 'wallpaper') {
          this._source.setRegion(ox, oy, ox + rw, oy + rh);
        }
      }

      // uniforms only depend on size and material, not on position
      if (!sizeChanged) return;
      this._materialChanged = false;
      const r = Math.min(m.radius, w / 2, h / 2);
      const n = this._n;
      const bezel = Math.max(4 * scale, Math.min(r * 1.1, Math.min(w, h) * 0.4));
      this._glass.setUniforms({
        size: [w + 2 * pad, h + 2 * pad],
        rect: [pad, pad, w, h],
        radius: r,
        bezel,
        refraction: Math.min(m.refraction, bezel * 1.5),
        chroma: m.refraction * 0.1,
        rim: m.rim,
        tint: [m.r, m.g, m.b, m.a],
        shadow: 0.22,
        scale,
        notch: [pad + n.x, pad + n.y, n.dx, n.dy],
        notchSize: [n.half, n.depth],
      });
    }
  }
);
