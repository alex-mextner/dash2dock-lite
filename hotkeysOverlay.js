// hotkeys-overlay: while Super is held ~0.5 s, label the first nine pinned
// apps with the digit of their Super+N shortcut (GNOME's
// switch-to-application-N counts favorites in AppFavorites order), as Ubuntu
// Dock does. Driven by keymap modifier changes; no polling, no per-frame work.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Fav from 'resource:///org/gnome/shell/ui/appFavorites.js';

const HOLD_MS = 500;
const SUPER_MASK =
  Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK;

export class HotkeysOverlay {
  constructor(extension) {
    this.extension = extension;
    this._labels = [];
    this._holdId = 0;
    this._keymap = Clutter.get_default_backend()
      .get_default_seat()
      .get_keymap();
    this._keymap.connectObject(
      'state-changed',
      () => this._onModifiersChanged(),
      this
    );
  }

  destroy() {
    this._keymap?.disconnectObject(this);
    this._keymap = null;
    this._cancelHold();
    this._hideLabels();
  }

  // Clutter.Keymap has no modifier getter; the pointer query carries the
  // seat's modifier mask (read only when the modifiers change)
  _superHeld() {
    let [, , mods] = global.get_pointer();
    return (mods & SUPER_MASK) !== 0;
  }

  _onModifiersChanged() {
    if (!this._superHeld()) {
      this._cancelHold();
      this._hideLabels();
      return;
    }
    if (this._holdId || this._labels.length) return;
    this._holdId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_MS, () => {
      this._holdId = 0;
      if (this._superHeld()) this._showLabels();
      return GLib.SOURCE_REMOVE;
    });
  }

  _cancelHold() {
    if (this._holdId) {
      GLib.source_remove(this._holdId);
      this._holdId = 0;
    }
  }

  _showLabels() {
    let favorites = Fav.getAppFavorites()
      .getFavorites()
      .slice(0, 9)
      .map((app) => app.get_id());
    if (!favorites.length) return;

    for (let dock of this.extension.docks ?? []) {
      // a hidden (autohidden or slid-out) dock shows no numbers
      if (dock._hidden || !dock.renderArea?.mapped) continue;
      for (let icon of dock._icons ?? []) {
        let renderer = icon._renderer;
        let id = icon._appwell?.app?.get_id?.();
        let n = id ? favorites.indexOf(id) : -1;
        if (n < 0 || !renderer) continue;
        let label = new St.Label({
          text: `${n + 1}`,
          style_class: 'd2da-hotkey-number',
        });
        dock.renderArea.add_child(label);
        let size = renderer.width * renderer.scaleX;
        let [, labelWidth] = label.get_preferred_width(-1);
        // inside the top-right corner of the rendered icon, as Ubuntu Dock
        label.set_position(
          Math.round(renderer.x + size - labelWidth * 0.75),
          Math.round(renderer.y - labelWidth * 0.25)
        );
        this._labels.push(label);
      }
    }
  }

  _hideLabels() {
    this._labels.forEach((label) => label.destroy());
    this._labels = [];
  }
}
