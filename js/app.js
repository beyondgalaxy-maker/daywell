// Daywell app: rendering and interactions.
import * as E from './engine.js';
import * as AI from './ai.js';
import { Store, applyChanges, markDone, moveTask, repairState } from './store.js';
import { Google, newSecret, scriptWithSecret, validScriptUrl } from './google.js';
import { I } from './icons.js';

const store = new Store();
const google = new Google(store);
window.__daywell = { store, google, E };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isMobile = () => matchMedia('(max-width: 860px)').matches;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

const ui = {
  view: 'today',
  tab: 'today',
  day: null,
  calMonth: null,
  calDay: null,
  search: '',
  area: '',
  drawer: null,
  ai: null,
  planning: false,
  planError: null,
  planStep: null,
  lastToday: null,
  autoPlanTried: null,
  suppressClick: false,
  editStep: null,
  showDone: false,
  toastTimer: null,
  syncTimer: null,
  menuFor: null,
};

/* ================================================================== */
/* helpers                                                             */
/* ================================================================== */

function ctxNow() {
  const s = store.state;
  const today = store.today;
  const idx = E.buildIndex(s.log);
  const settings = s.shared;
  const ws = settings.weekStart ?? 1;
  return { s, today, idx, settings, ws, sc: { today, idx, weekStart: ws }, timer: s.meta.timer?.id ? s.meta.timer : null };
}
const relWord = (D, today) => {
  const r = E.fmtRelDay(D, today, { long: true });
  return r === 'Yesterday' || r === 'Today' || r === 'Tomorrow' ? r.toLowerCase() : r;
};
const firstLine = (s) => String(s || '').split('\n')[0].slice(0, 90);
const fmtTimer = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
function lastStep() {
  return store.undoStack[store.undoStack.length - 1] || null;
}
function revertStep(step) {
  if (!step) return;
  const i = store.undoStack.indexOf(step);
  if (i > -1) store.undoStack.splice(i, 1);
  store.transact(`Undid ${step.label}`, (s) => {
    for (const ch of step.diff.tasks) {
      const j = s.tasks.findIndex((x) => x.id === ch.id);
      const v = ch.before ? { ...JSON.parse(JSON.stringify(ch.before)), updatedAt: Date.now() } : { ...E.purgedShell(ch.after), updatedAt: Date.now() };
      if (j > -1) s.tasks[j] = v;
      else s.tasks.push(v);
    }
    for (const ch of step.diff.log) {
      const j = s.log.findIndex((x) => x.id === ch.id);
      const v = ch.before ? { ...ch.before, updatedAt: Date.now() } : { ...ch.after, deleted: true, updatedAt: Date.now() };
      if (j > -1) s.log[j] = v;
      else s.log.push(v);
    }
    for (const ch of step.diff.order) s.meta.order[ch.k] = ch.before ? { ...ch.before, at: Date.now() } : { ids: [], at: Date.now(), cleared: true };
    for (const ch of step.diff.plans) s.meta.plans[ch.k] = ch.before ? { ...ch.before, at: Date.now() } : { removed: true, at: Date.now() };
  });
}

/* ================================================================== */
/* toast, confirm                                                      */
/* ================================================================== */

function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => {
    action.run();
    hideToast();
  };
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(hideToast, action ? 6500 : 3200);
}
function hideToast() {
  $('#toast').hidden = true;
}
function undoToast(msg, step) {
  toast(msg, step ? { label: 'Undo', run: () => revertStep(step) } : null);
}

function confirmBox({ title, body = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  const d = $('#confirm');
  d.innerHTML = `<h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ''}<div class="c-actions"><button type="button" class="btn secondary" data-c="no">${esc(cancel)}</button><button type="button" class="btn ${danger ? 'danger' : ''}" data-c="yes">${esc(ok)}</button></div>`;
  return new Promise((resolve) => {
    const done = (v) => {
      d.close();
      resolve(v);
    };
    d.querySelector('[data-c=yes]').onclick = () => done(true);
    d.querySelector('[data-c=no]').onclick = () => done(false);
    d.oncancel = (e) => {
      e.preventDefault();
      done(false);
    };
    d.showModal();
    d.querySelector('[data-c=yes]').focus();
  });
}

/* ================================================================== */
/* rendering                                                           */
/* ================================================================== */

function render() {
  const ctx = ctxNow();
  if (ui.lastToday && ui.lastToday !== ctx.today && ui.day === ui.lastToday) ui.day = null;
  ui.lastToday = ctx.today;
  renderTop();
  $('#app').dataset.tab = ui.tab;
  $('#viewToday').hidden = ui.view !== 'today';
  $('#viewCalendar').hidden = ui.view !== 'calendar';
  $('#viewHistory').hidden = ui.view !== 'history';
  if (ui.view === 'today') {
    renderDay(ctx);
    renderAll(ctx);
  } else if (ui.view === 'calendar') renderCalendar(ctx);
  else renderHistory(ctx);
  renderTimer(ctx);
  renderComposerMeta();
  // Re-render the drawer only for changes made elsewhere, never mid-edit (it would swallow clicks and focus).
  if (ui.drawer && !ui.fromDrawer && !$('#drawer').contains(document.activeElement)) renderDrawer();
}

function renderTop() {
  for (const b of $$('.views button')) b.setAttribute('aria-current', b.dataset.view === ui.view ? 'page' : 'false');
  const tabNow = ui.view === 'today' ? ui.tab : ui.view;
  for (const b of $$('#tabbar button')) b.setAttribute('aria-current', b.dataset.tab === tabNow ? 'page' : 'false');
  const u = $('#undoBtn');
  u.disabled = !store.canUndo();
  u.title = store.canUndo() ? `Undo ${lastStep()?.label || ''} (${MOD} Z)` : 'Nothing to undo';
  const st = $('#syncState');
  if (!google.configured) {
    st.hidden = true;
  } else {
    st.hidden = false;
    st.className = `sync-state ${google.status}`;
    const label = google.status === 'syncing' ? 'Syncing' : google.status === 'error' ? 'Sync problem' : google.status === 'ok' ? 'Synced' : 'Connected';
    st.innerHTML = `${google.status === 'error' ? I.cloudOff : I.sync}<span>${label}</span>`;
    st.title = google.status === 'error' ? google.error : store.device.lastSync ? `Last synced ${E.fmtClock(new Date(store.device.lastSync))}` : 'Google connected';
  }
}

/* ---------- task rows ---------- */

function subline(it, ctx, place) {
  const t = it.t;
  const today = ctx.today;
  const bits = [];
  if (ctx.timer?.id === t.id) bits.push(`<span><span class="timing-dot"></span>${fmtTimer(Date.now() - ctx.timer.start + (t.spent || 0) * 60000)} so far</span>`);
  if (place === 'routines') {
    bits.push(`<span>${esc(E.describeRepeat(t.repeat))}</span>`);
    if (t.paused) bits.push('<span>Paused</span>');
    else {
      const st = E.streak(t, ctx.idx, today, ctx.ws);
      if (st >= 2) bits.push(`<span>${st}-${t.repeat.kind === 'weekflex' ? 'week' : 'day'} streak</span>`);
      const nd = E.nextDue(t, ctx.idx, today, ctx.ws);
      if (nd && nd > today) bits.push(`<span>Next ${esc(relWord(nd, today))}</span>`);
      else if (nd && nd < today) bits.push(`<span class="warn">Due since ${esc(relWord(nd, today))}</span>`);
    }
    return bits.join('');
  }
  if (t.ai && t.ai.day === today && place === 'day' && it.status === 'open' && it.day === today) {
    bits.push(`<span class="ai-note">${I.spark}${esc(t.ai.note)}</span>`);
  } else if (it.carried && it.status === 'open') {
    bits.push(`<span>From ${esc(relWord(it.carried, today))}</span>`);
  } else if (it.lateDays && it.status === 'open') {
    const last = E.lastDoneDay(ctx.idx, t.id);
    bits.push(`<span class="warn">${last ? `Last done ${E.fmtAge(E.diffDays(last, today))} ago` : 'Due now'}</span>`);
  } else if (it.flexLeft != null && it.status === 'open') {
    bits.push(`<span>${it.flexLeft === 0 ? 'Last day this week' : 'Once this week'}</span>`);
  }
  if (it.status === 'miss') bits.push('<span>Missed</span>');
  if (it.status === 'skip') bits.push('<span>Skipped</span>');
  if (it.dueOnly) bits.push('<span>Due this day</span>');
  if (t.spent && it.status === 'open' && ctx.timer?.id !== t.id) bits.push(`<span>${E.fmtMins(t.spent)} done so far</span>`);
  if (!bits.length && t.notes) bits.push(`<span>${esc(firstLine(t.notes))}</span>`);
  return bits.join('');
}

function metaBits(it, ctx, place) {
  const t = it.t;
  const out = [];
  if (t.time && place !== 'routines') out.push(`<span class="m-time">${E.fmtTime(t.time)}</span>`);
  const est = E.fmtEst(t.estMin, t.estMax);
  if (est) out.push(`<span class="m-est">${est}</span>`);
  if (t.deadline && it.status !== 'done' && !t.doneDay) {
    const d = E.diffDays(ctx.today, t.deadline);
    const cls = d < 0 ? 'over' : d <= 2 ? 'soon' : '';
    out.push(`<span class="m-due ${cls}">${d < 0 ? 'Overdue' : `Due ${E.fmtRelDay(t.deadline, ctx.today)}`}</span>`);
  }
  if (place === 'later' && t.date) out.push(`<span class="m-date">${E.fmtRelDay(t.date, ctx.today)}</span>`);
  if (t.repeat && place !== 'routines') out.push(`<span class="m-rep" title="${esc(E.describeRepeat(t.repeat))}">${I.repeat}</span>`);
  if (t.priority <= 2) out.push(`<span class="m-pri p${t.priority}" title="${E.PRIORITY_NAMES[t.priority]} priority">P${t.priority}</span>`);
  if (t.area && place !== 'day') out.push(`<span class="m-area">${esc(t.area)}</span>`);
  return out.join('');
}

function taskRow(it, ctx, place = 'day') {
  const t = it.t;
  const st = it.status;
  const done = st === 'done';
  const cls = ['task', `p${t.priority}`, done && 'done', st === 'skip' && 'skipped', st === 'miss' && 'missed', t.optional && 'optional', ctx.timer?.id === t.id && 'timing'].filter(Boolean).join(' ');
  const sub = subline(it, ctx, place);
  const label = done || st === 'skip' ? `Mark “${t.title}” not done` : `Mark “${t.title}” done`;
  const quick = (place === 'all' || place === 'later') && !done ? `<button type="button" class="quick" data-act="to-today" title="Do today" aria-label="Do “${esc(t.title)}” today">${I.sun}</button>` : '';
  return `<li class="${cls}" data-id="${t.id}" data-day="${it.day || ''}" data-status="${st}">
<span class="grip" aria-hidden="true">${I.grip}</span>
<button type="button" class="check" data-act="check" aria-label="${esc(label)}" aria-pressed="${done}">${I.tick}</button>
<div class="body" data-act="open" role="button" tabindex="0"><span class="title">${esc(t.title)}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>
<div class="meta">${metaBits(it, ctx, place)}</div>${quick}
<button type="button" class="more" data-act="menu" aria-haspopup="menu" aria-label="Options for “${esc(t.title)}”">${I.more}</button>
</li>`;
}

/* ---------- day column ---------- */

function renderDay(ctx) {
  const { today } = ctx;
  const D = ui.day || today;
  const isToday = D === today;
  const isPast = D < today;
  const items = E.dayItems(ctx.s, ctx.idx, D, today, ctx.settings);
  const open = E.orderOpen(items.filter((i) => i.status === 'open'), D, ctx.s, ctx.sc);
  const finished = items
    .filter((i) => i.status === 'done' || i.status === 'skip')
    .sort((a, b) => String(b.entry?.at || b.t.doneAt || '').localeCompare(String(a.entry?.at || a.t.doneAt || '')));
  const missed = items.filter((i) => i.status === 'miss');
  const load = E.workload(open.filter((i) => !i.dueOnly));
  const doneN = items.filter((i) => i.status === 'done').length;
  const total = items.filter((i) => i.status !== 'skip').length;

  const rel = E.fmtRelDay(D, today, { long: true });
  const big = isToday ? E.WEEKDAYS[E.weekday(D)] : ['Tomorrow', 'Yesterday'].includes(rel) ? rel : E.WEEKDAYS[E.weekday(D)];
  const [y, m, d] = D.split('-').map(Number);
  const dateLine = `${E.MONTHS[m - 1]} ${d}${y !== Number(today.slice(0, 4)) ? `, ${y}` : ''}${!isToday && !['Tomorrow', 'Yesterday'].includes(rel) ? '' : ''}`;
  const plan = ctx.s.meta.plans[today];
  const planned = isToday && plan && !plan.removed;
  let html = `<header class="day-head">
<div class="dh-top"><div class="dh-nav">
<button type="button" class="icon-btn sm" data-act="day-prev" aria-label="Previous day" title="Previous day ([)">${I.left}</button>
<button type="button" class="icon-btn sm" data-act="day-next" aria-label="Next day" title="Next day (])">${I.right}</button>
${!isToday ? '<button type="button" class="text-btn" data-act="day-today">Back to today</button>' : ''}</div>
${isToday ? `<button type="button" class="plan-btn${planned ? ' ghost' : ''}" data-act="plan" ${ui.planning ? 'disabled' : ''}>${I.spark}<span>${ui.planning ? 'Planning…' : planned ? 'Replan' : 'Plan my day'}</span></button>` : ''}
</div>
<h1 class="day-title">${esc(big)}</h1>
<p class="day-sub"><span class="ds-date">${esc(isToday || ['Tomorrow', 'Yesterday'].includes(rel) ? `${E.WEEKDAYS[E.weekday(D)] === big ? '' : E.WEEKDAYS[E.weekday(D)] + ', '}${dateLine}` : dateLine)}</span>${total ? `<span>${doneN} of ${total} done</span>` : ''}${!isPast && open.length && load.mins ? `<span>${E.fmtMins(load.mins)} of tasks left</span>` : ''}</p>
</header>`;
  if (!isPast) html += ribbonHtml(ctx, D, isToday, load);
  if (isToday) html += briefHtml(ctx);
  const showWelcome = isToday && !ctx.s.meta.seeded && !ctx.s.tasks.some((t) => !t.purged);
  if (showWelcome) html += welcomeHtml();
  html += `<ul class="tasks day-list" data-list="day" data-day="${D}">${open.map((i) => taskRow(i, ctx, 'day')).join('')}${!open.length && !showWelcome ? `<li class="empty-drop">${isPast ? 'Nothing was planned for this day.' : isToday ? (doneN ? 'All done for today. Nice.' : 'Nothing planned yet. Add a task below, or drag one in from Everything else.') : 'Nothing planned. Drag tasks here to plan them for this day.'}</li>` : ''}</ul>`;
  if (isToday) html += suggestionsHtml(ctx, items);
  if (missed.length) html += `<h3 class="list-head">Missed <span class="n">${missed.length}</span></h3><ul class="tasks" data-list="none">${missed.map((i) => taskRow(i, ctx, 'past')).join('')}</ul>`;
  if (finished.length) {
    const open_ = ui.showDone || !isToday;
    html += `<h3 class="list-head"><button type="button" class="toggle" data-act="toggle-done" aria-expanded="${open_}">${I.down}Done</button><span class="n">${finished.length}</span></h3>${open_ ? `<ul class="tasks" data-list="none">${finished.map((i) => taskRow(i, ctx, 'day')).join('')}</ul>` : ''}`;
  }
  $('#dayCol').innerHTML = html;
}

function ribbonHtml(ctx, D, isToday, load) {
  const st = ctx.settings;
  const evs = google.eventsOn(D);
  const timed = evs.filter((e) => !e.allDay);
  const now = isToday ? new Date() : null;
  const ft = E.freeTime({ events: timed, D, dayStart: st.dayStart, dayEnd: st.dayEnd, now });
  const span = ft.end - ft.start || 1;
  const pct = (mm) => Math.max(0, Math.min(100, ((mm - ft.start) / span) * 100));
  let track = '';
  const nowMin = now ? E.minutesInto(now, D) : null;
  if (now && nowMin > ft.start) track += `<span class="rb-past" style="width:${pct(nowMin).toFixed(2)}%"></span>`;
  for (const ev of timed) {
    const a = E.minutesInto(new Date(ev.start), D);
    const b = E.minutesInto(new Date(ev.end), D);
    if (b <= ft.start || a >= ft.end || ev.free) continue;
    track += `<span class="rb-ev" style="left:${pct(a).toFixed(2)}%;width:${(pct(b) - pct(a)).toFixed(2)}%"></span>`;
  }
  let remaining = load.mins;
  let segs = '';
  for (const [a, b] of ft.gaps) {
    if (remaining <= 0) break;
    const take = Math.min(b - a, remaining);
    segs += `<span style="left:${pct(a).toFixed(2)}%;width:${(pct(a + take) - pct(a)).toFixed(2)}%"></span>`;
    remaining -= take;
  }
  if (remaining > 0) {
    const w = Math.min(28, (remaining / span) * 100);
    segs += `<span class="over" style="left:${(100 - w).toFixed(2)}%;width:${w.toFixed(2)}%"></span>`;
  }
  const marker = now && nowMin >= ft.start && nowMin <= ft.end ? `<span class="rb-now" style="left:${pct(nowMin).toFixed(2)}%" title="Now"></span>` : '';
  const mid = Math.round((ft.start + ft.end) / 2 / 60) * 60;
  const sum = [];
  if (load.mins || load.unknown) sum.push(`<span><b>${E.fmtMins(load.mins)}</b> of tasks${load.unknown ? ` and ${load.unknown} without a time` : ''}</span>`);
  sum.push(`<span><b>${E.fmtMins(ft.free)}</b> free${google.configured ? ' around your events' : isToday ? ' left today' : ''}</span>`);
  if (remaining > 0) sum.push(`<span class="over">${E.fmtMins(remaining)} more than you have</span>`);
  const evHtml = evs.length
    ? `<div class="events">${evs
        .slice(0, 8)
        .map((ev) => {
          const past = now && !ev.allDay && Date.parse(ev.end) < now.getTime();
          const when = ev.allDay ? 'All day' : E.fmtClock(new Date(ev.start));
          return `<span class="ev${past ? ' past' : ''}" style="--ev:${esc(ev.color || '')}" title="${esc(ev.title)}${ev.calName ? ` (${esc(ev.calName)})` : ''}"><i></i><b>${when}</b><span>${esc(ev.title)}</span></span>`;
        })
        .join('')}${evs.length > 8 ? `<span class="ev">+${evs.length - 8} more</span>` : ''}</div>`
    : '';
  return `<div class="ribbon" aria-label="Your day: ${E.fmtMins(load.mins)} of tasks, ${E.fmtMins(ft.free)} free">
<div class="rb-wrap"><div class="rb-track">${track}</div>${marker}</div>
<div class="rb-load">${segs}</div>
<div class="rb-axis"><span>${E.fmtTime(st.dayStart)}</span><span>${E.fmtTime(E.minToTime(mid))}</span><span>${E.fmtTime(st.dayEnd)}</span></div>
<div class="rb-sum">${sum.join('')}</div>${evHtml}</div>`;
}

function briefHtml(ctx) {
  const today = ctx.today;
  if (ui.planning) return `<div class="brief loading"><div class="b-head">${I.spark}Claude</div><p class="b-text"><span class="shimmer">Looking over everything and planning your day…</span></p></div>`;
  if (ui.planError) {
    const keyIssue = /key|Settings/i.test(ui.planError);
    return `<div class="brief error"><div class="b-head">${I.spark}Couldn't plan your day</div><p class="b-text">${esc(ui.planError)}</p><div class="b-actions"><button type="button" class="chip-btn" data-act="plan">Try again</button>${keyIssue ? '<button type="button" class="chip-btn" data-act="settings">Open settings</button>' : ''}</div><button type="button" class="icon-btn sm b-close" data-act="plan-error-x" aria-label="Dismiss">${I.x}</button></div>`;
  }
  const plan = ctx.s.meta.plans[today];
  if (!plan || plan.removed || plan.hidden) return '';
  const by = plan.by === 'claude' ? 'Claude' : 'Daywell';
  const moves = [];
  const title = (id) => store.task(id)?.title;
  const pulled = (plan.pulled || []).map((p) => title(p.id)).filter(Boolean);
  const deferred = (plan.deferred || []).map((p) => ({ t: title(p.id), to: p.to })).filter((x) => x.t);
  if (pulled.length) moves.push(`Added ${pulled.map(esc).join(', ')}.`);
  if (deferred.length) moves.push(`Moved ${deferred.map((x) => `${esc(x.t)} to ${x.to ? esc(relWord(x.to, today)) : 'no date'}`).join(', ')}.`);
  const added = new Set(plan.added || []);
  const sug = (plan.suggest || []).map((s, i) => ({ ...s, i })).filter((s) => !added.has(s.i));
  const step = ui.planStep && ui.planStep.day === today ? ui.planStep.step : null;
  return `<div class="brief"><div class="b-head">${I.spark}${by} planned your day at ${E.fmtClock(new Date(plan.at))}</div>
<p class="b-text">${esc(plan.brief)}</p>${moves.length ? `<p class="b-moves">${moves.join(' ')}</p>` : ''}
${sug.length || step ? `<div class="b-actions">${sug.map((s) => `<button type="button" class="chip-btn" data-act="plan-add" data-i="${s.i}" title="${esc(s.reason)}">${I.plus}${esc(s.title)}</button>`).join('')}${step ? `<button type="button" class="chip-btn" data-act="plan-undo">${I.undo}Undo plan</button>` : ''}</div>` : ''}
<button type="button" class="icon-btn sm b-close" data-act="plan-hide" aria-label="Hide the plan summary">${I.x}</button></div>`;
}

function suggestionsHtml(ctx, items) {
  const sug = E.suggestions(ctx.s, ctx.idx, ctx.today, new Set(items.map((i) => i.id)), ctx.settings, 3);
  if (!sug.length) return '';
  return `<h3 class="list-head">Worth doing today</h3><ul>${sug
    .map(
      (x) => `<li class="sug" data-id="${x.t.id}"><button type="button" class="sug-add" data-act="pull" aria-label="Add “${esc(x.t.title)}” to today" title="Add to today">${I.plus}</button><span class="title" data-act="open" role="button" tabindex="0">${esc(x.t.title)}</span><span class="why">${esc(x.reason || '')}</span><button type="button" class="sug-x" data-act="dismiss" aria-label="Hide “${esc(x.t.title)}” for today" title="Not today">${I.x}</button></li>`,
    )
    .join('')}</ul>`;
}

function welcomeHtml() {
  const rows = E.STARTER.map(
    (s, i) => `<label><input type="checkbox" data-starter="${i}" checked><span>${esc(s.title)}</span><small>${s.repeat ? 'Daily' : 'Once'}${s.estMin ? `, ${E.fmtEst(s.estMin, s.estMax)}` : ''}${s.optional ? ', optional' : ''}</small></label>`,
  ).join('');
  return `<section class="welcome"><h2>Welcome to the new Daywell</h2>
<p>Type a task below and press Enter. Press ${MOD}+Enter to hand Claude a whole list. Want your routines and to-dos from the first Daywell?</p>
<div class="starter">${rows}</div>
<div class="w-actions"><button type="button" class="btn" data-act="seed">Add selected</button><button type="button" class="btn secondary" data-act="seed-skip">Start empty</button>${store.device.apiKey ? '' : `<button type="button" class="btn secondary" data-act="settings">${I.key}Connect Claude</button>`}</div></section>`;
}

/* ---------- everything else ---------- */

function renderAll(ctx) {
  const { today } = ctx;
  const inToday = new Set(E.dayItems(ctx.s, ctx.idx, today, today, ctx.settings).map((i) => i.id));
  const q = ui.search.trim().toLowerCase();
  const live = ctx.s.tasks.filter((t) => !t.deletedAt && !t.purged);
  const areaCount = new Map();
  for (const t of live) if (t.area && !t.doneDay) areaCount.set(t.area, (areaCount.get(t.area) || 0) + 1);
  if (ui.area && !areaCount.has(ui.area)) ui.area = '';
  const chips = areaCount.size >= 2 ? [['', 'All'], ...[...areaCount.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => [a, a])] : [];
  $('#areaChips').innerHTML = chips.map(([v, l]) => `<button type="button" class="chip-btn${ui.area === v ? ' on' : ''}" data-act="area" data-area="${esc(v)}">${esc(l)}</button>`).join('');
  const match = (t) => (!q || `${t.title} ${t.notes} ${t.area}`.toLowerCase().includes(q)) && (!ui.area || t.area === ui.area);
  const shown = live.filter(match);
  const one = shown.filter((t) => !t.repeat && !t.doneDay && !inToday.has(t.id));
  const scoreOf = (t) => E.scoreTask(t, ctx.sc).score;
  const upcoming = one.filter((t) => t.date && t.date > today).sort((a, b) => a.date.localeCompare(b.date) || scoreOf(b) - scoreOf(a));
  const anytime = one.filter((t) => !t.date).sort((a, b) => scoreOf(b) - scoreOf(a));
  const reps = shown.filter((t) => t.repeat).sort((a, b) => a.title.localeCompare(b.title));
  const ws = E.startOfWeek(today, ctx.ws);
  const flex = reps.filter((t) => t.repeat.kind === 'weekflex' && !t.paused && !inToday.has(t.id) && !E.entriesBetween(ctx.idx, t.id, ws, E.addDays(ws, 6)).length);
  const row = (t, place = 'all') => taskRow({ t, id: t.id, status: 'open', day: '' }, ctx, place);
  let html = '';
  if (upcoming.length) {
    html += `<h3 class="list-head">Upcoming <span class="n">${upcoming.length}</span></h3>`;
    const groups = new Map();
    for (const t of upcoming) {
      const k = E.diffDays(today, t.date) <= 7 ? t.date : 'later';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    for (const [k, list] of groups) {
      const label = k === 'later' ? 'Later' : E.fmtRelDay(k, today, { long: true });
      html += `<div class="group"><h4>${esc(label)}${k !== 'later' && E.diffDays(today, k) > 1 ? ` <span class="m-area">${E.MON3[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8))}</span>` : ''}</h4><ul class="tasks" data-list="${k === 'later' ? 'none' : 'all'}" data-day="${k === 'later' ? '' : k}">${list.map((t) => row(t, k === 'later' ? 'later' : 'all')).join('')}</ul></div>`;
    }
  }
  if (flex.length) html += `<h3 class="list-head">Once this week <span class="n">${flex.length}</span></h3><ul class="tasks" data-list="none">${flex.map((t) => row(t)).join('')}</ul>`;
  html += `<h3 class="list-head">Anytime <span class="n">${anytime.length || ''}</span></h3><ul class="tasks" data-list="all" data-day="">${anytime.map((t) => row(t)).join('')}${!anytime.length ? `<li class="empty-drop">${q || ui.area ? 'No matching tasks.' : 'Tasks without a date land here. Claude and the “Worth doing today” list will bring them back when it matters.'}</li>` : ''}</ul>`;
  if (reps.length) {
    const open_ = !store.device.collapsed.routines;
    html += `<h3 class="list-head"><button type="button" class="toggle" data-act="toggle-routines" aria-expanded="${open_}">${I.down}Repeating</button><span class="n">${reps.length}</span></h3>`;
    if (open_)
      html += `<ul class="tasks" data-list="none">${reps
        .map((t) => {
          const e = E.entryOn(ctx.idx, t.id, today);
          return taskRow({ t, id: t.id, status: e ? (e.skip ? 'skip' : 'done') : 'open', day: today }, ctx, 'routines');
        })
        .join('')}</ul>`;
  }
  if (q && !upcoming.length && !anytime.length && !flex.length && !reps.length) html = `<p class="empty">Nothing matches “${esc(ui.search)}”.</p>`;
  $('#allList').innerHTML = html;
}

/* ---------- calendar ---------- */

function renderCalendar(ctx) {
  const { today } = ctx;
  const month = ui.calMonth || today.slice(0, 7);
  ui.calMonth = month;
  const sel = ui.calDay || today;
  const [y, m] = month.split('-').map(Number);
  google.ensureMonth(month);
  const first = `${month}-01`;
  const start = E.startOfWeek(first, ctx.ws);
  const lastDay = `${month}-${String(E.daysInMonth(y, m)).padStart(2, '0')}`;
  const weeks = Math.ceil((E.diffDays(start, lastDay) + 1) / 7);
  const counts = E.doneCountsByDay(ctx.s.log);
  let cells = '';
  for (let i = 0; i < 7; i++) cells += `<div class="cal-dow">${E.WD3[(ctx.ws + i) % 7]}</div>`;
  for (let i = 0; i < weeks * 7; i++) {
    const D = E.addDays(start, i);
    const inMonth = D.slice(0, 7) === month;
    const evs = google.eventsOn(D);
    const done = counts.get(D) || 0;
    let planned = 0;
    let missed = 0;
    if (D >= today) planned = E.dayItems(ctx.s, ctx.idx, D, today, ctx.settings).filter((x) => x.status === 'open' && x.t.repeat?.kind !== 'daily').length;
    else missed = E.dayItems(ctx.s, ctx.idx, D, today, ctx.settings).filter((x) => x.status === 'miss').length;
    const bars = evs
      .slice(0, 2)
      .map((ev) => `<span class="cbar" style="--ev:${esc(ev.color || '')}">${esc(ev.title)}</span>`)
      .join('');
    const stats = [done ? `<span class="d" title="${done} done">${done}<em> done</em></span>` : '', planned ? `<span class="o" title="${planned} planned">${planned}<em> planned</em></span>` : '', missed ? `<span class="m" title="${missed} missed">${missed}<em> missed</em></span>` : ''].join('');
    cells += `<button type="button" class="cell${inMonth ? '' : ' out'}${D === today ? ' today' : ''}${D === sel ? ' sel' : ''}" data-act="cal-day" data-day="${D}" aria-label="${E.fmtLongDay(D)}"><span class="num">${Number(D.slice(8))}</span>${bars}<span class="cstat">${stats}</span></button>`;
  }
  const items = E.dayItems(ctx.s, ctx.idx, sel, today, ctx.settings);
  const open = E.orderOpen(items.filter((i) => i.status === 'open'), sel, ctx.s, ctx.sc);
  const fin = items.filter((i) => i.status === 'done' || i.status === 'skip');
  const missed = items.filter((i) => i.status === 'miss');
  const evs = google.eventsOn(sel);
  const relSel = E.fmtRelDay(sel, today, { long: true });
  const longSel = E.fmtLongDay(sel, { year: sel.slice(0, 4) !== today.slice(0, 4) });
  let agenda = `<h2>${esc(relSel)}</h2><p class="sub-date">${esc(longSel.startsWith(relSel) ? longSel.slice(relSel.length + 2) : longSel)}</p>`;
  if (evs.length) agenda += `<div class="events">${evs.map((ev) => `<span class="ev" style="--ev:${esc(ev.color || '')}"><i></i><b>${ev.allDay ? 'All day' : E.fmtClock(new Date(ev.start))}</b><span>${esc(ev.title)}</span></span>`).join('')}</div>`;
  if (open.length) agenda += `<h3 class="list-head">${sel < today ? 'Planned, not done' : 'To do'} <span class="n">${open.length}</span></h3><ul class="tasks" data-list="${sel >= today ? 'day' : 'none'}" data-day="${sel}">${open.map((i) => taskRow(i, ctx, 'day')).join('')}</ul>`;
  if (missed.length) agenda += `<h3 class="list-head">Missed <span class="n">${missed.length}</span></h3><ul class="tasks" data-list="none">${missed.map((i) => taskRow(i, ctx, 'past')).join('')}</ul>`;
  if (fin.length) agenda += `<h3 class="list-head">Done <span class="n">${fin.length}</span></h3><ul class="tasks" data-list="none">${fin.map((i) => taskRow(i, ctx, 'past')).join('')}</ul>`;
  if (!open.length && !missed.length && !fin.length && !evs.length) agenda += `<p class="empty">${sel < today ? 'Nothing recorded for this day.' : 'Nothing planned for this day yet.'}</p>`;
  if (sel >= today) agenda += `<p class="dr-hint" style="margin-top:14px"><button type="button" class="text-btn" data-act="open-day" data-day="${sel}">Open this day in Today</button></p>`;
  $('#viewCalendar').innerHTML = `<div class="page"><div class="page-head"><h1>${E.MONTHS[m - 1]} <span>${y}</span></h1><div class="nav"><button type="button" class="icon-btn" data-act="cal-prev" aria-label="Previous month">${I.left}</button><button type="button" class="text-btn" data-act="cal-today">Today</button><button type="button" class="icon-btn" data-act="cal-next" aria-label="Next month">${I.right}</button></div></div>
<div class="cal-wrap"><div class="cal-grid">${cells}</div><aside class="cal-day">${agenda}</aside></div></div>`;
}

/* ---------- history ---------- */

function renderHistory(ctx) {
  const { today, s, idx } = ctx;
  const ws = E.startOfWeek(today, ctx.ws);
  const live = s.log.filter((e) => !e.deleted);
  const doneEntries = live.filter((e) => !e.skip);
  const weekDone = doneEntries.filter((e) => e.day >= ws).length;
  const weekMins = doneEntries.filter((e) => e.day >= ws).reduce((a, e) => a + (e.mins || 0), 0);
  const routines = s.tasks.filter((t) => t.repeat && !t.deletedAt && !t.purged);
  let sched = 0;
  let hit = 0;
  for (const t of routines) for (const p of E.routineTrail(t, idx, today, E.diffDays(ws, today) + 1)) {
    if (p.s === 'done') {
      hit++;
      sched++;
    } else if (p.s === 'miss') sched++;
  }
  const counts = E.doneCountsByDay(s.log);
  const weeksBack = isMobile() ? 17 : 26;
  const start = E.addDays(ws, -7 * (weeksBack - 1));
  let heat = '';
  for (let i = 0; i < weeksBack * 7; i++) {
    const D = E.addDays(start, i);
    const n = counts.get(D) || 0;
    const lvl = D > today ? 'fut' : n === 0 ? '' : n <= 2 ? 'l1' : n <= 5 ? 'l2' : n <= 8 ? 'l3' : 'l4';
    heat += `<i class="${lvl}${D === today ? ' now' : ''}" title="${E.fmtShortDate(D)}: ${n} done"></i>`;
  }
  const rr = routines
    .filter((t) => !t.paused)
    .map((t) => {
      const trail = E.routineTrail(t, idx, today, 14);
      const st = E.streak(t, idx, today, ctx.ws);
      const last = E.lastDoneDay(idx, t.id);
      return `<div class="routine-row"><div><div class="rr-title" data-act="open" data-id="${t.id}" role="button" tabindex="0">${esc(t.title)}</div><div class="rr-meta">${esc(E.describeRepeat(t.repeat))}${last ? `, last done ${esc(relWord(last, today))}` : ', not done yet'}</div><div class="trail">${trail.map((p) => `<i class="${p.s}" title="${E.fmtShortDate(p.day)}: ${p.s === 'miss' ? 'missed' : p.s === 'off' ? 'not scheduled' : p.s === 'today' ? 'today' : p.s}"></i>`).join('')}</div></div><div class="rr-streak">${st >= 2 ? `${st}-${t.repeat.kind === 'weekflex' ? 'week' : 'day'} streak` : ''}</div></div>`;
    })
    .join('');
  const byDay = new Map();
  const cutoff = E.addDays(today, -45);
  for (const e of live) {
    if (e.day < cutoff) continue;
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }
  const days = [...byDay.keys()].sort().reverse();
  const logHtml = days
    .map((D) => {
      const rows = byDay.get(D).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return `<div class="log-day"><h4>${esc(E.fmtRelDay(D, today, { long: true }))} <span>${E.fmtShortDate(D)}</span></h4>${rows
        .map((e) => {
          const t = store.task(e.task);
          const name = t && !t.purged ? t.title : e.title || 'Deleted task';
          const meta = [e.mins ? E.fmtMins(e.mins) : '', e.at ? E.fmtClock(new Date(e.at)) : ''].filter(Boolean).join(', ');
          return `<div class="log-row"><span class="lr-title${e.skip ? ' skip' : ''}">${esc(name)}</span><span class="lr-meta">${e.skip ? 'skipped' : esc(meta)}</span>${t && !t.purged && !t.deletedAt ? `<button type="button" data-act="reopen" data-id="${t.id}" data-day="${D}">${e.skip ? 'Unskip' : 'Reopen'}</button>` : ''}</div>`;
        })
        .join('')}</div>`;
    })
    .join('');
  const trash = s.tasks.filter((t) => t.deletedAt && !t.purged).sort((a, b) => b.deletedAt - a.deletedAt);
  const trashHtml = trash.length
    ? `<h3 class="list-head">Recently deleted <span class="n">${trash.length}</span></h3><p class="muted-note">Deleted tasks are kept for 30 days.</p>${trash.map((t) => `<div class="log-row"><span class="lr-title">${esc(t.title)}</span><span class="lr-meta">${esc(relWord(E.keyFromMs(t.deletedAt), today))}</span><button type="button" data-act="restore" data-id="${t.id}">Restore</button><button type="button" data-act="purge" data-id="${t.id}">Delete forever</button></div>`).join('')}`
    : '';
  $('#viewHistory').innerHTML = `<div class="page"><div class="page-head"><h1>History</h1></div>
<div class="h-stats"><div class="h-stat"><b>${weekDone}</b><span>done this week</span></div>${weekMins ? `<div class="h-stat"><b>${E.fmtMins(weekMins)}</b><span>timed this week</span></div>` : ''}${sched ? `<div class="h-stat"><b>${Math.round((hit / sched) * 100)}%</b><span>of routines kept this week</span></div>` : ''}<div class="h-stat"><b>${doneEntries.length}</b><span>done in total</span></div></div>
<div class="heat" aria-label="Tasks done per day">${heat}</div>
<div class="h-grid"><section>${rr ? `<h3 class="list-head">Routines, last 14 days</h3>${rr}` : '<h3 class="list-head">Routines</h3><p class="muted-note">Repeating tasks show their streaks here.</p>'}${trashHtml}</section>
<section><h3 class="list-head">Done</h3>${logHtml || '<p class="muted-note">Finished tasks show up here, day by day.</p>'}</section></div></div>`;
}

/* ---------- timer, composer ---------- */

function renderTimer(ctx) {
  const pill = $('#timerPill');
  const tm = ctx.timer;
  const t = tm ? store.task(tm.id) : null;
  if (!t) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.innerHTML = `<span class="tp-title">${esc(t.title)}</span><span class="tp-time" id="tpTime">${fmtTimer(Date.now() - tm.start)}</span><button type="button" data-act="timer-done">${I.tick}Done</button><button type="button" data-act="timer-stop" aria-label="Stop timer">${I.stop}Stop</button>`;
}

function targetDay() {
  if (isMobile()) return ui.tab === 'today' && ui.view === 'today' ? ui.day || store.today : null;
  return store.device.addTarget === 'day' ? ui.day || store.today : null;
}

function renderComposerMeta() {
  const tb = $('#targetBtn');
  const D = store.device.addTarget === 'day' ? ui.day || store.today : null;
  tb.innerHTML = `${I.down}<span>${D ? `To ${esc(relWord(D, store.today))}` : 'To Anytime'}</span>`;
  tb.title = 'Where new tasks go when you press Enter. Click to switch.';
  const ask = $('#askBtn');
  ask.classList.toggle('busy', ui.ai?.status === 'busy');
  renderParseChips();
}

function renderParseChips() {
  const v = $('#input').value;
  const el = $('#parseChips');
  if (!v.trim()) {
    el.innerHTML = `<span class="hint"><span><kbd>↵</kbd>Add</span><span><kbd>${MOD} ↵</kbd>Ask Claude</span><span><kbd>⇧ ↵</kbd>New line</span></span>`;
    return;
  }
  const lines = v.split('\n').filter((l) => l.trim());
  if (lines.length > 1) {
    el.innerHTML = `<span class="pc">${lines.length} tasks</span><span class="hint"><span>Enter adds each line</span><span>${MOD}+Enter lets Claude sort them</span></span>`;
    return;
  }
  const p = E.parseQuick(v, store.today, { weekStart: store.settings.weekStart });
  el.innerHTML = p.chips.map((c) => `<span class="pc">${esc(c.label)}</span>`).join('');
}

function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
}

/* ---------- AI panel ---------- */

function countItems(text) {
  const parts = text.split(/\n|,|;|\band\b|\bthen\b/i).filter((p) => p.trim().length > 2);
  return parts.length;
}

function renderAIPanel() {
  const a = ui.ai;
  const el = $('#aiPanel');
  if (!a) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  if (a.status === 'busy') {
    const n = countItems(a.text);
    const slow = Date.now() - a.startedAt > 14000;
    const msg = slow ? 'Still working. Long lists take Claude a little longer…' : n > 1 ? `Claude is sorting about ${n} things…` : 'Claude is on it…';
    el.innerHTML = `<div class="ai-head busy">${I.spark}<p class="ai-reply"><span class="shimmer">${esc(msg)}</span><span class="quoted">“${esc(a.text)}”</span></p><button type="button" class="icon-btn sm" data-ai="cancel" aria-label="Cancel">${I.x}</button></div>`;
    return;
  }
  if (a.status === 'error') {
    el.innerHTML = `<div class="ai-head error">${I.spark}<p class="ai-reply">${esc(a.message)}<span class="quoted">“${esc(a.text)}”</span></p><button type="button" class="icon-btn sm" data-ai="close" aria-label="Close">${I.x}</button></div><div class="ai-changes"><button type="button" class="chip-btn" data-ai="retry">Try again</button>${['nokey', 'auth', 'model'].includes(a.code) ? '<button type="button" class="chip-btn" data-ai="settings">Open settings</button>' : ''}</div>`;
    return;
  }
  const r = a.result;
  const title = (id) => store.task(id)?.title || 'a task';
  const chips = [];
  if (r.created.length) chips.push(`Added ${r.created.length}`);
  if (r.updated.length) chips.push(`Updated ${r.updated.length}`);
  if (r.completed.length) chips.push(`Completed ${r.completed.length}`);
  if (r.removed.length) chips.push(`Deleted ${r.removed.length}`);
  const any = chips.length > 0;
  const detail = [];
  for (const id of r.created) {
    const t = store.task(id);
    if (!t) continue;
    const bits = [t.date ? E.fmtRelDay(t.date, store.today) : '', t.deadline ? `due ${E.fmtRelDay(t.deadline, store.today)}` : '', t.repeat ? E.describeRepeat(t.repeat).toLowerCase() : '', E.fmtEst(t.estMin, t.estMax), t.priority <= 2 ? `P${t.priority}` : '', t.area].filter(Boolean);
    detail.push(`<li><span class="k">Added</span><span>${esc(t.title)}${bits.length ? ` <span class="m-area">${esc(bits.join(', '))}</span>` : ''}</span></li>`);
  }
  const FIELD = { title: 'title', notes: 'notes', priority: 'priority', area: 'area', estMin: 'time estimate', estMax: 'time estimate', optional: 'optional', date: 'date', deadline: 'deadline', time: 'time', repeat: 'repeat' };
  for (const u of r.updated) detail.push(`<li><span class="k">Updated</span><span>${esc(title(u.id))} <span class="m-area">${esc([...new Set(u.fields.map((f) => FIELD[f] || f))].join(', '))}</span></span></li>`);
  for (const id of r.completed) detail.push(`<li><span class="k">Done</span><span>${esc(title(id))}</span></li>`);
  for (const id of r.removed) detail.push(`<li><span class="k">Deleted</span><span>${esc(title(id))}</span></li>`);
  const qs = a.questions
    .map((q, i) => {
      const t = store.task(q.taskId);
      if (!t) return '';
      return `<div class="ai-q${q.answer ? ' answered' : ''}" data-qi="${i}"><p>${esc(q.text)}<small>${esc(t.title)}${q.answer ? `: ${esc(q.answer)}` : ''}</small></p>${q.answer ? '' : `<div class="opts">${q.options.map((o) => `<button type="button" class="chip-btn" data-ai="answer" data-qi="${i}" data-v="${esc(o)}">${esc(o)}</button>`).join('')}<input class="other" data-qi="${i}" placeholder="Other…" aria-label="Another answer"><button type="button" class="chip-btn" data-ai="skipq" data-qi="${i}">Skip</button></div>`}</div>`;
    })
    .join('');
  el.innerHTML = `<div class="ai-head">${I.spark}<p class="ai-reply">${esc(r.reply || (any ? 'Done.' : 'No changes.'))}</p><button type="button" class="icon-btn sm" data-ai="close" aria-label="Close">${I.x}</button></div>
${any ? `<div class="ai-changes">${chips.map((c) => `<span class="chip-btn" style="box-shadow:none;background:var(--spruce-soft);color:var(--spruce)">${c}</span>`).join('')}<button type="button" class="chip-btn" data-ai="details">${a.showDetails ? 'Hide details' : 'Details'}</button>${a.step ? `<button type="button" class="chip-btn" data-ai="undo">${I.undo}Undo</button>` : ''}</div>${a.showDetails ? `<ul class="ai-detail">${detail.join('')}</ul>` : ''}` : ''}
${qs ? `<div class="ai-qs">${qs}</div>` : ''}`;
}

/* ================================================================== */
/* drawer                                                              */
/* ================================================================== */

function openDrawer(id) {
  if (!store.task(id)) return;
  ui.drawer = id;
  ui.editStep = null;
  $('#drawer').hidden = false;
  $('#scrim').hidden = !isMobile();
  renderDrawer();
  closeMenu();
}
function closeDrawer() {
  ui.drawer = null;
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}

function renderDrawer() {
  const t = store.task(ui.drawer);
  if (!t || t.deletedAt || t.purged) return closeDrawer();
  const ctx = ctxNow();
  const { today } = ctx;
  const rep = t.repeat;
  const doneToday = rep ? !!E.entryOn(ctx.idx, t.id, today) : !!t.doneDay;
  const areas = [...new Set(store.state.tasks.filter((x) => x.area && !x.purged).map((x) => x.area))];
  const kind = rep ? rep.kind : 'none';
  const timing = ctx.timer?.id === t.id;
  const estChips = [5, 10, 15, 30, 45, 60, 90, 120].map((v) => `<button type="button" class="chip-btn${t.estMin === v && t.estMax === v ? ' on' : ''}" data-dr="est" data-v="${v}">${E.fmtMins(v)}</button>`).join('');
  const dateChips = [
    ['Today', today],
    ['Tomorrow', E.addDays(today, 1)],
    ['Weekend', E.resolveDate('this weekend', today)],
    ['Next week', E.resolveDate('next week', today, ctx.ws)],
  ]
    .map(([l, v]) => `<button type="button" class="chip-btn${(rep ? t.plan : t.date) === v ? ' on' : ''}" data-dr="date" data-v="${v}">${l}</button>`)
    .join('');
  const repeatSub =
    kind === 'weekly'
      ? `<div class="days-pick" style="margin-top:8px">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" data-dr="wday" data-v="${d}" aria-pressed="${rep.days.includes(d)}" aria-label="${E.WEEKDAYS[d]}">${E.WD3[d].slice(0, 2)}</button>`).join('')}</div>`
      : kind === 'interval'
        ? `<div class="row" style="margin-top:8px"><span>Every</span><input class="inp num" type="number" min="2" max="365" data-f="every" value="${rep.every}"><span>days, counted from the last time you did it</span></div>`
        : kind === 'monthly'
          ? `<div class="row" style="margin-top:8px"><span>On day</span><input class="inp num" type="number" min="1" max="31" data-f="dom" value="${rep.dom}"><span>of each month</span></div>`
          : '';
  const history = rep
    ? `<div class="field"><span class="label">Last 14 days</span><div><div class="trail">${E.routineTrail(t, ctx.idx, today, 14)
        .map((p) => `<i class="${p.s}" title="${E.fmtShortDate(p.day)}"></i>`)
        .join('')}</div><p class="dr-hint">${(() => {
        const st = E.streak(t, ctx.idx, today, ctx.ws);
        const last = E.lastDoneDay(ctx.idx, t.id);
        return [last ? `Last done ${relWord(last, today)}` : 'Not done yet', st >= 2 ? `${st}-${kind === 'weekflex' ? 'week' : 'day'} streak` : '', `${E.doneCount(ctx.idx, t.id)} times in total`].filter(Boolean).join('. ');
      })()}</p>
<label class="toggle-row" style="margin-top:8px"><input type="checkbox" class="switch" data-f="paused" ${t.paused ? 'checked' : ''}>Pause this routine</label></div></div>`
    : '';
  const gcal = google.configured
    ? `<div class="field"><span class="label">Calendar</span><div><div class="row"><input class="inp" type="date" id="gcDate" value="${t.date && t.date >= today ? t.date : today}"><input class="inp" type="time" id="gcTime" value="${t.time || nextHalfHour()}"><button type="button" class="chip-btn" data-dr="gcal">${I.calendar}Block ${E.fmtMins(E.estMid(t) || 30)}</button></div><p class="dr-hint">Adds a busy block to your Google Calendar.</p></div></div>`
    : '';
  $('#drawer').innerHTML = `<div class="dr-head"><span class="grow">${t.src === 'ai' ? 'Added by Claude' : 'Added'} ${esc(relWord(E.keyFromMs(t.createdAt || Date.now()), today))}</span><button type="button" class="icon-btn sm" data-dr="close" aria-label="Close details">${I.x}</button></div>
<div class="dr-body">
<textarea class="dr-title" data-f="title" rows="1" aria-label="Title">${esc(t.title)}</textarea>
<div class="dr-done"><button type="button" class="chip-btn${doneToday ? ' on' : ''}" data-dr="toggle-done">${I.tick}${doneToday ? (rep ? 'Done today' : 'Done') : rep ? 'Mark done today' : 'Mark done'}</button>
<button type="button" class="chip-btn" data-dr="timer">${timing ? `${I.stop}Stop timer` : `${I.play}Start timer`}</button>
${rep && !doneToday ? '<button type="button" class="chip-btn" data-dr="skip">Skip today</button>' : ''}</div>
<div class="field"><span class="label">Priority</span><div class="seg" role="group" aria-label="Priority">${[1, 2, 3, 4].map((p) => `<button type="button" class="p${p}" data-dr="pri" data-v="${p}" aria-pressed="${t.priority === p}">${E.PRIORITY_NAMES[p]}</button>`).join('')}</div></div>
<div class="field"><label for="drDate">${rep ? 'Next one on' : 'Do on'}</label><div><div class="row"><input id="drDate" class="inp" type="date" data-f="${rep ? 'plan' : 'date'}" value="${(rep ? t.plan : t.date) || ''}"><button type="button" class="chip-btn" data-dr="date" data-v="">${rep ? 'Usual schedule' : 'No date'}</button></div><div class="row" style="margin-top:6px">${dateChips}</div></div></div>
<div class="field"><label for="drDue">Due</label><div class="row"><input id="drDue" class="inp" type="date" data-f="deadline" value="${t.deadline || ''}">${t.deadline ? '<button type="button" class="chip-btn" data-dr="clear" data-v="deadline">Clear</button>' : ''}</div></div>
<div class="field"><label for="drTime">At</label><div class="row"><input id="drTime" class="inp" type="time" data-f="time" value="${t.time || ''}">${t.time ? '<button type="button" class="chip-btn" data-dr="clear" data-v="time">Clear</button>' : ''}</div></div>
<div class="field"><span class="label">Takes</span><div><div class="row">${estChips}</div><div class="row" style="margin-top:8px"><input class="inp num" type="number" min="1" max="1440" data-f="estMin" value="${t.estMin ?? ''}" aria-label="Minimum minutes" placeholder="min"><span>to</span><input class="inp num" type="number" min="1" max="1440" data-f="estMax" value="${t.estMax ?? ''}" aria-label="Maximum minutes" placeholder="max"><span>minutes</span>${t.estMin != null ? '<button type="button" class="chip-btn" data-dr="clear" data-v="est">Clear</button>' : ''}</div>${t.spent ? `<p class="dr-hint">${E.fmtMins(t.spent)} timed so far.</p>` : ''}</div></div>
<div class="field"><label for="drRep">Repeats</label><div><select id="drRep" class="inp" data-f="repeatKind">${[
    ['none', 'Does not repeat'],
    ['daily', 'Every day'],
    ['weekly', 'On certain weekdays'],
    ['weekflex', 'Once a week, any day'],
    ['interval', 'Every few days, after the last time'],
    ['monthly', 'Monthly'],
  ]
    .map(([v, l]) => `<option value="${v}"${v === kind ? ' selected' : ''}>${l}</option>`)
    .join('')}</select>${repeatSub}</div></div>
<div class="field"><label for="drArea">Area</label><div><input id="drArea" class="inp" data-f="area" list="drAreas" value="${esc(t.area)}" placeholder="School, Home, Health…"><datalist id="drAreas">${areas.map((a) => `<option value="${esc(a)}">`).join('')}</datalist></div></div>
<div class="field"><span class="label">Optional</span><label class="toggle-row"><input type="checkbox" class="switch" data-f="optional" ${t.optional ? 'checked' : ''}>Nice to do, not a must</label></div>
${history}${gcal}
<div class="field"><label for="drNotes">Notes</label><textarea id="drNotes" class="inp dr-notes" data-f="notes" placeholder="Details, links, steps…">${esc(t.notes)}</textarea></div>
</div>
<div class="dr-foot"><button type="button" class="btn secondary" data-dr="delete">${I.trash}Delete</button><span class="grow"></span><button type="button" class="btn secondary" data-dr="dup">${I.dup}Duplicate</button></div>`;
  const fit = () => {
    const ta = $('#drawer .dr-title');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight, 32)}px`;
  };
  fit();
  requestAnimationFrame(fit);
}

function nextHalfHour() {
  const d = new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  const n = Math.min(23 * 60 + 30, Math.ceil((m + 5) / 30) * 30);
  return E.minToTime(n);
}

function drawerField(el) {
  const t = store.task(ui.drawer);
  if (!t) return;
  const f = el.dataset.f;
  const today = store.today;
  let ch = null;
  if (f === 'title') {
    const v = el.value.replace(/\n/g, ' ');
    if (!v.trim()) return;
    ch = { title: v };
  } else if (f === 'notes') ch = { notes: el.value };
  else if (f === 'area') ch = { area: el.value };
  else if (f === 'date' || f === 'deadline' || f === 'plan') ch = { [f]: el.value || null };
  else if (f === 'time') ch = { time: el.value || null };
  else if (f === 'estMin' || f === 'estMax') {
    const a = $('[data-f=estMin]', $('#drawer')).value;
    const b = $('[data-f=estMax]', $('#drawer')).value;
    ch = { estMin: a === '' ? (b === '' ? null : Number(b)) : Number(a), estMax: b === '' ? (a === '' ? null : Number(a)) : Number(b) };
  } else if (f === 'optional') ch = { optional: el.checked };
  else if (f === 'paused') ch = { paused: el.checked };
  else if (f === 'repeatKind') {
    const k = el.value;
    if (k === 'none') ch = { repeat: null };
    else if (k === 'weekly') ch = { repeat: { kind: 'weekly', days: [E.weekday(today)] } };
    else if (k === 'interval') ch = { repeat: { kind: 'interval', every: 7 } };
    else if (k === 'monthly') ch = { repeat: { kind: 'monthly', dom: Number(today.slice(8)) } };
    else ch = { repeat: { kind: k } };
  } else if (f === 'every') ch = { repeat: { kind: 'interval', every: Number(el.value) || 7 } };
  else if (f === 'dom') ch = { repeat: { kind: 'monthly', dom: Number(el.value) || 1 } };
  if (!ch) return;
  const textual = ['title', 'notes', 'area', 'estMin', 'estMax', 'every', 'dom'].includes(f);
  const key = `${t.id}:${f}`;
  const undoable = !textual || ui.editStep !== key;
  if (textual) ui.editStep = key;
  ui.fromDrawer = true;
  try {
    store.updateTask(t.id, ch, { label: `Edited “${t.title}”`, undoable });
  } finally {
    ui.fromDrawer = false;
  }
  if (!textual) renderDrawer();
}

/* ================================================================== */
/* menu                                                                */
/* ================================================================== */

function openMenu(anchor, id, day) {
  const t = store.task(id);
  if (!t) return;
  const today = store.today;
  const ws = store.settings.weekStart ?? 1;
  const rep = t.repeat;
  const ctx = ctxNow();
  const inToday = E.dayItems(ctx.s, ctx.idx, today, today, ctx.settings).some((i) => i.id === id && i.status === 'open');
  const weekendKey = E.resolveDate('this weekend', today);
  const opts = [
    ['Today', today],
    ['Tomorrow', E.addDays(today, 1)],
    [E.weekday(today) === 6 || E.weekday(today) === 0 ? 'Next weekend' : 'This weekend', E.weekday(today) === 6 || E.weekday(today) === 0 ? E.resolveDate('next weekend', today) : weekendKey],
    ['Next week', E.resolveDate('next week', today, ws)],
  ];
  const timing = store.state.meta.timer?.id === id;
  const m = $('#menu');
  m.innerHTML = `<div class="m-pris" role="group" aria-label="Priority">${[1, 2, 3, 4].map((p) => `<button type="button" class="p${p}" data-m="pri" data-v="${p}" aria-pressed="${t.priority === p}" title="${E.PRIORITY_NAMES[p]}">P${p}</button>`).join('')}</div>
${opts.map(([l, v]) => `<button type="button" class="mi" role="menuitem" data-m="move" data-v="${v}">${l === 'Today' ? I.sun : I.calendar}${l}<small>${E.fmtShortDate(v)}</small></button>`).join('')}
<div class="m-date"><input type="date" class="inp" data-m="pick" aria-label="Pick a date" min="${today}"></div>
<button type="button" class="mi" role="menuitem" data-m="move" data-v="">${I.x}${rep ? 'Back to its usual schedule' : 'No date'}</button><hr>
${rep && inToday ? `<button type="button" class="mi" role="menuitem" data-m="skip">${I.skip}Skip today</button>` : ''}
<button type="button" class="mi" role="menuitem" data-m="timer">${timing ? `${I.stop}Stop timer` : `${I.play}Start timer`}</button>
<button type="button" class="mi" role="menuitem" data-m="open">${I.list}Details</button>
<button type="button" class="mi" role="menuitem" data-m="dup">${I.dup}Duplicate</button>
<button type="button" class="mi danger" role="menuitem" data-m="delete">${I.trash}Delete</button>`;
  m.hidden = false;
  ui.menuFor = { id, day, anchor };
  anchor.setAttribute('aria-expanded', 'true');
  if (!isMobile()) {
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    let left = Math.min(window.innerWidth - mw - 8, r.right - mw);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    m.style.left = `${Math.max(8, left)}px`;
    m.style.top = `${top}px`;
  }
  m.querySelector('.mi')?.focus({ preventScroll: true });
}
function closeMenu() {
  const m = $('#menu');
  if (m.hidden) return;
  m.hidden = true;
  ui.menuFor?.anchor?.setAttribute('aria-expanded', 'false');
  ui.menuFor = null;
}

function onMenu(act, el) {
  const f = ui.menuFor;
  if (!f) return;
  const t = store.task(f.id);
  if (!t) return closeMenu();
  const today = store.today;
  if (act === 'pri') {
    store.updateTask(t.id, { priority: Number(el.dataset.v) }, { label: `Changed priority of “${t.title}”` });
  } else if (act === 'move') {
    const v = el.dataset.v || null;
    store.moveTo(t.id, v);
    undoToast(v ? `Moved to ${relWord(v, today)}` : t.repeat ? 'Back on its usual schedule' : 'Moved to Anytime', lastStep());
  } else if (act === 'skip') {
    store.skip(t.id, today);
    undoToast(`Skipped “${t.title}” today`, lastStep());
  } else if (act === 'timer') toggleTimer(t.id);
  else if (act === 'open') openDrawer(t.id);
  else if (act === 'dup') duplicate(t);
  else if (act === 'delete') deleteTask(t);
  closeMenu();
}

/* ================================================================== */
/* actions                                                             */
/* ================================================================== */

function duplicate(t) {
  const copy = { ...t, title: `${t.title} (copy)` };
  delete copy.doneAt;
  delete copy.doneDay;
  store.addTasks([copy], { label: `Duplicated “${t.title}”` });
  toast('Duplicated');
}
function deleteTask(t) {
  store.remove(t.id);
  if (ui.drawer === t.id) closeDrawer();
  undoToast(`Deleted “${t.title}”`, lastStep());
}
function toggleTimer(id) {
  if (store.state.meta.timer?.id === id) store.stopTimer(true);
  else store.startTimer(id);
}

function toggleCheck(li) {
  const id = li.dataset.id;
  const t = store.task(id);
  if (!t) return;
  const day = li.dataset.day || store.today;
  const st = li.dataset.status;
  if (st === 'done' || st === 'skip') {
    store.uncomplete(id, t.repeat ? day : t.doneDay || day);
    return;
  }
  li.classList.add('done');
  li.querySelector('.check')?.setAttribute('aria-pressed', 'true');
  const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
  setTimeout(() => {
    store.complete(id, day);
    undoToast(`Done: ${t.title}`, lastStep());
  }, delay);
}

function addFromInput() {
  const input = $('#input');
  const raw = input.value.trim();
  if (!raw) return;
  const today = store.today;
  const ws = store.settings.weekStart ?? 1;
  const lines = raw
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[ ?\])\s+/, '').trim())
    .filter(Boolean);
  const D = targetDay();
  const list = lines.map((l) => {
    const p = E.parseQuick(l, today, { weekStart: ws });
    const f = { title: p.title, date: p.date, deadline: p.deadline, time: p.time, estMin: p.estMin, estMax: p.estMax, priority: p.priority || 3, repeat: p.repeat, area: p.area, optional: p.optional };
    if (!f.date && !f.repeat && D) f.date = D;
    return f;
  });
  const made = store.addTasks(list);
  input.value = '';
  autoGrow();
  renderParseChips();
  if (ui.ai && ui.ai.status !== 'busy' && !ui.ai.questions?.some((q) => !q.answer)) {
    ui.ai = null;
    renderAIPanel();
  }
  const where = (t) => (t.repeat ? E.describeRepeat(t.repeat).toLowerCase() : t.date ? (t.date === today ? 'today' : relWord(t.date, today)) : 'Anytime');
  const msg = made.length === 1 ? `Added to ${where(made[0])}` : `Added ${made.length} tasks`;
  undoToast(msg.replace('Added to every', 'Added, repeats every').replace('Added to once', 'Added, once').replace('Added to weekdays', 'Added, repeats on weekdays'), lastStep());
}

async function askClaude(textArg) {
  const input = $('#input');
  const text = (textArg ?? input.value).trim();
  if (!text) {
    input.focus();
    return;
  }
  if (!store.device.apiKey) {
    openSettings('claude');
    toast('Add your Anthropic API key to use Claude.');
    return;
  }
  if (ui.ai?.status === 'busy') {
    toast('Claude is still working on your last request.');
    return;
  }
  if (!textArg) {
    input.value = '';
    autoGrow();
    renderParseChips();
  }
  const ctrl = new AbortController();
  ui.ai = { status: 'busy', text, startedAt: Date.now(), ctrl };
  renderAIPanel();
  renderComposerMeta();
  const slowTimer = setTimeout(renderAIPanel, 15000);
  const ctx = ctxNow();
  try {
    const { ids, snapshot } = AI.commandContext({ state: store.state, idx: ctx.idx, today: ctx.today, now: new Date(), events: google.configured ? google.windowEvents(14) : null, settings: ctx.settings });
    const r = await AI.callClaude({
      apiKey: store.device.apiKey,
      model: store.device.model || AI.DEFAULT_MODEL,
      effort: store.device.effort || AI.DEFAULT_EFFORT,
      system: AI.COMMAND_SYSTEM,
      content: `Snapshot:\n${JSON.stringify(snapshot)}\n\nMessage:\n${text}`,
      schema: AI.COMMAND_SCHEMA,
      maxTokens: 12000,
      signal: ctrl.signal,
    });
    const result = applyCommand(r.data, ids);
    ui.ai = { status: 'done', text, result, step: result.step, questions: result.questions, showDetails: false };
  } catch (e) {
    if (e.code === 'cancelled') {
      ui.ai = null;
      if (!input.value) input.value = text;
      autoGrow();
      renderParseChips();
    } else {
      ui.ai = { status: 'error', text, message: e.message, code: e.code };
      if (!input.value.trim()) {
        input.value = text;
        autoGrow();
        renderParseChips();
      }
    }
  } finally {
    clearTimeout(slowTimer);
  }
  renderAIPanel();
  renderComposerMeta();
}

function applyCommand(data, ids) {
  const today = store.today;
  const refs = new Map();
  const out = { reply: String(data.reply || ''), created: [], updated: [], completed: [], removed: [], questions: [], step: null };
  const before = store.undoStack.length;
  store.transact('Claude’s changes', (s) => {
    for (const c of data.create || []) {
      const f = AI.taskFieldsFromAI(c);
      if (!f.title) continue;
      const t = E.normalizeTask({ ...f, src: 'ai', createdAt: Date.now(), updatedAt: Date.now() }, today);
      s.tasks.push(t);
      refs.set(String(c.ref || '').trim(), t.id);
      out.created.push(t.id);
    }
    const merged = new Map();
    for (const u of data.update || []) {
      const id = ids.long(u.id);
      if (!id) continue;
      merged.set(id, { ...(merged.get(id) || {}), ...AI.changesFromAI(u.set) });
    }
    for (const [id, ch] of merged) {
      const t = s.tasks.find((x) => x.id === id);
      if (!t || t.deletedAt || t.purged) continue;
      const eff = {};
      for (const [k, v] of Object.entries(ch)) if (JSON.stringify(t[k] ?? null) !== JSON.stringify(v ?? null)) eff[k] = v;
      if (!Object.keys(eff).length) continue;
      if ('date' in eff && t.repeat) {
        eff.plan = eff.date;
        delete eff.date;
      }
      applyChanges(t, eff, today);
      out.updated.push({ id, fields: Object.keys(eff) });
    }
    const idx = E.buildIndex(s.log);
    for (const sid of data.complete || []) {
      const id = ids.long(sid);
      const t = s.tasks.find((x) => x.id === id);
      if (!t || t.deletedAt || t.purged) continue;
      if (t.repeat ? E.entryOn(idx, t.id, today) : t.doneDay) continue;
      markDone(s, t, today);
      out.completed.push(id);
    }
    for (const sid of data.remove || []) {
      const id = ids.long(sid);
      const t = s.tasks.find((x) => x.id === id);
      if (!t || t.deletedAt || t.purged) continue;
      t.deletedAt = Date.now();
      t.updatedAt = Date.now();
      out.removed.push(id);
    }
  });
  if (store.undoStack.length > before) out.step = lastStep();
  for (const q of data.questions || []) {
    const taskId = refs.get(String(q.target).trim()) || ids.long(q.target);
    if (!taskId || !store.task(taskId)) continue;
    const options = (q.options || []).map((o) => String(o).slice(0, 40)).filter(Boolean).slice(0, 5);
    out.questions.push({ taskId, field: q.field, text: String(q.text || '').slice(0, 200), options, answer: null });
  }
  return out;
}

function answerQuestion(qi, value, inputEl) {
  const q = ui.ai?.questions?.[qi];
  if (!q) return;
  const ch = AI.answerToChanges(q.field, value, store.today, store.settings.weekStart ?? 1);
  if (ch === null) {
    if (inputEl) {
      inputEl.classList.remove('bad');
      void inputEl.offsetWidth;
      inputEl.classList.add('bad');
    }
    toast("Couldn't read that answer. Try something like “2h” or “Friday”.");
    return;
  }
  const t = store.task(q.taskId);
  if (Object.keys(ch).length && t) {
    const c = { ...ch };
    if ('date' in c && t.repeat) {
      c.plan = c.date;
      delete c.date;
    }
    store.updateTask(q.taskId, c, { label: `Updated “${t.title}”` });
  }
  q.answer = Object.keys(ch).length ? value : 'Skipped';
  renderAIPanel();
}

/* ---------- planning ---------- */

async function planDay({ auto = false } = {}) {
  const today = store.today;
  if (ui.planning) return;
  if (!store.device.apiKey) {
    localPlan();
    if (!auto) toast('Sorted by deadlines, priority, and how long things have waited. Add a Claude key in Settings for a smarter plan.');
    return;
  }
  ui.planning = true;
  ui.planError = null;
  render();
  try {
    if (google.configured) await google.refreshEvents(true).catch(() => {});
    const ctx = ctxNow();
    const items = E.dayItems(ctx.s, ctx.idx, today, today, ctx.settings);
    const now = new Date();
    const free = E.freeTime({ events: google.eventsOn(today).filter((e) => !e.allDay), D: today, dayStart: ctx.settings.dayStart, dayEnd: ctx.settings.dayEnd, now }).free;
    const { ids, snapshot } = AI.planContext({ state: ctx.s, idx: ctx.idx, today, now, events: google.configured ? google.windowEvents(14) : null, settings: ctx.settings, todayItems: items, free });
    const r = await AI.callClaude({
      apiKey: store.device.apiKey,
      model: store.device.model || AI.DEFAULT_MODEL,
      effort: store.device.effort || AI.DEFAULT_EFFORT,
      system: AI.PLAN_SYSTEM,
      content: `Snapshot:\n${JSON.stringify(snapshot)}`,
      schema: AI.PLAN_SCHEMA,
      maxTokens: 10000,
    });
    applyPlan(r.data, ids, today);
  } catch (e) {
    ui.planError = e.message;
  } finally {
    ui.planning = false;
    render();
  }
}

function applyPlan(data, ids, today) {
  const before = store.undoStack.length;
  store.transact('your day plan', (s) => {
    const find = (sid) => {
      const id = ids.long(sid);
      return id ? s.tasks.find((t) => t.id === id && !t.deletedAt && !t.purged) : null;
    };
    const pulled = [];
    const deferred = [];
    for (const p of data.pull || []) {
      const t = find(p.id);
      if (!t || t.doneDay) continue;
      moveTask(s, t, today, today);
      if (p.reason) t.ai = { note: String(p.reason).slice(0, 120), day: today };
      pulled.push({ id: t.id, reason: p.reason });
    }
    for (const d of data.defer || []) {
      const t = find(d.id);
      if (!t || t.repeat || t.priority === 1 || (t.deadline && t.deadline <= today) || t.doneDay) continue;
      const to = E.isKey(d.to) && d.to > today ? d.to : null;
      moveTask(s, t, to, today);
      deferred.push({ id: t.id, to, reason: d.reason });
    }
    for (const n of data.notes || []) {
      const t = find(n.id);
      if (!t || !n.note) continue;
      t.ai = { note: String(n.note).slice(0, 120), day: today };
      t.updatedAt = Date.now();
    }
    for (const e of data.estimates || []) {
      const t = find(e.id);
      if (!t || t.estMin != null || !(e.estMin > 0)) continue;
      applyChanges(t, { estMin: e.estMin, estMax: e.estMax || e.estMin }, today);
    }
    const order = [...new Set((data.order || []).map((x) => ids.long(x)).filter(Boolean))];
    if (order.length) s.meta.order[today] = { ids: order, at: Date.now(), by: 'claude' };
    s.meta.plans[today] = {
      brief: String(data.brief || '').slice(0, 600),
      at: Date.now(),
      by: 'claude',
      pulled,
      deferred,
      suggest: (data.suggest || []).slice(0, 3).map((x) => ({ title: String(x.title || '').slice(0, 140), reason: String(x.reason || '').slice(0, 140), deadline: E.isKey(x.deadline) ? x.deadline : null, estMin: x.estMin ?? null, estMax: x.estMax ?? null })),
      added: [],
    };
  });
  if (store.undoStack.length > before) ui.planStep = { day: today, step: lastStep() };
}

function localPlan() {
  const ctx = ctxNow();
  const today = ctx.today;
  const items = E.dayItems(ctx.s, ctx.idx, today, today, ctx.settings).filter((i) => i.status === 'open');
  const scored = items.map((i) => ({ i, sc: E.scoreTask(i.t, ctx.sc).score })).sort((a, b) => b.sc - a.sc);
  const load = E.workload(items);
  const free = E.freeTime({ events: google.eventsOn(today).filter((e) => !e.allDay), D: today, dayStart: ctx.settings.dayStart, dayEnd: ctx.settings.dayEnd, now: new Date() }).free;
  const top = scored[0]?.i.t.title;
  const brief = items.length ? `${items.length} things today, about ${E.fmtMins(load.mins)} against ${E.fmtMins(free)} free.${top ? ` Start with ${top}.` : ''}` : 'Nothing planned yet. Pull something in from the suggestions below.';
  const before = store.undoStack.length;
  store.transact('sorting your day', (s) => {
    s.meta.order[today] = { ids: scored.map((x) => x.i.id), at: Date.now(), by: 'daywell' };
    s.meta.plans[today] = { brief, at: Date.now(), by: 'daywell', pulled: [], deferred: [], suggest: [], added: [] };
  });
  if (store.undoStack.length > before) ui.planStep = { day: today, step: lastStep() };
}

function maybeAutoPlan() {
  const s = store.state;
  const today = store.today;
  if (!s.shared.autoPlan || !store.device.apiKey) return;
  if (s.meta.plans[today]) return;
  if (ui.autoPlanTried === today) return;
  const now = new Date();
  if (E.keyFromDate(now) === today && now.getHours() < (s.shared.autoPlanHour ?? 6)) return;
  const endMin = E.timeToMin(s.shared.dayEnd || '23:00');
  const nowMin = E.minutesInto(now, today);
  if (endMin > E.timeToMin(s.shared.dayStart || '07:00') && nowMin > endMin - 60) return;
  if (!s.tasks.some((t) => !t.deletedAt && !t.purged)) return;
  ui.autoPlanTried = today;
  planDay({ auto: true });
}

/* ================================================================== */
/* settings                                                            */
/* ================================================================== */

function openSettings(focus) {
  renderSettings();
  const d = $('#settings');
  if (!d.open) d.showModal();
  if (focus) {
    const sec = $(`#st-${focus}`);
    sec?.scrollIntoView({ block: 'start' });
    if (focus === 'claude' && !store.device.apiKey) $('#st-key')?.focus();
  }
}

function renderSettings() {
  const dv = store.device;
  const sh = store.state.shared;
  const hours = (sel) => Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === sel ? ' selected' : ''}>${E.fmtTime(E.minToTime(h * 60))}</option>`).join('');
  const g = google;
  const pending = dv.gsSecretPending || '';
  const cals = g.calendars || [];
  const prefs = sh.calendars || {};
  const googleBody = g.configured
    ? `<p>Connected. Your events show on each day, Claude plans around them, and your tasks sync across devices.</p>
<div class="st-row"><label>Sync</label><div class="row"><input type="checkbox" class="switch" id="st-sync" ${dv.sync ? 'checked' : ''}><span>${g.status === 'error' ? `<span class="st-status err">${esc(g.error)}</span>` : dv.lastSync ? `Last synced ${E.fmtClock(new Date(dv.lastSync))}` : 'Not synced yet'}</span><button type="button" class="chip-btn" data-st="sync-now">${I.sync}Sync now</button></div></div>
<div class="st-row"><label>Calendars</label><div>${cals.length ? `<div class="cal-list">${cals.map((c) => `<label><input type="checkbox" data-cal="${esc(c.id)}" ${(c.id in prefs ? prefs[c.id] : c.selected) ? 'checked' : ''}><i style="--ev:${esc(c.color)}"></i>${esc(c.name)}</label>`).join('')}</div>` : `<button type="button" class="chip-btn" data-st="load-cals">Show my calendars</button>`}</div></div>
<div class="st-row"><label>Other devices</label><div class="row"><button type="button" class="chip-btn" data-st="setup-link">${I.link}Copy setup link</button><label class="toggle-row" style="padding:0"><input type="checkbox" id="st-linkkey" ${dv.apiKey ? '' : 'disabled'}>Include Claude key</label></div></div>
<p class="st-note">Open the setup link on your phone to connect it in one tap. It contains your private keys, so send it only to yourself.</p>
<div class="st-row"><label></label><div class="row"><button type="button" class="btn secondary" data-st="disconnect">Disconnect Google</button></div></div>`
    : `<p>See your Google Calendar events on each day, let Claude plan around them, and sync tasks between your phone and laptop. It runs as a small free script inside your own Google account. Setup takes about 3 minutes.</p>
<ol class="steps">
<li><button type="button" class="chip-btn" data-st="copy-script">${I.copy}Copy script</button> It has a private key built in.</li>
<li>Open <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a>, delete the sample code, paste, and press <b>Save</b>.</li>
<li>Click <b>Deploy</b>, then <b>New deployment</b>. Pick <b>Web app</b>, set <b>Execute as: Me</b> and <b>Who has access: Anyone</b>, and press <b>Deploy</b>.</li>
<li>Allow access. If Google says the app isn't verified, choose <b>Advanced</b>, then <b>Go to … (unsafe)</b>. It's your own script.</li>
<li>Copy the <b>Web app URL</b> (it ends in /exec) and paste it here.</li></ol>
<div class="st-row"><label for="st-gsurl">Web app URL</label><div class="row"><input id="st-gsurl" class="inp wide" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(dv.gsUrlDraft || '')}"></div></div>
<div class="st-row"><label></label><div class="row"><button type="button" class="btn" data-st="connect" ${pending ? '' : 'disabled title="Copy the script first"'}>Connect</button><span id="st-gstatus" class="st-status"></span></div></div>
<p class="st-note">Already connected on another device? Open its setup link here instead.</p>`;
  $('#settings').innerHTML = `<div class="st-head"><h2>Settings</h2><button type="button" class="icon-btn" data-st="close" aria-label="Close settings">${I.x}</button></div><div class="st-body">
<section class="st-sec" id="st-claude"><h3>Claude <span class="badge${dv.apiKey ? '' : ' off'}">${dv.apiKey ? 'Key saved' : 'Not set up'}</span></h3>
<p>Claude turns lists into tasks, estimates times, asks quick questions, and plans your day. Your key stays in this browser and is only sent to Anthropic.</p>
<div class="st-row"><label for="st-key">API key</label><div class="row"><input id="st-key" class="inp" style="flex:1;min-width:200px" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(dv.apiKey)}"><button type="button" class="chip-btn" data-st="showkey">Show</button></div></div>
<div class="st-row"><label for="st-model">Model</label><div class="row"><input id="st-model" class="inp" list="st-models" value="${esc(dv.model)}"><datalist id="st-models"><option value="claude-sonnet-5-5"><option value="claude-haiku-5-5"><option value="claude-opus-5-5"></datalist></div></div>
<div class="st-row"><label>Effort</label><div><div class="seg" role="group" aria-label="Effort">${['low', 'medium', 'high'].map((e) => `<button type="button" data-st="effort" data-v="${e}" aria-pressed="${dv.effort === e}">${e[0].toUpperCase() + e.slice(1)}</button>`).join('')}</div><p class="dr-hint">Medium is careful; long lists can take 10–30 seconds. Low answers in about 5.</p></div></div>
<div class="st-row"><label></label><div class="row"><button type="button" class="btn secondary" data-st="test">Test connection</button><span id="st-test" class="st-status"></span></div></div>
<div class="st-row"><label for="st-auto">Daily plan</label><div class="row"><input type="checkbox" class="switch" id="st-auto" ${sh.autoPlan ? 'checked' : ''}><span>Plan my day the first time I open Daywell after</span><select id="st-autoh" class="inp">${hours(sh.autoPlanHour ?? 6)}</select></div></div></section>
<section class="st-sec" id="st-day"><h3>Your day</h3><p>Used for free time and the day ribbon.</p>
<div class="st-row"><label for="st-ds">Day starts</label><div class="row"><input id="st-ds" type="time" class="inp" value="${sh.dayStart}"><span>and ends</span><input id="st-de" type="time" class="inp" value="${sh.dayEnd}"></div></div>
<div class="st-row"><label for="st-roll">New day begins</label><div class="row"><select id="st-roll" class="inp">${[0, 1, 2, 3, 4, 5, 6].map((h) => `<option value="${h}"${h === (sh.rollHour ?? 4) ? ' selected' : ''}>${h === 0 ? 'At midnight' : `At ${h} AM`}</option>`).join('')}</select><span class="dr-hint" style="margin:0">Late nights still count as the same day.</span></div></div>
<div class="st-row"><label>Week starts on</label><div class="seg" role="group">${[
    [1, 'Monday'],
    [0, 'Sunday'],
  ]
    .map(([v, l]) => `<button type="button" data-st="ws" data-v="${v}" aria-pressed="${(sh.weekStart ?? 1) === v}">${l}</button>`)
    .join('')}</div></div></section>
<section class="st-sec" id="st-google"><h3>Google Calendar and sync <span class="badge${g.configured ? '' : ' off'}">${g.configured ? 'Connected' : 'Not connected'}</span></h3>${googleBody}</section>
<section class="st-sec" id="st-data"><h3>Your data</h3><p>Everything lives in this browser${g.configured ? ' and your Google script' : ''}. Keep a backup now and then.</p>
<div class="row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn secondary" data-st="export">${I.download}Download backup</button><button type="button" class="btn secondary" data-st="import">${I.upload}Restore from backup</button><input type="file" id="st-file" accept="application/json,.json" hidden>${!store.state.meta.seeded || !store.state.tasks.some((t) => !t.purged && E.STARTER.some((s) => s.title === t.title)) ? `<button type="button" class="btn secondary" data-st="seed">Add my Daywell routines</button>` : ''}<button type="button" class="btn secondary" data-st="wipe" style="color:var(--danger)">${I.trash}Delete all tasks</button></div></section>
<section class="st-sec"><h3>Appearance</h3><div class="st-row"><label>Theme</label><div class="seg" role="group">${['auto', 'light', 'dark'].map((v) => `<button type="button" data-st="theme" data-v="${v}" aria-pressed="${dv.theme === v}">${v === 'auto' ? 'Match system' : v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div></div></section>
<section class="st-sec"><h3>Keyboard</h3><div class="kbd-list"><kbd>N</kbd><span>Add a task</span><kbd>Enter</kbd><span>Add what you typed</span><kbd>${MOD} Enter</kbd><span>Send it to Claude</span><kbd>${MOD} Z</kbd><span>Undo (${MOD} Shift Z to redo)</span><kbd>[ ]</kbd><span>Previous or next day</span><kbd>T C H</kbd><span>Today, Calendar, History</span><kbd>P</kbd><span>Plan my day</span><kbd>Esc</kbd><span>Close panels</span></div></section>
<p class="muted-note" style="margin-top:8px">Daywell runs entirely in your browser. <a href="https://github.com/beyondgalaxy-maker/daywell" target="_blank" rel="noopener">Source</a></p>
</div>`;
}

async function onSettings(act, el) {
  const dv = store.device;
  if (act === 'close') return $('#settings').close();
  if (act === 'showkey') {
    const k = $('#st-key');
    k.type = k.type === 'password' ? 'text' : 'password';
    el.textContent = k.type === 'password' ? 'Show' : 'Hide';
    return;
  }
  if (act === 'effort') {
    store.setDevice({ effort: el.dataset.v });
    return renderSettings();
  }
  if (act === 'test') {
    const out = $('#st-test');
    saveKeyField();
    out.className = 'st-status';
    out.textContent = 'Testing…';
    try {
      const r = await AI.testConnection({ apiKey: store.device.apiKey, model: store.device.model, effort: store.device.effort });
      out.className = 'st-status ok';
      out.textContent = `Working. ${r.model} answered in ${(r.ms / 1000).toFixed(1)}s.`;
    } catch (e) {
      out.className = 'st-status err';
      out.textContent = e.message;
    }
    return;
  }
  if (act === 'ws') return store.setShared({ weekStart: Number(el.dataset.v) }), renderSettings();
  if (act === 'theme') {
    store.setDevice({ theme: el.dataset.v });
    applyTheme();
    return renderSettings();
  }
  if (act === 'copy-script') {
    const secret = dv.gsSecretPending || newSecret();
    store.setDevice({ gsSecretPending: secret });
    try {
      const code = await scriptWithSecret(secret);
      await copyText(code);
      toast('Script copied. Paste it into a new Apps Script project.');
    } catch (e) {
      toast(e.message);
    }
    return renderSettings();
  }
  if (act === 'connect') {
    const url = $('#st-gsurl').value.trim();
    const out = $('#st-gstatus');
    store.setDevice({ gsUrlDraft: url });
    if (!validScriptUrl(url)) {
      out.className = 'st-status err';
      out.textContent = 'That doesn’t look like a Web app URL. It should start with https://script.google.com/ and end with /exec.';
      return;
    }
    out.className = 'st-status';
    out.textContent = 'Connecting…';
    store.setDevice({ gsUrl: url, gsSecret: dv.gsSecretPending });
    try {
      await google.ping();
      await google.loadCalendars().catch(() => {});
      store.setDevice({ gsSecretPending: '', gsUrlDraft: '' });
      out.className = 'st-status ok';
      out.textContent = 'Connected.';
      await google.sync();
      await google.refreshEvents(true);
      renderSettings();
      render();
      toast('Google connected');
    } catch (e) {
      store.setDevice({ gsUrl: '', gsSecret: '' });
      out.className = 'st-status err';
      out.textContent = e.message;
    }
    return;
  }
  if (act === 'sync-now') {
    await google.sync();
    await google.refreshEvents(true);
    return renderSettings();
  }
  if (act === 'load-cals') {
    try {
      await google.loadCalendars();
    } catch (e) {
      toast(e.message);
    }
    return renderSettings();
  }
  if (act === 'setup-link') {
    const withKey = $('#st-linkkey')?.checked;
    const payload = { u: dv.gsUrl, s: dv.gsSecret, m: dv.model, e: dv.effort };
    if (withKey) payload.k = dv.apiKey;
    const link = `${location.origin}${location.pathname}#setup=${b64urlEncode(JSON.stringify(payload))}`;
    await copyText(link);
    toast('Setup link copied. Open it on your other device.');
    return;
  }
  if (act === 'disconnect') {
    const ok = await confirmBox({ title: 'Disconnect Google?', body: 'Your tasks stay on this device and in your Google script. You can reconnect any time.', ok: 'Disconnect' });
    if (!ok) return;
    store.setDevice({ gsUrl: '', gsSecret: '', syncRev: null, lastSync: 0 });
    google.clear();
    renderSettings();
    return render();
  }
  if (act === 'export') return exportBackup();
  if (act === 'import') return $('#st-file').click();
  if (act === 'seed') {
    seed(E.STARTER.map((_, i) => i));
    $('#settings').close();
    return;
  }
  if (act === 'wipe') {
    const ok = await confirmBox({ title: 'Delete all tasks?', body: 'This removes every task and its history on all your synced devices. Download a backup first if you might want them back.', ok: 'Delete everything', danger: true });
    if (!ok) return;
    store.transact('Deleted everything', (s) => {
      const now = Date.now();
      s.tasks = s.tasks.map((t) => (t.purged ? t : E.purgedShell(t, now)));
      s.log = s.log.map((e) => (e.deleted ? e : { ...e, deleted: true, updatedAt: now }));
      s.meta.order = {};
      s.meta.plans = {};
    }, { undoable: false });
    toast('All tasks deleted');
    return renderSettings();
  }
}

function saveKeyField() {
  const k = $('#st-key');
  const m = $('#st-model');
  if (!k) return;
  const key = k.value.trim();
  const model = (m?.value || '').trim() || AI.DEFAULT_MODEL;
  if (key !== store.device.apiKey || model !== store.device.model) {
    store.setDevice({ apiKey: key, model });
    render();
  }
}

function onSettingsChange(e) {
  const el = e.target;
  if (el.id === 'st-key' || el.id === 'st-model') {
    // Update in place: re-rendering here would swallow the click that caused the blur.
    saveKeyField();
    const badge = $('#st-claude .badge');
    if (badge) {
      badge.textContent = store.device.apiKey ? 'Key saved' : 'Not set up';
      badge.classList.toggle('off', !store.device.apiKey);
    }
    return;
  }
  if (el.id === 'st-auto') return store.setShared({ autoPlan: el.checked });
  if (el.id === 'st-autoh') return store.setShared({ autoPlanHour: Number(el.value) });
  if (el.id === 'st-ds' && E.isTime(el.value)) return store.setShared({ dayStart: el.value });
  if (el.id === 'st-de' && E.isTime(el.value)) return store.setShared({ dayEnd: el.value });
  if (el.id === 'st-roll') return store.setShared({ rollHour: Number(el.value) });
  if (el.id === 'st-sync') {
    store.setDevice({ sync: el.checked });
    if (el.checked) google.sync();
    return;
  }
  if (el.id === 'st-gsurl') return store.setDevice({ gsUrlDraft: el.value.trim() });
  if (el.dataset.cal) {
    const cals = { ...(store.state.shared.calendars || {}) };
    cals[el.dataset.cal] = el.checked;
    store.setShared({ calendars: cals });
    google.refreshEvents(true);
    return;
  }
  if (el.id === 'st-file' && el.files?.[0]) importBackup(el.files[0]);
}

function exportBackup() {
  const blob = new Blob([JSON.stringify({ app: 'daywell', version: 1, exportedAt: new Date().toISOString(), data: store.state }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `daywell-backup-${store.today}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Backup downloaded');
}

async function importBackup(file) {
  try {
    const json = JSON.parse(await file.text());
    const data = json?.data && json.app === 'daywell' ? json.data : json;
    if (!data || !Array.isArray(data.tasks)) throw new Error('bad');
    const n = data.tasks.filter((t) => !t.purged && !t.deletedAt).length;
    const ok = await confirmBox({ title: 'Restore this backup?', body: `It has ${n} task${n === 1 ? '' : 's'}. They'll be merged with what you have now; nothing current is deleted.`, ok: 'Restore' });
    if (!ok) return;
    store.transact('Restored a backup', (s) => {
      const merged = E.mergeStates(s, repairState(data));
      s.tasks = merged.tasks;
      s.log = merged.log;
      s.meta = merged.meta;
    });
    toast(`Restored ${n} tasks`);
  } catch {
    toast("That file isn't a Daywell backup.");
  } finally {
    const f = $('#st-file');
    if (f) f.value = '';
  }
}

function seed(indices) {
  const today = store.today;
  const pick = indices.map((i) => E.STARTER[i]).filter(Boolean);
  const have = new Set(store.state.tasks.filter((t) => !t.purged && !t.deletedAt).map((t) => t.title.toLowerCase()));
  const list = pick.filter((s) => !have.has(s.title.toLowerCase())).map((s) => ({ ...s, start: today }));
  store.transact(list.length ? `Added ${list.length} tasks` : 'Started Daywell', (s) => {
    for (const f of list) s.tasks.push(E.normalizeTask({ ...f, createdAt: Date.now(), updatedAt: Date.now() }, today));
    s.meta.seeded = true;
  });
  if (list.length) undoToast(`Added ${list.length} tasks`, lastStep());
}

/* ================================================================== */
/* misc utilities                                                      */
/* ================================================================== */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}
function b64urlEncode(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4))));
}
function applyTheme() {
  document.documentElement.dataset.theme = store.device.theme || 'auto';
}

async function handleSetupLink() {
  const m = location.hash.match(/^#setup=([\w-]+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  let p;
  try {
    p = JSON.parse(b64urlDecode(m[1]));
  } catch {
    return toast("That setup link didn't work. Copy it again from Settings.");
  }
  const parts = [p.u ? 'connect your Google script' : '', p.k ? 'save your Claude key' : ''].filter(Boolean);
  if (!parts.length) return;
  const ok = await confirmBox({ title: 'Set up this device?', body: `This will ${parts.join(' and ')} on this device.`, ok: 'Set up' });
  if (!ok) return;
  const patch = {};
  if (p.u && validScriptUrl(p.u) && p.s) Object.assign(patch, { gsUrl: p.u, gsSecret: p.s, sync: true });
  const localCount = store.state.tasks.filter((t) => !t.purged && !t.deletedAt).length;
  if (patch.gsUrl && localCount && !store.device.gsUrl) {
    const replace = await confirmBox({
      title: 'Use your synced tasks?',
      body: `This device already has ${localCount} task${localCount === 1 ? '' : 's'} that were never synced. Replace them with the tasks from your other device, or keep both?`,
      ok: 'Use synced tasks',
      cancel: 'Keep both',
    });
    if (replace) store.replaceState({ ...store.state, tasks: [], log: [], meta: { order: {}, plans: {}, dismiss: {}, timer: null, seeded: true } }, 'change');
  }
  if (p.k) patch.apiKey = p.k;
  if (p.m) patch.model = p.m;
  if (p.e) patch.effort = p.e;
  store.setDevice(patch);
  toast('This device is set up');
  if (google.configured) {
    await google.sync();
    await google.refreshEvents(true);
  }
  render();
}

/* ================================================================== */
/* drag and drop                                                       */
/* ================================================================== */

const drag = { s: null };

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const li = e.target.closest('li.task');
  if (!li) return;
  const list = li.closest('[data-list]');
  if (!list || list.dataset.list === 'none') return;
  const onGrip = !!e.target.closest('.grip');
  if (!onGrip && e.target.closest('button, input, textarea, select, a')) return;
  if (e.pointerType !== 'mouse' && !onGrip) return;
  drag.s = { li, id: li.dataset.id, src: list, x0: e.clientX, y0: e.clientY, started: false, pid: e.pointerId };
  if (onGrip) e.preventDefault();
}

function onPointerMove(e) {
  const d = drag.s;
  if (!d || e.pointerId !== d.pid) return;
  if (!d.started) {
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
    const r = d.li.getBoundingClientRect();
    d.dx = e.clientX - r.left;
    d.dy = e.clientY - r.top;
    d.ghost = d.li.cloneNode(true);
    d.ghost.classList.add('drag-ghost');
    d.ghost.style.width = `${r.width}px`;
    document.body.appendChild(d.ghost);
    d.li.classList.add('drag-placeholder');
    d.started = true;
    closeMenu();
  }
  e.preventDefault();
  d.ghost.style.left = `${e.clientX - d.dx}px`;
  d.ghost.style.top = `${e.clientY - d.dy}px`;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const list = el?.closest('[data-list="day"], [data-list="all"]') || null;
  for (const n of $$('.drop-target')) if (n !== list) n.classList.remove('drop-target');
  if (list) {
    list.classList.add('drop-target');
    const rows = [...list.querySelectorAll(':scope > li.task')].filter((r) => r !== d.li);
    let before = null;
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (e.clientY < b.top + b.height / 2) {
        before = r;
        break;
      }
    }
    if (before) {
      if (d.li.nextSibling !== before) list.insertBefore(d.li, before);
    } else if (list.lastElementChild !== d.li) list.appendChild(d.li);
    d.over = list;
  }
  const col = el?.closest('.col, .view-calendar');
  if (col) {
    const b = col.getBoundingClientRect();
    if (e.clientY < b.top + 60) col.scrollTop -= 14;
    else if (e.clientY > b.bottom - 140) col.scrollTop += 14;
  }
}

function onPointerUp(e) {
  const d = drag.s;
  drag.s = null;
  if (!d || !d.started) return;
  e.preventDefault();
  d.ghost?.remove();
  d.li.classList.remove('drag-placeholder');
  for (const n of $$('.drop-target')) n.classList.remove('drop-target');
  ui.suppressClick = true;
  setTimeout(() => (ui.suppressClick = false), 80);
  const list = d.li.closest('[data-list]');
  const t = store.task(d.id);
  if (!list || !t || list.dataset.list === 'none') return render();
  const today = store.today;
  if (list.dataset.list === 'day') {
    const D = list.dataset.day;
    const ids = [...list.querySelectorAll(':scope > li.task')].map((li) => li.dataset.id);
    const fromDay = d.src.dataset.list === 'day' && d.src.dataset.day === D;
    store.transact(fromDay ? 'Reordered' : `Planned “${t.title}”`, (s) => {
      if (!fromDay) moveTask(s, t, D, today);
      s.meta.order[D] = { ids, at: Date.now(), by: 'you' };
    });
    if (!fromDay) undoToast(`Moved to ${relWord(D, today)}`, lastStep());
  } else {
    if (d.src === list) return render();
    const D = list.dataset.day || null;
    if (t.repeat && t.repeat.kind !== 'weekflex' && t.repeat.kind !== 'interval') {
      toast('Repeating tasks follow their schedule. Use Skip in the menu to skip a day.');
      return render();
    }
    store.moveTo(t.id, D);
    undoToast(D ? `Moved to ${relWord(D, today)}` : 'Moved to Anytime', lastStep());
  }
}

function moveWithKeys(li, dir) {
  const list = li.closest('[data-list="day"]');
  if (!list) return;
  const rows = [...list.querySelectorAll(':scope > li.task')];
  const i = rows.indexOf(li);
  const j = i + dir;
  if (j < 0 || j >= rows.length) return;
  const ids = rows.map((r) => r.dataset.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  store.setOrder(list.dataset.day, ids);
  requestAnimationFrame(() => $(`[data-list="day"] li[data-id="${li.dataset.id}"] .body`)?.focus());
}

/* ================================================================== */
/* events                                                              */
/* ================================================================== */

function setView(v) {
  ui.view = v;
  if (v === 'calendar') {
    ui.calMonth = (ui.calDay || store.today).slice(0, 7);
  }
  closeMenu();
  render();
  const scroller = v === 'today' ? null : $(v === 'calendar' ? '#viewCalendar' : '#viewHistory');
  if (scroller) scroller.scrollTop = 0;
}

function onClick(e) {
  if (ui.suppressClick) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const m = e.target.closest('[data-m]');
  if (m && m.closest('#menu')) {
    if (m.dataset.m === 'pick') return;
    return onMenu(m.dataset.m, m);
  }
  const menuAnchor = ui.menuFor?.anchor || null;
  if (!$('#menu').hidden && !e.target.closest('#menu')) closeMenu();
  const st = e.target.closest('[data-st]');
  if (st) return onSettings(st.dataset.st, st);
  const ai = e.target.closest('[data-ai]');
  if (ai) return onAI(ai.dataset.ai, ai);
  const dr = e.target.closest('[data-dr]');
  if (dr) return onDrawer(dr.dataset.dr, dr);
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  const li = a.closest('li.task, li.sug');
  const id = li?.dataset.id || a.dataset.id;
  const today = store.today;
  switch (act) {
    case 'view':
      return setView(a.dataset.view);
    case 'tab': {
      const tab = a.dataset.tab;
      if (tab === 'today' || tab === 'all') {
        ui.tab = tab;
        return setView('today');
      }
      return setView(tab);
    }
    case 'settings':
      return openSettings(store.device.apiKey ? null : 'claude');
    case 'undo': {
      const l = store.undo();
      if (l) toast(`Undid ${l.charAt(0).toLowerCase() + l.slice(1)}`, { label: 'Redo', run: () => store.redo() });
      return;
    }
    case 'check':
      return li && toggleCheck(li);
    case 'open':
      return id && openDrawer(id);
    case 'menu':
      if (menuAnchor === a) return;
      return id && openMenu(a, id, li?.dataset.day);
    case 'to-today':
      store.moveTo(id, today);
      return undoToast('Moved to today', lastStep());
    case 'pull': {
      store.moveTo(id, today, { label: 'Added to today' });
      return undoToast('Added to today', lastStep());
    }
    case 'dismiss':
      return store.dismissSuggestion(today, id);
    case 'day-prev':
      ui.day = E.addDays(ui.day || today, -1);
      return render();
    case 'day-next':
      ui.day = E.addDays(ui.day || today, 1);
      return render();
    case 'day-today':
      ui.day = null;
      return render();
    case 'plan':
      return planDay();
    case 'plan-error-x':
      ui.planError = null;
      return render();
    case 'plan-hide':
      return store.transact('Hid plan', (s) => {
        const p = s.meta.plans[today];
        if (p) s.meta.plans[today] = { ...p, hidden: true, at: Date.now() };
      }, { undoable: false });
    case 'plan-undo': {
      const step = ui.planStep?.step;
      ui.planStep = null;
      revertStep(step);
      return toast('Plan undone');
    }
    case 'plan-add': {
      const plan = store.state.meta.plans[today];
      const sgt = plan?.suggest?.[Number(a.dataset.i)];
      if (!sgt) return;
      store.transact(`Added “${sgt.title}”`, (s) => {
        s.tasks.push(E.normalizeTask({ title: sgt.title, deadline: sgt.deadline, estMin: sgt.estMin, estMax: sgt.estMax, date: today, src: 'ai', priority: sgt.deadline && E.diffDays(today, sgt.deadline) <= 3 ? 2 : 3, notes: sgt.reason }, today));
        const p = s.meta.plans[today];
        s.meta.plans[today] = { ...p, added: [...(p.added || []), Number(a.dataset.i)], at: Date.now() };
      });
      return undoToast(`Added “${sgt.title}” to today`, lastStep());
    }
    case 'toggle-done':
      ui.showDone = !ui.showDone;
      return render();
    case 'toggle-routines':
      store.setDevice({ collapsed: { ...store.device.collapsed, routines: !store.device.collapsed.routines } });
      return render();
    case 'area':
      ui.area = a.dataset.area;
      return render();
    case 'target':
      store.setDevice({ addTarget: store.device.addTarget === 'day' ? 'anytime' : 'day' });
      return renderComposerMeta();
    case 'ask':
      return askClaude();
    case 'seed': {
      const picks = $$('[data-starter]').filter((c) => c.checked).map((c) => Number(c.dataset.starter));
      return seed(picks);
    }
    case 'seed-skip':
      return store.transact('Started empty', (s) => (s.meta.seeded = true), { undoable: false });
    case 'timer-done':
      return store.finishTimer();
    case 'timer-stop':
      return store.stopTimer(true);
    case 'cal-day':
      ui.calDay = a.dataset.day;
      if (ui.calDay.slice(0, 7) !== ui.calMonth) ui.calMonth = ui.calDay.slice(0, 7);
      return render();
    case 'cal-prev':
    case 'cal-next': {
      const [y, mo] = ui.calMonth.split('-').map(Number);
      const d = new Date(Date.UTC(y, mo - 1 + (act === 'cal-next' ? 1 : -1), 1));
      ui.calMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      return render();
    }
    case 'cal-today':
      ui.calMonth = today.slice(0, 7);
      ui.calDay = today;
      return render();
    case 'open-day':
      ui.day = a.dataset.day === today ? null : a.dataset.day;
      ui.tab = 'today';
      return setView('today');
    case 'reopen': {
      const t = store.task(a.dataset.id);
      if (!t) return;
      store.uncomplete(t.id, a.dataset.day);
      return undoToast(`Reopened “${t.title}”`, lastStep());
    }
    case 'restore':
      store.restore(a.dataset.id);
      return toast('Restored');
    case 'purge':
      return confirmBox({ title: 'Delete forever?', body: 'This task will be gone for good.', ok: 'Delete forever', danger: true }).then((ok) => ok && store.purge(a.dataset.id));
  }
}

function onAI(act, el) {
  const a = ui.ai;
  if (!a) return;
  if (act === 'close') {
    ui.ai = null;
    return renderAIPanel();
  }
  if (act === 'cancel') return a.ctrl?.abort();
  if (act === 'retry') {
    const text = a.text;
    ui.ai = null;
    if ($('#input').value.trim() === text) {
      $('#input').value = '';
      autoGrow();
    }
    return askClaude(text);
  }
  if (act === 'settings') return openSettings('claude');
  if (act === 'details') {
    a.showDetails = !a.showDetails;
    return renderAIPanel();
  }
  if (act === 'undo') {
    revertStep(a.step);
    ui.ai = null;
    renderAIPanel();
    return toast('Undid Claude’s changes');
  }
  if (act === 'answer') return answerQuestion(Number(el.dataset.qi), el.dataset.v);
  if (act === 'skipq') {
    const q = a.questions[Number(el.dataset.qi)];
    if (q) q.answer = 'Skipped';
    return renderAIPanel();
  }
}

async function onDrawer(act, el) {
  const t = store.task(ui.drawer);
  if (act === 'close') return closeDrawer();
  if (!t) return closeDrawer();
  const today = store.today;
  ui.editStep = null;
  if (act === 'toggle-done') {
    const done = t.repeat ? !!E.entryOn(E.buildIndex(store.state.log), t.id, today) : !!t.doneDay;
    if (done) store.uncomplete(t.id, t.repeat ? today : t.doneDay);
    else {
      store.complete(t.id, today);
      undoToast(`Done: ${t.title}`, lastStep());
    }
  } else if (act === 'timer') toggleTimer(t.id);
  else if (act === 'skip') {
    store.skip(t.id, today);
    undoToast(`Skipped “${t.title}” today`, lastStep());
  } else if (act === 'pri') store.updateTask(t.id, { priority: Number(el.dataset.v) });
  else if (act === 'date') {
    const v = el.dataset.v || null;
    store.moveTo(t.id, v);
  } else if (act === 'clear') {
    const f = el.dataset.v;
    store.updateTask(t.id, f === 'est' ? { estMin: null, estMax: null } : { [f]: null });
  } else if (act === 'est') {
    const v = Number(el.dataset.v);
    store.updateTask(t.id, { estMin: v, estMax: v });
  } else if (act === 'wday') {
    const d = Number(el.dataset.v);
    const days = new Set(t.repeat.days);
    if (days.has(d)) days.delete(d);
    else days.add(d);
    if (!days.size) return;
    store.updateTask(t.id, { repeat: { kind: 'weekly', days: [...days] } });
  } else if (act === 'delete') return deleteTask(t);
  else if (act === 'dup') duplicate(t);
  else if (act === 'gcal') {
    const date = $('#gcDate').value || today;
    const time = $('#gcTime').value || nextHalfHour();
    const start = E.localDate(date, E.timeToMin(time));
    const mins = E.estMid(t) || 30;
    const end = new Date(start.getTime() + mins * 60000);
    el.disabled = true;
    try {
      await google.addEvent({ title: t.title, start: start.toISOString(), end: end.toISOString(), description: t.notes || 'Planned in Daywell' });
      toast(`Blocked ${E.fmtMins(mins)} on ${relWord(date, today)} at ${E.fmtTime(time)}`);
      google.refreshEvents(true);
    } catch (e) {
      toast(e.message);
    }
    el.disabled = false;
    return;
  }
  renderDrawer();
}

function onKey(e) {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') {
    if (!$('#menu').hidden) return closeMenu();
    if ($('#settings').open || $('#confirm').open) return;
    if (ui.drawer) return closeDrawer();
    if (typing) return e.target.blur();
    if (ui.ai && ui.ai.status !== 'busy') {
      ui.ai = null;
      return renderAIPanel();
    }
    return;
  }
  if (mod && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    const l = e.shiftKey ? store.redo() : store.undo();
    if (l) toast(`${e.shiftKey ? 'Redid' : 'Undid'} ${l.charAt(0).toLowerCase() + l.slice(1)}`);
    return;
  }
  if (mod && e.key.toLowerCase() === 'y' && !typing) {
    e.preventDefault();
    store.redo();
    return;
  }
  if (e.target.classList?.contains('body') && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    return moveWithKeys(e.target.closest('li.task'), e.key === 'ArrowUp' ? -1 : 1);
  }
  if ((e.key === 'Enter' || e.key === ' ') && (e.target.matches?.('[data-act="open"]') || e.target.matches?.('.rr-title'))) {
    e.preventDefault();
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (id) openDrawer(id);
    return;
  }
  if (typing || mod || e.altKey || $('#settings').open || $('#confirm').open) return;
  const k = e.key;
  if (k === 'n' || k === '/') {
    e.preventDefault();
    $('#input').focus();
  } else if (k === '[') {
    ui.day = E.addDays(ui.day || store.today, -1);
    if (ui.view !== 'today') ui.view = 'today';
    render();
  } else if (k === ']') {
    ui.day = E.addDays(ui.day || store.today, 1);
    if (ui.view !== 'today') ui.view = 'today';
    render();
  } else if (k === 't') {
    ui.day = null;
    ui.tab = 'today';
    setView('today');
  } else if (k === 'c') setView('calendar');
  else if (k === 'h') setView('history');
  else if (k === 'p') planDay();
  else if (k === '?') openSettings();
}

function bindEvents() {
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove, { passive: false });
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
  document.addEventListener('pointerdown', (e) => {
    if (!$('#menu').hidden && !e.target.closest('#menu') && !e.target.closest('[data-act="menu"]')) closeMenu();
  });
  $('#scrim').addEventListener('click', closeDrawer);
  window.addEventListener('resize', () => closeMenu());
  for (const c of $$('.col')) c.addEventListener('scroll', () => closeMenu(), { passive: true });

  const input = $('#input');
  input.addEventListener('input', () => {
    autoGrow();
    renderParseChips();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) askClaude();
      else addFromInput();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    addFromInput();
  });

  $('#search').addEventListener('input', (e) => {
    ui.search = e.target.value;
    renderAll(ctxNow());
  });

  const drawer = $('#drawer');
  drawer.addEventListener('input', (e) => {
    const el = e.target;
    if (el.classList.contains('dr-title')) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
    if (el.dataset.f && ['title', 'notes', 'area'].includes(el.dataset.f)) {
      clearTimeout(ui.drawerTimer);
      ui.drawerTimer = setTimeout(() => drawerField(el), 350);
    }
  });
  drawer.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.dataset.f) return;
    clearTimeout(ui.drawerTimer);
    drawerField(el);
  });
  drawer.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('dr-title') && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
  });
  drawer.addEventListener('focusout', () => {
    ui.editStep = null;
  });

  const menu = $('#menu');
  menu.addEventListener('change', (e) => {
    if (e.target.dataset.m === 'pick' && e.target.value) {
      const f = ui.menuFor;
      if (!f) return;
      store.moveTo(f.id, e.target.value);
      undoToast(`Moved to ${relWord(e.target.value, store.today)}`, lastStep());
      closeMenu();
    }
  });

  const settings = $('#settings');
  settings.addEventListener('change', onSettingsChange);
  settings.addEventListener('close', () => {
    saveKeyField();
    render();
  });
  settings.addEventListener('click', (e) => {
    if (e.target === settings) settings.close();
  });

  $('#aiPanel').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('other')) {
      e.preventDefault();
      const v = e.target.value.trim();
      if (v) answerQuestion(Number(e.target.dataset.qi), v, e.target);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.flush();
    else {
      render();
      if (google.configured) {
        google.sync();
        google.refreshEvents();
      }
      maybeAutoPlan();
    }
  });
  window.addEventListener('pagehide', () => store.flush());
  window.addEventListener('online', () => google.configured && google.sync());
  matchMedia('(max-width: 860px)').addEventListener?.('change', () => render());
}

/* ================================================================== */
/* boot                                                                */
/* ================================================================== */

function staticChrome() {
  $('#undoBtn').innerHTML = I.undo;
  $('#settingsBtn').innerHTML = I.gear;
  $('#askBtn').innerHTML = `${I.spark}<span>Ask</span>`;
  $('#addBtn').innerHTML = I.plus;
  for (const s of $$('[data-ico]')) s.innerHTML = I[s.dataset.ico] || '';
  $('#allCol').innerHTML = `<header class="all-head"><h2>Everything else</h2><div class="search">${I.search}<input id="search" type="search" placeholder="Search" aria-label="Search tasks" autocomplete="off"></div></header><div class="area-chips" id="areaChips"></div><div id="allList"></div>`;
  $('#input').placeholder = isMobile() ? 'Add a task…' : 'Add a task, or paste a list and ask Claude…';
}

function boot() {
  applyTheme();
  staticChrome();
  bindEvents();
  store.subscribe((reason) => {
    if (reason === 'device') {
      renderTop();
      return;
    }
    render();
    if ((reason === 'change' || reason === 'external') && google.configured && store.device.sync) {
      clearTimeout(ui.syncTimer);
      ui.syncTimer = setTimeout(() => google.sync(), 2500);
    }
  });
  google.onChange(() => {
    renderTop();
    if ($('#settings').open && document.activeElement?.closest?.('#settings') == null) renderSettings();
  });
  render();
  renderAIPanel();
  handleSetupLink();
  setInterval(() => {
    const t = store.today;
    if (t !== ui.lastToday) {
      ui.planError = null;
      if (ui.day === ui.lastToday) ui.day = null;
    }
    if (!drag.s && !document.hidden) render();
    maybeAutoPlan();
  }, 60000);
  setInterval(() => {
    const tm = store.state.meta.timer;
    const el = $('#tpTime');
    if (tm?.id && el) el.textContent = fmtTimer(Date.now() - tm.start);
  }, 1000);
  setInterval(() => {
    if (google.configured && document.visibilityState === 'visible') {
      google.sync();
      google.refreshEvents();
    }
  }, 120000);
  if (google.configured) {
    const first = Promise.allSettled([google.sync(), google.refreshEvents(true)]);
    Promise.race([first, new Promise((r) => setTimeout(r, 6000))]).then(() => maybeAutoPlan());
  } else setTimeout(maybeAutoPlan, 400);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
