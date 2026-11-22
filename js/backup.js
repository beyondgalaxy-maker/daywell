// Automatic backups on this device: snapshots of your whole Daywell in IndexedDB, a separate
// store from the one the app runs on, so a bad sync, a bug or a cleared key can't take both out.
// One is taken when the app opens, every few minutes while you use it (only if something changed),
// and always right before anything (a sync, a restore, an import) removes tasks or check-offs.
// Kept: everything from the last two days (up to 30), one a day for 60 days, and the ones taken
// before something was removed for 30 days.

const DB_NAME = 'daywell-backups';
const STORE = 'snaps';
const DAY = 86400000;

let dbPromise = null;
function open() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('This browser has no storage for backups.'));
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Backups are busy in another tab.'));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Backup was interrupted.'));
  });
}

// A short, stable fingerprint of a snapshot's text, to skip saving the same thing twice.
function hash(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 + c, 2246822519);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${str.length.toString(36)}`;
}

export function countsOf(state) {
  const tasks = (state?.tasks || []).filter((t) => !t.deletedAt && !t.purged).length;
  const log = (state?.log || []).filter((e) => !e.deleted);
  return { tasks, done: log.filter((e) => !e.skip).length };
}

// Newest first, without the data itself.
export async function list() {
  const all = await run('readonly', (s) => s.getAll());
  return (all || []).map(({ data, ...meta }) => meta).sort((a, b) => b.at - a.at);
}

export async function get(id) {
  const snap = await run('readonly', (s) => s.get(id));
  if (!snap) return null;
  return { ...snap, state: JSON.parse(snap.data) };
}

// The text is taken right away, so callers can pass the live state and keep changing it.
export async function save(state, reason = 'auto', { force = false, keep = false } = {}) {
  const data = JSON.stringify(state);
  const fp = hash(data);
  const at = Date.now();
  try {
    const existing = await list();
    if (!force && existing[0]?.fp === fp) return null;
    const snap = { id: `${at}-${Math.random().toString(36).slice(2, 6)}`, at, reason, keep: keep || reason.startsWith('before'), fp, counts: countsOf(state), size: data.length, data };
    await run('readwrite', (s) => s.put(snap));
    await thin([snap, ...existing]);
    return { ...snap, data: undefined };
  } catch (e) {
    console.warn('[daywell] backup failed', e);
    return null;
  }
}

async function thin(snaps, now = Date.now()) {
  const keepIds = new Set();
  const sorted = [...snaps].sort((a, b) => b.at - a.at);
  let recent = 0;
  const days = new Set();
  for (const s of sorted) {
    const age = now - s.at;
    if (age < 2 * DAY && recent < 30) {
      keepIds.add(s.id);
      recent++;
      continue;
    }
    if (s.keep && age < 30 * DAY) {
      keepIds.add(s.id);
      continue;
    }
    const day = new Date(s.at).toDateString();
    if (age < 60 * DAY && !days.has(day)) {
      days.add(day);
      keepIds.add(s.id);
    }
  }
  const drop = sorted.filter((s) => !keepIds.has(s.id));
  if (drop.length) await run('readwrite', (s) => drop.forEach((x) => s.delete(x.id)));
}

export async function clear() {
  await run('readwrite', (s) => s.clear());
}

// Ask the browser not to clear Daywell's storage when space runs low (best effort).
export async function persist() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) || false;
  } catch {
    return false;
  }
}
