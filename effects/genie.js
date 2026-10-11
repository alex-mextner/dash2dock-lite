'use strict';

// macOS-style "genie" minimize/unminimize, drawn by the GPU.
//
// The window actor gets an offscreen effect: Clutter renders the window once
// into a texture (it stays cached while the window does not redraw). Each
// frame the effect draws one rectangle covering the window and its dock icon,
// and a fragment shader maps every pixel back into the window texture through
// the inverse genie, discarding pixels outside the shape. A frame costs one
// uniform write (d2da_t) and one paint node, as for any offscreen effect: no
// pixels read back and no CPU geometry. The target is re-measured each frame
// and the geometry redone only when it moved: the dock can open or close a
// slot while the window flies (another window minimized or restored).
//
// Clutter.DeformEffect would be the obvious base, but on Mutter 50 it paints
// nothing at all (also its C subclass Clutter.PageTurnEffect).
//
// The shape, in a frame where `a` runs along the dock and `b` towards it:
// during the first 40% the edge nearest the dock stretches to the icon while
// the sides pinch towards it along an S-curve; then the far edge slides into
// the icon. Rows stay straight, so the inverse is closed-form per pixel.
//
// Shell's own minimize/unminimize handlers stay connected but are blocked
// while the genie is enabled; windows the genie does not animate (maximized,
// no icon, overview open, ...) are handed to them unchanged.
//
// As on macOS the animating window draws above every other window: Mutter
// restacks right after a minimize (focus moves on) and would put the newly
// focused window over the genie. The actor is raised within its group for
// the animation, again after every restack, and put back where Mutter's
// stack has it once done.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DockPosition } from '../dock.js';

const DURATION_MS = 500;
const EFFECT_NAME = 'd2da-genie';

const ANIMATED_TYPES = [
  Meta.WindowType.NORMAL,
  Meta.WindowType.DIALOG,
  Meta.WindowType.MODAL_DIALOG,
];

const DECLARATIONS = `
uniform sampler2D d2da_tex; // the window, rendered offscreen
uniform float d2da_t;       // 0: the window, 1: inside the icon
uniform vec4  d2da_box;     // the window texture on stage: x, y, w, h (px)
uniform vec4  d2da_win;     // the same, dock frame: a0, b0, a1, b1
uniform vec4  d2da_icon;    // icon, dock frame: a0, b0, a1, b1
uniform float d2da_swap;    // 1: dock on the left/right, so a runs along y
uniform float d2da_flip;    // -1: dock on the top/left, towards it is -b

vec2 d2da_to_dock(vec2 p) {
  vec2 q = d2da_swap > 0.5 ? p.yx : p;
  q.y *= d2da_flip;
  return q;
}

vec2 d2da_to_stage(vec2 q) {
  q.y *= d2da_flip;
  return d2da_swap > 0.5 ? q.yx : q;
}
`;

// The rectangle's texture coordinates are window-normalised (0..1 across the
// window texture, beyond it towards the icon), so they give the stage point.
const FRAGMENT = `
const float split = 0.4;
vec2 c = d2da_to_dock(d2da_box.xy + cogl_tex_coord_in[0].st * d2da_box.zw);
float k = smoothstep(0.0, 1.0, clamp(d2da_t / split, 0.0, 1.0));
float j = smoothstep(0.0, 1.0, clamp((d2da_t - split) / (1.0 - split), 0.0, 1.0));
float far = mix(d2da_win.y, d2da_icon.y, j);
float near = mix(d2da_win.w, d2da_icon.w, k);
float v = (c.y - far) / max(near - far, 0.001);
float f = clamp((c.y - d2da_win.y) / max(d2da_icon.y - d2da_win.y, 1.0), 0.0, 1.0);
f = f * f * (3.0 - 2.0 * f) * k;
float left = mix(d2da_win.x, d2da_icon.x, f);
float right = mix(d2da_win.z, d2da_icon.z, f);
float u = (c.x - left) / max(right - left, 0.001);
if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0)
  discard;
vec2 s = d2da_to_stage(vec2(mix(d2da_win.x, d2da_win.z, u),
                            mix(d2da_win.y, d2da_win.w, v)));
cogl_color_out = texture2D(d2da_tex, (s - d2da_box.xy) / d2da_box.zw);
`;

// x, y, w, h (stage px) -> [a0, b0, a1, b1] in the dock frame
function toDockFrame(x, y, w, h, swap, flip) {
  let [a, b, aw, bw] = swap ? [y, x, h, w] : [x, y, w, h];
  let b0 = flip < 0 ? -(b + bw) : b;
  return [a, b0, a + aw, b0 + bw];
}

const GenieEffect = GObject.registerClass(
  class D2DAGenieEffect extends Clutter.OffscreenEffect {
    // paintBox: the window's stage paint box before the effect was added
    _init(snippet, paintBox, target) {
      super._init();
      this._snippet = snippet;
      this._paintBox = paintBox;
      this._target = target;
      this._pipeline = null;
      this._placed = false;
      this._rect = null; // Clutter.ActorBox drawn each frame
      this._texCoords = null; // [x1, y1, x2, y2]
      this._tLocation = -1;
      this.progress = 0;
    }

    retarget(target) {
      let t = this._target;
      if (
        t.x === target.x &&
        t.y === target.y &&
        t.width === target.width &&
        t.height === target.height &&
        t.side === target.side
      )
        return;
      this._target = target;
      this._placed = false;
    }

    // the genie reaches the dock, far outside the window: let Clutter
    // redraw the stage instead of clipping to the window's volume
    vfunc_modify_paint_volume(_volume) {
      return false;
    }

    // Clutter consumes a paint node's operations when it paints it, so a
    // node is built per frame, as OffscreenEffect itself does; the geometry
    // only when the pipeline or the target changes.
    vfunc_paint_target(node, _paintContext) {
      let pipeline = this.get_pipeline();
      if (!pipeline) return;
      if (pipeline !== this._pipeline) {
        // once per pipeline (normally once per animation)
        this._pipeline = pipeline;
        pipeline.add_snippet(this._snippet);
        this._placed = false;
      }
      if (!this._placed) this._place(pipeline);
      pipeline.set_uniform_1f(this._tLocation, this.progress);
      let [tx1, ty1, tx2, ty2] = this._texCoords;
      let pipelineNode = Clutter.PipelineNode.new(pipeline);
      pipelineNode.add_texture_rectangle(this._rect, tx1, ty1, tx2, ty2);
      node.add_child(pipelineNode);
    }

    // the window and target geometry: once per pipeline and target
    _place(pipeline) {
      this._placed = true;

      // Where the texture lies on stage, as OffscreenEffect sized it:
      // the paint box padded out and quantized (clutter-actor-box.c), in
      // device px at the actor's ceiled resource scale.
      let [, texWidth, texHeight] = this.get_target_size();
      let scale = Math.ceil(this.actor.get_resource_scale()) || 1;
      let pb = this._paintBox;
      let w = texWidth / scale;
      let h = texHeight / scale;
      let x = Math.ceil(pb.x2 + 0.75) - w;
      let y = Math.ceil(pb.y2 + 0.75) - h;

      let t = this._target;
      let swap = t.side === DockPosition.LEFT || t.side === DockPosition.RIGHT;
      let flip =
        t.side === DockPosition.TOP || t.side === DockPosition.LEFT ? -1 : 1;
      let set = (name, values) =>
        pipeline.set_uniform_float(
          pipeline.get_uniform_location(name),
          values.length,
          1,
          values
        );
      set('d2da_box', [x, y, w, h]);
      set('d2da_win', toDockFrame(x, y, w, h, swap, flip));
      set('d2da_icon', toDockFrame(t.x, t.y, t.width, t.height, swap, flip));
      set('d2da_swap', [swap ? 1 : 0]);
      set('d2da_flip', [flip]);
      pipeline.set_uniform_1i(pipeline.get_uniform_location('d2da_tex'), 0);
      this._tLocation = pipeline.get_uniform_location('d2da_t');

      // one rectangle over the window and the icon, in texture px relative
      // to the texture's origin (paint_target's coordinate space)
      let x0 = Math.min(x, t.x);
      let y0 = Math.min(y, t.y);
      let x1 = Math.max(x + w, t.x + t.width);
      let y1 = Math.max(y + h, t.y + t.height);
      this._rect = new Clutter.ActorBox({
        x1: (x0 - x) * scale,
        y1: (y0 - y) * scale,
        x2: (x1 - x) * scale,
        y2: (y1 - y) * scale,
      });
      this._texCoords = [
        (x0 - x) / w,
        (y0 - y) / h,
        (x1 - x) / w,
        (y1 - y) / h,
      ];
    }
  }
);

export class Genie {
  // targetFor(Meta.Window) -> {x, y, width, height, side} | null
  constructor(targetFor) {
    this._targetFor = targetFor;
    this._running = new Map(); // window actor -> animation
    this._blocked = [];
    this._snippet = null;
  }

  get enabled() {
    return this._blocked.length > 0;
  }

  enable() {
    if (this.enabled) return;
    let shellwm = Main.wm._shellwm;
    // Main.wm connected the first minimize/unminimize handlers at startup
    let ids = ['minimize', 'unminimize'].map((signalId) =>
      GObject.signal_handler_find(shellwm, { signalId })
    );
    if (ids.some((id) => !id)) {
      console.warn('d2da: genie: Shell minimize handlers not found');
      return;
    }
    if (!this._snippet) {
      this._snippet = Cogl.Snippet.new(
        Cogl.SnippetHook.FRAGMENT,
        DECLARATIONS,
        FRAGMENT
      );
    }
    ids.forEach((id) => GObject.signal_handler_block(shellwm, id));
    this._blocked = ids;
    shellwm.connectObject(
      'minimize',
      (wm, actor) => this._onMinimize(wm, actor),
      'unminimize',
      (wm, actor) => this._onUnminimize(wm, actor),
      'kill-window-effects',
      (wm, actor) => this._finish(actor),
      this
    );
  }

  disable() {
    if (!this.enabled) return;
    let shellwm = Main.wm._shellwm;
    shellwm.disconnectObject(this);
    for (let actor of [...this._running.keys()]) this._finish(actor);
    this._blocked.forEach((id) => GObject.signal_handler_unblock(shellwm, id));
    this._blocked = [];
  }

  _onMinimize(shellwm, actor) {
    let target = this._target(actor);
    if (target) {
      this._run(shellwm, actor, target, true);
    } else {
      Main.wm._minimizeWindow(shellwm, actor);
    }
  }

  _onUnminimize(shellwm, actor) {
    let target = this._target(actor);
    if (target) {
      this._run(shellwm, actor, target, false);
    } else {
      Main.wm._unminimizeWindow(shellwm, actor);
    }
  }

  // The genie only takes what Shell would animate with its scale effect;
  // Shell keeps skipped actors, fades monitor-sized windows and does not
  // animate in the overview or during a workspace gesture.
  _target(actor) {
    let wm = Main.wm;
    let window = actor.meta_window;
    if (!window || wm._skippedActors?.has(actor)) return null;
    if (!wm._shouldAnimate() || !actor.get_texture()) return null;
    if (!ANIMATED_TYPES.includes(window.get_window_type())) return null;
    if (window.is_monitor_sized()) return null;
    return this._targetFor(window);
  }

  _run(shellwm, actor, target, minimize) {
    this._finish(actor);

    // a minimized actor is hidden; showing it here cannot flash, nothing
    // paints before the effect below is in place
    if (!minimize) actor.show();
    // Where the window paints, measured before the effect is added (it
    // reports an unbounded volume). A just-shown minimized actor has no
    // paint volume yet; its buffer rect is the same box.
    let [hasBox, paintBox] = actor.get_paint_box();
    if (!hasBox) {
      let rect = actor.meta_window.get_buffer_rect();
      paintBox = new Clutter.ActorBox({
        x1: rect.x,
        y1: rect.y,
        x2: rect.x + rect.width,
        y2: rect.y + rect.height,
      });
    }
    if (!(paintBox.get_width() > 0 && paintBox.get_height() > 0)) {
      if (minimize) Main.wm._minimizeWindow(shellwm, actor);
      else Main.wm._unminimizeWindow(shellwm, actor);
      return;
    }

    let effect = new GenieEffect(this._snippet, paintBox, target);
    effect.progress = minimize ? 0 : 1;
    actor.add_effect_with_name(EFFECT_NAME, effect);

    let timeline = new Clutter.Timeline({ actor, duration: DURATION_MS });
    if (this._running.size === 0) {
      global.display.connectObject('restacked', () => this._raise(), this);
    }
    this._running.set(actor, { shellwm, timeline, effect, minimize });
    this._raise();
    timeline.connectObject(
      'new-frame',
      () => {
        let p = timeline.get_progress();
        effect.progress = minimize ? p : 1 - p;
        let current = actor.meta_window && this._targetFor(actor.meta_window);
        if (current) effect.retarget(current);
        effect.queue_repaint();
      },
      'stopped',
      () => this._finish(actor),
      this
    );
    // destroyed mid-animation: nothing left to complete or restack
    actor.connectObject('destroy', () => this._drop(actor, false), this);
    timeline.start();
  }

  // ends an animation and tells Mutter it is complete
  _finish(actor) {
    let animation = this._drop(actor);
    if (!animation) return;
    if (animation.minimize) animation.shellwm.completed_minimize(actor);
    else animation.shellwm.completed_unminimize(actor);
  }

  _drop(actor, restack = true) {
    let animation = this._running.get(actor);
    if (!animation) return null;
    this._running.delete(actor);
    if (this._running.size === 0) global.display.disconnectObject(this);
    actor.disconnectObject(this);
    animation.timeline.disconnectObject(this);
    animation.timeline.stop();
    actor.remove_effect(animation.effect);
    if (restack) this._restack(actor);
    return animation;
  }

  // animating windows above all others, in the order they started
  _raise() {
    for (let actor of this._running.keys()) {
      actor.get_parent()?.set_child_above_sibling(actor, null);
    }
  }

  // back to its place in Mutter's stack (global.get_window_actors() is kept
  // bottom to top); Mutter only re-syncs actor order on its next restack
  _restack(actor) {
    let parent = actor.get_parent();
    let actors = global.get_window_actors();
    let index = actors.indexOf(actor);
    if (!parent || index < 0) return;
    let above = actors
      .slice(index + 1)
      .find((other) => other.get_parent() === parent);
    if (above) parent.set_child_below_sibling(actor, above);
  }
}
