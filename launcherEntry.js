// Unity LauncherEntry API (https://wiki.ubuntu.com/Unity/LauncherAPI), written
// from the spec: apps (Telegram, Thunderbird, VS Code, Discord, Chrome
// downloads, Steam) broadcast `com.canonical.Unity.LauncherEntry.Update`
// signals carrying an unread count, a progress value and an urgent flag for
// their .desktop id. This module keeps the latest state per app; the animator
// draws it as the badge and the progress bar.

import Gio from 'gi://Gio';

const IFACE = 'com.canonical.Unity.LauncherEntry';
// libunity (and apps that mimic it) re-send their state when a launcher owns
// this name, so owning it answers the "who is listening" question at startup.
const LAUNCHER_NAME = 'com.canonical.Unity';

export class LauncherEntries {
  // onChanged(appId, entry, previous) runs after every state change.
  constructor(onChanged) {
    this._onChanged = onChanged;
    this.entries = {};
    // unique bus name of the sender -> set of app ids it updated, so entries
    // vanish when the app quits without resetting them (crash, kill)
    this._senders = new Map();

    let bus = Gio.DBus.session;
    this._updateId = bus.signal_subscribe(
      null,
      IFACE,
      'Update',
      null,
      null,
      Gio.DBusSignalFlags.NONE,
      (conn, sender, path, iface, signal, params) =>
        this._onUpdate(sender, params)
    );
    this._ownerId = bus.signal_subscribe(
      'org.freedesktop.DBus',
      'org.freedesktop.DBus',
      'NameOwnerChanged',
      '/org/freedesktop/DBus',
      null,
      Gio.DBusSignalFlags.NONE,
      (conn, sender, path, iface, signal, params) => {
        let [name, , newOwner] = params.deepUnpack();
        if (!newOwner && this._senders.has(name)) this._onSenderGone(name);
      }
    );
    // ALLOW_REPLACEMENT without REPLACE: if Ubuntu Dock already owns it, the
    // apps already broadcast and we just listen to the same signals.
    this._nameId = Gio.bus_own_name_on_connection(
      bus,
      LAUNCHER_NAME,
      Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT,
      null,
      null
    );
  }

  destroy() {
    let bus = Gio.DBus.session;
    bus.signal_unsubscribe(this._updateId);
    bus.signal_unsubscribe(this._ownerId);
    Gio.bus_unown_name(this._nameId);
    this.entries = {};
    this._senders.clear();
    this._onChanged = null;
  }

  _onUpdate(sender, params) {
    let [uri, props] = params.recursiveUnpack();
    if (typeof uri !== 'string' || !props) return;
    let appId = uri.replace(/^application:\/\//, '');
    if (!appId) return;
    if (!appId.endsWith('.desktop')) appId = `${appId}.desktop`;

    let previous = this.entries[appId];
    // Update carries only the changed properties; merge onto the last state.
    let entry = {
      count: 0,
      countVisible: false,
      progress: 0,
      progressVisible: false,
      urgent: false,
      ...previous,
    };
    if ('count' in props) entry.count = Number(props.count) || 0;
    if ('count-visible' in props) entry.countVisible = !!props['count-visible'];
    if ('progress' in props)
      entry.progress = Math.min(1, Math.max(0, Number(props.progress) || 0));
    if ('progress-visible' in props)
      entry.progressVisible = !!props['progress-visible'];
    if ('urgent' in props) entry.urgent = !!props.urgent;
    this.entries[appId] = entry;

    if (sender) {
      if (!this._senders.has(sender)) this._senders.set(sender, new Set());
      this._senders.get(sender).add(appId);
    }
    this._onChanged?.(appId, entry, previous);
  }

  _onSenderGone(sender) {
    let ids = this._senders.get(sender);
    this._senders.delete(sender);
    ids.forEach((appId) => {
      let previous = this.entries[appId];
      delete this.entries[appId];
      this._onChanged?.(appId, null, previous);
    });
  }
}
