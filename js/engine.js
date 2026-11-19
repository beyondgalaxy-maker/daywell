// Daywell engine: pure logic only (no DOM, no storage), so the same code runs
// in the browser and in Node tests.

export const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export function uid(prefix = 't') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

/* ------------------------------------------------------------------ */
/* Day keys: 'YYYY-MM-DD' in the person's local calendar               */
/* ------------------------------------------------------------------ */

export function keyFromDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// A "day" ends at rollHour (default 4 AM) so late nights still count as the same day.
export function todayKey(now = new Date(), rollHour = 4) {
  const d = new Date(now.getTime());
  if (d.getHours() < rollHour) d.setDate(d.getDate() - 1);
  return keyFromDate(d);
}
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function isKey(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return y > 1999 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}
const toUTC = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUTC = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
export const addDays = (key, n) => fromUTC(toUTC(key) + n * DAY_MS);
export const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / DAY_MS); // b − a
export const weekday = (key) => new Date(toUTC(key)).getUTCDay(); // 0 = Sunday
export const startOfWeek = (key, weekStart = 1) => addDays(key, -((weekday(key) - weekStart + 7) % 7));
export function localDate(key, minutes = 0) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, minutes);
}
export const minutesInto = (date, key) => Math.round((date.getTime() - localDate(key).getTime()) / 60000);
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const timeToMin = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
export const minToTime = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(Math.round(m) % 60)}`;
export const keyFromMs = (ms) => keyFromDate(new Date(ms));

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WD3 = WEEKDAYS.map((w) => w.slice(0, 3));
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MON3 = MONTHS.map((m) => m.slice(0, 3));

export function fmtRelDay(key, today, { long = false } = {}) {
  const d = diffDays(today, key);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d > 1 && d < 7) return long ? WEEKDAYS[weekday(key)] : WD3[weekday(key)];
  const [y, m, dd] = key.split('-').map(Number);
  const base = `${MON3[m - 1]} ${dd}`;
  return y === Number(today.slice(0, 4)) ? base : `${base}, ${y}`;
}
export function fmtLongDay(key, { year = false } = {}) {
  const [y, m, d] = key.split('-').map(Number);
  return `${WEEKDAYS[weekday(key)]}, ${MONTHS[m - 1]} ${d}${year ? `, ${y}` : ''}`;
}
export function fmtShortDate(key) {
  const [, m, d] = key.split('-').map(Number);
  return `${WD3[weekday(key)]}, ${MON3[m - 1]} ${d}`;
}
export function fmtMins(min) {
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
export function fmtEst(a, b) {
  if (a == null && b == null) return '';
  if (a == null) a = b;
  if (b == null) b = a;
  if (a === b) return fmtMins(a);
  if (a < 60 && b <= 60) return `${a}–${b}m`;
  if (a % 60 === 0 && b % 60 === 0) return `${a / 60}–${b / 60}h`;
  return `${fmtMins(a)}–${fmtMins(b)}`;
}
export function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${pad(m)} ${ap}` : `${h12} ${ap}`;
}
export function fmtClock(date) {
  return fmtTime(`${pad(date.getHours())}:${pad(date.getMinutes())}`);
}
export function fmtAge(days) {
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 14) return `${days} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ------------------------------------------------------------------ */
/* Repeats                                                             */
/* ------------------------------------------------------------------ */
// kinds: daily | weekly (days: [0..6]) | weekflex (once a week, any day)
//        interval (every N days counted from the last time it was done) | monthly (dom)

export function normRepeat(r) {
  if (!r || typeof r !== 'object') return null;
  const kind = r.kind;
  if (kind === 'daily') return { kind };
  if (kind === 'weekly') {
    const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number))]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    if (days.length === 7) return { kind: 'daily' };
    return days.length ? { kind, days } : { kind: 'weekflex' };
  }
  if (kind === 'weekflex') return { kind };
  if (kind === 'interval') {
    const every = clampInt(r.every, 1, 365, 7);
    return every === 1 ? { kind: 'daily' } : { kind, every };
  }
  if (kind === 'monthly') return { kind, dom: clampInt(r.dom, 1, 31, 1) };
  return null;
}

// "Mom's birthday", "Sam Lee's bday", "Birthday: Ana", "Happy birthday Joe!" → the person's name.
// Parties and dinners aren't birthdays to wish anyone for.
export function birthdayName(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!/\b(birthday|bday|b-day)\b/i.test(t)) return null;
  const tidy = (s) => {
    const n = String(s || '')
      .replace(/[\s!.,:;~*\-–—]+$/u, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .trim();
    return n && n.length <= 60 && !/^(party|dinner|lunch|brunch|drinks|celebration|cake|gift|present|card)\b/i.test(n) ? n : null;
  };
  let m = t.match(/^(.+?)['’]s?\s+(?:\d+\w{0,2}\s+)?(?:birthday|bday|b-day)\b/i);
  if (m) return tidy(m[1].replace(/['’]$/, ''));
  m = t.match(/^(?:happy\s+)?(?:birthday|bday|b-day)\s*(?:[:\-–—]\s*|\s(?:for|of|to)\s+|\s+)(.+)$/i);
  if (m) return tidy(m[1]);
  return null;
}

// Quick sorts for a day's open items (the default order comes from Claude's plan and your drags).
export const SORTS = {
  plan: 'Suggested',
  priority: 'Priority',
  due: 'Due date',
  quick: 'Quickest first',
  big: 'Biggest first',
};
export function sortOpen(items, how) {
  const mid = (i) => estMid(i.t);
  const due = (i) => i.t.deadline || '9999-12-31';
  const keep = new Map(items.map((i, k) => [i, k]));
  const cmp = {
    priority: (a, b) => a.t.priority - b.t.priority || due(a).localeCompare(due(b)),
    due: (a, b) => due(a).localeCompare(due(b)) || a.t.priority - b.t.priority,
    quick: (a, b) => (mid(a) ?? 1e9) - (mid(b) ?? 1e9) || a.t.priority - b.t.priority,
    big: (a, b) => (mid(b) ?? -1) - (mid(a) ?? -1) || a.t.priority - b.t.priority,
  }[how];
  if (!cmp) return items;
  return [...items].sort((a, b) => cmp(a, b) || keep.get(a) - keep.get(b));
}
// Put items in a saved order (ids); anything new keeps its place after them.
export function applyOrder(items, ids) {
  const pos = new Map((ids || []).map((id, k) => [id, k]));
  const keep = new Map(items.map((i, k) => [i, k]));
  return [...items].sort((a, b) => (pos.get(a.id) ?? 1e6 + keep.get(a)) - (pos.get(b.id) ?? 1e6 + keep.get(b)));
}

// The day's backbone: routines that come back every day (or every weekday).
export function isDaily(t) {
  const r = t?.repeat;
  if (!r) return false;
  return r.kind === 'daily' || (r.kind === 'weekly' && (r.days || []).length >= 5);
}

const mondayFirst = (a, b) => ((a + 6) % 7) - ((b + 6) % 7);
export function describeRepeat(r, { long = false } = {}) {
  if (!r) return '';
  switch (r.kind) {
    case 'daily':
      return 'Every day';
    case 'weekly': {
      const d = [...r.days].sort(mondayFirst);
      const j = [...r.days].sort((a, b) => a - b).join();
      if (j === '1,2,3,4,5') return 'Weekdays';
      if (j === '0,6') return 'Weekends';
      if (d.length === 1) return `Every ${WEEKDAYS[d[0]]}`;
      return `Every ${d.map((x) => WD3[x]).join(', ')}`;
    }
    case 'weekflex':
      return long ? 'Once a week, any day' : 'Once a week';
    case 'interval': {
      const base = r.every % 7 === 0 ? (r.every === 7 ? 'Every week' : `Every ${r.every / 7} weeks`) : `Every ${r.every} days`;
      return long ? `${base}, counted from the last time you did it` : base;
    }
    case 'monthly':
      return `Monthly on the ${ordinal(r.dom)}`;
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export function cleanTitle(s) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (/^[a-z]/.test(t) && !/^[a-z][A-Z]/.test(t)) t = t[0].toUpperCase() + t.slice(1);
  return t;
}
export function cleanArea(s) {
  const t = String(s ?? '').replace(/^#/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}
const minutesOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 60) : null;
};

export function normalizeTask(input, today) {
  let estMin = minutesOrNull(input.estMin);
  let estMax = minutesOrNull(input.estMax);
  if (estMin == null) estMin = estMax;
  if (estMax == null) estMax = estMin;
  if (estMin != null && estMax < estMin) [estMin, estMax] = [estMax, estMin];
  const repeat = normRepeat(input.repeat);
  const now = Date.now();
  const t = {
    id: input.id || uid('t'),
    title: cleanTitle(input.title) || 'Untitled',
    notes: String(input.notes ?? '').slice(0, 4000),
    priority: [1, 2, 3, 4].includes(Number(input.priority)) ? Number(input.priority) : 3,
    area: cleanArea(input.area),
    estMin,
    estMax,
    optional: !!input.optional,
    date: isKey(input.date) ? input.date : null,
    deadline: isKey(input.deadline) ? input.deadline : null,
    time: isTime(input.time) ? input.time : null,
    repeat,
    start: isKey(input.start) ? input.start : today,
    plan: isKey(input.plan) ? input.plan : null,
    spent: Math.max(0, Math.round(Number(input.spent) || 0)),
    bumps: Math.max(0, Math.round(Number(input.bumps) || 0)),
    doneAt: input.doneAt || null,
    doneDay: isKey(input.doneDay) ? input.doneDay : null,
    paused: !!input.paused,
    ai: input.ai && (input.ai.note || input.ai.focus) ? { note: String(input.ai.note || '').slice(0, 240), day: input.ai.day || today, focus: !!input.ai.focus } : null,
    auto: input.auto && input.auto.kind === 'birthday' && isKey(input.auto.day) ? { kind: 'birthday', day: input.auto.day, who: String(input.auto.who || '').slice(0, 80) } : null,
    src: input.src === 'ai' ? 'ai' : 'manual',
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
    deletedAt: input.deletedAt || null,
  };
  if (repeat) {
    // Repeating tasks use `start` instead of a one-off date.
    if (isKey(input.date) && !isKey(input.start)) t.start = input.date;
    t.date = null;
    t.doneAt = null;
    t.doneDay = null;
  }
  return t;
}

export const estMid = (t) => {
  if (t.estMin == null && t.estMax == null) return null;
  const a = t.estMin ?? t.estMax;
  const b = t.estMax ?? t.estMin;
  return Math.round((a + b) / 2);
};

/* ------------------------------------------------------------------ */
/* Completion log index                                                */
/* ------------------------------------------------------------------ */

export function buildIndex(log) {
  const byTask = new Map();
  const byDay = new Map();
  for (const e of log) {
    if (e.deleted) continue;
    let a = byTask.get(e.task);
    if (!a) byTask.set(e.task, (a = []));
    a.push(e);
    let b = byDay.get(e.day);
    if (!b) byDay.set(e.day, (b = []));
    b.push(e);
  }
  for (const a of byTask.values()) a.sort((x, y) => (x.day === y.day ? (x.at < y.at ? -1 : 1) : x.day < y.day ? -1 : 1));
  return { byTask, byDay };
}
const entriesOf = (idx, id) => idx.byTask.get(id) || [];
export const entryOn = (idx, id, day) => entriesOf(idx, id).find((e) => e.day === day) || null;
export const entriesBetween = (idx, id, a, b) => entriesOf(idx, id).filter((e) => e.day >= a && e.day <= b);
export function lastDoneDay(idx, id, onOrBefore = null) {
  const a = entriesOf(idx, id);
  for (let i = a.length - 1; i >= 0; i--) if (!a[i].skip && (!onOrBefore || a[i].day <= onOrBefore)) return a[i].day;
  return null;
}
export const doneCount = (idx, id) => entriesOf(idx, id).filter((e) => !e.skip).length;

/* ------------------------------------------------------------------ */
/* Recurrence                                                          */
/* ------------------------------------------------------------------ */

export function scheduledOn(t, D) {
  const r = t.repeat;
  if (!r) return false;
  if (t.start && D < t.start) return false;
  if (r.kind === 'daily') return true;
  if (r.kind === 'weekly') return r.days.includes(weekday(D));
  if (r.kind === 'monthly') {
    const [y, m, d] = D.split('-').map(Number);
    return d === Math.min(r.dom, daysInMonth(y, m));
  }
  return false;
}
export function prevScheduled(t, D, back = 35) {
  for (let i = 0; i <= back; i++) {
    const k = addDays(D, -i);
    if (t.start && k < t.start) return null;
    if (scheduledOn(t, k)) return k;
  }
  return null;
}
export function nextScheduled(t, D, ahead = 62) {
  for (let i = 0; i <= ahead; i++) {
    const k = addDays(D, i);
    if (scheduledOn(t, k)) return k;
  }
  return null;
}
export function intervalDue(t, idx) {
  const last = lastDoneDay(idx, t.id);
  return last ? addDays(last, t.repeat.every) : t.start || null;
}
// When is this task next expected? Used for the routines list and AI context.
export function nextDue(t, idx, today, weekStart = 1) {
  const r = t.repeat;
  if (!r) return t.date || null;
  if (t.paused) return null;
  if (r.kind === 'interval') return t.plan || intervalDue(t, idx);
  if (r.kind === 'weekflex') {
    const s = startOfWeek(today, weekStart);
    if (entriesBetween(idx, t.id, s, addDays(s, 6)).length) return addDays(s, 7);
    return t.plan && t.plan >= today ? t.plan : today;
  }
  if (r.kind === 'daily') return entryOn(idx, t.id, today) ? addDays(today, 1) : today;
  const p = prevScheduled(t, today);
  if (p && !entriesOf(idx, t.id).some((e) => e.day >= p)) return t.plan && t.plan > today ? t.plan : today;
  return nextScheduled(t, addDays(today, 1));
}

/* ------------------------------------------------------------------ */
/* What shows up on a given day                                        */
/* ------------------------------------------------------------------ */
// item: { t, id, day, status: 'open'|'done'|'skip'|'miss', carried, routine, ... }

export function dayItems(state, idx, D, today, settings = {}) {
  const ws = settings.weekStart ?? 1;
  const out = [];
  for (const t of state.tasks) {
    if (t.deletedAt) continue;
    const it = t.repeat ? recurringOn(t, D, today, idx, ws) : oneTimeOn(t, D, today);
    if (it) out.push(it);
  }
  return out;
}

function oneTimeOn(t, D, today) {
  const base = { t, id: t.id, day: D };
  if (t.doneDay) return t.doneDay === D ? { ...base, status: 'done' } : null;
  if (D === today) {
    if ((t.date && t.date <= D) || (t.deadline && t.deadline <= D)) {
      return { ...base, status: 'open', carried: t.date && t.date < D ? t.date : null };
    }
    return null;
  }
  if (D > today) {
    if (t.date === D) return { ...base, status: 'open' };
    if (t.deadline === D) return { ...base, status: 'open', dueOnly: true }; // show deadlines on their day
    return null;
  }
  return t.date === D ? { ...base, status: 'open', past: true } : null;
}

function recurringOn(t, D, today, idx, ws) {
  const base = { t, id: t.id, day: D, routine: true };
  if (t.start && D < t.start) return null;
  const k = t.repeat.kind;
  const e = entryOn(idx, t.id, D);
  if (e) return { ...base, status: e.skip ? 'skip' : 'done', entry: e };
  if (t.paused) return null;
  if (D < today) {
    if (k === 'daily' || ((k === 'weekly' || k === 'monthly') && scheduledOn(t, D))) return { ...base, status: 'miss' };
    return null;
  }
  if (D === today) {
    if (k === 'daily') return { ...base, status: 'open' };
    if (k === 'weekly' || k === 'monthly') {
      const p = prevScheduled(t, D);
      if (!p) return t.plan === D ? { ...base, status: 'open' } : null;
      if (entriesOf(idx, t.id).some((x) => x.day >= p)) return null;
      if (t.plan && t.plan > D) return null;
      return { ...base, status: 'open', carried: p < D ? p : null };
    }
    if (k === 'weekflex') {
      const s = startOfWeek(D, ws);
      const end = addDays(s, 6);
      if (entriesBetween(idx, t.id, s, end).length) return null;
      const left = diffDays(D, end);
      const planned = t.plan && t.plan >= s && t.plan <= D;
      return planned || left <= 1 ? { ...base, status: 'open', flexLeft: left } : null;
    }
    if (k === 'interval') {
      const due = intervalDue(t, idx);
      const eff = t.plan || due;
      if (eff && eff <= D) return { ...base, status: 'open', lateDays: due ? Math.max(0, diffDays(due, D)) : 0 };
      return null;
    }
    return null;
  }
  // future days
  if (k === 'daily') return { ...base, status: 'open', future: true };
  if (k === 'weekly' || k === 'monthly') return scheduledOn(t, D) || t.plan === D ? { ...base, status: 'open', future: true } : null;
  if (k === 'weekflex') return t.plan === D ? { ...base, status: 'open', future: true } : null;
  if (k === 'interval') {
    const eff = t.plan || intervalDue(t, idx);
    return eff === D ? { ...base, status: 'open', future: true } : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Scoring: what deserves attention                                    */
/* ------------------------------------------------------------------ */

const PRIORITY_WEIGHT = { 1: 100, 2: 55, 3: 25, 4: 5 };
export const PRIORITY_NAMES = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };

export function scoreTask(t, { today, idx, weekStart = 1 }) {
  let s = PRIORITY_WEIGHT[t.priority] ?? 25;
  const why = [];
  if (t.priority === 1) why.push('Urgent');
  if (t.deadline) {
    const d = diffDays(today, t.deadline);
    if (d < 0) {
      s += 120 + Math.min(60, -d * 10);
      why.push(`Overdue by ${fmtAge(-d)}`);
    } else if (d === 0) {
      s += 110;
      why.push('Due today');
    } else if (d === 1) {
      s += 85;
      why.push('Due tomorrow');
    } else if (d <= 7) {
      s += 72 - d * 7;
      why.push(`Due ${fmtRelDay(t.deadline, today, { long: true })}`);
    } else s += Math.max(0, 20 - (d - 7));
  }
  // Lead time: a long task due soon needs to start earlier than a short one.
  const est0 = estMid(t);
  if (t.deadline && est0) {
    const left = diffDays(today, t.deadline);
    if (left >= 0 && left <= 14) {
      const lead = Math.min(50, est0 / Math.max(1, left) / 6);
      s += lead;
      if (lead >= 12 && !why.some((w) => w.startsWith('Due') || w.startsWith('Overdue'))) why.push(`Needs ~${fmtMins(est0)} before ${fmtRelDay(t.deadline, today, { long: true })}`);
    }
  }
  if (t.bumps) {
    s += Math.min(40, t.bumps * 10);
    if (t.bumps >= 2) why.push(`Pushed back ${t.bumps} times`);
  }
  if (!t.repeat) {
    if (t.date && t.date < today) {
      const carried = diffDays(t.date, today);
      s += 12 + Math.min(30, carried * 3);
      if (carried >= 2) why.push(`Carried over ${carried} days`);
    }
    if (!t.deadline) {
      const age = Math.max(0, diffDays(keyFromMs(t.createdAt), today));
      s += Math.min(35, age * 1.2);
      if (age >= 7) why.push(`Waiting ${fmtAge(age)}`);
    }
  } else {
    const k = t.repeat.kind;
    if (k === 'interval') {
      const last = lastDoneDay(idx, t.id);
      const since = last ? diffDays(last, today) : null;
      const ratio = since == null ? 1 : since / t.repeat.every;
      if (ratio >= 1) {
        s += 40 + Math.min(60, (ratio - 1) * 30);
        why.push(since == null ? 'Not done yet' : `Last done ${fmtAge(since)} ago`);
      } else if (ratio >= 0.8) {
        s += 15;
        why.push('Due soon');
      }
    } else if (k === 'weekflex') {
      const left = diffDays(today, addDays(startOfWeek(today, weekStart), 6));
      s += (6 - left) * 12;
      why.push(left === 0 ? 'Last day this week' : `${left + 1} days left this week`);
    } else if (k === 'daily') s += 20;
  }
  if (t.optional) s -= 30;
  const est = estMid(t);
  if (est != null && est <= 15) s += 6;
  return { score: Math.round(s), reason: why[0] || null, reasons: why };
}

// Tasks worth pulling into today that aren't there yet.
export function suggestions(state, idx, today, inToday, settings = {}, limit = 3) {
  const ws = settings.weekStart ?? 1;
  const dismissed = new Set(state.meta?.dismiss?.[today] || []);
  const ctx = { today, idx, weekStart: ws };
  const out = [];
  for (const t of state.tasks) {
    if (t.deletedAt || t.paused || inToday.has(t.id) || dismissed.has(t.id)) continue;
    if (!t.repeat) {
      if (t.doneDay) continue;
      if (t.date && t.date > today && !(t.deadline && diffDays(today, t.deadline) <= 2)) continue;
    } else {
      const k = t.repeat.kind;
      if (k === 'daily' || k === 'weekly' || k === 'monthly') continue;
      if (k === 'weekflex') {
        const s = startOfWeek(today, ws);
        if (entriesBetween(idx, t.id, s, addDays(s, 6)).length) continue;
        if (t.plan && t.plan > today) continue;
      }
      if (k === 'interval') {
        const eff = t.plan || intervalDue(t, idx);
        if (!eff || diffDays(today, eff) > 2) continue;
      }
    }
    const sc = scoreTask(t, ctx);
    if (sc.score >= 60 || (sc.reasons.length && sc.score >= 45)) out.push({ t, ...sc });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// Order open items for a day: saved order first (manual or AI), then by score.
export function orderOpen(items, D, state, ctx) {
  const saved = state.meta?.order?.[D]?.ids || [];
  const pos = new Map(saved.map((id, i) => [id, i]));
  const rows = items.map((it) => ({ it, sc: scoreTask(it.t, ctx).score, p: pos.has(it.id) ? pos.get(it.id) : null }));
  const placed = rows.filter((r) => r.p != null).sort((a, b) => a.p - b.p);
  const rest = rows.filter((r) => r.p == null).sort((a, b) => b.sc - a.sc);
  const urgent = rest.filter((r) => r.it.t.priority === 1 || (r.it.t.deadline && r.it.t.deadline <= D));
  const normal = rest.filter((r) => !urgent.includes(r));
  return [...urgent, ...placed, ...normal].map((r) => r.it);
}

/* ------------------------------------------------------------------ */
/* Time: workload vs free time                                         */
/* ------------------------------------------------------------------ */

export function workload(items) {
  let mins = 0;
  let unknown = 0;
  for (const it of items) {
    if (it.status !== 'open') continue;
    const m = estMid(it.t);
    if (m == null) unknown++;
    else mins += Math.max(0, m - (it.t.spent || 0));
  }
  return { mins, unknown };
}

// Free minutes in the planning window, after calendar events. Times are minutes after local midnight of D.
export function freeTime({ events = [], D, dayStart = '07:00', dayEnd = '23:00', now = null }) {
  const start = timeToMin(dayStart);
  let end = timeToMin(dayEnd);
  if (end <= start) end += 24 * 60;
  let from = start;
  if (now) {
    const n = minutesInto(now, D);
    if (n > from) from = Math.min(n, end);
  }
  const busy = [];
  for (const ev of events) {
    if (ev.allDay || ev.free) continue;
    const a = Math.max(from, minutesInto(new Date(ev.start), D));
    const b = Math.min(end, minutesInto(new Date(ev.end), D));
    if (b > a) busy.push([a, b]);
  }
  busy.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const iv of busy) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([...iv]);
  }
  const gaps = [];
  let cur = from;
  for (const [a, b] of merged) {
    if (a > cur) gaps.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (cur < end) gaps.push([cur, end]);
  return { start, end, from, busy: merged, gaps, free: gaps.reduce((s, [a, b]) => s + b - a, 0) };
}

// Free time and planned work for each of the next `days` days (today counts from now).
export function weekCapacity(state, idx, today, settings, eventsOn, now = new Date(), days = 7) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const D = addDays(today, i);
    const evs = eventsOn ? eventsOn(D).filter((e) => !e.allDay) : [];
    const ft = freeTime({ events: evs, D, dayStart: settings.dayStart, dayEnd: settings.dayEnd, now: i === 0 ? now : null });
    const items = dayItems(state, idx, D, today, settings).filter((x) => x.status === 'open' && !x.dueOnly);
    const load = workload(items);
    out.push({
      date: D,
      weekday: WEEKDAYS[weekday(D)],
      freeMinutes: ft.free,
      busyMinutes: ft.busy.reduce((a, [x, y]) => a + (y - x), 0),
      plannedMinutes: load.mins,
      unestimatedTasks: load.unknown,
      deadlines: state.tasks.filter((t) => !t.deletedAt && !t.purged && !t.doneDay && t.deadline === D).map((t) => t.title),
    });
  }
  return out;
}

// Average real minutes from timed completions of this task.
export function typicalMinutes(idx, id) {
  const mins = (idx.byTask.get(id) || []).filter((e) => !e.skip && e.mins).map((e) => e.mins);
  if (mins.length < 2) return null;
  return Math.round(mins.reduce((a, b) => a + b, 0) / mins.length);
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export function doneCountsByDay(log) {
  const m = new Map();
  for (const e of log) if (!e.deleted && !e.skip) m.set(e.day, (m.get(e.day) || 0) + 1);
  return m;
}

export function routineTrail(t, idx, today, n = 14) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const D = addDays(today, -i);
    if (t.start && D < t.start) {
      out.push({ day: D, s: 'off' });
      continue;
    }
    const e = entryOn(idx, t.id, D);
    if (e) {
      out.push({ day: D, s: e.skip ? 'skip' : 'done' });
      continue;
    }
    const k = t.repeat.kind;
    const sched = k === 'daily' || ((k === 'weekly' || k === 'monthly') && scheduledOn(t, D));
    out.push({ day: D, s: !sched || t.paused ? 'off' : D === today ? 'today' : 'miss' });
  }
  return out;
}

export function streak(t, idx, today, weekStart = 1) {
  const k = t.repeat?.kind;
  if (!k || k === 'interval') return 0;
  let n = 0;
  if (k === 'weekflex') {
    let s = startOfWeek(today, weekStart);
    if (!entriesBetween(idx, t.id, s, addDays(s, 6)).some((e) => !e.skip)) s = addDays(s, -7);
    for (let i = 0; i < 200; i++) {
      if (t.start && addDays(s, 6) < t.start) break;
      if (entriesBetween(idx, t.id, s, addDays(s, 6)).some((e) => !e.skip)) n++;
      else break;
      s = addDays(s, -7);
    }
    return n;
  }
  // daily / weekly / monthly: walk back through scheduled occurrences.
  let occ = prevScheduled(t, today, 400);
  let guard = 0;
  while (occ && guard++ < 500) {
    const next = nextScheduled(t, addDays(occ, 1), 62) || addDays(today, 1);
    const handled = entriesBetween(idx, t.id, occ, addDays(next, -1));
    const done = handled.some((e) => !e.skip);
    const skipped = !done && handled.some((e) => e.skip);
    if (done) n++;
    else if (!skipped && !(next > today)) break; // an occurrence still open today doesn't break the streak
    occ = prevScheduled(t, addDays(occ, -1), 400);
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Sync: merge two copies of the data without losing edits            */
/* ------------------------------------------------------------------ */

function pickNewer(x, y) {
  const a = x.updatedAt || 0;
  const b = y.updatedAt || 0;
  if (a !== b) return b > a ? y : x;
  return JSON.stringify(y) > JSON.stringify(x) ? y : x; // deterministic tie-break
}
function mergeById(a = [], b = []) {
  const m = new Map();
  for (const x of a) m.set(x.id, x);
  for (const y of b) {
    const x = m.get(y.id);
    m.set(y.id, x ? pickNewer(x, y) : y);
  }
  return [...m.values()];
}
function mergeKeyed(a = {}, b = {}, stamp = 'at') {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (!cur || (v?.[stamp] || 0) > (cur?.[stamp] || 0)) out[k] = v;
  }
  return out;
}
export function mergeStates(local, remote) {
  if (!remote || !Array.isArray(remote.tasks)) return local;
  const lm = local.meta || {};
  const rm = remote.meta || {};
  const dismiss = { ...(lm.dismiss || {}) };
  for (const [k, ids] of Object.entries(rm.dismiss || {})) dismiss[k] = [...new Set([...(dismiss[k] || []), ...ids])];
  const timer = (rm.timer?.updatedAt || 0) > (lm.timer?.updatedAt || 0) ? rm.timer : lm.timer || null;
  const shared = (remote.shared?.updatedAt || 0) > (local.shared?.updatedAt || 0) ? remote.shared : local.shared;
  return {
    v: 1,
    tasks: mergeById(local.tasks, remote.tasks),
    log: mergeById(local.log, remote.log),
    meta: {
      order: mergeKeyed(lm.order, rm.order),
      plans: mergeKeyed(lm.plans, rm.plans),
      sorted: mergeKeyed(lm.sorted, rm.sorted),
      dismiss,
      timer,
      seeded: !!(lm.seeded || rm.seeded),
    },
    shared,
  };
}

// Stable fingerprint of the synced data, to skip no-op uploads.
export function fingerprint(state) {
  const s = JSON.stringify([state.tasks.map((t) => [t.id, t.updatedAt]), state.log.map((e) => [e.id, e.updatedAt]), state.meta, state.shared?.updatedAt]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

// Drop old tombstones and old per-day metadata.
export function prune(state, today, now = Date.now()) {
  const tombstoneCutoff = now - 45 * DAY_MS;
  const trashCutoff = now - 30 * DAY_MS;
  for (const t of state.tasks) {
    if (t.deletedAt && !t.purged && t.deletedAt < trashCutoff) Object.assign(t, purgedShell(t, now));
  }
  state.tasks = state.tasks.filter((t) => !(t.purged && (t.updatedAt || 0) < tombstoneCutoff));
  state.log = state.log.filter((e) => !(e.deleted && (e.updatedAt || 0) < tombstoneCutoff));
  const oldest = addDays(today, -60);
  for (const key of ['order', 'plans', 'dismiss', 'sorted']) {
    const m = state.meta?.[key];
    if (m) for (const d of Object.keys(m)) if (d < oldest) delete m[d];
  }
  return state;
}
export function purgedShell(t, now = Date.now()) {
  return { id: t.id, title: '', notes: '', purged: true, deletedAt: t.deletedAt || now, updatedAt: now, repeat: null, createdAt: t.createdAt };
}

/* ------------------------------------------------------------------ */
/* Quick add: understand "call mom tomorrow 3pm 15m p2 #family"        */
/* ------------------------------------------------------------------ */
// Only trailing words are read, so titles like "Watch 3 hours of lectures" stay intact.

const WD_RE = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday|s)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const WD_LOOKUP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const wdIndex = (w) => WD_LOOKUP[w.toLowerCase().slice(0, 3)];
const MONTH_LOOKUP = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, few: 3, couple: 2, other: 2 };
const toNum = (s) => (/^\d+$/.test(s) ? Number(s) : NUM_WORDS[s] ?? NaN);

function futureMonthDay(today, m, d) {
  const y = Number(today.slice(0, 4));
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  let k = `${y}-${pad(m)}-${pad(d)}`;
  if (k < today) {
    if (d > daysInMonth(y + 1, m)) return null;
    k = `${y + 1}-${pad(m)}-${pad(d)}`;
  }
  return k;
}

export function resolveDate(phrase, today, weekStart = 1) {
  const p = phrase.toLowerCase().trim().replace(/\s+/g, ' ');
  let m;
  if (/^(today|tod|tonight|this evening|this afternoon|this morning)$/.test(p)) return today;
  if (/^(tomorrow|tmr|tmrw|tmw|tom)$/.test(p)) return addDays(today, 1);
  if (/^(day after tomorrow)$/.test(p)) return addDays(today, 2);
  if ((m = p.match(new RegExp(`^(?:(this|next|on) )?(${WD_RE})$`)))) {
    const target = wdIndex(m[2]);
    let ahead = (target - weekday(today) + 7) % 7;
    if (m[1] === 'this') return addDays(today, ahead);
    if (ahead === 0) ahead = 7;
    let k = addDays(today, ahead);
    if (m[1] === 'next' && k <= addDays(startOfWeek(today, weekStart), 6)) k = addDays(k, 7);
    return k;
  }
  if (p === 'next week') return addDays(startOfWeek(today, weekStart), 7);
  if (/^(this weekend|weekend|the weekend)$/.test(p)) {
    const wd = weekday(today);
    return wd === 6 || wd === 0 ? today : addDays(today, 6 - wd);
  }
  if (p === 'next weekend') {
    const wd = weekday(today);
    const sat = wd === 6 ? today : wd === 0 ? addDays(today, -1) : addDays(today, 6 - wd);
    return addDays(sat, 7);
  }
  if (/^(end of (the )?week|eow)$/.test(p)) return addDays(startOfWeek(today, weekStart), 6);
  if (/^(end of (the )?month|eom)$/.test(p)) {
    const [y, mo] = today.split('-').map(Number);
    return `${y}-${pad(mo)}-${pad(daysInMonth(y, mo))}`;
  }
  if ((m = p.match(/^in (\d+|a|an|one|two|three|four|five|six|seven|a few|a couple of|a couple) (day|days|week|weeks|month|months)$/))) {
    const n = toNum(m[1].replace(/^a (few|couple)( of)?$/, '$1'));
    if (!Number.isFinite(n)) return null;
    if (m[2].startsWith('day')) return addDays(today, n);
    if (m[2].startsWith('week')) return addDays(today, n * 7);
    const [y, mo, d] = today.split('-').map(Number);
    const tm = mo - 1 + n;
    const ny = y + Math.floor(tm / 12);
    const nm = (tm % 12) + 1;
    return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
  }
  if ((m = p.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/))) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const k = `${y}-${pad(mo)}-${pad(d)}`;
      return isKey(k) ? k : null;
    }
    return futureMonthDay(today, mo, d);
  }
  if ((m = p.match(new RegExp(`^(?:on )?(${MONTH_RE})\\.? (\\d{1,2})(?:st|nd|rd|th)?$`)))) {
    return futureMonthDay(today, MONTH_LOOKUP[m[1].slice(0, 3)], Number(m[2]));
  }
  if ((m = p.match(new RegExp(`^(?:on )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTH_RE})$`)))) {
    return futureMonthDay(today, MONTH_LOOKUP[m[2].slice(0, 3)], Number(m[1]));
  }
  if (isKey(p)) return p;
  return null;
}

function parseDuration(p) {
  let m;
  const unit = '(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)';
  const toMin = (n, u) => Math.round(u.startsWith('h') ? n * 60 : n);
  if ((m = p.match(new RegExp(`^(?:for |~ ?|about |around |approx )?(\\d+(?:\\.\\d+)?) ?(?:-|–|to) ?(\\d+(?:\\.\\d+)?) ?${unit}$`)))) {
    const a = toMin(Number(m[1]), m[3]);
    const b = toMin(Number(m[2]), m[3]);
    return a > 0 && b > 0 ? [Math.min(a, b), Math.max(a, b)] : null;
  }
  if ((m = p.match(/^(?:for |~ ?)?(\d+) ?h(?:r|rs|ours?)? ?(\d+) ?m?(?:in|ins|inutes?)?$/))) {
    const v = Number(m[1]) * 60 + Number(m[2]);
    return v > 0 ? [v, v] : null;
  }
  if ((m = p.match(new RegExp(`^(?:for |~ ?|about |around |approx )?(\\d+(?:\\.\\d+)?|an|a|half an) ?${unit}$`)))) {
    const n = m[1] === 'half an' ? 0.5 : m[1] === 'an' || m[1] === 'a' ? 1 : Number(m[1]);
    const v = toMin(n, m[2]);
    return v > 0 && v <= 24 * 60 ? [v, v] : null;
  }
  return null;
}

function parseTime(p) {
  let m;
  if ((m = p.match(/^(?:at |@ ?)?(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)$/))) {
    let h = Number(m[1]);
    const mi = Number(m[2] || 0);
    if (h < 1 || h > 12 || mi > 59) return null;
    const pm = m[3].startsWith('p');
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    return `${pad(h)}:${pad(mi)}`;
  }
  if ((m = p.match(/^(?:at |@ ?)(\d{1,2}):(\d{2})$/))) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    return h < 24 && mi < 60 ? `${pad(h)}:${pad(mi)}` : null;
  }
  if (/^(?:at )?noon$/.test(p)) return '12:00';
  if ((m = p.match(/^at (\d{1,2})$/))) {
    let h = Number(m[1]);
    if (h < 1 || h > 12) return null;
    if (h <= 7) h += 12;
    return `${pad(h)}:00`;
  }
  return null;
}

function parseRepeat(p, today) {
  let m;
  if (/^(every ?day|daily|each day)$/.test(p)) return { kind: 'daily' };
  if (/^(every weekday|weekdays|on weekdays)$/.test(p)) return { kind: 'weekly', days: [1, 2, 3, 4, 5] };
  if (/^(every weekend|weekends|on weekends)$/.test(p)) return { kind: 'weekly', days: [0, 6] };
  if (/^every other day$/.test(p)) return { kind: 'interval', every: 2 };
  if ((m = p.match(/^every (\d+|two|three|four|five|six|seven|few|couple of|couple) days$/))) {
    const n = toNum(m[1].replace(' of', ''));
    return Number.isFinite(n) ? normRepeat({ kind: 'interval', every: n }) : null;
  }
  if (/^(weekly|every week|once a week|once per week|once weekly)$/.test(p)) return { kind: 'weekflex' };
  if (/^(biweekly|every other week|every two weeks)$/.test(p)) return { kind: 'interval', every: 14 };
  if ((m = p.match(/^every (\d+|two|three|four|five|six) weeks$/))) {
    const n = toNum(m[1]);
    return Number.isFinite(n) ? normRepeat({ kind: 'interval', every: n * 7 }) : null;
  }
  if (/^(monthly|every month|once a month)$/.test(p)) return { kind: 'monthly', dom: Number(today.slice(8, 10)) };
  if ((m = p.match(/^(?:every|on the) (\d{1,2})(?:st|nd|rd|th)(?: of (?:the|every) month)?$/))) {
    const d = Number(m[1]);
    return d >= 1 && d <= 31 ? { kind: 'monthly', dom: d } : null;
  }
  if ((m = p.match(new RegExp(`^every (${WD_RE}(?:(?:, ?| and | & | |, and )${WD_RE})*)$`)))) {
    const days = m[1].split(/, and |, ?| and | & | /).filter(Boolean).map(wdIndex);
    return normRepeat({ kind: 'weekly', days });
  }
  if ((m = p.match(/^(?:on )?(mon|tues|wednes|thurs|fri|satur|sun)days$/))) return { kind: 'weekly', days: [wdIndex(m[1])] };
  return null;
}

const FIELD_LABEL = {
  date: (v, today) => fmtRelDay(v, today, { long: true }),
  deadline: (v, today) => `Due ${fmtRelDay(v, today, { long: true })}`,
  time: (v) => fmtTime(v),
  est: (v) => fmtEst(v[0], v[1]),
  priority: (v) => `P${v}`,
  repeat: (v) => describeRepeat(v),
  area: (v) => `#${v}`,
  optional: () => 'Optional',
};

export function parseQuick(input, today, { weekStart = 1 } = {}) {
  const original = String(input ?? '').replace(/\s+/g, ' ').trim();
  const res = { title: original, date: null, deadline: null, time: null, estMin: null, estMax: null, priority: null, repeat: null, area: '', optional: false, chips: [] };
  if (!original) return res;
  const words = original.split(' ');
  const found = {};
  const tryPhrase = (p) => {
    let l = p.toLowerCase();
    if (!/^(?:p|!)[1-4]$/.test(l)) l = l.replace(/[.,;!?]+$/, '');
    let v;
    if (!found.priority && (v = l.match(/^(?:p|!)([1-4])$/))) return ['priority', Number(v[1])];
    if (!found.area && /^#[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(p)) return ['area', cleanArea(p)];
    if (!found.optional && /^\(?(optional|opt)\)?$/.test(l)) return ['optional', true];
    if (!found.est && (v = parseDuration(l))) return ['est', v];
    if (!found.time && (v = parseTime(l))) return ['time', v];
    if (!found.repeat && (v = parseRepeat(l, today))) return ['repeat', v];
    if (!found.deadline && (v = l.match(/^(?:by|due|due on|before|deadline)\s+(.+)$/)) && (v = resolveDate(v[1], today, weekStart))) return ['deadline', v];
    if (!found.date && !/^(sun|sat|wed|mar|may|jun|jul|aug|sep|oct|nov|dec|jan|feb|apr|tue|thu|fri|mon)$/.test(l) && (v = resolveDate(l, today, weekStart))) return ['date', v];
    // Abbreviated weekdays only when introduced ("on sat") or as the very last word.
    if (!found.date && /^(on|this|next) /.test(l) && (v = resolveDate(l, today, weekStart))) return ['date', v];
    return null;
  };
  let end = words.length;
  let lastWord = true;
  let guard = 0;
  while (end > 1 && guard++ < 12) {
    let hit = null;
    for (let n = Math.min(6, end - 1); n >= 1 && !hit; n--) {
      const phrase = words.slice(end - n, end).join(' ');
      let r = tryPhrase(phrase);
      if (!r && lastWord && n === 1 && !found.date) {
        const bare = phrase.replace(/[.,;!?]+$/, '');
        const v = resolveDate(bare, today, weekStart);
        if (v && /^[a-z]+$/i.test(bare)) r = ['date', v];
      }
      if (r) hit = [n, r];
    }
    if (!hit) break;
    const [n, [k, v]] = hit;
    found[k] = v;
    end -= n;
    lastWord = false;
    // Drop a dangling connector left before the parsed words ("read for", "call mom at").
    while (end > 1 && /^(at|on|for|by|due|in|every|from)$/i.test(words[end - 1])) end--;
  }
  // Area and priority markers are unambiguous anywhere in the text.
  let titleWords = words.slice(0, end);
  if (!found.area) {
    const i = titleWords.findIndex((w) => /^#[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(w));
    if (i > -1 && titleWords.length > 1) {
      found.area = cleanArea(titleWords[i]);
      titleWords.splice(i, 1);
    }
  }
  if (!found.priority) {
    const i = titleWords.findIndex((w) => /^(?:p|!)[1-4]$/i.test(w));
    if (i > -1 && titleWords.length > 1) {
      found.priority = Number(titleWords[i].slice(1));
      titleWords.splice(i, 1);
    }
  }
  const title = titleWords.join(' ').replace(/[\s,;–-]+$/, '').trim();
  if (!title) return res;
  res.title = cleanTitle(title);
  if (found.date) res.date = found.date;
  if (found.deadline) res.deadline = found.deadline;
  if (found.time) res.time = found.time;
  if (found.est) [res.estMin, res.estMax] = found.est;
  if (found.priority) res.priority = found.priority;
  if (found.repeat) res.repeat = found.repeat;
  if (found.area) res.area = found.area;
  if (found.optional) res.optional = true;
  const order = ['date', 'deadline', 'time', 'repeat', 'est', 'priority', 'area', 'optional'];
  res.chips = order.filter((k) => found[k] != null).map((k) => ({ k, label: FIELD_LABEL[k](found[k], today) }));
  return res;
}

/* ------------------------------------------------------------------ */
/* Starter routines from the first Daywell                             */
/* ------------------------------------------------------------------ */

export const STARTER = [
  { title: 'Step', estMin: 120, estMax: 180, repeat: { kind: 'daily' } },
  { title: 'Work out', estMin: 45, estMax: 45, repeat: { kind: 'daily' } },
  { title: 'Piano', estMin: 30, estMax: 60, repeat: { kind: 'daily' } },
  { title: 'Chinese Anki', estMin: 30, estMax: 60, repeat: { kind: 'daily' } },
  { title: 'Learn stuff', estMin: 45, estMax: 45, repeat: { kind: 'daily' } },
  { title: 'EQ', estMin: 20, estMax: 20, repeat: { kind: 'daily' } },
  { title: 'School', estMin: 20, estMax: 20, repeat: { kind: 'daily' }, optional: true },
  { title: 'Cut nails', estMin: 10, estMax: 10 },
  { title: 'Email professors about projects' },
  { title: 'Biology review report' },
  { title: 'Transfer things from notes' },
];
