// State, persistence, undo/redo, and every change to tasks.
import * as E from './engine.js';

const DATA_KEY = 'daywell:data:v1';
const DEVICE_KEY = 'daywell:device:v1';
const EVENTS_KEY = 'daywell:events:v1';

export const DEFAULT_SHARED = {
  name: '',
  dayStart: '07:00',
  dayEnd: '23:00',
  rollHour: 4,
  weekStart: 1,
  autoPlan: true,
  autoPlanHour: 6,
  calendars: {},
  sortBy: 'plan', // plan | priority | due | quick | big | <saved sort id>
  sorts: [], // your saved Claude sorts: { id, name, prompt }
  updatedAt: 0,
};
export const DEFAULT_DEVICE = {
  apiKey: '',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  gsUrl: '',
  gsSecret: '',
  sync: true,
  theme: 'auto',
  syncRev: null,
  lastSync: 0,
  addTarget: 'anytime',
  collapsed: { routines: true },
};

export const storage = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
      return true;
    } catch {
      return false;
    }
  },
  remove(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

export function emptyState() {
  return { v: 1, tasks: [], log: [], meta: { order: {}, plans: {}, sorted: {}, bdays: {}, dismiss: {}, timer: null, seeded: false }, shared: { ...DEFAULT_SHARED } };
}

export function repairState(s) {
  const out = emptyState();
  if (!s || typeof s !== 'object') return out;
  out.tasks = Array.isArray(s.tasks) ? s.tasks.filter((t) => t && typeof t.id === 'string') : [];
  out.log = Array.isArray(s.log) ? s.log.filter((e) => e && e.id && e.task && E.isKey(e.day)) : [];
  const m = s.meta && typeof s.meta === 'object' ? s.meta : {};
  out.meta = {
    order: m.order && typeof m.order === 'object' ? m.order : {},
    plans: m.plans && typeof m.plans === 'object' ? m.plans : {},
    sorted: m.sorted && typeof m.sorted === 'object' ? m.sorted : {},
    bdays: m.bdays && typeof m.bdays === 'object' ? m.bdays : {},
    dismiss: m.dismiss && typeof m.dismiss === 'object' ? m.dismiss : {},
    timer: m.timer || null,
    seeded: !!m.seeded,
  };
  out.shared = { ...DEFAULT_SHARED, ...(s.shared && typeof s.shared === 'object' ? s.shared : {}) };
  return out;
}

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

// Sync keeps the newest edit of each item by its timestamp. If another device's clock runs ahead,
// its edits carry future timestamps, and a later edit here would lose to them. So an edit always
// gets a timestamp past the one it replaces, whatever this device's clock says.
function stampsOf(s) {
  const m = new Map();
  for (const t of s.tasks) m.set(`t:${t.id}`, t.updatedAt || 0);
  for (const e of s.log) m.set(`l:${e.id}`, e.updatedAt || 0);
  return m;
}
function keepStampsMonotonic(s, stamps) {
  for (const t of s.tasks) {
    const was = stamps.get(`t:${t.id}`);
    if (was != null && t.updatedAt !== was && !(t.updatedAt > was)) t.updatedAt = was + 1;
  }
  for (const e of s.log) {
    const was = stamps.get(`l:${e.id}`);
    if (was != null && e.updatedAt !== was && !(e.updatedAt > was)) e.updatedAt = was + 1;
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class Store {
  constructor() {
    this.state = repairState(safeParse(storage.get(DATA_KEY)));
    this.device = { ...DEFAULT_DEVICE, ...(safeParse(storage.get(DEVICE_KEY)) || {}) };
    this.device.collapsed = { ...DEFAULT_DEVICE.collapsed, ...(this.device.collapsed || {}) };
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.saveTimer = null;
    this.changeCount = 0;
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === DATA_KEY && e.newValue) {
          const other = repairState(safeParse(e.newValue));
          this.state = E.mergeStates(this.state, other);
          this.emit('external');
        }
      });
    }
  }

  get today() {
    return E.todayKey(new Date(), this.state.shared.rollHour ?? 4);
  }
  get settings() {
    return this.state.shared;
  }
  task(id) {
    return this.state.tasks.find((t) => t.id === id) || null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(reason) {
    for (const fn of this.listeners) fn(reason);
  }

  /* ---------- persistence ---------- */
  persist() {
    this.changeCount++;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 120);
  }
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const ok = storage.set(DATA_KEY, JSON.stringify(this.state));
    if (!ok) this.emit('storage-error');
  }
  saveDevice() {
    storage.set(DEVICE_KEY, JSON.stringify(this.device));
  }
  setDevice(patch) {
    Object.assign(this.device, patch);
    this.saveDevice();
    this.emit('device');
  }
  setShared(patch) {
    this.state.shared = { ...this.state.shared, ...patch, updatedAt: Math.max(Date.now(), (this.state.shared.updatedAt || 0) + 1) };
    this.persist();
    this.emit('change');
  }
  replaceState(next, reason = 'sync') {
    this.state = repairState(next);
    this.persist();
    this.emit(reason);
  }
  loadEventsCache() {
    return safeParse(storage.get(EVENTS_KEY));
  }
  saveEventsCache(v) {
    storage.set(EVENTS_KEY, JSON.stringify(v));
  }

  /* ---------- transactions with item-level undo ---------- */
  // Undo restores only the items a step touched, so edits synced from other devices survive.
  // `meta` rides along with the undo step (for example the text the person typed), so the UI can
  // put things back where they came from when the step is undone.
  transact(label, fn, { undoable = true, meta = null } = {}) {
    const stamps = stampsOf(this.state);
    const before = undoable ? clone({ tasks: this.state.tasks, log: this.state.log, meta: this.state.meta }) : null;
    const result = fn(this.state);
    keepStampsMonotonic(this.state, stamps);
    if (undoable) {
      const diff = diffStates(before, this.state);
      if (diff.count) {
        this.undoStack.push({ label, diff, meta });
        if (this.undoStack.length > 80) this.undoStack.shift();
        this.redoStack = [];
      }
    }
    this.persist();
    this.emit('change');
    return result;
  }
  canUndo() {
    return this.undoStack.length > 0;
  }
  undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    const stamps = stampsOf(this.state);
    applyDiff(this.state, step.diff, 'before');
    keepStampsMonotonic(this.state, stamps);
    this.redoStack.push(step);
    this.persist();
    this.emit('change');
    this.onStep?.('undo', step);
    return step.label;
  }
  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    const stamps = stampsOf(this.state);
    applyDiff(this.state, step.diff, 'after');
    keepStampsMonotonic(this.state, stamps);
    this.undoStack.push(step);
    this.persist();
    this.emit('change');
    this.onStep?.('redo', step);
    return step.label;
  }

  /* ---------- task changes ---------- */
  // `again`: tasks you typed again that are already on your list. They move up (and take a date
  // if you gave one) in the same undoable step instead of being added twice.
  addTasks(list, { label, src = 'manual', meta = null, again = [] } = {}) {
    const today = this.today;
    const made = [];
    const first = list[0] ? `Added “${E.cleanTitle(list[0].title)}”` : `Moved up “${this.task(again[0]?.id)?.title || 'a task'}”`;
    this.transact(label || (list.length + again.length === 1 ? first : list.length ? `Added ${list.length} task${list.length === 1 ? '' : 's'}` : `Moved up ${again.length} tasks`), (s) => {
      for (const a of again) {
        const t = s.tasks.find((x) => x.id === a.id);
        if (!t) continue;
        t.again = { n: Math.min(9, E.againCount(t, today) + 1), at: Date.now() };
        if (a.date && !t.repeat) t.date = a.date;
        t.updatedAt = Date.now();
      }
      for (const f of list) {
        const t = E.normalizeTask({ ...f, id: undefined, src, createdAt: Date.now(), updatedAt: Date.now() }, today);
        s.tasks.push(t);
        made.push(t);
      }
    }, { meta });
    return made;
  }
  updateTask(id, changes, { label, undoable = true } = {}) {
    const t = this.task(id);
    if (!t) return null;
    return this.transact(label || `Edited “${t.title}”`, () => applyChanges(t, changes, this.today), { undoable });
  }
  complete(id, day = this.today) {
    const t = this.task(id);
    if (!t) return;
    this.transact(`Completed “${t.title}”`, (s) => markDone(s, t, day));
  }
  uncomplete(id, day) {
    const t = this.task(id);
    if (!t) return;
    this.transact(`Reopened “${t.title}”`, (s) => markUndone(s, t, day ?? t.doneDay ?? this.today));
  }
  // Partly done: logged for that day without counting as done. A one-off stays on your list, a
  // routine is marked for the day, a running timer stops and its minutes carry on to the finish.
  // Marking something you'd checked off as partly done takes the check off.
  partDone(id, day = this.today) {
    const t = this.task(id);
    if (!t) return;
    this.transact(`Partly did “${t.title}”`, (s) => {
      if (s.meta.timer?.id === t.id) this.stopTimerInner(s, true);
      const idx = E.buildIndex(s.log);
      if (t.repeat ? E.entryOn(idx, t.id, day) : t.doneDay) markUndone(s, t, t.repeat ? day : t.doneDay);
      markPart(s, t, day);
    });
  }
  // Takes back "partly done" (the one showing for that day, and any earlier ones it stood for).
  unpartDone(id, day = this.today) {
    const t = this.task(id);
    if (!t) return;
    this.transact(`Took back “partly done” on “${t.title}”`, (s) => clearPart(s, t, day, this.settings.weekStart ?? 1));
  }
  // Removes one check-in from the history (a "partly done" from the History list).
  removeEntry(entryId) {
    const e = this.state.log.find((x) => x.id === entryId && !x.deleted);
    if (!e) return;
    this.transact(`Removed a check-in for “${this.task(e.task)?.title || e.title || 'a task'}”`, () => {
      e.deleted = true;
      e.updatedAt = Date.now();
    });
  }
  skip(id, day = this.today) {
    const t = this.task(id);
    if (!t) return;
    this.transact(`Skipped “${t.title}”`, (s) => {
      const now = Date.now();
      s.log.push({ id: E.uid('l'), task: t.id, day, at: new Date().toISOString(), title: t.title, skip: true, updatedAt: now });
      t.plan = null;
      t.updatedAt = now;
    });
  }
  remove(id) {
    const t = this.task(id);
    if (!t) return;
    this.transact(`Deleted “${t.title}”`, (s) => {
      t.deletedAt = Date.now();
      t.updatedAt = Date.now();
      if (s.meta.timer?.id === id) s.meta.timer = { id: null, updatedAt: Date.now() };
    });
  }
  restore(id) {
    const t = this.task(id);
    if (!t) return;
    this.transact(`Restored “${t.title}”`, () => {
      t.deletedAt = null;
      t.updatedAt = Date.now();
    });
  }
  purge(id) {
    const t = this.task(id);
    if (!t) return;
    this.transact('Deleted forever', () => Object.assign(t, E.purgedShell(t)), { undoable: false });
  }
  // Put a task on a day (null = no date). Repeating tasks get a one-off plan instead.
  moveTo(id, day, { label } = {}) {
    const t = this.task(id);
    if (!t) return;
    this.transact(label || (day ? `Moved “${t.title}” to ${E.fmtRelDay(day, this.today)}` : `Removed the date from “${t.title}”`), (s) => moveTask(s, t, day, this.today));
  }
  setOrder(day, ids, by = 'you') {
    this.transact('Reordered', (s) => {
      s.meta.order[day] = { ids: [...ids], at: Date.now(), by };
    });
  }
  dismissSuggestion(day, id) {
    this.transact('Hid a suggestion', (s) => {
      s.meta.dismiss[day] = [...new Set([...(s.meta.dismiss[day] || []), id])];
    });
  }

  /* ---------- focus timer ---------- */
  startTimer(id) {
    this.transact('Started timer', (s) => {
      this.stopTimerInner(s, true);
      s.meta.timer = { id, start: Date.now(), updatedAt: Date.now() };
    }, { undoable: false });
  }
  stopTimerInner(s, keep) {
    const tm = s.meta.timer;
    if (!tm?.id) return true;
    const t = s.tasks.find((x) => x.id === tm.id);
    const mins = Math.round((Date.now() - tm.start) / 60000);
    if (t && keep && mins > 0) {
      t.spent = (t.spent || 0) + mins;
      t.updatedAt = Date.now();
    }
    s.meta.timer = { id: null, updatedAt: Date.now() };
    return true;
  }
  stopTimer(keep = true) {
    this.transact('Stopped timer', (s) => this.stopTimerInner(s, keep), { undoable: false });
  }
  partTimer() {
    const tm = this.state.meta.timer;
    if (!tm?.id) return null;
    const t = this.task(tm.id);
    if (!t) return this.stopTimer(false);
    this.partDone(t.id, this.today);
    return t;
  }
  finishTimer() {
    const tm = this.state.meta.timer;
    if (!tm?.id) return;
    const t = this.task(tm.id);
    if (!t) return this.stopTimer(false);
    this.transact(`Completed “${t.title}”`, (s) => {
      this.stopTimerInner(s, true);
      markDone(s, t, this.today);
    });
  }
}

function safeParse(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function applyChanges(t, changes, today) {
  const c = { ...changes };
  if ('notesAppend' in c) {
    c.notes = [t.notes, c.notesAppend].filter(Boolean).join('\n');
    delete c.notesAppend;
  }
  const next = E.normalizeTask({ ...t, ...c, updatedAt: Date.now() }, today);
  if ('repeat' in c && c.repeat && !t.repeat) next.start = c.start || t.date || today;
  if ('repeat' in c && !c.repeat && t.repeat) next.date = c.date ?? null;
  Object.assign(t, next);
  return t;
}

export function markDone(s, t, day, mins = null) {
  const now = Date.now();
  const spent = (t.spent || 0) + (mins || 0);
  s.log.push({ id: E.uid('l'), task: t.id, day, at: new Date().toISOString(), title: t.title, mins: spent || null, est: E.estMid(t), updatedAt: now });
  if (!t.repeat) {
    t.doneAt = now;
    t.doneDay = day;
  } else {
    t.plan = null;
    t.bumps = 0;
  }
  t.spent = 0;
  t.spentLogged = 0;
  t.updatedAt = now;
  if (s.meta.timer?.id === t.id) s.meta.timer = { id: null, updatedAt: now };
}

// Reopening keeps any "partly done" from that day, so it goes back to how it was before.
export function markUndone(s, t, day) {
  const now = Date.now();
  for (const e of s.log) {
    if (e.task === t.id && e.day === day && !e.deleted && !e.part) {
      e.deleted = true;
      e.updatedAt = now;
    }
  }
  if (!t.repeat) {
    t.doneAt = null;
    t.doneDay = null;
  }
  t.updatedAt = now;
}

// mins = timed minutes since the last check-in. The total keeps adding up in t.spent until the
// task is finished, so the final check-off records how long the whole thing took.
export function markPart(s, t, day) {
  const now = Date.now();
  const session = Math.max(0, (t.spent || 0) - (t.spentLogged || 0));
  s.log.push({ id: E.uid('l'), task: t.id, day, at: new Date().toISOString(), title: t.title, part: true, mins: session || null, est: E.estMid(t), updatedAt: now });
  t.spentLogged = t.spent || 0;
  t.updatedAt = now;
}

export function clearPart(s, t, day, weekStart = 1) {
  const now = Date.now();
  for (let guard = 0; guard < 50; guard++) {
    const p = E.partOf(t, E.buildIndex(s.log), day, weekStart);
    if (!p) break;
    const e = s.log.find((x) => x.id === p.id);
    e.deleted = true;
    e.updatedAt = now;
  }
  t.updatedAt = now;
}

export function moveTask(s, t, day, today) {
  const now = Date.now();
  // Count real postpones: something due now (or carried) pushed to later or to no date.
  const current = t.repeat ? t.plan || null : t.date;
  if (today && current && current <= today && (!day || day > today) && !t.doneDay) t.bumps = (t.bumps || 0) + 1;
  if (!t.repeat) {
    t.date = day;
  } else {
    t.plan = day;
  }
  if (t.doneDay && day) {
    t.doneDay = null;
    t.doneAt = null;
  }
  t.updatedAt = now;
  // Keep the saved order of the destination day sensible.
  if (day && s.meta.order[day]) {
    const o = s.meta.order[day];
    if (!o.ids.includes(t.id)) s.meta.order[day] = { ...o, ids: [...o.ids, t.id], at: now };
  }
}

/* ---------- diffs ---------- */
function diffList(before = [], after = []) {
  const b = new Map(before.map((x) => [x.id, x]));
  const a = new Map(after.map((x) => [x.id, x]));
  const out = [];
  for (const [id, x] of a) if (!b.has(id) || !same(b.get(id), x)) out.push({ id, before: b.get(id) ? clone(b.get(id)) : null, after: clone(x) });
  for (const [id, x] of b) if (!a.has(id)) out.push({ id, before: clone(x), after: null });
  return out;
}
function diffMap(before = {}, after = {}) {
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) if (!same(before?.[k], after?.[k])) out.push({ k, before: clone(before?.[k]) ?? null, after: clone(after?.[k]) ?? null });
  return out;
}
export function diffStates(before, after) {
  const d = {
    tasks: diffList(before.tasks, after.tasks),
    log: diffList(before.log, after.log),
    order: diffMap(before.meta.order, after.meta.order),
    plans: diffMap(before.meta.plans, after.meta.plans),
    sorted: diffMap(before.meta.sorted || {}, after.meta.sorted || {}),
    bdays: diffMap(before.meta.bdays || {}, after.meta.bdays || {}),
    dismiss: diffMap(before.meta.dismiss, after.meta.dismiss),
    timer: same(before.meta.timer, after.meta.timer) ? null : { before: clone(before.meta.timer), after: clone(after.meta.timer) },
    seeded: before.meta.seeded !== after.meta.seeded ? { before: before.meta.seeded, after: after.meta.seeded } : null,
  };
  d.count = d.tasks.length + d.log.length + d.order.length + d.plans.length + d.sorted.length + d.bdays.length + d.dismiss.length + (d.timer ? 1 : 0) + (d.seeded ? 1 : 0);
  return d;
}
export function applyDiff(s, d, side) {
  const now = Date.now();
  const put = (list, ch, tomb) => {
    const i = list.findIndex((x) => x.id === ch.id);
    const v = ch[side];
    const val = v ? { ...clone(v), updatedAt: now } : tomb(i > -1 ? list[i] : ch.before || ch.after);
    if (i > -1) list[i] = val;
    else list.push(val);
  };
  for (const ch of d.tasks) put(s.tasks, ch, (x) => E.purgedShell(x, now));
  for (const ch of d.log) put(s.log, ch, (x) => ({ ...x, deleted: true, updatedAt: now }));
  const putMap = (m, ch, tomb) => {
    const v = ch[side];
    m[ch.k] = v ? { ...clone(v), at: now } : tomb;
  };
  for (const ch of d.order) putMap(s.meta.order, ch, { ids: [], at: now, cleared: true });
  for (const ch of d.plans) putMap(s.meta.plans, ch, { removed: true, at: now });
  for (const ch of d.sorted || []) putMap((s.meta.sorted ||= {}), ch, { by: {}, at: now });
  for (const ch of d.bdays || []) putMap((s.meta.bdays ||= {}), ch, { ...(ch.before || ch.after || {}), gone: true, at: now });
  for (const ch of d.dismiss) s.meta.dismiss[ch.k] = clone(ch[side]) || [];
  if (d.timer) s.meta.timer = { ...(clone(d.timer[side]) || { id: null }), updatedAt: now };
  if (d.seeded) s.meta.seeded = d.seeded[side];
}
