// Google Calendar + sync through a small Apps Script that runs in the person's own Google account.
import * as E from './engine.js';
import { repairState } from './store.js';

export const SCRIPT_PATH = 'apps-script/Code.gs';

export function newSecret() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 28);
}

export async function scriptText() {
  const res = await fetch(SCRIPT_PATH, { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load the script.');
  return res.text();
}

export function validScriptUrl(u) {
  return /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec\/?$/.test(String(u || '').trim());
}

function normEvent(ev) {
  const o = { ...ev, title: String(ev.title || '(No title)') };
  // Events on a calendar named "optional" are shown but don't block free time.
  if (/optional/i.test(o.calName || '')) {
    o.optional = true;
    o.free = true;
  }
  if (!o.allDay) {
    if (!o.start || !o.end || isNaN(Date.parse(o.start)) || isNaN(Date.parse(o.end))) return null;
    const mins = (Date.parse(o.end) - Date.parse(o.start)) / 60000;
    if (mins >= 23.5 * 60) {
      // Birthdays and similar come through as midnight-to-midnight: treat them as all-day.
      o.allDay = true;
      o.startDay = E.keyFromDate(new Date(o.start));
      o.endDay = E.keyFromDate(new Date(Date.parse(o.end) - 60000));
      o.endDay = E.addDays(o.endDay, 1);
      delete o.start;
      delete o.end;
    } else if (mins <= 0) {
      const st = new Date(o.start);
      if (st.getHours() === 0 && st.getMinutes() === 0) {
        // Zero-length midnight entries (like birthdays) are all-day notes.
        o.allDay = true;
        o.startDay = E.keyFromDate(st);
        o.endDay = E.addDays(o.startDay, 1);
        delete o.start;
        delete o.end;
      } else o.free = true;
    }
  }
  if (o.allDay) {
    if (!E.isKey(o.startDay)) return null;
    if (!E.isKey(o.endDay) || o.endDay <= o.startDay) o.endDay = E.addDays(o.startDay, 1);
  }
  return o;
}

// The same event on two calendars (e.g. a busy-mirror calendar) shows once; mirrors lose.
function dedupe(list) {
  const seen = new Map();
  const rank = (ev) => (/availab|busy|mirror/i.test(ev.calName || '') ? 1 : 0);
  for (const ev of [...list].sort((a, b) => rank(a) - rank(b))) {
    const k = `${ev.title.trim().toLowerCase()}|${ev.start || ev.startDay}|${ev.end || ev.endDay}`;
    if (!seen.has(k)) seen.set(k, ev);
  }
  return [...seen.values()];
}

// Your own Daywell script (it only answers to your device key or your sign-in key).
export const HOME_SCRIPT = 'https://script.google.com/macros/s/AKfycbwAKayPxTlOzFdFUTossoiWAacO61lw3izZAt4H2Q9h95XBZ1oInL7yV2ptgMo7QDvsMA/exec';

export class Google {
  constructor(store) {
    this.store = store;
    this.status = 'off'; // off | syncing | ok | error
    this.error = '';
    this.syncing = false;
    this.pending = false;
    this.events = new Map();
    this.months = new Map(); // 'YYYY-MM' → fetchedAt
    this.windowAt = 0;
    this.calendars = null;
    const cache = store.loadEventsCache();
    if (cache?.events) for (const ev of cache.events) this.events.set(ev.id, ev);
    this.listeners = new Set();
  }
  get configured() {
    return !!(this.store.device.gsUrl && this.store.device.gsSecret);
  }
  onChange(fn) {
    this.listeners.add(fn);
  }
  emit() {
    for (const fn of this.listeners) fn();
  }
  setStatus(status, error = '') {
    this.status = status;
    this.error = error;
    this.emit();
  }

  async request(action, params = {}, post = false) {
    const { gsUrl, gsSecret } = this.store.device;
    if (!gsUrl || !gsSecret) throw new Error('Google is not connected.');
    let res;
    try {
      if (post) {
        res = await fetch(gsUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: gsSecret, action, ...params }) });
      } else {
        const q = new URLSearchParams({ secret: gsSecret, action, ...params });
        res = await fetch(`${gsUrl}?${q}`);
      }
    } catch {
      throw new Error("Couldn't reach your Google script. Check that it's deployed as a Web app with access set to Anyone.");
    }
    let j;
    try {
      j = await res.json();
    } catch {
      throw new Error("Your Google script didn't answer as expected. Make sure you deployed it as a Web app and copied the /exec URL.");
    }
    if (!j.ok && !j.conflict) throw new Error(j.error || 'Your Google script reported an error.');
    return j;
  }

  ping() {
    return this.request('ping');
  }
  // Another device signs in with the sign-in key; the script hands back the device key.
  async signIn(phrase) {
    const url = this.store.device.gsUrl || HOME_SCRIPT;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'login', phrase }) });
    } catch {
      throw new Error('Couldn’t reach your Daywell. Check your connection and try again.');
    }
    let j;
    try {
      j = await res.json();
    } catch {
      throw new Error('Your Daywell didn’t answer. Try again in a moment.');
    }
    if (!j.ok || !j.secret) throw new Error(j.error || 'That key didn’t work.');
    return { url, secret: j.secret, claudeKey: j.claudeKey || '' };
  }
  setPhrase(phrase, claudeKey = '') {
    return this.request('setPhrase', { phrase, claudeKey }, true);
  }
  phraseInfo() {
    return this.request('phrase');
  }
  // First connection registers this device's key with the script (later devices use a setup link).
  claim() {
    return this.request('claim');
  }
  async loadCalendars() {
    const r = await this.request('calendars');
    this.calendars = r.calendars || [];
    this._on = null;
    this.emit();
    return this.calendars;
  }
  enabledCalendarIds() {
    const pref = this.store.state.shared.calendars || {};
    if (!this.calendars) {
      const on = Object.entries(pref).filter(([, v]) => v).map(([k]) => k);
      return on.length ? on : [];
    }
    return this.calendars.filter((c) => (c.id in pref ? pref[c.id] : c.selected)).map((c) => c.id);
  }

  async fetchRange(fromKey, toKey) {
    const cals = this.enabledCalendarIds();
    const r = await this.request('events', {
      start: E.localDate(fromKey).toISOString(),
      end: E.localDate(toKey).toISOString(),
      cals: JSON.stringify(cals),
    });
    // Replace everything we had inside this range.
    for (const [id, ev] of this.events) if (this.overlaps(ev, fromKey, toKey)) this.events.delete(id);
    for (const raw of r.events || []) {
      const ev = normEvent(raw);
      if (ev) this.events.set(ev.id, ev);
    }
  }
  overlaps(ev, fromKey, toKey) {
    if (ev.allDay) return ev.startDay < toKey && ev.endDay > fromKey;
    return Date.parse(ev.start) < E.localDate(toKey).getTime() && Date.parse(ev.end) > E.localDate(fromKey).getTime();
  }
  async refreshEvents(force = false) {
    if (!this.configured) return;
    if (!force && Date.now() - this.windowAt < 5 * 60000) return;
    const today = this.store.today;
    try {
      if (!this.calendars) await this.loadCalendars().catch(() => {});
      await this.fetchRange(E.addDays(today, -7), E.addDays(today, 29));
      this.windowAt = Date.now();
      this.persistEvents();
      this.store.emit('events');
    } catch (e) {
      this.setStatus('error', e.message);
    }
  }
  async ensureMonth(monthKey) {
    if (!this.configured) return;
    const fetched = this.months.get(monthKey);
    if (fetched && Date.now() - fetched < 10 * 60000) return;
    const from = `${monthKey}-01`;
    const [y, m] = monthKey.split('-').map(Number);
    const to = E.addDays(`${monthKey}-${String(E.daysInMonth(y, m)).padStart(2, '0')}`, 7);
    try {
      await this.fetchRange(E.addDays(from, -7), to);
      this.months.set(monthKey, Date.now());
      this.store.emit('events');
    } catch {
      /* calendar view just shows what it has */
    }
  }
  persistEvents() {
    const today = this.store.today;
    const keep = [...this.events.values()].filter((ev) => this.overlaps(ev, E.addDays(today, -7), E.addDays(today, 30)));
    this.store.saveEventsCache({ events: keep, at: Date.now() });
  }
  // Only calendars that are switched on, even for events cached before a calendar was turned off.
  shown(ev) {
    if (!this.calendars || !ev.cal) return true;
    if (!this._on || this._onKey !== JSON.stringify(this.store.state.shared.calendars || {})) {
      this._onKey = JSON.stringify(this.store.state.shared.calendars || {});
      this._on = new Set(this.enabledCalendarIds());
    }
    return this._on.has(ev.cal);
  }
  eventsOn(D) {
    if (!this.configured && !this.events.size) return [];
    let out = [];
    for (const ev of this.events.values()) if (this.overlaps(ev, D, E.addDays(D, 1)) && this.shown(ev)) out.push(ev);
    out = dedupe(out);
    out.sort((a, b) => (a.allDay === b.allDay ? (a.start || a.startDay).localeCompare(b.start || b.startDay) : a.allDay ? -1 : 1));
    return out;
  }
  windowEvents(days = 14) {
    const today = this.store.today;
    const end = E.addDays(today, days);
    return dedupe([...this.events.values()].filter((ev) => this.overlaps(ev, today, end) && this.shown(ev)))
      .sort((a, b) => (a.start || a.startDay + 'T00').localeCompare(b.start || b.startDay + 'T00'));
  }
  clear() {
    this.events.clear();
    this.months.clear();
    this.calendars = null;
    this.windowAt = 0;
    this.store.saveEventsCache({ events: [] });
    this.setStatus('off');
  }

  /* ---------- sync ---------- */
  async sync() {
    if (!this.configured || !this.store.device.sync) return;
    if (this.syncing) {
      this.pending = true;
      return;
    }
    this.syncing = true;
    this.setStatus('syncing');
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await this.request('load');
        const local = this.store.state;
        const remoteState = remote.data ? repairState(remote.data) : null;
        const merged = remoteState ? E.mergeStates(local, remoteState) : local;
        E.prune(merged, this.store.today);
        if (E.fingerprint(merged) !== E.fingerprint(local)) this.store.replaceState(merged, 'sync');
        const needsUpload = !remoteState || E.fingerprint(this.store.state) !== E.fingerprint(remoteState);
        if (!needsUpload) {
          this.store.setDevice({ syncRev: remote.rev, lastSync: Date.now() });
          break;
        }
        // If this upload removes things the server has, have the script keep a copy first.
        const lost = remoteState ? E.lostBetween(remoteState, this.store.state) : { tasks: [], log: [] };
        const r = await this.save(this.store.state, remote.rev, lost.tasks.length >= 3 || lost.log.length > 0);
        if (r.conflict) continue;
        this.store.setDevice({ syncRev: r.rev, lastSync: Date.now() });
        break;
      }
      this.setStatus('ok');
    } catch (e) {
      this.setStatus('error', e.message);
    } finally {
      this.syncing = false;
      if (this.pending) {
        this.pending = false;
        setTimeout(() => this.sync(), 400);
      }
    }
  }

  // Some browsers refuse to read Apps Script's reply to a POST. If that happens, send it
  // without reading the reply and confirm by loading the data back.
  async postBlind(action, params) {
    const { gsUrl, gsSecret } = this.store.device;
    await fetch(gsUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: gsSecret, action, ...params }) });
  }
  async save(state, baseRev, backup = false) {
    const extra = backup ? { backup: 1 } : {};
    try {
      return await this.request('save', { data: state, baseRev, ...extra }, true);
    } catch (e) {
      if (!/reach/i.test(e.message)) throw e;
      await this.postBlind('save', { data: state, baseRev, ...extra });
      const back = await this.request('load');
      if (back.rev === Number(baseRev) + 1 && back.data && E.fingerprint(repairState(back.data)) === E.fingerprint(state)) return { ok: true, rev: back.rev };
      return { ok: false, conflict: true, rev: back.rev };
    }
  }
  /* ---------- backups kept by your Google script ---------- */
  // null when the script is an older version without backups.
  async backups() {
    try {
      return (await this.request('backups')).backups || [];
    } catch (e) {
      if (/unknown action/i.test(e.message)) return null;
      throw e;
    }
  }
  async backupData(id) {
    const r = await this.request('backup', { id });
    return r.data ? repairState(r.data) : null;
  }
  async backupNow() {
    try {
      return (await this.request('backupNow')).backups || [];
    } catch (e) {
      if (/unknown action/i.test(e.message)) return null;
      throw e;
    }
  }

  async addEvent({ title, start, end, description }) {
    try {
      return await this.request('addEvent', { title, start, end, description }, true);
    } catch (e) {
      if (!/reach/i.test(e.message)) throw e;
      await this.postBlind('addEvent', { title, start, end, description });
      return { ok: true };
    }
  }
}
