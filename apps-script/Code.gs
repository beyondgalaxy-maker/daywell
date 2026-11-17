// Daywell connector for Google Calendar and sync.
// Runs inside YOUR Google account and contains no keys. The first Daywell that presses
// Connect registers a private key here; after that, only that key works.
// To connect a different Daywell later, choose resetKey in the toolbar and press Run once.
//
// Setup: script.google.com → New project → paste this → Save →
// Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy.

const VERSION = 2;
const CHUNK = 8000;

function doGet(e) {
  return respond_(e && e.parameter ? e.parameter : {});
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {}
  return respond_(body);
}

function respond_(p) {
  var out;
  try {
    out = handle_(p);
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(p) {
  p = p || {};
  if (p.action === 'claim') return claim_(p.secret);
  var stored = PropertiesService.getScriptProperties().getProperty('dw_key');
  if (!stored) return { ok: false, error: 'This script is not connected yet. Press Connect in Daywell.' };
  if (p.secret !== stored) return { ok: false, error: 'This script belongs to a different Daywell key. In the script editor, run resetKey, then press Connect in Daywell again.' };
  switch (p.action) {
    case 'ping':
      return { ok: true, version: VERSION, timeZone: Session.getScriptTimeZone() };
    case 'calendars':
      return { ok: true, calendars: calendars_() };
    case 'events':
      return { ok: true, events: events_(p) };
    case 'load':
      return load_();
    case 'save':
      return save_(p.data, p.baseRev);
    case 'addEvent':
      return addEvent_(p);
    default:
      return { ok: false, error: 'Unknown action' };
  }
}

function calendars_() {
  return CalendarApp.getAllCalendars().map(function (c) {
    return { id: c.getId(), name: c.getName(), color: c.getColor(), primary: c.isMyPrimaryCalendar(), selected: c.isSelected() && !c.isHidden() };
  });
}

function events_(p) {
  var start = new Date(p.start);
  var end = new Date(p.end);
  var wanted = p.cals ? JSON.parse(p.cals) : [];
  var tz = Session.getScriptTimeZone();
  var out = [];
  CalendarApp.getAllCalendars().forEach(function (c) {
    var use = wanted.length ? wanted.indexOf(c.getId()) !== -1 : c.isSelected() && !c.isHidden();
    if (!use) return;
    c.getEvents(start, end).forEach(function (ev) {
      var status = '';
      try {
        status = String(ev.getMyStatus());
      } catch (e) {}
      if (status === 'NO') return;
      var free = false;
      try {
        free = String(ev.getTransparency()) === 'TRANSPARENT';
      } catch (e) {}
      var o = {
        id: ev.getId() + '@' + ev.getStartTime().getTime(),
        cal: c.getId(),
        calName: c.getName(),
        color: c.getColor(),
        title: ev.getTitle(),
        allDay: ev.isAllDayEvent(),
        location: ev.getLocation() || '',
        free: free,
      };
      if (o.allDay) {
        o.startDay = Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd');
        o.endDay = Utilities.formatDate(ev.getAllDayEndDate(), tz, 'yyyy-MM-dd');
      } else {
        o.start = ev.getStartTime().toISOString();
        o.end = ev.getEndTime().toISOString();
      }
      out.push(o);
    });
  });
  return out;
}

function load_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var n = Number(all.dw_n || 0);
  var rev = Number(all.dw_rev || 0);
  if (!n) return { ok: true, data: null, rev: rev };
  var b64 = '';
  for (var i = 0; i < n; i++) b64 += all['dw_' + i] || '';
  var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip');
  var json = Utilities.ungzip(blob).getDataAsString();
  return { ok: true, data: JSON.parse(json), rev: rev };
}

function save_(data, baseRev) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var props = PropertiesService.getScriptProperties();
    var rev = Number(props.getProperty('dw_rev') || 0);
    if (baseRev !== null && baseRev !== undefined && baseRev !== '' && Number(baseRev) !== rev) return { ok: false, conflict: true, rev: rev };
    var json = typeof data === 'string' ? data : JSON.stringify(data);
    var gz = Utilities.gzip(Utilities.newBlob(json, 'application/json'));
    var b64 = Utilities.base64Encode(gz.getBytes());
    if (b64.length > 440000) return { ok: false, error: 'Your Daywell data is too large to sync. Export a backup and clear old history.' };
    var oldN = Number(props.getProperty('dw_n') || 0);
    var n = Math.ceil(b64.length / CHUNK);
    var map = {};
    for (var i = 0; i < n; i++) map['dw_' + i] = b64.substr(i * CHUNK, CHUNK);
    map.dw_n = String(n);
    map.dw_rev = String(rev + 1);
    props.setProperties(map);
    for (var j = n; j < oldN; j++) props.deleteProperty('dw_' + j);
    return { ok: true, rev: rev + 1 };
  } finally {
    lock.releaseLock();
  }
}

function addEvent_(p) {
  var cal = CalendarApp.getDefaultCalendar();
  var ev = cal.createEvent(String(p.title || 'Daywell task'), new Date(p.start), new Date(p.end), { description: String(p.description || 'Added from Daywell') });
  return { ok: true, id: ev.getId() };
}

function claim_(secret) {
  secret = String(secret || '');
  if (secret.length < 20) return { ok: false, error: 'Missing key.' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var stored = props.getProperty('dw_key');
    if (stored && stored !== secret) return { ok: false, error: 'This script is already connected to another Daywell. In the script editor, run resetKey, then press Connect again.' };
    if (!stored) props.setProperty('dw_key', secret);
    return { ok: true, version: VERSION, timeZone: Session.getScriptTimeZone() };
  } finally {
    lock.releaseLock();
  }
}

// Run this once from the editor to let a new Daywell connect (your synced data is kept).
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty('dw_key');
}
