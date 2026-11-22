import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/engine.js';

const TODAY = '2026-11-16'; // a Monday

const mk = (fields) => E.normalizeTask({ createdAt: Date.parse('2026-11-16T12:00:00'), ...fields }, TODAY);
const state = (tasks, log = []) => ({ tasks, log, meta: {}, shared: {} });
const entry = (task, day, extra = {}) => ({ id: E.uid('l'), task: task.id, day, at: `${day}T12:00:00.000Z`, updatedAt: 1, ...extra });

test('day math', () => {
  assert.equal(E.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(E.addDays('2026-03-08', 1), '2026-03-09'); // US DST change
  assert.equal(E.diffDays('2026-11-16', '2026-11-20'), 4);
  assert.equal(E.weekday(TODAY), 1);
  assert.equal(E.startOfWeek('2026-11-22', 1), '2026-11-16');
  assert.equal(E.startOfWeek('2026-11-22', 0), '2026-11-22');
  assert.equal(E.todayKey(new Date(2026, 10, 17, 2, 30), 4), '2026-11-16');
  assert.equal(E.todayKey(new Date(2026, 10, 17, 5, 0), 4), '2026-11-17');
  assert.ok(E.isKey('2028-02-29'));
  assert.ok(!E.isKey('2026-02-29'));
});

test('formatting', () => {
  assert.equal(E.fmtEst(30, 60), '30–60m');
  assert.equal(E.fmtEst(120, 180), '2–3h');
  assert.equal(E.fmtEst(45, 45), '45m');
  assert.equal(E.fmtEst(90, 90), '1h 30m');
  assert.equal(E.fmtTime('15:30'), '3:30 PM');
  assert.equal(E.fmtRelDay('2026-11-17', TODAY), 'Tomorrow');
  assert.equal(E.fmtRelDay('2026-11-20', TODAY), 'Fri');
  assert.equal(E.describeRepeat({ kind: 'weekly', days: [0, 1, 3] }), 'Every Mon, Wed, Sun');
  assert.equal(E.describeRepeat({ kind: 'interval', every: 14 }), 'Every 2 weeks');
  assert.equal(E.cleanTitle('iPhone repair'), 'iPhone repair');
  assert.equal(E.cleanTitle('cut nails'), 'Cut nails');
});

test('resolveDate', () => {
  assert.equal(E.resolveDate('tomorrow', TODAY), '2026-11-17');
  assert.equal(E.resolveDate('friday', TODAY), '2026-11-20');
  assert.equal(E.resolveDate('monday', TODAY), '2026-11-23');
  assert.equal(E.resolveDate('this monday', TODAY), TODAY);
  assert.equal(E.resolveDate('next friday', TODAY), '2026-11-27');
  assert.equal(E.resolveDate('next week', TODAY), '2026-11-23');
  assert.equal(E.resolveDate('this weekend', TODAY), '2026-11-21');
  assert.equal(E.resolveDate('in 3 days', TODAY), '2026-11-19');
  assert.equal(E.resolveDate('in a few days', TODAY), '2026-11-19');
  assert.equal(E.resolveDate('11/20', TODAY), '2026-11-20');
  assert.equal(E.resolveDate('1/5', TODAY), '2027-01-05');
  assert.equal(E.resolveDate('nov 30th', TODAY), '2026-11-30');
  assert.equal(E.resolveDate('3 dec', TODAY), '2026-12-03');
  assert.equal(E.resolveDate('end of month', TODAY), '2026-11-30');
  assert.equal(E.resolveDate('banana', TODAY), null);
});

test('parseQuick reads trailing details only', () => {
  const p = (s) => E.parseQuick(s, TODAY);
  let r = p('call mom tomorrow at 3pm 15m p2 #family');
  assert.deepEqual([r.title, r.date, r.time, r.estMin, r.priority, r.area], ['Call mom', '2026-11-17', '15:00', 15, 2, 'Family']);
  r = p('Piano every day 30-60m');
  assert.deepEqual([r.title, r.repeat, r.estMin, r.estMax], ['Piano', { kind: 'daily' }, 30, 60]);
  r = p('Step 2-3h');
  assert.deepEqual([r.title, r.estMin, r.estMax], ['Step', 120, 180]);
  r = p('Essay due friday p2');
  assert.deepEqual([r.title, r.deadline, r.priority], ['Essay', '2026-11-20', 2]);
  r = p('Read for 30 min');
  assert.deepEqual([r.title, r.estMin], ['Read', 30]);
  r = p('Laundry 1h 30m');
  assert.equal(r.estMin, 90);
  r = p('Watch 3 hours of lectures');
  assert.deepEqual([r.title, r.estMin], ['Watch 3 hours of lectures', null]);
  r = p('SAT exam prep');
  assert.deepEqual([r.title, r.date], ['SAT exam prep', null]);
  r = p('call mom fri');
  assert.equal(r.date, '2026-11-20');
  r = p('Run every mon, wed and fri');
  assert.deepEqual(r.repeat, { kind: 'weekly', days: [1, 3, 5] });
  r = p('Cut nails every 2 weeks');
  assert.deepEqual(r.repeat, { kind: 'interval', every: 14 });
  r = p('Laundry weekly');
  assert.deepEqual(r.repeat, { kind: 'weekflex' });
  r = p('Pay rent every 1st');
  assert.deepEqual(r.repeat, { kind: 'monthly', dom: 1 });
  r = p('Gym mondays');
  assert.deepEqual(r.repeat, { kind: 'weekly', days: [1] });
  r = p('Call mom tomorrow.');
  assert.deepEqual([r.title, r.date], ['Call mom', '2026-11-17']);
  r = p('tomorrow');
  assert.deepEqual([r.title, r.date], ['Tomorrow', null]);
  r = p('Email professors about projects');
  assert.deepEqual(r.chips, []);
  r = p('School optional');
  assert.equal(r.optional, true);
  r = p('Meet Sam at 3pm on friday');
  assert.deepEqual([r.title, r.time, r.date], ['Meet Sam', '15:00', '2026-11-20']);
});

test('one-time tasks roll over softly; deadlines are hard', () => {
  const a = mk({ title: 'Planned last week', date: '2026-11-10' });
  const b = mk({ title: 'Due yesterday', deadline: '2026-11-15' });
  const c = mk({ title: 'Anytime' });
  const d = mk({ title: 'Friday', date: '2026-11-20' });
  const e = mk({ title: 'Due Friday, no date', deadline: '2026-11-20' });
  const s = state([a, b, c, d, e]);
  const idx = E.buildIndex(s.log);
  const today = E.dayItems(s, idx, TODAY, TODAY);
  assert.deepEqual(today.map((i) => i.t.title).sort(), ['Due yesterday', 'Planned last week']);
  assert.equal(today.find((i) => i.t.title === 'Planned last week').carried, '2026-11-10');
  const fri = E.dayItems(s, idx, '2026-11-20', TODAY);
  assert.deepEqual(fri.map((i) => i.t.title).sort(), ['Due Friday, no date', 'Friday']);
  assert.ok(fri.find((i) => i.t.title === 'Due Friday, no date').dueOnly);
});

test('daily routines: one check per day, misses never stack', () => {
  const t = mk({ title: 'Piano', repeat: { kind: 'daily' }, start: '2026-11-10' });
  const s = state([t], [entry(t, '2026-11-14')]);
  const idx = E.buildIndex(s.log);
  assert.equal(E.dayItems(s, idx, TODAY, TODAY)[0].status, 'open');
  assert.equal(E.dayItems(s, idx, '2026-11-15', TODAY)[0].status, 'miss');
  assert.equal(E.dayItems(s, idx, '2026-11-14', TODAY)[0].status, 'done');
  assert.equal(E.dayItems(s, idx, '2026-11-09', TODAY).length, 0); // before it existed
  assert.equal(E.dayItems(s, idx, '2026-11-25', TODAY)[0].status, 'open');
});

test('weekly on a day carries over until the next occurrence', () => {
  const t = mk({ title: 'Laundry', repeat: { kind: 'weekly', days: [6] }, start: '2026-11-01' }); // Saturdays
  let s = state([t]);
  let idx = E.buildIndex(s.log);
  const it = E.dayItems(s, idx, TODAY, TODAY)[0];
  assert.equal(it.carried, '2026-11-14');
  s = state([t], [entry(t, '2026-11-15')]); // done on Sunday
  idx = E.buildIndex(s.log);
  assert.equal(E.dayItems(s, idx, TODAY, TODAY).length, 0);
  assert.equal(E.dayItems(s, idx, '2026-11-21', TODAY).length, 1);
  assert.equal(E.streak(t, idx, TODAY), 1);
});

test('once-a-week tasks surface late in the week or when planned', () => {
  const t = mk({ title: 'Call grandma', repeat: { kind: 'weekflex' } });
  let s = state([t]);
  let idx = E.buildIndex(s.log);
  assert.equal(E.dayItems(s, idx, TODAY, TODAY).length, 0);
  assert.equal(E.dayItems(s, idx, '2026-11-21', '2026-11-21').length, 1); // Saturday: 1 day left
  t.plan = TODAY;
  assert.equal(E.dayItems(s, idx, TODAY, TODAY).length, 1);
  s = state([t], [entry(t, TODAY)]);
  idx = E.buildIndex(s.log);
  assert.equal(E.dayItems(s, idx, '2026-11-18', '2026-11-18').length, 0);
});

test('every-N-days tasks are due N days after the last time', () => {
  const t = mk({ title: 'Cut nails', repeat: { kind: 'interval', every: 10 }, start: '2026-10-01' });
  const s = state([t], [entry(t, '2026-11-01')]);
  const idx = E.buildIndex(s.log);
  assert.equal(E.intervalDue(t, idx), '2026-11-11');
  const it = E.dayItems(s, idx, TODAY, TODAY)[0];
  assert.equal(it.lateDays, 5);
  const sc = E.scoreTask(t, { today: TODAY, idx });
  assert.equal(sc.reason, 'Last done 2 weeks ago');
  const sug = E.suggestions(state([mk({ title: 'x', repeat: { kind: 'interval', every: 3 }, start: TODAY })], []), E.buildIndex([]), TODAY, new Set());
  assert.equal(sug.length, 1);
});

test('monthly', () => {
  const t = mk({ title: 'Rent', repeat: { kind: 'monthly', dom: 31 }, start: '2026-01-01' });
  assert.ok(E.scheduledOn(t, '2026-11-30'));
  assert.ok(!E.scheduledOn(t, '2026-11-29'));
});

test('suggestions push neglected and due-soon work', () => {
  const old = mk({ title: 'Clean garage', createdAt: Date.parse('2026-10-10T12:00:00') });
  const soon = mk({ title: 'Bio report', deadline: '2026-11-18' });
  const fresh = mk({ title: 'Someday thing', priority: 4 });
  const s = state([old, soon, fresh]);
  const sug = E.suggestions(s, E.buildIndex([]), TODAY, new Set());
  assert.deepEqual(sug.map((x) => x.t.title), ['Bio report', 'Clean garage']);
  assert.equal(sug[1].reason, 'Waiting 5 weeks');
});

test('ordering keeps saved order and lifts urgent newcomers', () => {
  const a = mk({ title: 'A' });
  const b = mk({ title: 'B' });
  const urgent = mk({ title: 'Urgent', priority: 1 });
  const s = { ...state([a, b, urgent]), meta: { order: { [TODAY]: { ids: [b.id, a.id], at: 1 } } } };
  const items = [a, b, urgent].map((t) => ({ t, id: t.id, status: 'open' }));
  const out = E.orderOpen(items, TODAY, s, { today: TODAY, idx: E.buildIndex([]) });
  assert.deepEqual(out.map((i) => i.t.title), ['Urgent', 'B', 'A']);
});

test('free time subtracts calendar events', () => {
  const ev = (s, e) => ({ start: new Date(2026, 10, 16, ...s).toISOString(), end: new Date(2026, 10, 16, ...e).toISOString() });
  const f = E.freeTime({ D: TODAY, dayStart: '08:00', dayEnd: '22:00', events: [ev([10, 0], [11, 0]), ev([10, 30], [12, 0]), { allDay: true, start: '', end: '' }], now: new Date(2026, 10, 16, 9, 0) });
  assert.equal(f.free, 13 * 60 - 120);
  assert.deepEqual(f.gaps[0], [540, 600]);
});

test('streaks', () => {
  const t = mk({ title: 'Anki', repeat: { kind: 'daily' }, start: '2026-11-01' });
  const log = ['2026-11-13', '2026-11-14', '2026-11-15'].map((d) => entry(t, d));
  const idx = E.buildIndex(log);
  assert.equal(E.streak(t, idx, TODAY), 3); // today still open
  const idx2 = E.buildIndex([...log, entry(t, TODAY)]);
  assert.equal(E.streak(t, idx2, TODAY), 4);
});

test('merge keeps the newest edit and converges', () => {
  const base = mk({ title: 'Task', updatedAt: 10 });
  const local = state([{ ...base, title: 'Local edit', updatedAt: 20 }, mk({ id: 'only-local', title: 'L', updatedAt: 5 })]);
  const remote = state([{ ...base, title: 'Remote edit', updatedAt: 15 }, mk({ id: 'only-remote', title: 'R', updatedAt: 5 })]);
  const m1 = E.mergeStates(local, remote);
  const m2 = E.mergeStates(remote, local);
  const titles = (m) => m.tasks.map((t) => `${t.id === base.id ? 'base' : t.id}:${t.title}`).sort();
  assert.deepEqual(titles(m1), titles(m2));
  assert.ok(titles(m1).includes('base:Local edit'));
  // equal timestamps resolve the same way on both sides
  const x = state([{ ...base, title: 'X', updatedAt: 30 }]);
  const y = state([{ ...base, title: 'Y', updatedAt: 30 }]);
  assert.equal(E.mergeStates(x, y).tasks[0].title, E.mergeStates(y, x).tasks[0].title);
  // a deletion (tombstone) wins if newer
  const del = state([{ ...base, deletedAt: 40, updatedAt: 40 }]);
  assert.ok(E.mergeStates(local, del).tasks.find((t) => t.id === base.id).deletedAt);
});

test('normalizeTask repairs input', () => {
  const t = E.normalizeTask({ title: '  water plants ', estMin: 30, estMax: 10, priority: 9, repeat: { kind: 'weekly', days: [] }, date: '2026-11-18' }, TODAY);
  assert.equal(t.title, 'Water plants');
  assert.deepEqual([t.estMin, t.estMax], [10, 30]);
  assert.equal(t.priority, 3);
  assert.deepEqual(t.repeat, { kind: 'weekflex' });
  assert.equal(t.start, '2026-11-18');
  assert.equal(t.date, null);
});

/* ---------- birthdays, habits, backups ---------- */

test('birthdayName reads the ways people write birthdays', () => {
  const cases = {
    "Sam Florek Birthday": 'Sam Florek',
    'Sam Florek bday': 'Sam Florek',
    "Sam Florek's Birthday": 'Sam Florek',
    'Sofi’s birthday 🎂': 'Sofi',
    "Hasan's Birthday (Dana Brother)": 'Hasan',
    'Happy Birthday Sam!': 'Sam',
    'Birthday: Ana': 'Ana',
    'Bday - Sam Florek': 'Sam Florek',
    '🎂 Sam Florek': 'Sam Florek',
    'Sam turns 21 🎉': 'Sam',
    "Mom's 50th birthday": 'Mom',
    "Sam Florek b'day": 'Sam Florek',
    'Birthday party': null,
    "Sam's birthday dinner": null,
    'Wish Sam a happy birthday': null,
    'Buy gift for Sam bday': null,
    'Happy Birthday!': null,
    'My birthday': null,
    'Birthdays': null,
    'Chem exam': null,
  };
  for (const [title, want] of Object.entries(cases)) assert.equal(E.birthdayName(title), want, title);
  assert.equal(E.birthdayName('Sam Florek', { sure: true }), 'Sam Florek');
});

test('your own birthday is recognized and skipped', () => {
  assert.equal(E.isSelfName('Justin Tang', { email: 'justint0003@gmail.com', name: 'Justin' }), true);
  assert.equal(E.isSelfName('Justin Lee', { email: 'justint0003@gmail.com', name: 'Justin' }), false);
  assert.equal(E.isSelfName('Sam Florek', { email: 'justint0003@gmail.com' }), false);
});

test('birthdays you add come around every year, leap days included', () => {
  const b = { 'sam-florek': { name: 'Sam Florek', md: '12-02', at: 1 }, leap: { name: 'Leap', md: '02-29', at: 1 }, old: { name: 'Gone', md: '12-02', gone: true, at: 2 } };
  assert.deepEqual(E.birthdaysOn('2026-12-02', b).map((x) => x.name), ['Sam Florek']);
  assert.equal(E.birthdaysOn('2027-02-28', b).length, 1);
  assert.equal(E.birthdaysOn('2028-02-28', b).length, 0);
  assert.equal(E.nextOccurrence('11-21', '2026-11-21'), '2026-11-21');
  assert.equal(E.nextOccurrence('01-05', '2026-11-21'), '2027-01-05');
  const merged = E.mergeStates({ tasks: [], log: [], meta: { bdays: { a: { name: 'A', md: '01-01', at: 5 } } } }, { tasks: [], log: [], meta: { bdays: { a: { name: 'A', md: '01-01', gone: true, at: 9 }, b: { name: 'B', md: '02-02', at: 1 } } } });
  assert.equal(merged.meta.bdays.a.gone, true);
  assert.equal(merged.meta.bdays.b.name, 'B');
});

test('habitProfile describes when things get done', () => {
  const today = '2026-11-21';
  const tasks = [
    { id: 'step', title: 'Step', repeat: { kind: 'daily' } },
    { id: 'bio', title: 'Biology review' },
  ];
  const log = [];
  for (let k = 0; k < 6; k++) {
    const day = E.addDays(today, -k);
    const at = (h, m) => new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`).toISOString();
    log.push({ id: `s${k}`, task: 'step', day, at: at(22, 15), est: 120 });
    log.push({ id: `b${k}`, task: 'bio', day, at: at(21, 40), est: 60 });
  }
  const p = E.habitProfile({ tasks, log }, today);
  assert.ok(p);
  assert.match(p.lines.join(' '), /night \(9pm–midnight\)/);
  assert.match(p.lines.join(' '), /“Step” 10:15pm/);
  assert.equal(p.usual.step, 22 * 60 + 15);
  assert.equal(E.habitProfile({ tasks, log: log.slice(0, 3) }, today), null);
});

test('lostBetween and recoverFrom bring back only what is missing', () => {
  const before = {
    tasks: [
      { id: 'a', title: 'Keep me', updatedAt: 1 },
      { id: 'b', title: 'Deleted later', updatedAt: 1 },
      { id: 'c', title: 'Gone from list', updatedAt: 1 },
    ],
    log: [{ id: 'l1', task: 'a', day: '2026-11-20', updatedAt: 1 }],
    meta: { bdays: { sam: { name: 'Sam', md: '12-02', at: 1 } } },
  };
  const now = {
    tasks: [
      { id: 'a', title: 'Keep me (edited)', updatedAt: 5 },
      { id: 'b', title: 'Deleted later', deletedAt: 4, updatedAt: 4 },
      { id: 'd', title: 'New since', updatedAt: 6 },
    ],
    log: [{ id: 'l1', task: 'a', day: '2026-11-20', deleted: true, updatedAt: 4 }],
    meta: { bdays: {} },
  };
  assert.deepEqual(E.lostBetween(before, now), { tasks: ['b', 'c'], log: ['l1'] });
  const r = E.recoverFrom(now, before, 100);
  assert.equal(r.tasks, 2);
  assert.equal(r.log, 1);
  const byId = Object.fromEntries(r.state.tasks.map((t) => [t.id, t]));
  assert.equal(byId.a.title, 'Keep me (edited)');
  assert.equal(byId.b.deletedAt, null);
  assert.equal(byId.b.updatedAt, 100);
  assert.ok(byId.c && byId.d);
  assert.equal(r.state.log[0].deleted, false);
  assert.equal(r.state.meta.bdays.sam.name, 'Sam');
  assert.deepEqual(E.lostBetween(before, r.state), { tasks: [], log: [] });
});
