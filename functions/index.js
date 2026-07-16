/**
 * AFS Fleet — scheduled email automation (1st-gen Cloud Functions).
 *
 * Functions:
 *   weeklyReminder    — Fri 8:00 AM  : email every driver who hasn't submitted this week
 *   escalation        — Fri :00/:15/:30/:45, 1:00–3:30 PM : re-nudge the still-missing; 3:30 admin alert
 *   oilAlerts         — daily 7:00 AM : email drivers of due/overdue oil changes; admins for overdue
 *   inspectionAlerts  — 1st @ 7 AM (due) + 26th @ 7 AM (overdue sweep) : email managers/admins
 *   runJob            — admin-only HTTP trigger to run any job on demand (verification)
 *
 * Sending goes through sendEmail() (SendGrid). Every send is de-duped and logged in
 * fleet_notifications by (toEmail, category, refKey). Firestore access is via firebase-admin.
 *
 * Secrets (Secret Manager):  SENDGRID_KEY, FROM_EMAIL
 * Config:  DASHBOARD_URL env or functions config; TZ = America/New_York
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const sgMail = require('@sendgrid/mail');

admin.initializeApp();
const db = admin.firestore();
const TS = () => admin.firestore.FieldValue.serverTimestamp();

const REGION = 'us-central1';
const TZ = 'America/New_York';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://carter7171.github.io/fleet-dashboard/index.html';
const runtime = { secrets: ['SENDGRID_KEY', 'FROM_EMAIL'], timeoutSeconds: 120, memory: '256MB' };

/* ---------------- date/key helpers (mirror the client) ---------------- */
function partsInTz(d) {
  // returns {y,m,day,dow,hour,min} in TZ
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const o = {};
  fmt.formatToParts(d).forEach(p => { o[p.type] = p.value; });
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +o.year, m: +o.month, day: +o.day, dow: dowMap[o.weekday], hour: +o.hour, min: +o.minute };
}
function isoFromParts(p) { return p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.day).padStart(2, '0'); }
function fridayISO(now) {
  // date of Friday in the Monday-based week containing `now` (TZ-aware, date-only math)
  const p = partsInTz(now);
  const base = new Date(Date.UTC(p.y, p.m - 1, p.day));
  const dow = p.dow; // 0..6
  const diffToMon = (dow === 0 ? -6 : 1 - dow);
  base.setUTCDate(base.getUTCDate() + diffToMon + 4); // Monday + 4 = Friday
  return base.getUTCFullYear() + '-' + String(base.getUTCMonth() + 1).padStart(2, '0') + '-' + String(base.getUTCDate()).padStart(2, '0');
}
function weekKey(now) { return 'friday-' + fridayISO(now || new Date()); }
function monthKey(now) { const p = partsInTz(now || new Date()); return p.y + '-' + String(p.m).padStart(2, '0'); }

/* ---------------- email + logging ---------------- */
async function sendEmail(toEmail, subject, body) {
  sgMail.setApiKey(process.env.SENDGRID_KEY);
  const from = process.env.FROM_EMAIL;
  await sgMail.send({ to: toEmail, from, subject, text: body, html: '<p>' + body.replace(/\n/g, '<br>') + '</p>' });
}
async function alreadySent(toEmail, category, refKey) {
  const snap = await db.collection('fleet_notifications')
    .where('toEmail', '==', toEmail).where('category', '==', category).where('refKey', '==', refKey).limit(1).get();
  return !snap.empty;
}
async function notify(toEmail, category, refKey, subject, body) {
  if (await alreadySent(toEmail, category, refKey)) return false;
  let status = 'sent', error = null, providerId = null;
  try { await sendEmail(toEmail, subject, body); }
  catch (e) { status = 'failed'; error = String(e.message || e); }
  await db.collection('fleet_notifications').add({ toEmail, category, refKey, subject, status, error, providerId, createdAt: TS() });
  return status === 'sent';
}

/* ---------------- data loaders ---------------- */
async function getActiveDrivers() {
  const snap = await db.collection('fleet_employees').where('active', '==', true).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function getVehicles() {
  const snap = await db.collection('fleet_vehicles').where('active', '==', true).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function getAdmins() {
  const snap = await db.collection('fleet_employees').where('role', '==', 'admin').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
function oilStatus(v) {
  const next = (+v.lastOilChangeMileage || 0) + (+v.oilChangeInterval || 0);
  const remaining = next - (+v.currentMileage || 0);
  const soon = +v.oilDueSoonMiles || 500;
  return { next, remaining, state: remaining <= 0 ? 'overdue' : (remaining <= soon ? 'soon' : 'ok') };
}

/* ============================================================
   JOB: weekly reminder
   ============================================================ */
async function jobWeeklyReminder(now) {
  now = now || new Date();
  const wk = weekKey(now);
  const vehicles = await getVehicles();
  const byDriver = {};
  vehicles.forEach(v => { if (v.assignedDriverEmail) byDriver[v.assignedDriverEmail] = v; });
  const drivers = (await getActiveDrivers()).filter(d => byDriver[d.email]);

  let sent = 0;
  for (const d of drivers) {
    const veh = byDriver[d.email];
    const wsId = wk + '_' + d.email;
    const wsRef = db.collection('fleet_week_status').doc(wsId);
    const ws = await wsRef.get();
    if (!ws.exists) await wsRef.set({ weekKey: wk, driverEmail: d.email, vehicleNo: veh.vehicleNo, submitted: false, reminderSentAt: null, escalationCount: 0, createdAt: TS() });
    const data = ws.exists ? ws.data() : { submitted: false, reminderSentAt: null };
    if (data.submitted) continue;
    if (data.reminderSentAt) continue; // already reminded this week
    // First outreach (no oil baseline on file yet) asks for current mileage AND next oil change.
    const needsOilBaseline = !(veh.lastOilChangeMileage > 0);
    const ask = needsOilBaseline
      ? 'Please submit your CURRENT mileage and your NEXT OIL CHANGE mileage (from the windshield sticker) for this week\'s fleet update.'
      : 'Please submit your current vehicle mileage for this week\'s fleet update.';
    const ok = await notify(d.email, 'weekly_reminder', wk,
      'Weekly mileage — ' + veh.vehicleNo,
      'Hi ' + (d.name || '') + ',\n\n' + ask + '\nVehicle: ' + veh.vehicleNo + (veh.description ? ' (' + veh.description + ')' : '') +
      '\n\nSubmit here: ' + DASHBOARD_URL + '\n\n— AFS Fleet');
    if (ok) { await wsRef.set({ reminderSentAt: TS() }, { merge: true }); sent++; }
  }
  return { job: 'weeklyReminder', weekKey: wk, drivers: drivers.length, sent };
}

/* ============================================================
   JOB: escalation (Fri 1:00–3:30 PM)
   ============================================================ */
async function jobEscalation(now) {
  now = now || new Date();
  const p = partsInTz(now);
  const minutes = p.hour * 60 + p.min;
  const START = 13 * 60, END = 15 * 60 + 30;
  // guard window (skip outside 1:00–3:30 PM); allow manual runJob to bypass with force flag handled by caller
  if (p.dow !== 5 || minutes < START || minutes > END) return { job: 'escalation', skipped: 'outside window', dow: p.dow, minutes };

  const wk = weekKey(now);
  const missSnap = await db.collection('fleet_week_status').where('weekKey', '==', wk).where('submitted', '==', false).get();
  const missing = missSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  let nudged = 0;
  for (const w of missing) {
    const body = 'Reminder: we still need your current mileage for ' + w.vehicleNo + ' this week.\nPlease submit now: ' + DASHBOARD_URL + '\n\n— AFS Fleet';
    // escalation nudges use a per-tick refKey so each 15-min ping logs, but we still avoid duplicates within the same minute
    const refKey = wk + '_esc_' + p.hour + '-' + String(p.min).padStart(2, '0');
    const ok = await notify(w.driverEmail, 'escalation', refKey, 'Mileage still needed — ' + w.vehicleNo, body);
    if (ok) { await db.collection('fleet_week_status').doc(w.id).set({ escalationCount: (w.escalationCount || 0) + 1, lastEscalationAt: TS() }, { merge: true }); nudged++; }
  }

  // Final admin alert at/after 3:30 PM — once per week
  let adminAlerted = 0;
  if (minutes >= END && missing.length) {
    const admins = await getAdmins();
    const stillMissing = missing.filter(w => !w.adminNotifiedAt);
    if (stillMissing.length) {
      const lines = [];
      for (const w of stillMissing) {
        const emp = (await db.collection('fleet_employees').doc(w.driverEmail).get()).data() || {};
        lines.push('• ' + (emp.name || w.driverEmail) + ' — ' + w.vehicleNo);
      }
      const body = 'The following drivers have NOT submitted mileage by 3:30 PM this week:\n\n' + lines.join('\n') + '\n\n— AFS Fleet';
      for (const a of admins) await notify(a.email, 'admin_missing', wk, 'Missing mileage submissions — week of ' + fridayISO(now), body);
      for (const w of stillMissing) await db.collection('fleet_week_status').doc(w.id).set({ adminNotifiedAt: TS() }, { merge: true });
      adminAlerted = stillMissing.length;
    }
  }
  return { job: 'escalation', weekKey: wk, missing: missing.length, nudged, adminAlerted };
}

/* ============================================================
   JOB: oil alerts (daily)
   ============================================================ */
async function jobOilAlerts() {
  const vehicles = await getVehicles();
  const admins = await getAdmins();
  let driverSent = 0, adminSent = 0;
  for (const v of vehicles) {
    const o = oilStatus(v);
    if (o.state === 'ok') continue;
    const refKey = v.vehicleNo + '_' + o.next; // one reminder per oil-change cycle
    if (v.assignedDriverEmail) {
      const emp = (await db.collection('fleet_employees').doc(v.assignedDriverEmail).get()).data() || {};
      const msg = o.state === 'overdue'
        ? 'Oil change for ' + v.vehicleNo + ' is OVERDUE by ' + Math.abs(o.remaining).toLocaleString() + ' miles. Please schedule service.'
        : 'Oil change for ' + v.vehicleNo + ' is due soon (' + o.remaining.toLocaleString() + ' miles remaining).';
      if (await notify(v.assignedDriverEmail, 'oil_due', refKey, 'Oil change ' + (o.state === 'overdue' ? 'overdue' : 'due soon') + ' — ' + v.vehicleNo, msg + '\n\n— AFS Fleet')) driverSent++;
    }
    if (o.state === 'overdue') {
      for (const a of admins) if (await notify(a.email, 'oil_due', refKey + '_admin', 'Vehicle oil change overdue — ' + v.vehicleNo,
        v.vehicleNo + ' oil change is overdue by ' + Math.abs(o.remaining).toLocaleString() + ' miles.\n\n— AFS Fleet')) adminSent++;
    }
  }
  return { job: 'oilAlerts', driverSent, adminSent };
}

/* ============================================================
   JOB: inspection alerts
   ============================================================ */
async function jobInspectionAlerts(overdueSweep) {
  const vehicles = await getVehicles();
  const admins = await getAdmins();
  const mk = monthKey();
  let mgrSent = 0, adminSent = 0;
  for (const v of vehicles) {
    const inspId = v.vehicleNo + '_' + mk;
    const done = (await db.collection('fleet_inspections').doc(inspId).get()).exists;
    if (done) continue;
    const driver = v.assignedDriverEmail ? ((await db.collection('fleet_employees').doc(v.assignedDriverEmail).get()).data() || {}) : {};
    const mgrEmail = driver.managerId ? (await mgrEmailById(driver.managerId)) : null;
    const category = overdueSweep ? 'inspection_overdue' : 'inspection_due';
    const refKey = v.vehicleNo + '_' + mk + (overdueSweep ? '_over' : '');
    const subject = (overdueSweep ? 'Inspection OVERDUE' : 'Monthly inspection due') + ' — ' + v.vehicleNo;
    const body = (overdueSweep ? 'The monthly inspection for ' + v.vehicleNo + ' is overdue.' : 'The monthly inspection for ' + v.vehicleNo + ' is due this month.') +
      '\nComplete it in the dashboard: ' + DASHBOARD_URL + '\n\n— AFS Fleet';
    if (mgrEmail) { if (await notify(mgrEmail, category, refKey, subject, body)) mgrSent++; }
    if (overdueSweep) for (const a of admins) if (await notify(a.email, category, refKey + '_admin', subject, body)) adminSent++;
  }
  return { job: overdueSweep ? 'inspectionOverdue' : 'inspectionDue', mgrSent, adminSent };
}
async function mgrEmailById(empId) {
  const snap = await db.collection('fleet_employees').where('empId', '==', empId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

/* ============================================================
   SCHEDULED TRIGGERS
   ============================================================ */
exports.weeklyReminder = functions.region(REGION).runWith(runtime)
  .pubsub.schedule('0 8 * * 5').timeZone(TZ).onRun(() => jobWeeklyReminder());

exports.escalation = functions.region(REGION).runWith(runtime)
  .pubsub.schedule('0,15,30,45 13-15 * * 5').timeZone(TZ).onRun(() => jobEscalation());

exports.oilAlerts = functions.region(REGION).runWith(runtime)
  .pubsub.schedule('0 7 * * *').timeZone(TZ).onRun(() => jobOilAlerts());

exports.inspectionDue = functions.region(REGION).runWith(runtime)
  .pubsub.schedule('0 7 1 * *').timeZone(TZ).onRun(() => jobInspectionAlerts(false));

exports.inspectionOverdue = functions.region(REGION).runWith(runtime)
  .pubsub.schedule('0 7 26 * *').timeZone(TZ).onRun(() => jobInspectionAlerts(true));

/* ============================================================
   DEBUG: admin-only HTTP trigger to run a job on demand
   GET runJob?name=weeklyReminder&key=<ADMIN_RUN_KEY>
   ============================================================ */
exports.runJob = functions.region(REGION).runWith({ ...runtime, secrets: [...runtime.secrets, 'ADMIN_RUN_KEY'] })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if ((req.query.key || '') !== process.env.ADMIN_RUN_KEY) { res.status(403).json({ error: 'forbidden' }); return; }
    const name = req.query.name;
    try {
      let out;
      if (name === 'weeklyReminder') out = await jobWeeklyReminder();
      else if (name === 'escalation') out = await jobEscalation(req.query.force ? forcedFriday() : undefined);
      else if (name === 'oilAlerts') out = await jobOilAlerts();
      else if (name === 'inspectionDue') out = await jobInspectionAlerts(false);
      else if (name === 'inspectionOverdue') out = await jobInspectionAlerts(true);
      else { res.status(400).json({ error: 'unknown job', jobs: ['weeklyReminder', 'escalation', 'oilAlerts', 'inspectionDue', 'inspectionOverdue'] }); return; }
      res.json({ ok: true, result: out });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
// For manual escalation testing outside the Friday window: pretend it's Friday 3:30pm ET.
function forcedFriday() {
  const now = new Date();
  // find next/this Friday, set to 15:30 local-ish (UTC approximation is fine for a manual test)
  const d = new Date(now); const day = d.getUTCDay(); d.setUTCDate(d.getUTCDate() + ((5 - day + 7) % 7)); d.setUTCHours(19, 30, 0, 0);
  return d;
}
