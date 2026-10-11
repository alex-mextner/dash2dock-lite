// Unity LauncherEntry API (https://wiki.ubuntu.com/Unity/LauncherAPI), written
// from the spec: apps (Telegram, Thunderbird, VS Code, Discord, Chrome
// downloads, Steam) broadcast `com.canonical.Unity.LauncherEntry.Update`
// signals carrying an unread count, a progress value and an urgent flag for
// their .desktop id. This module keeps the latest state per app; the animator
// draws it as the badge and the progress bar.
//
// Trust: the API has no authentication, so any session-bus client can set
// any app's badge, as with Ubuntu Dock and Plasma. Binding a sender to its
// app is not workable: flatpak apps reach the bus through xdg-dbus-proxy (the
// sender's PID is the proxy's), apps closed to the tray (Telegram,
// Thunderbird) have no window to match a PID against, and launchers such as
// Chrome's are wrapper scripts. A same-user process can do far worse than a
// fake badge anyway. What a sender can do is kept small instead: only ids of
// installed apps are kept (a flood of made-up ids cannot grow the Shell's
// memory), values are clamped, and change notifications (redraws, the urgent
// bounce) are coalesced to one per NOTIFY_DELAY_MS whatever the signal rate.
// `urgent` only ever starts the capped attention bounce (windowFeedback.js).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

const IFACE = 'com.canonical.Unity.LauncherEntry';
// libunity (and apps that mimic it) re-send their state when a launcher owns
// this name, so owning it answers the "who is listening" question at startup.
const LAUNCHER_NAME = 'com.canonical.Unity';
const NOTIFY_DELAY_MS = 100;

export class LauncherEntries {
  // onChanged(appId, entry, previous) runs after state changes, at most once
  // per app per NOTIFY_DELAY_MS; previous is the state last reported.
  constructor(onChanged) {
    this._onChanged = onChanged;
    this.entries = {};
    // unique bus name of the sender -> set of app ids it updated, so entries
    // vanish when the app quits without resetting them (crash, kill)
    this._senders = new Map();
    // app id -> its state when onChanged last ran, for apps changed since
    this._pending = new Map();
    this._notifyId = 0;

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
    if (this._notifyId) GLib.source_remove(this._notifyId);
    this._notifyId = 0;
    this._pending.clear();
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
    // the dock only shows entries for apps it can look up; anything else
    // would just pile up
    if (!Shell.AppSystem.get_default().lookup_app(appId)) return;

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
    if ('count' in props)
      entry.count = Math.max(0, Math.trunc(Number(props.count)) || 0);
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
    this._changed(appId, previous);
  }

  _onSenderGone(sender) {
    let ids = this._senders.get(sender);
    this._senders.delete(sender);
    ids.forEach((appId) => {
      let previous = this.entries[appId];
      delete this.entries[appId];
      this._changed(appId, previous);
    });
  }

  _changed(appId, previous) {
    if (!this._pending.has(appId)) this._pending.set(appId, previous);
    if (this._notifyId) return;
    this._notifyId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      NOTIFY_DELAY_MS,
      () => {
        this._notifyId = 0;
        let pending = this._pending;
        this._pending = new Map();
        pending.forEach((previous, appId) =>
          this._onChanged?.(appId, this.entries[appId] ?? null, previous)
        );
        return GLib.SOURCE_REMOVE;
      }
    );
  }
}
