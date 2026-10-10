'use strict';

// macOS dock interactions that GNOME's Dash lacks, one instance per Dock:
//  - drag-off-remove: drag a pinned icon away from the dock to unpin it
//    ("Remove" label near the pointer, poof on drop);
//  - background-menu: right-click on the dock background/separator opens
//    Hiding / Magnification / Position / Dock Settings;
//  - spring-loading: a file drag hovering over an app icon for ~1 s brings
//    that app forward, and an autohidden dock is revealed while files drag.
// Everything is event driven (DND monitors are installed only for the
// duration of a drag) and animated with Clutter implicit transitions.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Fav from 'resource:///org/gnome/shell/ui/appFavorites.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

const SPRING_DELAY_MS = 1000;
const POOF_PUFFS = 6;
const POOF_MS = 320;
const POOF_SPREAD = 28;

// dock-location values, in the order of the prefs dropdown
const LOCATION = { BOTTOM: 0, LEFT: 1, RIGHT: 2, TOP: 3 };

export class DockInteractions {
  constructor(dock) {
    this.dock = dock;
    this.extension = dock.extension;

    // bound once so the DND monitors allocate nothing per motion event
    this._dragOffMonitor = {
      dragMotion: this._onDragOffMotion.bind(this),
      dragDrop: this._onDragOffDrop.bind(this),
    };
    this._springMonitor = {
      dragMotion: this._onSpringMotion.bind(this),
    };

    this._dragApp = null;
    this._dragActor = null;
    this._inRemoveZone = false;
    this._rect = [0, 0, 0, 0];
    this._margin = 0;

    this._springApp = null;
    this._springId = 0;
    this._xdndActive = false;

    Main.xdndHandler.connectObject(
      'drag-begin',
      this._onXdndBegin.bind(this),
      'drag-end',
      this._onXdndEnd.bind(this),
      this
    );
  }

  destroy() {
    Main.xdndHandler.disconnectObject(this);
    this._onXdndEnd();
    this.endIconDrag();
    this._removeLabel?.destroy();
    this._removeLabel = null;
    this._menu?.destroy();
    this._menu = null;
    this._menuManager = null;
    this._menuAnchor?.destroy();
    this._menuAnchor = null;
    this.dock = null;
    this.extension = null;
  }

  //---------------------------
  // drag an icon off the dock to remove it
  //---------------------------

  beginIconDrag(app) {
    // the overview has its own drop targets (workspaces launch the app)
    if (
      !this.extension.drag_off_remove ||
      !app ||
      Main.overview.visible ||
      !Fav.getAppFavorites().isFavorite(app.get_id())
    ) {
      return;
    }
    // the dock does not move during a drag: measure it once
    let struts = this.dock.struts;
    let [x, y] = struts.get_transformed_position();
    this._rect[0] = x;
    this._rect[1] = y;
    this._rect[2] = struts.width;
    this._rect[3] = struts.height;
    // "more than ~1 icon height away": the dock's own thickness
    this._margin = this.dock.isVertical() ? struts.width : struts.height;
    this._dragApp = app;
    this._inRemoveZone = false;
    DND.addDragMonitor(this._dragOffMonitor);
  }

  endIconDrag() {
    if (!this._dragApp) return;
    DND.removeDragMonitor(this._dragOffMonitor);
    this._setRemoveZone(false);
    this._dragApp = null;
    this._dragActor = null;
  }

  _ensureRemoveLabel() {
    if (!this._removeLabel) {
      this._removeLabel = new St.Label({
        style_class: 'd2da-remove-label',
        text: _('Remove'),
        visible: false,
      });
      Main.uiGroup.add_child(this._removeLabel);
    }
    return this._removeLabel;
  }

  _setRemoveZone(inZone) {
    if (this._inRemoveZone === inZone) return;
    this._inRemoveZone = inZone;
    if (this._removeLabel) this._removeLabel.visible = inZone;
    if (this._dragActor) this._dragActor.opacity = inZone ? 110 : 255;
  }

  _onDragOffMotion(dragEvent) {
    let r = this._rect;
    let m = this._margin;
    let x = dragEvent.x;
    let y = dragEvent.y;
    let out =
      x < r[0] - m || x > r[0] + r[2] + m || y < r[1] - m || y > r[1] + r[3] + m;
    this._dragActor = dragEvent.dragActor;
    if (out) {
      let label = this._ensureRemoveLabel();
      this._setRemoveZone(true);
      Main.uiGroup.set_child_above_sibling(label, null);
      label.set_position(x + 14, y - label.height - 14);
    } else {
      this._setRemoveZone(false);
    }
    return DND.DragMotionResult.CONTINUE;
  }

  _onDragOffDrop(dropEvent) {
    if (!this._inRemoveZone || !this._dragApp) {
      return DND.DragDropResult.CONTINUE;
    }
    let id = this._dragApp.get_id();
    let [x, y] = global.get_pointer();
    // the drop is then cancelled by DND; hiding the actor turns the
    // snap-back into an invisible no-op instead of a fly-home
    dropEvent.dropActor?.hide();
    // DND destroys the clone after the snap-back, before drag-end
    this._dragActor = null;
    this._poof(x, y);
    // like Shell's Show Apps drop: unpin after the drop has been processed,
    // so the dash does not rebuild under the running drag code
    global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      Fav.getAppFavorites().removeFavorite(id);
      return GLib.SOURCE_REMOVE;
    });
    console.log(`d2da: drag-off removed ${id}`);
    return DND.DragDropResult.CONTINUE;
  }

  // a one-shot puff of smoke: a few discs that drift apart, grow and fade
  _poof(x, y) {
    for (let i = 0; i < POOF_PUFFS; i++) {
      let a = (i / POOF_PUFFS) * Math.PI * 2;
      let puff = new St.Widget({
        style_class: 'd2da-poof-puff',
        x: x - 12,
        y: y - 12,
        width: 24,
        height: 24,
        opacity: 230,
        pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
      });
      Main.uiGroup.add_child(puff);
      puff.ease({
        translation_x: Math.cos(a) * POOF_SPREAD,
        translation_y: Math.sin(a) * POOF_SPREAD,
        scale_x: 1.8,
        scale_y: 1.8,
        opacity: 0,
        duration: POOF_MS,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onStopped: () => puff.destroy(),
      });
    }
  }

  //---------------------------
  // right-click on the dock background
  //---------------------------

  // true when the press was handled (menu shown)
  handleButtonPress(evt) {
    if (!this.extension.background_menu || evt.get_button() !== 3) {
      return false;
    }
    let actor = global.stage.get_event_actor(evt);
    for (let a = actor; a && a !== this.dock.dash; a = a.get_parent()) {
      // icons (apps, Show Apps, trash, stacks) keep their own menus
      if (
        a.has_style_class_name?.('dash-item-container') ||
        a instanceof St.Button
      ) {
        return false;
      }
    }
    let [x, y] = evt.get_coords();
    this._openMenu(x, y);
    return true;
  }

  _openMenu(x, y) {
    let side = St.Side.BOTTOM;
    switch (this.extension.dock_location) {
      case LOCATION.LEFT:
        side = St.Side.LEFT;
        break;
      case LOCATION.RIGHT:
        side = St.Side.RIGHT;
        break;
      case LOCATION.TOP:
        side = St.Side.TOP;
        break;
    }
    // the arrow side is fixed at construction: rebuild after a dock move
    if (this._menu && this._menuSide !== side) {
      this._menu.destroy();
      this._menu = null;
    }
    if (!this._menu) this._buildMenu(side);
    this._menuAnchor.set_position(x, y);

    let ext = this.extension;
    this._hideItem.label.text = ext.autohide_dash
      ? _('Turn Hiding Off')
      : _('Turn Hiding On');
    this._magnifyItem.label.text = ext.animate_icons
      ? _('Turn Magnification Off')
      : _('Turn Magnification On');
    for (let [loc, item] of this._positionItems) {
      item.setOrnament(
        ext.dock_location === loc
          ? PopupMenu.Ornament.CHECK
          : PopupMenu.Ornament.NONE
      );
    }
    this._menu.open(true);
  }

  _buildMenu(side) {
    // 1x1 invisible anchor at the click point, so the menu points at
    // where the user clicked rather than at the middle of the dock
    if (!this._menuAnchor) {
      this._menuAnchor = new St.Widget({ width: 1, height: 1, opacity: 0 });
      Main.uiGroup.add_child(this._menuAnchor);
      this._menuManager = new PopupMenu.PopupMenuManager(this._menuAnchor);
    }

    let menu = new PopupMenu.PopupMenu(this._menuAnchor, 0.5, side);
    this._menuSide = side;
    menu.actor.add_style_class_name('d2da-background-menu');
    let settings = this.extension._settings;
    let toggle = (key) => settings.set_boolean(key, !settings.get_boolean(key));

    this._hideItem = menu.addAction('', () => toggle('autohide-dash'));
    this._magnifyItem = menu.addAction('', () => toggle('animate-icons'));

    let position = new PopupMenu.PopupSubMenuMenuItem(_('Position on Screen'));
    this._positionItems = [
      [LOCATION.LEFT, _('Left')],
      [LOCATION.BOTTOM, _('Bottom')],
      [LOCATION.RIGHT, _('Right')],
    ].map(([loc, title]) => [
      loc,
      position.menu.addAction(title, () => settings.set_int('dock-location', loc)),
    ]);
    menu.addMenuItem(position);

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    menu.addAction(_('Dock Settings…'), () => this.extension.openPreferences());

    Main.uiGroup.add_child(menu.actor);
    menu.actor.hide();
    this._menuManager.addMenu(menu);
    this._menu = menu;
  }

  //---------------------------
  // spring-loading (file drags from other apps arrive as xdnd)
  //---------------------------

  get xdndActive() {
    return this._xdndActive;
  }

  _onXdndBegin() {
    if (!this.extension.spring_loading || this._xdndActive) return;
    this._xdndActive = true;
    DND.addDragMonitor(this._springMonitor);
    let autohider = this.dock.autohider;
    if (autohider?._enabled && !autohider._shown) {
      autohider.show();
    }
  }

  _onXdndEnd() {
    if (!this._xdndActive) return;
    this._xdndActive = false;
    DND.removeDragMonitor(this._springMonitor);
    this._armSpring(null);
    // let autohide take over again now that the files are dropped
    this.dock?.autohider?._debounceCheckHide();
  }

  _onSpringMotion(dragEvent) {
    if (dragEvent.source !== Main.xdndHandler) {
      return DND.DragMotionResult.CONTINUE;
    }
    let dash = this.dock.dash;
    let app = null;
    for (let a = dragEvent.targetActor; a; a = a.get_parent()) {
      if (a === dash) break;
      if (a.app) {
        app = a.app;
        break;
      }
    }
    // only icons of this dock
    if (app && !dash?.contains(dragEvent.targetActor)) app = null;
    if (app !== this._springApp) this._armSpring(app);
    return DND.DragMotionResult.CONTINUE;
  }

  _armSpring(app) {
    if (this._springId) {
      GLib.source_remove(this._springId);
      this._springId = 0;
    }
    this._springApp = app;
    if (!app) return;
    this._springId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      SPRING_DELAY_MS,
      () => {
        this._springId = 0;
        console.log(`d2da: spring-loading activates ${app.get_id()}`);
        // app.activate() left the running window behind the focused one
        // (harness test); activateWindow raises it the way Shell does
        let win = app.get_windows()[0];
        if (win) {
          Main.activateWindow(win);
        } else {
          app.activate();
        }
        return GLib.SOURCE_REMOVE;
      }
    );
  }
}
