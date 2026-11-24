// Daywell app: rendering and interactions.
import * as E from './engine.js';
import * as AI from './ai.js';
import { Store, applyChanges, markDone, markPart, moveTask, repairState } from './store.js';
import { Google, HOME_SCRIPT, newSecret, scriptText, validScriptUrl } from './google.js';
import { I } from './icons.js';
import * as Backup from './backup.js';

const store = new Store();
const google = new Google(store);
window.__daywell = { store, google, E };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isMobile = () => matchMedia('(max-width: 860px)').matches;
const coarse = () => matchMedia('(pointer: coarse)').matches;
const lc = (l) => (/^Claude/.test(l) ? String(l) : String(l || '').charAt(0).toLowerCase() + String(l || '').slice(1));
// A short tap of haptics on phones that support it (Android). Silently does nothing elsewhere.
const buzz = (ms = 10) => {
  try {
    if (coarse()) navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
};
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
  showDone: !matchMedia('(max-width: 860px)').matches,
  lastProgress: null,
  toastTimer: null,
  syncTimer: null,
  menuFor: null,
  restored: null,
  fresh: new Map(), // task id → when you moved it onto a day (keeps it in view)
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
  if (!step) return null;
  const i = store.undoStack.indexOf(step);
  if (i > -1) store.undoStack.splice(i, 1);
  const before = store.undoStack.length;
  const label = step.meta?.reverts ? step.meta.reverts.label : `Undid ${lc(step.label)}`;
  store.transact(label, (s) => {
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
    for (const ch of step.diff.sorted || []) (s.meta.sorted ||= {})[ch.k] = ch.before ? { ...ch.before, at: Date.now() } : { by: {}, at: Date.now() };
  }, { meta: { reverts: step } });
  stepUndone(step);
  return store.undoStack.length > before ? lastStep() : null;
}

/* ---------- undo puts your words back ---------- */
// Steps that came from the composer remember what was typed. Undoing them puts the text back
// in the box (nothing you wrote disappears); redoing takes it out again.
// Undoing an "undo" is a redo of the original (and so on), so follow the chain to the real step.
function resolveStep(step, kind) {
  let s = step;
  let k = kind;
  while (s?.meta?.reverts) {
    s = s.meta.reverts;
    k = k === 'undo' ? 'redo' : 'undo';
  }
  return { s, k };
}
function backMessage(step, kind) {
  const { s, k } = resolveStep(step, kind);
  if (k !== 'undo' || !s?.meta?.input) return null;
  return s.meta.mode === 'ask' ? 'Undone. Your message is back in the box.' : 'Undone. Your text is back in the box.';
}
function stepUndone(step) {
  if (!step) return;
  if (step.meta?.reverts) return stepRedone(step.meta.reverts);
  if (step.meta?.sortTo) store.setShared({ sortBy: step.meta.sortFrom || 'plan' });
  if (ui.ai && ui.ai.status !== 'busy' && ui.ai.step === step) {
    ui.ai = null;
    renderAIPanel();
  }
  if (step.meta?.input) restoreComposer(step.meta);
}
function stepRedone(step) {
  if (!step) return;
  if (step.meta?.reverts) return stepUndone(step.meta.reverts);
  if (step.meta?.sortTo) store.setShared({ sortBy: step.meta.sortTo });
  if (step.meta?.input) clearComposer(step.meta);
  if (step.meta?.ai && (!ui.ai || ui.ai.status !== 'busy')) {
    ui.ai = step.meta.ai;
    renderAIPanel();
  }
}
function restoreComposer({ input: text, mode }) {
  const el = $('#input');
  if (!text) return;
  if (!el.value.includes(text)) el.value = el.value.trim() ? `${el.value.replace(/\s+$/, '')}\n${text}` : text;
  ui.restored = { text, mode };
  if (mode === 'ask') ui.modeOverride = 'ask';
  autoGrow();
  renderParseChips();
  const box = $('#composer');
  box.classList.remove('restored');
  void box.offsetWidth;
  box.classList.add('restored');
  // On a computer, put the cursor at the end so it's ready to edit. On a phone, don't pop the keyboard.
  if (!coarse()) {
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }
}
function clearComposer({ input: text }) {
  const el = $('#input');
  if (!text || !el.value.includes(text)) return;
  el.value = el.value.trim() === text.trim() ? '' : el.value.replace(`\n${text}`, '').replace(text, '').trim();
  if (ui.restored?.text === text) ui.restored = null;
  autoGrow();
  renderParseChips();
}
function undoLast() {
  const step = lastStep();
  const l = store.undo();
  if (!l) return toast('Nothing to undo');
  toast(backMessage(step, 'undo') || `Undid ${lc(l)}`, { label: 'Redo', run: redoLast });
}
function redoLast() {
  const l = store.redo();
  if (l) toast(`Redid ${lc(l)}`, { label: 'Undo', run: undoLast });
}
function undoWithToast(step) {
  const undid = revertStep(step);
  toast(backMessage(step, 'undo') || 'Undone', undid ? { label: 'Redo', run: () => revertStep(undid) } : null);
}

/* ================================================================== */
/* toast, confirm                                                      */
/* ================================================================== */

// While a dialog (Settings, a confirm) is open, everything behind it is inert, so the toast
// shows inside that dialog instead, where its button can be pressed.
function toast(msg, action) {
  let el = $('#toast');
  const dlg = document.querySelector('dialog[open]');
  if (dlg) {
    el.hidden = true;
    el = dlg.querySelector(':scope > .toast.in-dialog');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast in-dialog';
      el.setAttribute('role', 'status');
      dlg.appendChild(el);
    }
  }
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => {
    hideToast();
    action.run();
  };
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(hideToast, action ? 6500 : 3200);
}
function hideToast() {
  $('#toast').hidden = true;
  for (const t of document.querySelectorAll('dialog .toast.in-dialog')) t.hidden = true;
}
function undoToast(msg, step) {
  toast(msg, step ? { label: 'Undo', run: () => undoWithToast(step) } : null);
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
    d.querySelector(danger ? '[data-c=no]' : '[data-c=yes]').focus();
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

/* ---------- sorting ---------- */

const sortName = (key) => E.SORTS[key] || store.settings.sorts?.find((x) => x.id === key)?.name || 'Suggested';
const isClaudeSort = (key) => !E.SORTS[key];

// The day's open items in the order you picked: Claude's plan (default), a quick sort, or one of
// your saved Claude sorts (cached per day, worked out the first time you open the day).
function sortDay(open, D, ctx) {
  const key = store.settings.sortBy || 'plan';
  if (key === 'plan') return open;
  if (E.SORTS[key]) return E.sortOpen(open, key);
  const saved = store.settings.sorts?.find((x) => x.id === key);
  if (!saved) return open;
  const cached = ctx.s.meta.sorted?.[D]?.by?.[key];
  if (cached) return E.applyOrder(open, cached);
  const tried = (ui.sortTried ||= new Set());
  if (D >= ctx.today && store.device.apiKey && !ui.sorting && open.length > 1 && !tried.has(`${key}|${D}`)) {
    tried.add(`${key}|${D}`);
    setTimeout(() => runSort({ key, D }), 0);
  }
  return open;
}

async function runSort({ key, prompt, D = ui.day || store.today, save = false }) {
  const saved = key ? store.settings.sorts?.find((x) => x.id === key) : null;
  const instruction = (prompt || saved?.prompt || '').trim();
  if (!instruction || ui.sorting) return;
  if (!store.device.apiKey) return toast('Add your Claude key in Settings to sort with Claude.');
  const ctx = ctxNow();
  const items = E.orderOpen(E.dayItems(ctx.s, ctx.idx, D, ctx.today, ctx.settings).filter((i) => i.status === 'open'), D, ctx.s, ctx.sc);
  if (items.length < 2) return toast('Nothing to sort yet.');
  ui.sorting = { key: key || 'new', text: instruction };
  render();
  try {
    const { ids, content } = AI.sortContext({ items, today: D, now: new Date(), eventsOn: google.configured ? (d) => google.eventsOn(d) : null, instruction, state: ctx.s });
    const r = await AI.callClaude({ apiKey: store.device.apiKey, model: store.device.model, effort: store.device.effort, system: AI.SORT_SYSTEM, content, schema: AI.SORT_SCHEMA, maxTokens: 3000 });
    const order = [...new Set((r.data.order || []).map((x) => ids.long(x)).filter(Boolean))];
    if (!order.length) throw new Error('Claude didn’t return an order. Try again.');
    let id = key;
    const sortFrom = store.settings.sortBy || 'plan';
    if (!id) {
      id = E.uid('s');
      store.setShared({ sorts: [...(store.settings.sorts || []).filter((x) => !x.temp), { id, name: shortSortName(instruction), prompt: instruction, temp: !save }] });
    }
    store.transact(`Sorted: ${sortName(id)}`, (s) => {
      const day = (s.meta.sorted ||= {})[D] || { by: {} };
      day.by = { ...day.by, [id]: order };
      day.at = Date.now();
      s.meta.sorted[D] = day;
    }, { meta: { sortFrom, sortTo: id } });
    if (store.settings.sortBy !== id) store.setShared({ sortBy: id });
    toast(String(r.data.reply || 'Sorted.').slice(0, 140));
  } catch (e) {
    toast(e.message || 'Sorting didn’t work. Try again.');
  } finally {
    ui.sorting = null;
    render();
  }
}

const shortSortName = (text) => {
  const t = String(text).trim().replace(/^(please\s+)?(sort|order|reorder|organi[sz]e|prioriti[sz]e)\s+(my\s+)?(tasks|list|day|things)?\s*(by|with|so)?\s*/i, '');
  const n = t.charAt(0).toUpperCase() + t.slice(1);
  return n.length > 32 ? `${n.slice(0, 30).trim()}…` : n || 'My sort';
};

function openSortMenu(anchor) {
  const m = $('#menu');
  const cur = store.settings.sortBy || 'plan';
  const sorts = (store.settings.sorts || []).filter((x) => !x.temp || x.id === cur);
  const hasKey = !!store.device.apiKey;
  const opt = (key, label, note = '') => `<button type="button" class="mi${key === cur ? ' on' : ''}" role="menuitemradio" aria-checked="${key === cur}" data-sort="pick" data-v="${esc(key)}">${key === cur ? I.tick : '<i class="mi-dot"></i>'}${esc(label)}${note ? `<small>${esc(note)}</small>` : ''}</button>`;
  m.innerHTML = `<div class="sheet-grip" aria-hidden="true"></div><div class="m-title">Sort today</div>
${opt('plan', 'Suggested', 'Claude’s plan + your drags')}
${['priority', 'due', 'quick', 'big'].map((k) => opt(k, E.SORTS[k])).join('')}
${sorts.length ? `<hr><div class="m-title">Your sorts</div>${sorts.map((x) => `<div class="mi-row">${opt(x.id, x.name)}${x.temp ? `<button type="button" class="mi-x" data-sort="keep" data-v="${esc(x.id)}" title="Save this sort">${I.plus}</button>` : `<button type="button" class="mi-x" data-sort="del" data-v="${esc(x.id)}" aria-label="Delete “${esc(x.name)}”">${I.x}</button>`}</div>`).join('')}` : ''}
${hasKey ? `<hr><form class="m-ask" data-sort-form><input class="inp" name="q" placeholder="Ask Claude: school first, chores last…" autocomplete="off" aria-label="How should Claude sort today?"><button type="submit" class="btn">Sort</button></form>
<label class="m-check"><input type="checkbox" name="keep" checked>Save it for later</label>
${isClaudeSort(cur) || cur === 'plan' ? `<button type="button" class="mi" data-sort="resort">${I.spark}${cur === 'plan' ? 'Re-plan with Claude' : `Re-sort “${esc(sortName(cur))}”`}</button>` : ''}` : ''}`;
  m.hidden = false;
  m.classList.add('sort-menu');
  if (isMobile()) $('#scrim').hidden = false;
  const col = anchor.closest('.col, .view-calendar');
  ui.menuFor = { sort: true, anchor, col, top: col?.scrollTop ?? 0 };
  anchor.setAttribute('aria-expanded', 'true');
  if (!isMobile()) {
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    m.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left))}px`;
    m.style.top = `${top}px`;
  }
  m.querySelector('.mi.on')?.focus({ preventScroll: true });
  m.querySelector('[data-sort-form]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q) return e.target.q.focus();
    const keep = m.querySelector('.m-check input')?.checked;
    closeMenu();
    runSort({ prompt: q, save: keep });
  });
}

function onSortMenu(act, el) {
  const key = el.dataset.v;
  if (act === 'pick') {
    closeMenu();
    if (key !== (store.settings.sortBy || 'plan')) store.setShared({ sortBy: key });
    return;
  }
  if (act === 'del') {
    store.setShared({ sorts: (store.settings.sorts || []).filter((x) => x.id !== key), ...(store.settings.sortBy === key ? { sortBy: 'plan' } : {}) });
    return openSortMenu(ui.menuFor?.anchor || $('#sortBtn'));
  }
  if (act === 'keep') {
    store.setShared({ sorts: (store.settings.sorts || []).map((x) => (x.id === key ? { ...x, temp: false } : x)) });
    toast('Saved. It’s in Sort whenever you want it.');
    return openSortMenu(ui.menuFor?.anchor || $('#sortBtn'));
  }
  if (act === 'resort') {
    closeMenu();
    const cur = store.settings.sortBy || 'plan';
    if (cur === 'plan') return planDay();
    return runSort({ key: cur });
  }
}

/* ---------- birthdays ---------- */

// The day before someone's birthday, a to-do pops up to wish them a happy birthday (top of the
// list). It stays through the day itself and tidies itself away after. Birthdays come from your
// calendar however they're written (see E.birthdayName), from events Google marks as birthdays,
// and from the ones you add in Settings or tell Claude about. Ids are stable, so two devices never
// add it twice, and one you delete stays deleted.
function calendarBirthdays(evs, today) {
  const out = [];
  for (const ev of evs) {
    if (!ev.allDay || /holiday/i.test(ev.calName || '')) continue;
    const who = E.birthdayName(ev.title, { sure: /birthday/i.test(ev.type || '') });
    if (!who || E.isSelfName(who, { email: /@/.test(ev.calName || '') ? ev.calName : '', name: store.settings.name })) continue;
    if (ev.startDay >= today) out.push({ who, D: ev.startDay });
  }
  return out;
}
function ensureBirthdays() {
  const today = store.today;
  const want = new Map();
  const wish = (who, D) => {
    const id = `bday-${E.bdayKey(who)}-${D}`;
    if (!want.has(id)) want.set(id, { id, who, D });
  };
  for (const D of [today, E.addDays(today, 1)]) {
    if (google.configured) for (const b of calendarBirthdays(google.eventsOn(D), today)) if (b.D === D) wish(b.who, D);
    for (const b of E.birthdaysOn(D, store.state.meta.bdays)) wish(b.name, D);
  }
  const have = new Set(store.state.tasks.map((t) => t.id));
  const add = [...want.values()].filter((w) => !have.has(w.id));
  const stale = store.state.tasks.filter((t) => t.auto?.kind === 'birthday' && !t.deletedAt && !t.purged && !t.doneDay && t.auto.day < today);
  if (!add.length && !stale.length) return;
  store.transact(
    'Birthday reminders',
    (s) => {
      for (const w of add) {
        const before = E.addDays(w.D, -1);
        s.tasks.push(E.normalizeTask({ id: w.id, title: `Wish ${w.who} a happy birthday`, date: before < today ? today : before, deadline: w.D, priority: 1, estMin: 5, estMax: 10, area: 'Social', auto: { kind: 'birthday', day: w.D, who: w.who } }, today));
      }
      for (const t of stale) {
        const x = s.tasks.find((y) => y.id === t.id);
        if (x) {
          x.deletedAt = Date.now();
          x.updatedAt = Date.now();
        }
      }
    },
    { undoable: false },
  );
}

/* ---------- sign in on a new device with your key ---------- */

const needsSignIn = () => !google.configured && !store.device.localOnly;

function renderGate() {
  let g = $('#gate');
  if (!needsSignIn()) {
    if (g) g.remove();
    document.documentElement.classList.remove('gated');
    return;
  }
  document.documentElement.classList.add('gated');
  if (g) return;
  g = document.createElement('div');
  g.id = 'gate';
  g.className = 'gate';
  g.innerHTML = `<form class="gate-card" id="gateForm">
<svg class="brand-mark gate-mark" viewBox="0 0 32 32" aria-hidden="true"><rect class="bm-bg" width="32" height="32" rx="9"/><path class="bm-sun" d="M10.5 20.5a5.5 5.5 0 0 1 11 0z"/><path class="bm-line" d="M7.5 20.5h17"/></svg>
<h1>Daywell</h1>
<input id="gateKey" class="inp" type="password" name="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Your key" aria-label="Your key" enterkeyhint="go">
<button type="submit" class="btn" id="gateGo">Open</button>
<p class="gate-err" id="gateErr" role="alert"></p>
<button type="button" class="gate-skip" data-act="gate-skip">Use without signing in</button>
</form>`;
  document.body.appendChild(g);
  g.querySelector('#gateForm').addEventListener('submit', onGateSubmit);
  if (!coarse()) setTimeout(() => $('#gateKey')?.focus(), 50);
}

async function onGateSubmit(e) {
  e.preventDefault();
  const input = $('#gateKey');
  const btn = $('#gateGo');
  const err = $('#gateErr');
  const phrase = input.value.trim();
  if (!phrase) return input.focus();
  btn.disabled = true;
  btn.textContent = 'Opening…';
  err.textContent = '';
  try {
    const r = await google.signIn(phrase);
    input.blur();
    const local = store.state.tasks.filter((t) => !t.purged && !t.deletedAt).length;
    store.setDevice({ gsUrl: r.url, gsSecret: r.secret, sync: true, localOnly: false, syncRev: null, ...(r.claudeKey ? { apiKey: r.claudeKey } : {}) });
    if (local) {
      const replace = await confirmBox({ title: 'Use your synced tasks?', body: `This device has ${local} task${local === 1 ? '' : 's'} of its own. Replace them with your synced tasks, or keep both?`, ok: 'Use synced tasks', cancel: 'Keep both' });
      if (replace) store.replaceState({ ...store.state, tasks: [], log: [], meta: { order: {}, plans: {}, dismiss: {}, timer: null, seeded: true } }, 'change');
    }
    renderGate();
    toast('Opening your Daywell…');
    await google.sync();
    await google.refreshEvents(true);
    render();
    const name = (store.settings.name || '').trim();
    toast(name ? `Welcome back, ${name}` : 'You’re in');
  } catch (ex) {
    err.textContent = ex.message;
    btn.disabled = false;
    btn.textContent = 'Open';
    input.select();
  }
}

function renderTop() {
  renderGate();
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
  const part = partOfItem(it, ctx);
  if (part) {
    const when = part.day === (it.day || today) || it.status === 'part' ? '' : ` ${relWord(part.day, today)}`;
    const so = it.status === 'part' ? (part.mins ? `, ${E.fmtMins(part.mins)}` : '') : t.spent && ctx.timer?.id !== t.id ? `, ${E.fmtMins(t.spent)} so far` : '';
    bits.push(`<span class="part-tag">${I.half}Partly done${esc(when)}${so}</span>`);
  }
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
  const aiToday = t.ai && t.ai.day === it.day && (place === 'day' || place === 'daily') && it.status === 'open';
  if (aiToday && t.ai.focus) bits.push('<span class="focus-tag">Focus</span>');
  if (aiToday && t.ai.note) {
    bits.push(`<span class="ai-note">${I.spark}${esc(t.ai.note)}</span>`);
  } else if (it.carried && it.status === 'open' && t.auto?.kind !== 'birthday' && !(part && part.day >= it.carried)) {
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
  if (t.spent && it.status === 'open' && ctx.timer?.id !== t.id && !part) bits.push(`<span>${E.fmtMins(t.spent)} done so far</span>`);
  if (!bits.length && t.notes) bits.push(`<span>${esc(firstLine(t.notes))}</span>`);
  return bits.join('');
}

function metaBits(it, ctx, place) {
  const t = it.t;
  const out = [];
  if (t.time && place !== 'routines') out.push(`<span class="m-time">${E.fmtTime(t.time)}</span>`);
  const est = E.fmtEst(t.estMin, t.estMax);
  if (est) out.push(`<span class="m-est">${est}</span>`);
  const bday = t.auto?.kind === 'birthday';
  if (bday && it.status !== 'done' && !t.doneDay) {
    const d = E.diffDays(ctx.today, t.auto.day);
    out.push(`<span class="m-bday">${I.cake}${d <= 0 ? 'Birthday today' : d === 1 ? 'Birthday tomorrow' : `Birthday ${E.fmtRelDay(t.auto.day, ctx.today)}`}</span>`);
  } else if (t.deadline && it.status !== 'done' && !t.doneDay) {
    const d = E.diffDays(ctx.today, t.deadline);
    const cls = d < 0 ? 'over' : d <= 2 ? 'soon' : '';
    out.push(`<span class="m-due ${cls}">${d < 0 ? `Was due ${E.fmtRelDay(t.deadline, ctx.today)}` : `Due ${E.fmtRelDay(t.deadline, ctx.today)}`}</span>`);
  }
  if (place === 'later' && t.date) out.push(`<span class="m-date">${E.fmtRelDay(t.date, ctx.today)}</span>`);
  if (t.repeat && place !== 'routines' && place !== 'daily') out.push(`<span class="m-rep" title="${esc(E.describeRepeat(t.repeat))}">${I.repeat}</span>`);
  if (t.priority <= 2 && !bday) out.push(`<span class="m-pri p${t.priority}" title="${E.PRIORITY_NAMES[t.priority]} priority">P${t.priority}</span>`);
  if (t.area && place !== 'day' && place !== 'daily') out.push(`<span class="m-area">${esc(t.area)}</span>`);
  return out.join('');
}

// The "partly done" a row shows: a past day's record, or progress on something still open.
function partOfItem(it, ctx) {
  if (it.status === 'part') return it.entry || null;
  if (it.status !== 'open') return null;
  if (it.part !== undefined) return it.part;
  return E.partOf(it.t, ctx.idx, it.day || ctx.today, ctx.ws);
}

function taskRow(it, ctx, place = 'day', opts = {}) {
  const t = it.t;
  const st = it.status;
  const done = st === 'done';
  const timing = ctx.timer?.id === t.id;
  const part = partOfItem(it, ctx);
  const cls = ['task', `p${t.priority}`, done && 'done', part && 'part', st === 'skip' && 'skipped', st === 'miss' && 'missed', t.optional && 'optional', timing && 'timing', opts.next && 'up-next', t.auto?.kind === 'birthday' && !done && 'bday'].filter(Boolean).join(' ');
  const tag = opts.next ? `<span class="next-tag${opts.bonus ? ' bonus' : ''}">${opts.bonus ? 'Bonus' : 'Up next'}</span>` : '';
  const sub = tag + subline(it, ctx, place);
  const start = opts.next && !timing ? `<button type="button" class="start-btn" data-act="start" aria-label="Start a timer for “${esc(t.title)}”">${I.play}<span>Start</span></button>` : '';
  const label = done || st === 'skip' ? `Mark “${t.title}” not done` : `Mark “${t.title}” done${part ? ' (it’s partly done)' : ''}`;
  const quick = (place === 'all' || place === 'later') && !done ? `<button type="button" class="quick" data-act="to-today" title="Do today" aria-label="Do “${esc(t.title)}” today">${I.sun}</button>` : '';
  return `<li class="${cls}" data-id="${t.id}" data-day="${it.day || ''}" data-status="${st}">
<span class="grip" aria-hidden="true">${I.grip}</span>
<button type="button" class="check" data-act="check" aria-label="${esc(label)}" aria-pressed="${done}">${I.tick}</button>
<div class="body" data-act="open" role="button" tabindex="0"><span class="title">${esc(t.title)}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>
<div class="meta">${tag.replace('class="next-tag', 'class="next-tag nt-m')}${metaBits(it, ctx, place)}${start}</div>${quick}
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
  const open = sortDay(E.orderOpen(items.filter((i) => i.status === 'open'), D, ctx.s, ctx.sc), D, ctx);
  const finished = items
    .filter((i) => i.status === 'done' || i.status === 'skip' || i.status === 'part')
    .sort((a, b) => String(b.entry?.at || b.t.doneAt || '').localeCompare(String(a.entry?.at || a.t.doneAt || '')));
  const missed = items.filter((i) => i.status === 'miss');
  const prog = progressOf(items);

  const rel = E.fmtRelDay(D, today, { long: true });
  const big = ['Tomorrow', 'Yesterday'].includes(rel) ? rel : E.WEEKDAYS[E.weekday(D)];
  const [y, m, d] = D.split('-').map(Number);
  const dateLine = `${big === rel && rel !== E.WEEKDAYS[E.weekday(D)] ? `${E.WEEKDAYS[E.weekday(D)]}, ` : ''}${E.MONTHS[m - 1]} ${d}${y !== Number(today.slice(0, 4)) ? `, ${y}` : ''}`;
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
<p class="day-sub"><span class="ds-date">${esc(dateLine)}</span>${!isToday && !isPast && open.length ? `<span>${open.length} planned</span>` : ''}</p>
</header>`;
  if (isToday || isPast) html += cheerHtml(ctx, D, prog, isToday);
  html += eventsHtml(D, isToday);
  if (isToday) html += briefHtml(ctx);
  const showWelcome = isToday && !ctx.s.meta.seeded && !ctx.s.tasks.some((t) => !t.purged);
  if (showWelcome) html += welcomeHtml();
  // One clear next step: the first must-do; once those are done, optional ones become a bonus.
  // Something you partly did today waits until the untouched ones are done.
  const fresh_ = (i) => !(i.part && i.part.day === D);
  const nextItem = isToday ? open.find((i) => !i.dueOnly && !i.t.optional && fresh_(i)) || open.find((i) => !i.dueOnly && !i.t.optional) || open.find((i) => !i.dueOnly) : null;
  const bonus = !!nextItem?.t.optional;
  // A one-time hint so the phone gestures are discoverable.
  if (isToday && open.length >= 2 && coarse() && !store.device.tipGestures) html += `<p class="tip">${I.spark}<span>Swipe right when done, left for later. Hold to move.</span><button type="button" class="chip-btn" data-act="tip-ok">Got it</button></p>`;
  const row = (i) => taskRow(i, ctx, 'day', { next: i === nextItem, bonus });
  const dailyRow = (i) => taskRow(i, ctx, 'daily', { next: i === nextItem, bonus });
  const empty = (msg) => `<li class="empty-drop">${msg}</li>`;
  const daily = open.filter((i) => E.isDaily(i.t));
  const todos = open.filter((i) => !E.isDaily(i.t));
  const split = store.device.todayView === 'split';
  if (!isPast && open.length > 1) {
    const sortKey = store.settings.sortBy || 'plan';
    const busy = ui.sorting ? `<span class="sorting">${I.spark}<span class="shimmer">Claude is sorting…</span></span>` : '';
    const look = prog.split && todos.length ? `<div class="seg sm" role="group" aria-label="Show the list">${['together', 'split'].map((v) => `<button type="button" data-act="today-view" data-v="${v}" aria-pressed="${(v === 'split') === split}">${v === 'split' ? 'Dailies first' : 'All in order'}</button>`).join('')}</div>` : '';
    html += `<div class="list-bar">${busy}<button type="button" class="sort-btn${sortKey !== 'plan' ? ' on' : ''}" id="sortBtn" data-act="sort" aria-haspopup="menu">${I.sort}<span>${esc(sortName(sortKey))}</span></button>${look}</div>`;
  }
  if (split && prog.split && !isPast) {
    // Split look: daily routines, then a short to-do section (top few, the rest folded).
    const dailyDone = items.some((i) => E.isDaily(i.t) && i.status === 'done');
    const dailyLeft = daily.filter((i) => !i.t.optional).length;
    html += `<h3 class="list-head">Daily${dailyLeft ? ` <span class="n">${dailyLeft} left</span>` : ''}</h3>`;
    html += `<ul class="tasks day-list" data-list="day" data-day="${D}">${daily.map(dailyRow).join('')}${!daily.length ? empty(dailyDone ? 'All your dailies are done. Nice work.' : 'No daily routines on this day.') : ''}</ul>`;
    if (todos.length) {
      const LIMIT = 3;
      const showAll = ui.todosAll || todos.length <= LIMIT + 1;
      // Anything you just added or moved here stays in view, even when the list is folded.
      const now = Date.now();
      const fresh = (i) => now - (i.t.createdAt || 0) < 600000 || now - (ui.fresh.get(i.id) || 0) < 600000;
      const shown = showAll ? todos : todos.filter((i, k) => k < LIMIT || fresh(i));
      const rest = todos.filter((i) => !shown.includes(i)).map((i) => i.id);
      html += `<h3 class="list-head">${isToday ? 'To-dos' : 'Also'} <span class="n">${todos.length}</span>${isToday ? '<span class="lh-note">pick what fits</span>' : ''}</h3>`;
      html += `<ul class="tasks day-list todo-list" data-list="day" data-day="${D}" data-rest="${rest.join(',')}">${shown.map(row).join('')}</ul>`;
      if (rest.length || ui.todosAll) html += `<button type="button" class="more-btn" data-act="todos-all">${ui.todosAll ? 'Show fewer' : `Show ${rest.length} more`}</button>`;
    }
  } else {
    // Together: everything in the suggested order. Dailies keep their repeat mark so you can tell them apart.
    html += `<ul class="tasks day-list" data-list="day" data-day="${D}">${open.map(row).join('')}${!open.length && !showWelcome ? empty(isPast ? 'Nothing else was planned for this day.' : isToday ? (prog.doneN ? 'Everything on today’s list is done. Pick something from Worth doing today if you feel like more.' : 'Nothing planned yet. Add a task below, or drag one in from Everything else.') : 'Nothing planned yet. Drag tasks here to plan them for this day.') : ''}</ul>`;
  }
  if (isToday && todos.length < 3) html += suggestionsHtml(ctx, items);
  if (missed.length) html += `<h3 class="list-head">Not done <span class="n">${missed.length}</span></h3><ul class="tasks soft" data-list="none">${missed.map((i) => taskRow(i, ctx, 'past')).join('')}</ul>`;
  if (finished.length) {
    const open_ = ui.showDone || !isToday;
    html += `<h3 class="list-head"><button type="button" class="toggle" data-act="toggle-done" aria-expanded="${open_}">${I.down}${isToday ? 'Done today' : 'Done'}</button><span class="n">${finished.length}</span></h3>${open_ ? `<ul class="tasks" data-list="none">${finished.map((i) => taskRow(i, ctx, 'day')).join('')}</ul>` : ''}`;
  }
  $('#dayCol').innerHTML = html;
  // Celebrate the moment the day's list is finished.
  const key = `${D}:${prog.doneN}/${prog.total}`;
  if (isToday && prog.total && prog.doneN >= prog.total && ui.lastProgress && ui.lastProgress.day === D && ui.lastProgress.doneN < prog.doneN) {
    requestAnimationFrame(() => celebrate($('#dayCol .ring'), 22));
  }
  ui.lastProgress = { day: D, doneN: prog.doneN, total: prog.total, pct: prog.pct, key };
}

// The ring counts the daily routines: that's the realistic list for a day. Other to-dos are extra
// (they show up as wins when done). With no daily routines at all, everything counts.
// Optional tasks are a bonus: they count when done but never hold the ring back.
function progressOf(items) {
  const daily = items.filter((i) => E.isDaily(i.t));
  const split = daily.some((i) => !i.t.optional);
  const base = split ? daily : items;
  const doneN = base.filter((i) => i.status === 'done').length;
  const required = base.filter((i) => i.status === 'open' && !i.t.optional && !i.dueOnly).length;
  // Partly done today: still to go, but it fills half its share of the ring.
  const partN = base.filter((i) => i.status === 'open' && !i.t.optional && !i.dueOnly && i.part && i.part.day === i.day).length;
  const extras = split ? items.filter((i) => !E.isDaily(i.t) && i.status === 'done').length : 0;
  const total = doneN + required;
  return { doneN, partN, total, left: required, extras, split, pct: total ? (doneN + partN / 2) / total : 0 };
}

const pick = (list, seed) => {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
};

function cheerHtml(ctx, D, prog, isToday) {
  const { doneN, total, left, partN } = prog;
  const pct = prog.pct;
  const complete = total > 0 && doneN >= total;
  const entries = (ctx.idx.byDay.get(D) || []).filter((e) => !e.skip);
  // Timed minutes from partly done work count too (an untimed one adds nothing: we can't know).
  const doneIds = new Set(entries.map((e) => e.task));
  const minsDone = entries.reduce((a, e) => a + (e.mins || e.est || 0), 0) + (ctx.idx.partsByDay?.get(D) || []).filter((e) => !doneIds.has(e.task)).reduce((a, e) => a + (e.mins || 0), 0);
  let line;
  const seed = `${D}${doneN}`;
  if (!isToday) {
    line = doneN ? pick([`You finished ${doneN} thing${doneN === 1 ? '' : 's'} that day.`, `${doneN} done that day. Nice.`], seed) : 'A quiet day.';
  } else {
    const h = new Date().getHours();
    const name = (ctx.settings.name || '').trim();
    const greet = `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}${name ? `, ${name}` : ''}.`;
    let msg;
    if (!total) msg = 'Nothing planned. Enjoy the space, or pull something in when you feel like it.';
    else if (complete) msg = pick(['Everything’s done for today. Well earned.', 'All clear for today. Enjoy it.', 'Done for the day. Really nice work.'], seed);
    else if (!doneN) msg = h < 12 ? pick(['Fresh start. One thing at a time.', 'Let’s get the first one done.', 'Start with one. The rest gets easier.'], seed) : pick(['Plenty of day left. Start with something small.', 'One small win gets things rolling.', 'Pick one and start. You’ve got this.'], seed);
    else if (pct < 0.5) msg = pick([`Nice start: ${doneN} done.`, `${doneN} down. Good momentum.`, `You’re moving: ${doneN} done.`], seed);
    else if (pct < 0.85) msg = pick([`Over halfway. ${left} to go.`, `${doneN} done. Keep it rolling.`, `Good pace: just ${left} left.`], seed);
    else msg = pick([`Almost there. ${left} left.`, `Home stretch: ${left} to go.`], seed);
    if (isMobile()) msg = msg.replace(/^(.*?[.!:])\s.*$/, '$1').replace(/:$/, '.');
    line = `${greet} ${msg}`;
  }
  const subs = [];
  if (partN && !complete) subs.push(`${partN} partly done`);
  if (prog.extras) subs.push(`${prog.extras} to-do${prog.extras === 1 ? '' : 's'} done too`);
  if (minsDone >= 10) subs.push(`${E.fmtMins(minsDone)} of work done`);
  if (isToday) {
    let best = null;
    for (const t of ctx.s.tasks) {
      if (!t.repeat || t.deletedAt || t.purged || t.paused || t.repeat.kind === 'interval') continue;
      const st = E.streak(t, ctx.idx, D, ctx.ws);
      if (st >= 3 && (!best || st > best.st)) best = { t, st };
    }
    if (best) subs.push(`${esc(best.t.title)} ${best.st} ${best.t.repeat.kind === 'weekflex' ? 'weeks' : 'days'} in a row`);
    if (!doneN) {
      const y = (ctx.idx.byDay.get(E.addDays(D, -1)) || []).filter((e) => !e.skip).length;
      if (y) subs.push(`${y} done yesterday`);
    }
  }
  const from = ui.lastProgress && ui.lastProgress.day === D && ui.lastProgress.total === total ? (ui.lastProgress.pct ?? ui.lastProgress.doneN / Math.max(1, total)) * 100 : pct * 100;
  const what = prog.split ? 'dailies' : 'things';
  const ring = `<div class="ring${complete ? ' complete' : ''}" role="img" aria-label="${complete ? `All ${what} done` : `${left} ${what} to go`}" style="--from:${from.toFixed(1)};--to:${(pct * 100).toFixed(1)}">
<svg viewBox="0 0 48 48" aria-hidden="true"><circle class="r-track" cx="24" cy="24" r="20"/><circle class="r-fill" cx="24" cy="24" r="20" pathLength="100"/></svg>
<span class="r-label${complete ? '' : ' togo'}">${complete ? I.tick : `${left}<small>to go</small>`}</span></div>`;
  return `<section class="cheer">${total ? ring : ''}<div class="cheer-text"><p class="cheer-line">${esc(line)}</p>${subs.length ? `<p class="cheer-sub">${subs.map((x) => `<span>${x}</span>`).join('')}</p>` : ''}</div></section>`;
}

// Calendar titles are often long codes ("Elective - EB 7: … - Lecture - Dr. X [abc] [2026-27]").
// Keep the part that says what it is; the rest becomes a quiet note.
function tidyEvent(title) {
  const t = String(title || '').replace(/\s*\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  const parts = t.split(/\s*-\s+|\s+-\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return { main: t || 'Event', note: '' };
  const noise = /^(elective|mandatory|optional|required|lecture|tutorial|lab|seminar|small group( faculty)?|in person|virtual|zoom|(dr|prof)\.?\s.+)$/i;
  const main = parts.find((x) => x.includes(':') && !noise.test(x)) || parts.filter((x) => !noise.test(x)).sort((a, b) => b.length - a.length)[0] || parts[0];
  const note = parts.filter((x) => x !== main && !/^(dr|prof)\.?\s/i.test(x)).join(' · ');
  return { main, note };
}

function eventsHtml(D, isToday) {
  const evs = google.eventsOn(D);
  if (!evs.length) return '';
  const now = Date.now();
  const short = (d) => E.fmtClock(d).replace(/\s?(AM|PM)$/i, (m) => m.trim().toLowerCase().charAt(0));
  if (isMobile()) {
    // Phones: a compact agenda of what's left today; earlier events fold away.
    const allDay = evs.filter((e) => e.allDay);
    const timed = evs.filter((e) => !e.allDay);
    const past = isToday ? timed.filter((e) => Date.parse(e.end) < now) : [];
    const rest = timed.filter((e) => !past.includes(e));
    const showAll = ui.agendaAll;
    const shown = showAll ? timed : rest.slice(0, 4);
    const hidden = timed.length - shown.length;
    const later = showAll ? 0 : rest.length - shown.length;
    const row = (ev) => {
      const { main } = tidyEvent(ev.title);
      const st = Date.parse(ev.start);
      const nowOn = isToday && st <= now && Date.parse(ev.end) >= now;
      return `<li class="ag${past.includes(ev) ? ' past' : ''}${nowOn ? ' now' : ''}${ev.optional ? ' opt' : ''}" style="--ev:${esc(ev.color || '')}" title="${esc(ev.title)}"><b>${nowOn ? 'Now' : short(new Date(st))}</b><i></i><span>${esc(main)}</span></li>`;
    };
    const days = allDay.map((ev) => `<span class="ag-day" style="--ev:${esc(ev.color || '')}"><i></i>${esc(tidyEvent(ev.title).main)}</span>`).join('');
    if (!shown.length && !days) return past.length ? `<button type="button" class="ag-more" data-act="agenda">${past.length} earlier event${past.length === 1 ? '' : 's'}</button>` : '';
    return `<section class="agenda">${days ? `<div class="ag-days">${days}</div>` : ''}${shown.length ? `<ul>${shown.map(row).join('')}</ul>` : ''}${hidden > 0 || showAll ? `<button type="button" class="ag-more" data-act="agenda">${showAll ? 'Show less' : later ? `${hidden} more` : `${hidden} earlier`}</button>` : ''}</section>`;
  }
  return `<div class="events">${evs
    .slice(0, 8)
    .map((ev) => {
      const past = isToday && !ev.allDay && Date.parse(ev.end) < now;
      const when = ev.allDay ? 'All day' : E.fmtClock(new Date(ev.start));
      const { main } = tidyEvent(ev.title);
      return `<span class="ev${past ? ' past' : ''}${ev.optional ? ' opt' : ''}" style="--ev:${esc(ev.color || '')}" title="${esc(ev.title)}${ev.calName ? ` (${esc(ev.calName)})` : ''}"><i></i><b>${when}</b><span>${esc(main)}</span></span>`;
    })
    .join('')}${evs.length > 8 ? `<span class="ev">+${evs.length - 8} more</span>` : ''}</div>`;
}

function celebrate(el, n = 12) {
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = el.getBoundingClientRect();
  const burst = document.createElement('div');
  burst.className = 'burst';
  burst.style.left = `${r.left + r.width / 2}px`;
  burst.style.top = `${r.top + r.height / 2}px`;
  for (let i = 0; i < n; i++) {
    const dot = document.createElement('i');
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
    const dist = (n > 14 ? 34 : 20) + Math.random() * 14;
    dot.style.setProperty('--dx', `${Math.cos(a) * dist}px`);
    dot.style.setProperty('--dy', `${Math.sin(a) * dist}px`);
    dot.style.background = i % 3 === 0 ? 'var(--amber)' : 'var(--spruce)';
    burst.appendChild(dot);
  }
  document.body.appendChild(burst);
  setTimeout(() => burst.remove(), 800);
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
  const sched = (plan.scheduled || []).map((p) => ({ t: title(p.id), d: p.date })).filter((x) => x.t);
  if (sched.length) moves.push(`Scheduled ${sched.map((x) => `${esc(x.t)} for ${esc(relWord(x.d, today))}`).join(', ')}.`);
  const added = new Set(plan.added || []);
  const sug = (plan.suggest || []).map((s, i) => ({ ...s, i })).filter((s) => !added.has(s.i));
  const step = ui.planStep && ui.planStep.day === today ? ui.planStep.step : null;
  return `<div class="brief"><div class="b-head">${I.spark}${by} planned your day at ${E.fmtClock(new Date(plan.at))}</div>
<p class="b-text" data-act="brief-more">${esc(plan.brief)}</p>${moves.length ? `<p class="b-moves">${moves.join(' ')}</p>` : ''}
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
  return `<section class="welcome"><h2>Welcome to Daywell</h2>
<p>Type a task below to add it, or type a whole list and Claude sorts it. Start with these?</p>
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
  // Claude's daily ranking orders the backlog; anything new or urgent since then is slotted in by score.
  const plan = ctx.s.meta.plans[today];
  const rank = plan && !plan.removed && plan.rank?.length ? new Map(plan.rank.map((id, i) => [id, i])) : null;
  const byScore = (a, b) => scoreOf(b) - scoreOf(a);
  let anytime = one.filter((t) => !t.date);
  if (rank) {
    const ranked = anytime.filter((t) => rank.has(t.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const rest = anytime.filter((t) => !rank.has(t.id)).sort(byScore);
    const urgent = rest.filter((t) => t.priority === 1 || (t.deadline && E.diffDays(today, t.deadline) <= 1));
    anytime = [...urgent, ...ranked, ...rest.filter((t) => !urgent.includes(t))];
  } else anytime.sort(byScore);
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
  html += `<h3 class="list-head">Anytime <span class="n">${anytime.length || ''}</span>${rank && anytime.length > 1 ? `<span class="n" style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;color:var(--spruce)" title="Claude ranked these by importance this morning">${I.spark.replace('<svg', '<svg style="width:12px;height:12px"')}Ranked by Claude</span>` : ''}</h3><ul class="tasks" data-list="all" data-day="">${anytime.map((t) => row(t)).join('')}${!anytime.length ? `<li class="empty-drop">${q || ui.area ? 'No matching tasks.' : 'Tasks without a date land here. Claude and the “Worth doing today” list will bring them back when it matters.'}</li>` : ''}</ul>`;
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
  const fin = items.filter((i) => i.status === 'done' || i.status === 'skip' || i.status === 'part');
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

// What Daywell has noticed about how you work, the same notes Claude gets when it plans and sorts.
function patternsHtml(ctx) {
  const hp = E.habitProfile(ctx.s, ctx.today);
  if (!hp) return `<section class="patterns"><h3 class="list-head">Your patterns</h3><p class="muted-note">After a few days of checking things off, Daywell notes when you usually get things done, and Claude takes it into account when it plans and sorts.</p></section>`;
  return `<section class="patterns"><h3 class="list-head">Your patterns <span class="n">${esc(hp.basedOn)}</span></h3><ul>${hp.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p class="muted-note">Claude uses these to keep plans and sorts realistic. They describe what you tend to do, not what you should do, so it won't copy the ones that work against you.</p></section>`;
}

function renderHistory(ctx) {
  const { today, s, idx } = ctx;
  const ws = E.startOfWeek(today, ctx.ws);
  const live = s.log.filter((e) => !e.deleted);
  const doneEntries = live.filter((e) => !e.skip && !e.part);
  const weekDone = doneEntries.filter((e) => e.day >= ws).length;
  const doneThisWeek = new Set(doneEntries.filter((e) => e.day >= ws).map((e) => e.task));
  const weekMins = doneEntries.filter((e) => e.day >= ws).reduce((a, e) => a + (e.mins || 0), 0) + live.filter((e) => e.part && e.day >= ws && !doneThisWeek.has(e.task)).reduce((a, e) => a + (e.mins || 0), 0);
  const routines = s.tasks.filter((t) => t.repeat && !t.deletedAt && !t.purged);
  let sched = 0;
  let hit = 0;
  for (const t of routines) for (const p of E.routineTrail(t, idx, today, E.diffDays(ws, today) + 1)) {
    if (p.s === 'done') {
      hit++;
      sched++;
    } else if (p.s === 'part') {
      hit += 0.5;
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
      return `<div class="routine-row"><div><div class="rr-title" data-act="open" data-id="${t.id}" role="button" tabindex="0">${esc(t.title)}</div><div class="rr-meta">${esc(E.describeRepeat(t.repeat))}${last ? `, last done ${esc(relWord(last, today))}` : ', not done yet'}</div><div class="trail">${trail.map((p) => `<i class="${p.s}" title="${E.fmtShortDate(p.day)}: ${p.s === 'miss' ? 'missed' : p.s === 'off' ? 'not scheduled' : p.s === 'today' ? 'today' : p.s === 'part' ? 'partly done' : p.s}"></i>`).join('')}</div></div><div class="rr-streak">${st >= 2 ? `${st}-${t.repeat.kind === 'weekflex' ? 'week' : 'day'} streak` : ''}</div></div>`;
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
          const meta = [e.part ? 'partly done' : '', e.mins ? E.fmtMins(e.mins) : '', e.at ? E.fmtClock(new Date(e.at)) : ''].filter(Boolean).join(', ');
          const btn = e.part ? `<button type="button" data-act="remove-entry" data-e="${esc(e.id)}">Remove</button>` : `<button type="button" data-act="reopen" data-id="${t?.id}" data-day="${D}">${e.skip ? 'Unskip' : 'Reopen'}</button>`;
          return `<div class="log-row${e.part ? ' part' : ''}"><span class="lr-title${e.skip ? ' skip' : ''}">${esc(name)}</span><span class="lr-meta">${e.skip ? 'skipped' : esc(meta)}</span>${t && !t.purged && !t.deletedAt ? btn : ''}</div>`;
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
${patternsHtml(ctx)}<div class="h-grid"><section>${rr ? `<h3 class="list-head">Routines, last 14 days</h3>${rr}` : '<h3 class="list-head">Routines</h3><p class="muted-note">Repeating tasks show their streaks here.</p>'}${trashHtml}</section>
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
  pill.innerHTML = `<span class="tp-title">${esc(t.title)}</span><span class="tp-time" id="tpTime">${fmtTimer(Date.now() - tm.start)}</span><button type="button" data-act="timer-done">${I.tick}Done</button><button type="button" data-act="timer-part" aria-label="Partly done" title="Stop the timer and mark it partly done">${I.half}<span class="tp-lbl">Partly</span></button><button type="button" data-act="timer-stop" aria-label="Stop timer">${I.stop}<span class="tp-lbl">Stop</span></button>`;
}

function targetDay() {
  if (isMobile()) return ui.tab === 'today' && ui.view === 'today' ? ui.day || store.today : null;
  return store.device.addTarget === 'day' ? ui.day || store.today : null;
}

function renderComposerMeta() {
  const tb = $('#targetBtn');
  const D = store.device.addTarget === 'day' ? ui.day || store.today : null;
  tb.innerHTML = `${I.down}<span>${D ? `To ${esc(relWord(D, store.today))}` : 'To Anytime'}</span>`;
  tb.title = 'Where new tasks go. Click to switch.';
  renderParseChips();
}

// Plain tasks are added straight away; lists, questions and requests go to Claude.
function autoMode(v) {
  if (!store.device.apiKey) return 'add';
  const t = v.trim();
  if (!t) return 'add';
  if (t.split('\n').filter((l) => l.trim()).length > 1) return 'ask';
  if (t.split(/[,;]+|\s+(?:and then|then|also)\s+/i).filter((x) => x.trim().length > 1).length >= 3) return 'ask';
  if (/\?\s*$/.test(t)) return 'ask';
  if (/^(please\s+)?(move|delete|remove|finish|complete|mark|reschedule|push|postpone|rename|change|clear|cancel|plan|sort|organi[sz]e|prioriti[sz]e|what|when|which|how|should|can you|could you|help me|i have|i need to|i want to)\b/i.test(t)) return 'ask';
  // Progress reports ("did half of the bio review", "finished laundry") aren't new tasks.
  if (/^(i\s+)?(did|done|finished|started|worked on|partly|partially|half of|halfway|made progress|got through|got some)\b/i.test(t)) return 'ask';
  if (t.length > 100) return 'ask';
  return 'add';
}
function sendMode() {
  const v = $('#input').value;
  if (!store.device.apiKey || !v.trim()) return 'add';
  return ui.modeOverride || autoMode(v);
}
function send() {
  if (sendMode() === 'ask') return askClaude();
  return addFromInput();
}
function renderSendBtn() {
  const btn = $('#addBtn');
  const mode = sendMode();
  const busy = ui.ai?.status === 'busy';
  btn.classList.toggle('ai', mode === 'ask');
  btn.classList.toggle('busy', busy && mode === 'ask');
  btn.innerHTML = mode === 'ask' ? I.spark : I.plus;
  btn.setAttribute('aria-label', mode === 'ask' ? 'Send to Claude' : 'Add task');
  btn.title = mode === 'ask' ? 'Claude sorts it (Enter)' : 'Add (Enter)';
}

function renderParseChips() {
  const v = $('#input').value;
  const el = $('#parseChips');
  if (!v.trim()) ui.modeOverride = null;
  if (ui.restored && !v.includes(ui.restored.text)) ui.restored = null;
  renderSendBtn();
  const r = ui.restored;
  const back = r ? `<span class="pc back">${I.undo}${r.mode === 'ask' ? 'Your message is back' : 'Back from undo'}</span>` : '';
  if (!v.trim()) {
    el.innerHTML = '';
    return;
  }
  const hasKey = !!store.device.apiKey;
  const mode = sendMode();
  if (mode === 'ask') {
    const n = v.split(/\n|[,;]+/).filter((x) => x.trim().length > 1).length;
    el.innerHTML = `${back}<span class="pc ai">${I.spark}${n >= 2 ? `Claude sorts these ${n}` : 'Claude takes it from here'}</span><button type="button" class="pc mode" data-act="mode" data-v="add">Add as is</button>`;
    return;
  }
  const lines = v.split('\n').filter((l) => l.trim());
  const chips = lines.length > 1 ? `<span class="pc">${lines.length} tasks</span>` : E.parseQuick(v, store.today, { weekStart: store.settings.weekStart }).chips.map((c) => `<span class="pc">${esc(c.label)}</span>`).join('');
  el.innerHTML = `${back}${chips}${hasKey ? `<button type="button" class="pc mode" data-act="mode" data-v="ask">${I.spark}Ask Claude</button>` : ''}`;
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
  renderSendBtn();
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
  if (r.partial?.length) chips.push(`Partly done ${r.partial.length}`);
  if (r.removed.length) chips.push(`Deleted ${r.removed.length}`);
  if (r.sorted) chips.push('Sorted today');
  const same = r.same || [];
  const any = chips.length > 0 || same.length > 0;
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
  for (const id of r.partial || []) detail.push(`<li><span class="k">Partly done</span><span>${esc(title(id))}</span></li>`);
  for (const id of r.removed) detail.push(`<li><span class="k">Deleted</span><span>${esc(title(id))}</span></li>`);
  // Already on the list: say so, and let you keep it as its own task if Claude matched wrong.
  const sameHtml = same.length
    ? `<ul class="ai-same">${same
        .map((m, i) => (store.task(m.id) ? `<li><span class="k">${m.split ? 'Kept both' : 'Already there'}</span><span>${esc(title(m.id))}${m.split ? '' : ` <span class="m-area">moved up</span>`}</span>${m.split ? '' : `<button type="button" class="chip-btn" data-ai="split" data-si="${i}" title="Add “${esc(m.said)}” as its own task">Add as new</button>`}</li>` : ''))
        .join('')}</ul>`
    : '';
  const qs = a.questions
    .map((q, i) => {
      const t = store.task(q.taskId);
      if (!t) return '';
      return `<div class="ai-q${q.answer ? ' answered' : ''}" data-qi="${i}"><p>${esc(q.text)}<small>${esc(t.title)}${q.answer ? `: ${esc(q.answer)}` : ''}</small></p>${q.answer ? '' : `<div class="opts">${q.options.map((o) => `<button type="button" class="chip-btn" data-ai="answer" data-qi="${i}" data-v="${esc(o)}">${esc(o)}</button>`).join('')}<input class="other" data-qi="${i}" placeholder="Other…" aria-label="Another answer"><button type="button" class="chip-btn" data-ai="skipq" data-qi="${i}">Skip</button></div>`}</div>`;
    })
    .join('');
  el.innerHTML = `<div class="ai-head">${I.spark}<p class="ai-reply">${esc(r.reply || (any ? 'Done.' : 'No changes.'))}</p><button type="button" class="icon-btn sm" data-ai="close" aria-label="Close">${I.x}</button></div>
${sameHtml}${chips.length || a.step ? `<div class="ai-changes">${chips.map((c) => `<span class="chip-btn" style="box-shadow:none;background:var(--spruce-soft);color:var(--spruce)">${c}</span>`).join('')}<button type="button" class="chip-btn" data-ai="details">${a.showDetails ? 'Hide details' : 'Details'}</button>${r.sorted && store.settings.sorts?.find((x) => x.id === r.sorted.id)?.temp ? `<button type="button" class="chip-btn" data-ai="save-sort">${I.plus}Save this sort</button>` : ''}${a.step ? `<button type="button" class="chip-btn" data-ai="undo">${I.undo}Undo</button>` : ''}</div>${a.showDetails ? `<ul class="ai-detail">${detail.join('')}</ul>` : ''}` : ''}
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
  $('#drawer').style.transform = '';
  if ($('#menu').hidden) $('#scrim').hidden = true;
}

/* ---------- phone helpers: sheets you can swipe down, a composer that rides the keyboard ---------- */

function sheetDrag(sheet, handle, close) {
  let st = null;
  sheet.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !isMobile()) return;
    if (!e.target.closest(handle) || e.target.closest('button, input, textarea, select, a')) return;
    st = { y0: e.clientY, t0: e.timeStamp, pid: e.pointerId, dy: 0 };
  });
  sheet.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.pid) return;
    st.dy = Math.max(0, e.clientY - st.y0);
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${st.dy}px)`;
  });
  const end = (e) => {
    if (!st || e.pointerId !== st.pid) return;
    const fast = st.dy > 30 && st.dy / Math.max(1, e.timeStamp - st.t0) > 0.5;
    const go = e.type !== 'pointercancel' && (st.dy > 110 || fast);
    st = null;
    sheet.style.transition = 'transform 0.2s ease';
    sheet.style.transform = go ? 'translateY(105%)' : '';
    setTimeout(() => {
      sheet.style.transition = '';
      if (go) close();
      sheet.style.transform = '';
    }, 200);
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
}

// Phones: keep the composer (and any open sheet) just above the on-screen keyboard, and hide the
// tab bar while typing. Works with iOS (visual viewport) and Android (resizes-content).
function watchViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  let raf = 0;
  const update = () => {
    raf = 0;
    const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    root.style.setProperty('--kb', `${kb}px`);
    if (vv) root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    const ae = document.activeElement;
    root.classList.toggle('kb-open', coarse() && isMobile() && !!ae?.closest?.('#dock, #menu') && ae.matches('textarea, input:not([type=checkbox])'));
  };
  const soon = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };
  vv?.addEventListener('resize', soon);
  vv?.addEventListener('scroll', soon);
  document.addEventListener('focusin', soon);
  document.addEventListener('focusout', () => setTimeout(soon, 80));
  update();
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
  $('#drawer').innerHTML = `<div class="sheet-grip" aria-hidden="true"></div><div class="dr-head"><span class="grow">${t.src === 'ai' ? 'Added by Claude' : 'Added'} ${esc(relWord(E.keyFromMs(t.createdAt || Date.now()), today))}${t.bumps ? `, pushed back ${t.bumps} time${t.bumps === 1 ? '' : 's'}` : ''}</span><button type="button" class="icon-btn sm" data-dr="close" aria-label="Close details">${I.x}</button></div>
<div class="dr-body">
<textarea class="dr-title" data-f="title" rows="1" aria-label="Title">${esc(t.title)}</textarea>
<div class="dr-done"><button type="button" class="chip-btn${doneToday ? ' on' : ''}" data-dr="toggle-done">${I.tick}${doneToday ? (rep ? 'Done today' : 'Done') : rep ? 'Mark done today' : 'Mark done'}</button>
<button type="button" class="chip-btn" data-dr="timer">${timing ? `${I.stop}Stop timer` : `${I.play}Start timer`}</button>
${(() => {
    const ps = partState(t, null, ctx);
    return ps.part ? `<button type="button" class="chip-btn on" data-dr="unpart" title="Take back “partly done”">${I.half}Partly done${rep ? ' today' : ''}</button>` : `<button type="button" class="chip-btn" data-dr="part">${I.half}${ps.done ? 'Only partly done' : 'Partly done'}</button>`;
  })()}
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
  const ps = partState(t, day, ctx);
  const partBtn = ps.done
    ? `<button type="button" class="mi" role="menuitem" data-m="part">${I.half}Only partly done</button>`
    : ps.part
      ? `<button type="button" class="mi" role="menuitem" data-m="unpart">${I.half}Not partly done<small>take it back</small></button>`
      : `<button type="button" class="mi" role="menuitem" data-m="part">${I.half}Partly done</button>`;
  const m = $('#menu');
  m.innerHTML = `<div class="sheet-grip" aria-hidden="true"></div><div class="m-pris" role="group" aria-label="Priority">${[1, 2, 3, 4].map((p) => `<button type="button" class="p${p}" data-m="pri" data-v="${p}" aria-pressed="${t.priority === p}" title="${E.PRIORITY_NAMES[p]}">P${p}</button>`).join('')}</div>
${partBtn}${rep?.kind === 'daily' ? '' : '<hr>'}
${rep?.kind === 'daily' ? '' : `${opts.map(([l, v]) => `<button type="button" class="mi" role="menuitem" data-m="move" data-v="${v}">${l === 'Today' ? I.sun : I.calendar}${l}<small>${E.fmtShortDate(v)}</small></button>`).join('')}
<div class="m-date"><input type="date" class="inp" data-m="pick" aria-label="Pick a date" min="${today}"></div>
<button type="button" class="mi" role="menuitem" data-m="move" data-v="">${I.x}${rep ? 'Back to its usual schedule' : 'No date'}</button><hr>`}
${rep && inToday ? `<button type="button" class="mi" role="menuitem" data-m="skip">${I.skip}Skip today</button>` : ''}
<button type="button" class="mi" role="menuitem" data-m="timer">${timing ? `${I.stop}Stop timer` : `${I.play}Start timer`}</button>
<button type="button" class="mi" role="menuitem" data-m="open">${I.list}Details</button>
<button type="button" class="mi" role="menuitem" data-m="dup">${I.dup}Duplicate</button>
<button type="button" class="mi danger" role="menuitem" data-m="delete">${I.trash}Delete</button>`;
  m.hidden = false;
  if (isMobile()) $('#scrim').hidden = false;
  const col = anchor.closest('.col, .view-calendar');
  ui.menuFor = { id, day, anchor, col, top: col?.scrollTop ?? 0 };
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
// Which day a "partly done" from this row counts for (today, or the past day you're looking at),
// and where the task stands on it.
function partState(t, rowDay, ctx = ctxNow()) {
  const today = ctx.today;
  const day = rowDay && rowDay < today ? rowDay : today;
  const done = t.repeat ? !!E.entryOn(ctx.idx, t.id, day) && !E.entryOn(ctx.idx, t.id, day).skip : !!t.doneDay;
  const p = done ? null : E.partOf(t, ctx.idx, day, ctx.ws);
  return { day, done, part: p && p.day === day ? p : null, earlier: p && p.day !== day ? p : null };
}
function markPartly(t, rowDay) {
  const { day, done } = partState(t, rowDay);
  store.partDone(t.id, day);
  const msg = done ? 'Changed to partly done' : t.repeat?.kind === 'daily' ? `Partly done ${day === store.today ? 'today' : relWord(day, store.today)}` : day === store.today && !t.repeat ? 'Partly done. It stays on your list' : 'Marked partly done';
  undoToast(msg, lastStep());
}

function closeMenu() {
  const m = $('#menu');
  if (m.hidden) return;
  m.hidden = true;
  m.classList.remove('sort-menu');
  m.style.transform = '';
  if (!ui.drawer) $('#scrim').hidden = true;
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
  } else if (act === 'part') markPartly(t, f.day);
  else if (act === 'unpart') {
    store.unpartDone(t.id, partState(t, f.day).day);
    undoToast('Took back “partly done”', lastStep());
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
  if (st === 'part' && !t.repeat && t.doneDay) return toast(`Already finished ${relWord(t.doneDay, store.today)}`);
  if (st === 'done' || st === 'skip') {
    store.uncomplete(id, t.repeat ? day : t.doneDay || day);
    return;
  }
  li.classList.add('done', 'just-done');
  li.querySelector('.check')?.setAttribute('aria-pressed', 'true');
  celebrate(li.querySelector('.check'));
  const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 320;
  setTimeout(() => {
    store.complete(id, day);
    undoToast(doneMessage(t, day), lastStep());
  }, delay);
}

function doneMessage(t, day) {
  if (day !== store.today) return `Done: ${t.title}`;
  const ctx = ctxNow();
  const prog = progressOf(E.dayItems(ctx.s, ctx.idx, day, ctx.today, ctx.settings));
  const seed = `${t.id}${prog.doneN}`;
  if (prog.total && prog.left === 0) return 'That’s everything for today. Well done.';
  if (prog.doneN === 1) return pick(['First one done. Nice.', 'Off to a good start.'], seed);
  return pick([`Done. ${prog.doneN} today.`, `Nice. That’s ${prog.doneN} today.`, `Checked off. ${prog.left} to go.`, `${t.title}: done.`], seed);
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
  // Something you type that's already on your list (or twice in one go) isn't added again: the
  // one you have moves up instead, and "Add anyway" adds the copy if you meant a second one.
  const open = new Map();
  for (const t of store.state.tasks) if (!t.deletedAt && !t.purged && !t.doneDay) open.set(E.sameTitleKey(t.title), t);
  const seen = new Set();
  const list = [];
  const again = [];
  for (const l of lines) {
    const p = E.parseQuick(l, today, { weekStart: ws });
    const f = { title: p.title, date: p.date, deadline: p.deadline, time: p.time, estMin: p.estMin, estMax: p.estMax, priority: p.priority || 3, repeat: p.repeat, area: p.area, optional: p.optional };
    const k = E.sameTitleKey(f.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const have = open.get(k);
    if (have && !f.repeat) {
      again.push({ id: have.id, date: p.date, f });
      continue;
    }
    if (!f.date && !f.repeat && D) f.date = D;
    list.push(f);
  }
  const made = store.addTasks(list, { meta: { input: raw, mode: 'add' }, again });
  input.value = '';
  ui.restored = null;
  autoGrow();
  renderParseChips();
  if (ui.ai && ui.ai.status !== 'busy' && !ui.ai.questions?.some((q) => !q.answer)) {
    ui.ai = null;
    renderAIPanel();
  }
  const where = (t) => (t.repeat ? E.describeRepeat(t.repeat).toLowerCase() : t.date ? (t.date === today ? 'today' : relWord(t.date, today)) : 'Anytime');
  if (again.length) {
    const name = store.task(again[0].id)?.title || 'That';
    const msg = again.length === 1 ? `“${name}” is already on your list, so it moved up` : `${again.length} were already on your list, so they moved up`;
    return toast(`${made.length ? `Added ${made.length}. ` : ''}${msg}`, { label: 'Add anyway', run: () => {
      const copies = store.addTasks(again.map((a) => ({ ...a.f, date: a.f.date || (a.f.repeat ? null : D) })), { meta: { input: raw, mode: 'add' } });
      undoToast(copies.length === 1 ? `Added “${copies[0].title}” as a separate task` : `Added ${copies.length} separate tasks`, lastStep());
    } });
  }
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
  // On a phone, put the keyboard away so Claude's answer has room.
  if (coarse() && document.activeElement === input) input.blur();
  const ctrl = new AbortController();
  ui.ai = { status: 'busy', text, startedAt: Date.now(), ctrl };
  renderAIPanel();
  renderComposerMeta();
  const slowTimer = setTimeout(renderAIPanel, 15000);
  const ctx = ctxNow();
  try {
    const todayIds = sortDay(E.orderOpen(E.dayItems(ctx.s, ctx.idx, ctx.today, ctx.today, ctx.settings).filter((i) => i.status === 'open'), ctx.today, ctx.s, ctx.sc), ctx.today, ctx).map((i) => i.id);
    const { ids, snapshot } = AI.commandContext({ state: store.state, idx: ctx.idx, today: ctx.today, now: new Date(), events: google.configured ? google.windowEvents(14) : null, eventsOn: (D) => google.eventsOn(D), settings: ctx.settings, todayIds });
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
    const result = applyCommand(r.data, ids, text);
    ui.ai = { status: 'done', text, result, step: result.step, questions: result.questions, showDetails: false };
    if (result.step) result.step.meta.ai = ui.ai;
    if (ui.restored?.text === text) ui.restored = null;
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

function applyCommand(data, ids, text = '') {
  const today = store.today;
  const refs = new Map();
  const out = { reply: String(data.reply || ''), created: [], updated: [], same: [], completed: [], partial: [], removed: [], questions: [], step: null, sorted: null, birthdays: [] };
  const order = [...new Set((data.order || []).map((x) => ids.long(x)).filter((id) => id && store.task(id)))];
  const sid = order.length > 1 ? E.uid('s') : null;
  const sortFrom = store.settings.sortBy || 'plan';
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
    // Things you said again that are already on your list: no duplicate, it just moves up a bit.
    for (const m of data.same || []) {
      const id = ids.long(m.id);
      const t = id && s.tasks.find((x) => x.id === id);
      if (!t || t.deletedAt || t.purged || out.same.some((x) => x.id === id)) continue;
      const n = E.againCount(t, today);
      t.again = { n: Math.min(9, n + 1), at: Date.now() };
      t.updatedAt = Date.now();
      out.same.push({ id, said: String(m.said || '').trim().slice(0, 300) });
    }
    const merged = new Map();
    for (const u of data.update || []) {
      const id = ids.long(u.id);
      if (!id) continue;
      const ch = AI.changeFromAI(u.field, u.value);
      const prev = merged.get(id) || {};
      if (ch.addNote) ch.addNote = prev.addNote ? `${prev.addNote}\n${ch.addNote}` : ch.addNote;
      merged.set(id, { ...prev, ...ch });
    }
    for (const [id, ch0] of merged) {
      const t = s.tasks.find((x) => x.id === id);
      if (!t || t.deletedAt || t.purged) continue;
      const { addNote, ...ch } = ch0;
      if (addNote && !(ch.notes ?? t.notes ?? '').includes(addNote)) ch.notes = [ch.notes ?? t.notes ?? '', addNote].filter(Boolean).join('\n').slice(0, 4000);
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
    for (const sid of data.partial || []) {
      const id = ids.long(sid);
      const t = s.tasks.find((x) => x.id === id);
      if (!t || t.deletedAt || t.purged || out.completed.includes(id) || out.partial.includes(id)) continue;
      if (t.repeat ? E.entryOn(idx, t.id, today) : t.doneDay) continue;
      if (s.meta.timer?.id === t.id) store.stopTimerInner(s, true);
      markPart(s, t, today);
      out.partial.push(id);
    }
    for (const sid of data.remove || []) {
      const id = ids.long(sid);
      const t = s.tasks.find((x) => x.id === id);
      if (!t || t.deletedAt || t.purged) continue;
      t.deletedAt = Date.now();
      t.updatedAt = Date.now();
      out.removed.push(id);
    }
    for (const b of data.birthdays || []) {
      const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const md = `${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}`;
      if (!name || !E.isKey(`2024-${md}`)) continue;
      const k = E.bdayKey(name);
      (s.meta.bdays ||= {})[k] = { name, md, at: Math.max(Date.now(), (s.meta.bdays[k]?.at || 0) + 1) };
      out.birthdays.push(name);
    }
    if (sid) {
      // A sort request from the chat box: keep it as a one-off sort you can save from the panel.
      const day = (s.meta.sorted ||= {})[today] || { by: {} };
      day.by = { ...day.by, [sid]: order };
      day.at = Date.now();
      s.meta.sorted[today] = day;
      out.sorted = { id: sid, prompt: text };
    }
  }, { meta: { input: text, mode: 'ask', ...(sid ? { sortFrom, sortTo: sid } : {}) } });
  if (out.sorted) store.setShared({ sorts: [...(store.settings.sorts || []).filter((x) => !x.temp), { id: out.sorted.id, name: shortSortName(text), prompt: text, temp: true }], sortBy: out.sorted.id });
  if (out.birthdays.length) ensureBirthdays();
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
    const { ids, snapshot } = AI.planContext({ state: ctx.s, idx: ctx.idx, today, now, events: google.configured ? google.windowEvents(14) : null, eventsOn: (D) => google.eventsOn(D), settings: ctx.settings, todayItems: items });
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
    // A new plan replaces today's earlier focus marks and notes.
    for (const t of s.tasks) {
      if (t.ai && t.ai.day === today) {
        t.ai = null;
        t.updatedAt = Date.now();
      }
    }
    const find = (sid) => {
      const id = ids.long(sid);
      return id ? s.tasks.find((t) => t.id === id && !t.deletedAt && !t.purged) : null;
    };
    const pulled = [];
    const deferred = [];
    for (const p of (data.pull || []).slice(0, 3)) {
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
    const scheduled = [];
    for (const sc of (data.schedule || []).slice(0, 6)) {
      const t = find(sc.id);
      const limit = E.addDays(today, 7);
      if (!t || t.doneDay || !E.isKey(sc.date) || sc.date <= today || sc.date > limit) continue;
      if (t.repeat && !['interval', 'weekflex'].includes(t.repeat.kind)) continue;
      if (pulled.some((p) => p.id === t.id)) continue;
      moveTask(s, t, sc.date, today);
      t.ai = { note: String(sc.reason || '').slice(0, 120), day: sc.date };
      scheduled.push({ id: t.id, date: sc.date, reason: sc.reason });
    }
    for (const n of data.notes || []) {
      const t = find(n.id);
      if (!t || !n.note) continue;
      t.ai = { ...(t.ai || {}), note: String(n.note).slice(0, 120), day: today };
      t.updatedAt = Date.now();
    }
    const focus = [...new Set((data.focus || []).map((x) => ids.long(x)).filter(Boolean))].slice(0, 3);
    for (const id of focus) {
      const t = s.tasks.find((x) => x.id === id);
      if (!t) continue;
      t.ai = { note: t.ai?.day === today ? t.ai.note : '', day: today, focus: true };
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
      scheduled,
      focus,
      suggest: (data.suggest || []).slice(0, 3).map((x) => ({ title: String(x.title || '').slice(0, 140), reason: String(x.reason || '').slice(0, 140), deadline: E.isKey(x.deadline) ? x.deadline : null, estMin: x.estMin > 0 ? x.estMin : null, estMax: x.estMax > 0 ? x.estMax : null })),
      rank: [...new Set((data.rank || []).map((x) => ids.long(x)).filter(Boolean))],
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
  void load;
  void free;
  const brief = items.length ? `${items.length} thing${items.length === 1 ? '' : 's'} on today's list.${top ? ` Start with ${top}, then take them one at a time.` : ''}` : 'Nothing planned yet. Pull something in from the suggestions below when you feel like it.';
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
  if (endMin > E.timeToMin(s.shared.dayStart || '07:00') && nowMin > endMin - 180) return; // too little day left
  if (!s.tasks.some((t) => !t.deletedAt && !t.purged)) return;
  ui.autoPlanTried = today;
  planDay({ auto: true });
}

/* ================================================================== */
/* settings                                                            */
/* ================================================================== */

function openSettings(focus) {
  ui.bkRemote = null;
  renderSettings();
  const d = $('#settings');
  if (!d.open) d.showModal();
  if (focus) {
    const sec = $(`#st-${focus}`);
    sec?.scrollIntoView({ block: 'start' });
    if (focus === 'claude' && !store.device.apiKey) $('#st-key')?.focus();
  }
}

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function phoneSection() {
  if (!google.configured) return '';
  const ph = ui.phrase;
  const state = ph == null ? '' : `<span class="badge${ph.set ? '' : ' off'}">${ph.set ? 'Set' : 'Not set'}</span>`;
  const install = coarse() && !isStandalone()
    ? `<p class="st-note">${isIOS() ? 'For an app icon: Share, then Add to Home Screen. Open it and type your key once.' : 'For an app icon: browser menu, then Add to Home screen.'}</p>`
    : '';
  return `<section class="st-sec" id="st-phone"><h3>Sign-in key ${state}</h3>
<p>Open Daywell on your phone or any computer and type this key to get your tasks and calendar. Capital letters don’t matter.</p>
<div class="st-row"><label for="st-phrase">${ph?.set ? 'New key' : 'Key'}</label><div class="row"><input id="st-phrase" class="inp" type="password" autocomplete="new-password" autocapitalize="none" spellcheck="false" placeholder="${ph?.set ? 'Type a new key' : 'Choose a key'}"><button type="button" class="btn" data-st="save-phrase">Save</button></div></div>
${store.device.apiKey ? `<div class="st-row"><label></label><label class="toggle-row"><input type="checkbox" id="st-phrase-claude" ${!ph?.set || ph.claude ? 'checked' : ''}>Bring my Claude key along</label></div>` : ''}
<div class="st-row"><label></label><span id="st-phrase-status" class="st-status">${ph?.set ? `Saved. On your phone, open <b>${esc(location.host + location.pathname.replace(/index\.html$/, ''))}</b> and type it.` : ''}</span></div>
${install}
<div class="st-row"><label></label><div class="row"><button type="button" class="chip-btn" data-st="sign-out">Sign out of this device</button></div></div></section>`;
}

function renderSettings() {
  const dv = store.device;
  const sh = store.state.shared;
  const hours = (sel) => Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === sel ? ' selected' : ''}>${E.fmtTime(E.minToTime(h * 60))}</option>`).join('');
  const g = google;
  const cals = g.calendars || [];
  const prefs = sh.calendars || {};
  const googleBody = g.configured
    ? `<p>Connected. Your events show on each day, Claude plans around them, and your tasks sync across devices.</p>
<div class="st-row"><label>Sync</label><div class="row"><input type="checkbox" class="switch" id="st-sync" ${dv.sync ? 'checked' : ''}><span>${g.status === 'error' ? `<span class="st-status err">${esc(g.error)}</span>` : dv.lastSync ? `Last synced ${E.fmtClock(new Date(dv.lastSync))}` : 'Not synced yet'}</span><button type="button" class="chip-btn" data-st="sync-now">${I.sync}Sync now</button></div></div>
<div class="st-row"><label>Calendars</label><div>${cals.length ? `<div class="cal-list">${cals.map((c) => `<label><input type="checkbox" data-cal="${esc(c.id)}" ${(c.id in prefs ? prefs[c.id] : c.selected) ? 'checked' : ''}><i style="--ev:${esc(c.color)}"></i>${esc(c.name)}</label>`).join('')}</div>` : `<button type="button" class="chip-btn" data-st="load-cals">Show my calendars</button>`}</div></div>
<div class="st-row"><label></label><div class="row"><button type="button" class="btn secondary" data-st="disconnect">Disconnect Google</button></div></div>`
    : `<div class="st-row"><label></label><div class="row"><button type="button" class="btn" data-st="sign-in">Sign in with your key</button></div></div>
<details class="st-more"><summary>Set up a new Google script</summary>
<p>See your Google Calendar events on each day, let Claude plan around them, and sync tasks between your phone and laptop. It runs as a small free script inside your own Google account. Setup takes about 3 minutes.</p>
<ol class="steps">
<li><button type="button" class="chip-btn" data-st="copy-script">${I.copy}Copy script</button></li>
<li>Open <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a>, delete the sample code, paste, and press <b>Save</b>.</li>
<li>Click <b>Deploy</b>, then <b>New deployment</b>. Pick <b>Web app</b>, set <b>Execute as: Me</b> and <b>Who has access: Anyone</b>, and press <b>Deploy</b>.</li>
<li>Allow access. If Google says the app isn't verified, choose <b>Advanced</b>, then <b>Go to … (unsafe)</b>. It's your own script.</li>
<li>Copy the <b>Web app URL</b> (it ends in /exec) and paste it here.</li></ol>
<div class="st-row"><label for="st-gsurl">Web app URL</label><div class="row"><input id="st-gsurl" class="inp wide" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(dv.gsUrlDraft || '')}"></div></div>
<div class="st-row"><label></label><div class="row"><button type="button" class="btn" data-st="connect">Connect</button><span id="st-gstatus" class="st-status"></span></div></div></details>
`;
  const keepToast = $('#settings').querySelector(':scope > .toast.in-dialog');
  $('#settings').innerHTML = `<div class="st-head"><h2>Settings</h2><button type="button" class="icon-btn" data-st="close" aria-label="Close settings">${I.x}</button></div><div class="st-body">
<section class="st-sec" id="st-claude"><h3>Claude <span class="badge${dv.apiKey ? '' : ' off'}">${dv.apiKey ? 'Key saved' : 'Not set up'}</span></h3>
<p>Claude turns lists into tasks, estimates times, asks quick questions, and plans your day. Your key stays in this browser and is only sent to Anthropic.</p>
<div class="st-row"><label for="st-key">API key</label><div class="row"><input id="st-key" class="inp" style="flex:1;min-width:200px" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(dv.apiKey)}"><button type="button" class="chip-btn" data-st="showkey">Show</button></div></div>
<div class="st-row"><label for="st-model">Model</label><div class="row"><input id="st-model" class="inp" list="st-models" value="${esc(dv.model)}"><datalist id="st-models"><option value="claude-sonnet-5-5"><option value="claude-haiku-5-5"><option value="claude-opus-5-5"></datalist></div></div>
<div class="st-row"><label>Effort</label><div><div class="seg" role="group" aria-label="Effort">${['low', 'medium', 'high'].map((e) => `<button type="button" data-st="effort" data-v="${e}" aria-pressed="${dv.effort === e}">${e[0].toUpperCase() + e.slice(1)}</button>`).join('')}</div><p class="dr-hint">Medium is careful; long lists can take 10–30 seconds. Low answers in about 5.</p></div></div>
<div class="st-row"><label></label><div class="row"><button type="button" class="btn secondary" data-st="test">Test connection</button><span id="st-test" class="st-status"></span></div></div>
<div class="st-row"><label for="st-auto">Daily plan</label><div class="row"><input type="checkbox" class="switch" id="st-auto" ${sh.autoPlan ? 'checked' : ''}><span>Plan my day the first time I open Daywell after</span><select id="st-autoh" class="inp">${hours(sh.autoPlanHour ?? 6)}</select></div></div></section>
<section class="st-sec" id="st-day"><h3>Your day</h3><p>Used to greet you and to plan around your free time.</p>
<div class="st-row"><label for="st-name">Your name</label><div class="row"><input id="st-name" class="inp" autocomplete="given-name" placeholder="First name" value="${esc(sh.name || '')}"></div></div>
<div class="st-row"><label for="st-ds">Day starts</label><div class="row"><input id="st-ds" type="time" class="inp" value="${sh.dayStart}"><span>and ends</span><input id="st-de" type="time" class="inp" value="${sh.dayEnd}"></div></div>
<div class="st-row"><label for="st-roll">New day begins</label><div class="row"><select id="st-roll" class="inp">${[0, 1, 2, 3, 4, 5, 6].map((h) => `<option value="${h}"${h === (sh.rollHour ?? 4) ? ' selected' : ''}>${h === 0 ? 'At midnight' : `At ${h} AM`}</option>`).join('')}</select><span class="dr-hint" style="margin:0">Late nights still count as the same day.</span></div></div>
<div class="st-row"><label>Week starts on</label><div class="seg" role="group">${[
    [1, 'Monday'],
    [0, 'Sunday'],
  ]
    .map(([v, l]) => `<button type="button" data-st="ws" data-v="${v}" aria-pressed="${(sh.weekStart ?? 1) === v}">${l}</button>`)
    .join('')}</div></div></section>
${coarse() && !g.configured ? phoneSection() : ''}<section class="st-sec" id="st-google"><h3>Google Calendar and sync <span class="badge${g.configured ? '' : ' off'}">${g.configured ? 'Connected' : 'Not connected'}</span></h3>${googleBody}</section>
${coarse() && !g.configured ? '' : phoneSection()}
${bdaySection()}
<section class="st-sec" id="st-data"><h3>Backups</h3><p>Daywell backs itself up: on this device whenever something changes and right before a sync removes anything${g.configured ? ', and in your Google account every couple of hours' : ''}. Restoring brings back whatever is missing and never deletes what you have now.</p>
<div class="bk-list" id="bk-list"><p class="muted-note">Looking for backups…</p></div>
<div class="row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn secondary" data-st="export">${I.download}Download backup</button><button type="button" class="btn secondary" data-st="import">${I.upload}Restore from a file</button><input type="file" id="st-file" accept="application/json,.json" hidden>${!store.state.meta.seeded || !store.state.tasks.some((t) => !t.purged && E.STARTER.some((s) => s.title === t.title)) ? `<button type="button" class="btn secondary" data-st="seed">Add my Daywell routines</button>` : ''}<button type="button" class="btn secondary" data-st="wipe" style="color:var(--danger)">${I.trash}Delete all tasks</button></div></section>
<section class="st-sec"><h3>Appearance</h3><div class="st-row"><label>Theme</label><div class="seg" role="group">${['auto', 'light', 'dark'].map((v) => `<button type="button" data-st="theme" data-v="${v}" aria-pressed="${dv.theme === v}">${v === 'auto' ? 'Match system' : v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div></div></section>
${coarse() ? '' : `<section class="st-sec"><h3>Keyboard</h3><div class="kbd-list"><kbd>N</kbd><span>Add a task</span><kbd>Enter</kbd><span>Add what you typed</span><kbd>${MOD} Enter</kbd><span>Send it to Claude</span><kbd>${MOD} Z</kbd><span>Undo (${MOD} Shift Z to redo)</span><kbd>[ ]</kbd><span>Previous or next day</span><kbd>T C H</kbd><span>Today, Calendar, History</span><kbd>P</kbd><span>Plan my day</span><kbd>Esc</kbd><span>Close panels</span></div></section>`}
<p class="muted-note" style="margin-top:8px">Daywell runs entirely in your browser. <a href="https://github.com/beyondgalaxy-maker/daywell" target="_blank" rel="noopener">Source</a></p>
</div>`;
  if (keepToast) $('#settings').appendChild(keepToast);
  if (google.configured && ui.phrase == null && !ui.phraseLoading) {
    ui.phraseLoading = true;
    google
      .phraseInfo()
      .then((r) => {
        ui.phrase = { set: !!r.set, claude: !!r.claude };
        if ($('#settings').open && !document.activeElement?.closest?.('#st-phone')) renderSettings();
      })
      .catch(() => {})
      .finally(() => (ui.phraseLoading = false));
  }
  fillBackups();
}

async function onSettings(act, el) {
  const dv = store.device;
  if (act === 'close') return $('#settings').close();
  if (act === 'install') {
    const pr = ui.installPrompt;
    ui.installPrompt = null;
    if (pr) {
      await pr.prompt();
      await pr.userChoice.catch(() => null);
    }
    return renderSettings();
  }
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
    try {
      await copyText(await scriptText());
      toast('Script copied. Paste it into a new Apps Script project.');
    } catch (e) {
      toast(e.message);
    }
    return;
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
    store.setDevice({ gsUrl: url, gsSecret: newSecret() });
    try {
      await google.claim();
      await google.loadCalendars().catch(() => {});
      store.setDevice({ gsUrlDraft: '' });
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
  if (act === 'sign-in') {
    store.setDevice({ localOnly: false });
    $('#settings').close();
    return render();
  }
  if (act === 'save-phrase') {
    const v = ($('#st-phrase')?.value || '').trim();
    const out = $('#st-phrase-status');
    if (v.length < 4) {
      out.className = 'st-status err';
      out.textContent = 'Use at least 4 characters.';
      return;
    }
    out.className = 'st-status';
    out.textContent = 'Saving…';
    try {
      const claude = $('#st-phrase-claude')?.checked ? store.device.apiKey : '';
      const r = await google.setPhrase(v, claude);
      ui.phrase = { set: true, claude: !!r.claude };
      renderSettings();
      toast('Sign-in key saved');
    } catch (e) {
      out.className = 'st-status err';
      out.textContent = e.message;
    }
    return;
  }
  if (act === 'sign-out') {
    const ok = await confirmBox({ title: 'Sign out of this device?', body: 'This device forgets your tasks, calendar and keys. Everything stays safe in your Google script; type your key to come back.', ok: 'Sign out', cancel: 'Stay signed in', danger: true });
    if (!ok) return;
    // Send anything not synced yet first; if that fails, keep this device's backups.
    let synced = !google.configured || !dv.sync;
    if (!synced) {
      for (let i = 0; i < 40 && google.syncing; i++) await new Promise((r) => setTimeout(r, 250));
      await google.sync();
      synced = google.status === 'ok';
      if (!synced) {
        const go = await confirmBox({ title: 'Couldn’t sync your latest changes', body: `${google.error || 'Your Google script didn’t answer.'} If you sign out now, changes made on this device since the last sync stay only in this device’s backups.`, ok: 'Sign out anyway', cancel: 'Stay signed in', danger: true });
        if (!go) return;
      }
    }
    store.setDevice({ gsUrl: '', gsSecret: '', apiKey: '', syncRev: null, lastSync: 0, localOnly: false });
    ui.quietReplace = synced;
    store.replaceState({ ...store.state, tasks: [], log: [], meta: { order: {}, plans: {}, dismiss: {}, timer: null, seeded: true } }, 'change');
    ui.quietReplace = false;
    if (synced) Backup.clear().catch(() => {});
    google.clear();
    store.undoStack.length = 0;
    store.redoStack.length = 0;
    ui.phrase = null;
    const k = $('#st-key');
    if (k) k.value = '';
    $('#settings').close();
    return render();
  }
  if (act === 'disconnect') {
    const ok = await confirmBox({ title: 'Disconnect Google?', body: 'Calendar and sync stop on this device until you reconnect, which takes a few steps. Your tasks stay here and in your Google script.', ok: 'Disconnect', cancel: 'Keep connected', danger: true });
    if (!ok) return;
    store.setDevice({ gsUrl: '', gsSecret: '', syncRev: null, lastSync: 0 });
    google.clear();
    renderSettings();
    return render();
  }
  if (act === 'export') return exportBackup();
  if (act === 'import') return $('#st-file').click();
  if (act === 'bk-restore') return restoreBackup(el.dataset.src, el.dataset.id);
  if (act === 'bk-more') {
    ui.bkAll = !ui.bkAll;
    return fillBackups();
  }
  if (act === 'bday-add') {
    const nameEl = $('#bd-name');
    const dateEl = $('#bd-date');
    const name = (nameEl?.value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const date = dateEl?.value || '';
    if (!name) return nameEl?.focus();
    if (!E.isKey(date)) return dateEl?.focus();
    store.transact(`Added ${name}’s birthday`, (s) => {
      const k = E.bdayKey(name);
      (s.meta.bdays ||= {})[k] = { name, md: date.slice(5), at: Math.max(Date.now(), (s.meta.bdays[k]?.at || 0) + 1) };
    });
    ensureBirthdays();
    undoToast(`Added ${name}’s birthday`, lastStep());
    return renderSettings();
  }
  if (act === 'bday-del') {
    const k = el.dataset.k;
    const b = store.state.meta.bdays?.[k];
    if (!b) return;
    store.transact(`Removed ${b.name}’s birthday`, (s) => {
      s.meta.bdays[k] = { ...s.meta.bdays[k], gone: true, at: Math.max(Date.now(), (s.meta.bdays[k]?.at || 0) + 1) };
    });
    undoToast(`Removed ${b.name}’s birthday`, lastStep());
    return renderSettings();
  }
  if (act === 'seed') {
    seed(E.STARTER.map((_, i) => i));
    $('#settings').close();
    return;
  }
  if (act === 'wipe') {
    const ok = await confirmBox({ title: 'Delete all tasks?', body: 'This removes every task and its history on all your synced devices. A backup is kept, so you can bring them back from Settings → Backups.', ok: 'Delete everything', danger: true });
    if (!ok) return;
    await Backup.save(store.state, 'before-delete-all', { force: true, keep: true });
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
  if (el.id === 'st-name') return store.setShared({ name: el.value.trim().slice(0, 40) });
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

/* ---------- backups ---------- */

const BACKUP_WHY = {
  open: 'opened Daywell',
  auto: 'automatic',
  'before-sync': 'before a sync removed things',
  'before-change': 'before this device’s tasks were replaced',
  'before-restore': 'before a restore',
  'before-delete-all': 'before deleting everything',
};
function fmtWhen(at) {
  const d = new Date(at);
  return `${E.fmtRelDay(E.keyFromDate(d), E.keyFromDate(new Date()))}, ${E.fmtClock(d)}`;
}

// Before anything replaces your data with something that has less in it (a sync bringing in
// deletions from another device, a "use synced tasks" choice), keep a copy of what was here.
// A sync that removes several things at once says so, with a way to bring them back.
function watchForLoss() {
  const replace = store.replaceState.bind(store);
  store.replaceState = (next, reason = 'sync') => {
    const prev = store.state;
    if (!ui.quietReplace) {
      const lost = E.lostBetween(prev, next);
      if (lost.tasks.length || lost.log.length) {
        const saved = Backup.save(prev, `before-${reason}`, { force: true });
        if (reason === 'sync' && (lost.tasks.length >= 3 || lost.log.length >= 3)) {
          saved.then((snap) => {
            if (!snap) return;
            const n = lost.tasks.length;
            const msg = n ? `Sync removed ${n} task${n === 1 ? '' : 's'} deleted on another device` : `Sync removed ${lost.log.length} check-offs`;
            toast(msg, { label: 'Bring back', run: () => restoreBackup('device', snap.id, { ask: false }) });
          });
        }
      }
    }
    return replace(next, reason);
  };
}

function autoBackup(reason = 'auto') {
  ui.lastBackupAt = Date.now();
  return Backup.save(store.state, reason);
}

async function fillBackups() {
  if (!$('#bk-list')) return;
  let local = null;
  try {
    local = await Backup.list();
  } catch {
    local = null;
  }
  let remote = ui.bkRemote?.list;
  if (google.configured && (!ui.bkRemote || Date.now() - ui.bkRemote.at > 60000)) {
    try {
      remote = await google.backups();
    } catch {
      remote = undefined;
    }
    ui.bkRemote = { at: Date.now(), list: remote };
  }
  const box = $('#bk-list');
  if (!box) return;
  const row = (r) => `<li><span class="bk-when">${esc(fmtWhen(r.at))}</span><span class="bk-what">${esc(r.what)}</span><button type="button" class="chip-btn" data-st="bk-restore" data-src="${r.src}" data-id="${esc(r.id)}">Restore</button></li>`;
  const dev = (local || []).map((b) => ({ src: 'device', id: b.id, at: b.at, what: `${b.counts?.tasks ?? '?'} tasks${b.reason && b.reason !== 'auto' && b.reason !== 'open' ? ` · ${BACKUP_WHY[b.reason] || b.reason}` : ''}` }));
  const goo = (google.configured && remote ? remote : []).map((b) => ({ src: 'google', id: b.id, at: b.at, what: '' }));
  const cap = (list, n) => (ui.bkAll ? list : list.slice(0, n));
  let html = '';
  if (local !== null) html += `<h4>On this device</h4>${dev.length ? `<ul>${cap(dev, 4).map(row).join('')}</ul>` : '<p class="muted-note">The first one is made in a moment.</p>'}`;
  else html += '<p class="muted-note">This browser won’t keep backups on the device (private browsing?). Use Download backup now and then.</p>';
  if (google.configured) {
    if (remote === null) html += '<p class="muted-note">Your Google script is an older version without backups; update it to keep copies there too.</p>';
    else if (remote) html += `<h4>In your Google account</h4>${goo.length ? `<ul>${cap(goo, 3).map(row).join('')}</ul>` : '<p class="muted-note">The first copy is kept on the next sync that changes something.</p>'}`;
  }
  if (dev.length > 4 || goo.length > 3) html += `<button type="button" class="link-btn" data-st="bk-more">${ui.bkAll ? 'Show fewer' : `Show all ${dev.length + goo.length}`}</button>`;
  box.innerHTML = html;
}

async function restoreBackup(src, id, { ask = true } = {}) {
  let snap = null;
  let when = '';
  try {
    if (src === 'google') {
      snap = await google.backupData(id);
      when = fmtWhen(Number(id));
    } else {
      const b = await Backup.get(id);
      if (b) {
        snap = repairState(b.state);
        when = fmtWhen(b.at);
      }
    }
  } catch (e) {
    return toast(`Couldn’t open that backup: ${e.message}`);
  }
  if (!snap) return toast('That backup is no longer kept.');
  return bringBack(snap, when, { ask });
}

// Restores add back what's missing, never remove: newer edits stay, deleted things come back.
async function bringBack(snap, when, { ask = true } = {}) {
  const preview = E.recoverFrom(store.state, snap);
  if (!preview.tasks && !preview.log) return toast('Everything in that backup is already here.');
  const what = [preview.tasks && `${preview.tasks} task${preview.tasks === 1 ? '' : 's'}`, preview.log && `${preview.log} check-off${preview.log === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
  if (ask) {
    const ok = await confirmBox({ title: `Bring back ${what}?`, body: `From the backup of ${when}: everything in it that isn’t here now, including things deleted since. Nothing you have now is removed or changed.`, ok: 'Bring back' });
    if (!ok) return;
  }
  await Backup.save(store.state, 'before-restore', { force: true });
  const { state: next } = E.recoverFrom(store.state, snap);
  store.transact(`Brought back ${what}`, (s) => {
    s.tasks = next.tasks;
    s.log = next.log;
    s.meta.bdays = next.meta.bdays || {};
  });
  undoToast(`Brought back ${what}`, lastStep());
  if ($('#settings').open) renderSettings();
}

/* ---------- birthdays in Settings ---------- */

function bdaySection() {
  const today = store.today;
  const md = (m) => new Date(2024, Number(m.slice(0, 2)) - 1, Number(m.slice(3))).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const added = Object.entries(store.state.meta.bdays || {})
    .filter(([, b]) => b && !b.gone && b.name && b.md)
    .map(([k, b]) => ({ k, name: b.name, md: b.md, next: E.nextOccurrence(b.md, today) }))
    .sort((a, b) => String(a.next).localeCompare(String(b.next)));
  const seen = new Set();
  const soon = [...(google.configured ? calendarBirthdays(google.windowEvents(31), today) : []), ...added.filter((a) => a.next && E.diffDays(today, a.next) <= 31).map((a) => ({ who: a.name, D: a.next }))]
    .filter((b) => {
      const k = `${E.bdayKey(b.who)}|${b.D}`;
      return seen.has(k) ? false : seen.add(k);
    })
    .sort((a, b) => a.D.localeCompare(b.D))
    .slice(0, 8);
  return `<section class="st-sec" id="st-bdays"><h3>Birthdays</h3><p>The day before a birthday, “Wish them a happy birthday” shows up in Today. Daywell finds birthdays on your calendar however they’re written (“Sam’s birthday”, “Sam Florek bday”, “🎂 Sam”). Add any that aren’t there, or tell Claude “Sam’s birthday is March 3”.</p>
${soon.length ? `<p class="bd-soon">Coming up: ${soon.map((b) => `${esc(b.who)} <span>${esc(E.fmtRelDay(b.D, today))}</span>`).join(', ')}</p>` : ''}${added.length ? `<ul class="bd-list">${added.map((a) => `<li><span>${esc(a.name)}</span><span class="bd-date">${esc(md(a.md))}</span><button type="button" class="icon-btn" data-st="bday-del" data-k="${esc(a.k)}" aria-label="Remove ${esc(a.name)}’s birthday">${I.x}</button></li>`).join('')}</ul>` : ''}
<div class="st-row"><label for="bd-name">Add one</label><div class="row bd-add"><input id="bd-name" class="inp" placeholder="Name" autocomplete="off" maxlength="60"><input id="bd-date" class="inp" type="date" aria-label="Birthday"><button type="button" class="btn secondary" data-st="bday-add">Add</button></div></div></section>`;
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
    await bringBack(repairState(data), json.exportedAt ? fmtWhen(Date.parse(json.exportedAt)) : 'that file');
  } catch (e) {
    if (e?.message !== 'bad' && !(e instanceof SyntaxError)) return toast(`Couldn’t restore: ${e.message}`);
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

const SCRIPT_PREFIX = 'https://script.google.com/macros/s/';

async function handleSetupLink() {
  const m = location.hash.match(/^#setup=([\w-]+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  await applySetup(m[1]);
}

async function applySetup(code) {
  let p;
  try {
    p = JSON.parse(b64urlDecode(code));
  } catch {
    return toast("That setup link didn't work. Make a new one in Settings on your computer.");
  }
  if (p.d && !p.u) p.u = `${SCRIPT_PREFIX}${p.d}/exec`;
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
  ui.pasteBox = false;
  toast(patch.gsUrl ? 'Linked. Your tasks are on their way.' : 'This device is set up');
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
const touch = { s: null };

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const li = e.target.closest('li.task');
  if (!li) return;
  const list = li.closest('[data-list]');
  if (!list) return;
  if (e.pointerType !== 'mouse') return touchDown(e, li, list);
  if (list.dataset.list === 'none') return;
  const onGrip = !!e.target.closest('.grip');
  if (!onGrip && e.target.closest('button, input, textarea, select, a')) return;
  drag.s = { li, id: li.dataset.id, src: list, x0: e.clientX, y0: e.clientY, started: false, pid: e.pointerId };
  if (onGrip) e.preventDefault();
}

/* ---------- touch: swipe right to finish, left to move; press and hold to reorder ---------- */

function touchDown(e, li, list) {
  if (touch.s || drag.s) return;
  if (e.target.closest('input, textarea, select, .start-btn')) return;
  const kind = list.dataset.list;
  const movable = kind === 'day' || kind === 'all';
  const g = { li, list, id: li.dataset.id, x0: e.clientX, y0: e.clientY, pid: e.pointerId, mode: null, canSwipe: movable && li.dataset.status === 'open', canDrag: movable };
  if (!g.canSwipe && !g.canDrag) return;
  touch.s = g;
  if (g.canDrag) g.timer = setTimeout(() => holdToDrag(g), e.target.closest('.grip') ? 0 : 420);
}

function holdToDrag(g) {
  if (touch.s !== g || g.mode) return;
  g.mode = 'drag';
  buzz(12);
  drag.s = { li: g.li, id: g.id, src: g.list, x0: g.x0, y0: g.y0, started: false, pid: g.pid, touch: true };
  beginDrag(drag.s, g.x0, g.y0);
}

function swipeActions(g) {
  const today = store.today;
  const D = g.list.dataset.day || '';
  const t = store.task(g.id);
  // A daily routine is on every day, so "later" means skipping this one.
  if (g.list.dataset.list === 'day' && D >= today && t?.repeat?.kind === 'daily') return { skip: D, label: D === today ? 'Skip today' : 'Skip', icon: I.skip };
  if (g.list.dataset.list === 'day' && D === today && t && !t.repeat && !t.deadline) return { day: null, label: 'Not today', icon: I.x };
  if (g.list.dataset.list === 'day' && D >= today) {
    const next = E.addDays(D, 1);
    return { day: next, label: next === E.addDays(today, 1) ? 'Tomorrow' : E.fmtRelDay(next, today), icon: I.calendar };
  }
  return { day: today, label: 'Today', icon: I.sun };
}

function swipeStart(g) {
  const li = g.li;
  g.move = swipeActions(g);
  const under = document.createElement('div');
  under.className = 'swipe-under';
  under.setAttribute('aria-hidden', 'true');
  under.innerHTML = `<span class="su-done">${I.tick}<b>Done</b></span><span class="su-move"><b>${esc(g.move.label)}</b>${g.move.icon}</span>`;
  under.style.cssText = `top:${li.offsetTop}px;left:${li.offsetLeft}px;width:${li.offsetWidth}px;height:${li.offsetHeight}px`;
  li.parentElement.insertBefore(under, li);
  li.classList.add('swiping');
  g.under = under;
  g.w = li.offsetWidth;
  g.armed = false;
  closeMenu();
}

function swipeMove(g, dx) {
  const x = Math.max(-g.w * 0.92, Math.min(g.w * 0.92, dx));
  g.x = x;
  g.li.style.transform = `translateX(${x}px)`;
  g.under.dataset.dir = x >= 0 ? 'done' : 'move';
  const armed = Math.abs(x) > Math.min(110, g.w * 0.3);
  if (armed !== g.armed) {
    g.armed = armed;
    g.under.classList.toggle('armed', armed);
    if (armed) buzz(8);
  }
}

function swipeEnd(g) {
  ui.suppressClick = true;
  setTimeout(() => (ui.suppressClick = false), 400);
  if (!g.armed) return swipeBack(g);
  const dir = g.x > 0 ? 1 : -1;
  g.li.style.transition = 'transform 0.16s ease-in';
  g.li.style.transform = `translateX(${dir * (g.w + 24)}px)`;
  setTimeout(() => swipeDo(g, dir), 150);
}

function swipeBack(g) {
  g.li.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.8, 0.3, 1)';
  g.li.style.transform = '';
  setTimeout(() => {
    g.li.classList.remove('swiping');
    g.li.style.transition = '';
    g.under?.remove();
  }, 230);
}

function swipeDo(g, dir) {
  const t = store.task(g.id);
  const today = store.today;
  if (!t) {
    g.under?.remove();
    return render();
  }
  if (dir > 0) {
    const day = g.li.dataset.day || today;
    store.complete(t.id, day);
    buzz(14);
    undoToast(doneMessage(t, day), lastStep());
  } else if (g.move.skip) {
    store.skip(t.id, g.move.skip);
    undoToast(`Skipped “${t.title}”${g.move.skip === today ? ' today' : ''}`, lastStep());
  } else {
    store.moveTo(t.id, g.move.day);
    undoToast(g.move.day ? `Moved to ${relWord(g.move.day, today)}` : 'Moved to Everything else', lastStep());
  }
}

/* ---------- dragging (mouse anywhere on a row, or touch after a long press) ---------- */

function beginDrag(d, x, y) {
  const r = d.li.getBoundingClientRect();
  d.dx = x - r.left;
  d.dy = y - r.top;
  d.ghost = d.li.cloneNode(true);
  d.ghost.classList.add('drag-ghost');
  if (d.touch) d.ghost.classList.add('lifted');
  d.ghost.style.width = `${r.width}px`;
  d.ghost.style.left = `${x - d.dx}px`;
  d.ghost.style.top = `${y - d.dy}px`;
  document.body.appendChild(d.ghost);
  d.li.classList.add('drag-placeholder');
  d.startIndex = [...d.src.children].indexOf(d.li);
  d.scroller = d.li.closest('.col, .view-calendar, .view-history');
  d.lx = x;
  d.ly = y;
  d.started = true;
  closeMenu();
  d.raf = requestAnimationFrame(() => dragLoop(d));
}

function dragAt(d, x, y) {
  d.ghost.style.left = `${x - d.dx}px`;
  d.ghost.style.top = `${y - d.dy}px`;
  const el = document.elementFromPoint(x, y);
  const list = el?.closest('[data-list="day"], [data-list="all"]') || null;
  for (const n of $$('.drop-target')) if (n !== list) n.classList.remove('drop-target');
  if (!list) return;
  list.classList.add('drop-target');
  const rows = [...list.querySelectorAll(':scope > li.task')].filter((r) => r !== d.li);
  let before = null;
  for (const r of rows) {
    const b = r.getBoundingClientRect();
    if (y < b.top + b.height / 2) {
      before = r;
      break;
    }
  }
  if (before) {
    if (d.li.nextSibling !== before) list.insertBefore(d.li, before);
  } else if (list.lastElementChild !== d.li) list.appendChild(d.li);
  d.over = list;
}

// Scroll the list while a dragged row is held near the top or bottom edge.
function dragLoop(d) {
  if (drag.s !== d || !d.started) return;
  const col = d.scroller;
  if (col) {
    const b = col.getBoundingClientRect();
    const top = b.top + 70;
    const bottom = b.bottom - (isMobile() ? 230 : 140);
    const v = d.ly < top ? -Math.min(16, (top - d.ly) / 5 + 3) : d.ly > bottom ? Math.min(16, (d.ly - bottom) / 5 + 3) : 0;
    if (v) {
      const was = col.scrollTop;
      col.scrollTop += v;
      if (col.scrollTop !== was) dragAt(d, d.lx, d.ly);
    }
  }
  d.raf = requestAnimationFrame(() => dragLoop(d));
}

function onPointerMove(e) {
  const g = touch.s;
  if (g && e.pointerId === g.pid && g.mode !== 'drag') {
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.mode) {
      if (g.canSwipe && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        g.mode = 'swipe';
        clearTimeout(g.timer);
        swipeStart(g);
      } else if (Math.hypot(dx, dy) > 9) {
        g.mode = 'scroll';
        clearTimeout(g.timer);
      }
    }
    if (g.mode === 'swipe') {
      e.preventDefault();
      swipeMove(g, dx);
    }
    return;
  }
  const d = drag.s;
  if (!d || e.pointerId !== d.pid) return;
  if (!d.started) {
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
    beginDrag(d, e.clientX, e.clientY);
  }
  e.preventDefault();
  d.lx = e.clientX;
  d.ly = e.clientY;
  dragAt(d, e.clientX, e.clientY);
}

function endDrag(d) {
  cancelAnimationFrame(d.raf);
  d.ghost?.remove();
  d.li.classList.remove('drag-placeholder');
  for (const n of $$('.drop-target')) n.classList.remove('drop-target');
}

function onPointerCancel(e) {
  const g = touch.s;
  if (g && e.pointerId === g.pid) {
    touch.s = null;
    clearTimeout(g.timer);
    if (g.mode === 'swipe') swipeBack(g);
  }
  const d = drag.s;
  if (d && e.pointerId === d.pid) {
    drag.s = null;
    if (d.started) {
      endDrag(d);
      render();
    }
  }
}

function onPointerUp(e) {
  const g = touch.s;
  if (g && e.pointerId === g.pid) {
    touch.s = null;
    clearTimeout(g.timer);
    if (g.mode === 'swipe') return swipeEnd(g);
    if (g.mode !== 'drag') return;
  }
  const d = drag.s;
  if (!d || e.pointerId !== d.pid) return;
  drag.s = null;
  if (!d.started) return;
  e.preventDefault();
  endDrag(d);
  ui.suppressClick = true;
  setTimeout(() => (ui.suppressClick = false), d.touch ? 400 : 80);
  const list = d.li.closest('[data-list]');
  const t = store.task(d.id);
  if (!list || !t || list.dataset.list === 'none') return render();
  if (list === d.src && [...list.children].indexOf(d.li) === d.startIndex) return render();
  const today = store.today;
  if (list.dataset.list === 'day') {
    const D = list.dataset.day;
    const scope = list.closest('#dayCol, .view-calendar') || list.parentElement;
    const lists = [...scope.querySelectorAll(`[data-list="day"][data-day="${D}"]`)];
    const ids = lists.flatMap((l) => [...l.querySelectorAll(':scope > li.task')].map((li) => li.dataset.id).concat((l.dataset.rest || '').split(',').filter(Boolean)));
    const fromDay = d.src.dataset.list === 'day' && d.src.dataset.day === D;
    if (!fromDay) ui.fresh.set(t.id, Date.now());
    if ((store.settings.sortBy || 'plan') !== 'plan') {
      store.setShared({ sortBy: 'plan' });
      toast('Switched to Suggested, with your order');
    }
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
  const so = e.target.closest('[data-sort]');
  if (so && so.closest('#menu')) return onSortMenu(so.dataset.sort, so);
  if (e.target.closest('#menu.sort-menu')) return;
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
    case 'undo':
      return undoLast();
    case 'check':
      return li && toggleCheck(li);
    case 'open':
      return id && openDrawer(id);
    case 'menu':
      if (menuAnchor === a) return;
      return id && openMenu(a, id, li?.dataset.day);
    case 'gate-skip':
      store.setDevice({ localOnly: true });
      return render();
    case 'sort':
      if (ui.menuFor?.sort) return closeMenu();
      return openSortMenu(a);
    case 'today-view':
      store.setDevice({ todayView: a.dataset.v });
      return render();
    case 'todos-all':
      ui.todosAll = !ui.todosAll;
      return render();
    case 'agenda':
      ui.agendaAll = !ui.agendaAll;
      return render();
    case 'brief-more':
      a.closest('.brief')?.classList.toggle('open');
      return;
    case 'tip-ok':
      store.setDevice({ tipGestures: true });
      return render();
    case 'start':
      if (!id) return;
      store.startTimer(id);
      return toast(pick(['Timer started. You’ve got this.', 'Go time. One thing at a time.', 'Started. Focus mode.'], `${id}${Date.now() >> 16}`));
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
    case 'mode':
      ui.modeOverride = a.dataset.v;
      renderParseChips();
      if (!coarse()) $('#input').focus();
      return;
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
    case 'timer-part': {
      const t = store.partTimer();
      return t && undoToast(`Partly done${t.spent ? `: ${E.fmtMins(t.spent)} so far` : ''}`, lastStep());
    }
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
    case 'remove-entry': {
      store.removeEntry(a.dataset.e);
      return undoToast('Removed it from your history', lastStep());
    }
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
  if (act === 'save-sort' && a.result?.sorted) {
    const id = a.result.sorted.id;
    store.setShared({ sorts: (store.settings.sorts || []).map((x) => (x.id === id ? { ...x, temp: false } : x)) });
    renderAIPanel();
    return toast(`Saved “${sortName(id)}”. Pick it any day from Sort.`);
  }
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
  if (act === 'split') {
    const m = a.result?.same?.[Number(el.dataset.si)];
    if (!m || m.split || !store.task(m.id)) return;
    const today = store.today;
    const p = E.parseQuick(m.said || store.task(m.id).title, today, { weekStart: store.settings.weekStart ?? 1 });
    const orig = store.task(m.id);
    store.transact(`Added “${E.cleanTitle(p.title)}” as its own task`, (s) => {
      const t = s.tasks.find((x) => x.id === m.id);
      if (t?.again) {
        t.again = t.again.n > 1 ? { ...t.again, n: t.again.n - 1 } : null;
        t.updatedAt = Date.now();
      }
      s.tasks.push(E.normalizeTask({ title: p.title || orig.title, date: p.date, deadline: p.deadline, time: p.time, estMin: p.estMin, estMax: p.estMax, priority: p.priority || 3, repeat: p.repeat, area: orig.area, optional: p.optional, src: 'ai', createdAt: Date.now(), updatedAt: Date.now() }, today));
    });
    m.split = true;
    undoToast('Added as its own task', lastStep());
    return renderAIPanel();
  }
  if (act === 'details') {
    a.showDetails = !a.showDetails;
    return renderAIPanel();
  }
  if (act === 'undo') {
    const undid = revertStep(a.step);
    ui.ai = null;
    renderAIPanel();
    return toast('Undid Claude’s changes. Your message is back in the box.', undid ? { label: 'Redo', run: () => revertStep(undid) } : null);
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
  if (act === 'part') {
    markPartly(t, null);
    return renderDrawer();
  }
  if (act === 'unpart') {
    store.unpartDone(t.id, today);
    undoToast('Took back “partly done”', lastStep());
    return renderDrawer();
  }
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
    if (e.shiftKey) redoLast();
    else undoLast();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y' && !typing) {
    e.preventDefault();
    redoLast();
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
  document.addEventListener('pointercancel', onPointerCancel);
  // While a row is being dragged or swiped, the page must not scroll under the finger.
  document.addEventListener('touchmove', (e) => {
    if (drag.s?.started || touch.s?.mode === 'swipe') e.preventDefault();
  }, { passive: false });
  // A long press on a row means "pick it up", not "open the browser's menu".
  document.addEventListener('contextmenu', (e) => {
    if (coarse() && e.target.closest('li.task')) e.preventDefault();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#menu').hidden && !e.target.closest('#menu') && !e.target.closest('[data-act="menu"]')) closeMenu();
  });
  $('#scrim').addEventListener('click', () => {
    closeMenu();
    closeDrawer();
  });
  sheetDrag($('#drawer'), '.sheet-grip, .dr-head', closeDrawer);
  sheetDrag($('#menu'), '.sheet-grip', closeMenu);
  watchViewport();
  // A setup link opened while Daywell is already open only changes the #hash, so listen for it too.
  window.addEventListener('hashchange', handleSetupLink);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    ui.installPrompt = e;
  });
  window.addEventListener('resize', () => closeMenu());
  // Scrolling away closes the menu; a small nudge (or a scroll the app makes itself) doesn't.
  for (const c of $$('.col')) {
    c.addEventListener('scroll', () => {
      const m = ui.menuFor;
      if (m && (m.col !== c || Math.abs(c.scrollTop - m.top) > 48)) closeMenu();
    }, { passive: true });
  }

  const input = $('#input');
  input.addEventListener('input', () => {
    autoGrow();
    renderParseChips();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && store.device.apiKey) askClaude();
      else send();
    }
  });
  // Tapping + keeps the keyboard up, so you can add several tasks in a row.
  $('#addBtn').addEventListener('mousedown', (e) => e.preventDefault());
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
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
    maybeAutoPlan();
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
    if (document.visibilityState === 'hidden') {
      store.flush();
      if (Date.now() - (ui.lastBackupAt || 0) > 60000) autoBackup();
    } else {
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
  $('#addBtn').innerHTML = I.plus;
  for (const s of $$('[data-ico]')) s.innerHTML = I[s.dataset.ico] || '';
  $('#allCol').innerHTML = `<header class="all-head"><h2>Everything else</h2><div class="search">${I.search}<input id="search" type="search" placeholder="Search" aria-label="Search tasks" autocomplete="off"></div></header><div class="area-chips" id="areaChips"></div><div id="allList"></div>`;
  $('#input').placeholder = isMobile() ? 'Add a task or a list…' : 'Add a task, or type a whole list for Claude…';
}

function boot() {
  applyTheme();
  staticChrome();
  bindEvents();
  store.onStep = (kind, step) => (kind === 'undo' ? stepUndone(step) : stepRedone(step));
  watchForLoss();
  Backup.persist();
  autoBackup('open');
  const moveTo = store.moveTo.bind(store);
  store.moveTo = (id, day, ...rest) => {
    if (day) ui.fresh.set(id, Date.now());
    return moveTo(id, day, ...rest);
  };
  store.subscribe((reason) => {
    if (reason === 'device') {
      renderTop();
      return;
    }
    if (reason === 'events') ensureBirthdays();
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
      ensureBirthdays();
      ui.planError = null;
      if (ui.day === ui.lastToday) ui.day = null;
    }
    if (!drag.s && !document.hidden) render();
    maybeAutoPlan();
    if (Date.now() - (ui.lastBackupAt || 0) > 5 * 60000) autoBackup();
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
  }, 60000);
  if (google.configured) {
    const first = Promise.allSettled([google.sync(), google.refreshEvents(true)]);
    Promise.race([first, new Promise((r) => setTimeout(r, 6000))]).then(() => maybeAutoPlan());
  } else setTimeout(maybeAutoPlan, 400);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
