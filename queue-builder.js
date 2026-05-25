// ============================================================
// Beachside EP Comms — Queue Builder
// Runs daily at 7am AEST via GitHub Actions
// node queue-builder.js
// ============================================================

require('dotenv').config();
const https = require('https');

const CLINIKO_BASE = 'https://api.au2.cliniko.com/v1';
const CLINIKO_KEY  = process.env.CLINIKO_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!CLINIKO_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing required env vars: CLINIKO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0,300))); return; }
        try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('JSON parse: ' + body.slice(0,200))); }
      });
    }).on('error', reject);
  });
}

function httpRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request(new URL(url), {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, headers),
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode + ' ' + method + ': ' + data.slice(0,300))); return; }
        try { resolve(data ? JSON.parse(data) : {}); } catch(e) { resolve({}); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const clinikoHeaders = {
  'Authorization': 'Basic ' + Buffer.from(CLINIKO_KEY + ':').toString('base64'),
  'Accept': 'application/json',
  'User-Agent': 'BeachsideEP-Comms/1.0 (admin@beachsideep.com.au)',
};

const supabaseHeaders = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY };

async function sbGet(table, params) {
  return httpGet(`${SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`, supabaseHeaders);
}

async function sbPost(table, body) {
  return httpRequest('POST', `${SUPABASE_URL}/rest/v1/${table}`,
    Object.assign({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }, supabaseHeaders), body);
}

async function sbPatch(table, filter, body) {
  return httpRequest('PATCH', `${SUPABASE_URL}/rest/v1/${table}?${filter}`,
    Object.assign({ 'Prefer': 'return=minimal' }, supabaseHeaders), body);
}

async function getPatientContact(patientId) {
  // Read contact details from Supabase (synced from Cliniko by sync.js)
  // Avoids JS number precision issues with large Cliniko IDs
  try {
    const rows = await sbGet('patients', `id=eq.${patientId}&select=email,phone`);
    if (rows && rows[0]) return { email: rows[0].email || null, phone: rows[0].phone || null };
    return { email: null, phone: null };
  } catch(e) {
    console.warn(`  ! Could not fetch contact for patient ${patientId}:`, e.message);
    return { email: null, phone: null };
  }
}

async function getSettings() {
  const rows = await sbGet('settings', 'select=key,value');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function getTemplate(triggerKey) {
  const rows = await sbGet('message_templates', `trigger_key=eq.${triggerKey}&is_active=eq.true&select=*`);
  return rows[0] || null;
}

function renderTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `{{${k}}}`);
}

async function isAlreadyQueued(patientId, triggerKey) {
  const rows = await sbGet('message_queue',
    `patient_id=eq.${patientId}&trigger_key=eq.${triggerKey}&status=in.(pending,approved,sent)&select=id&limit=1`);
  return rows.length > 0;
}

async function hasFutureBooking(patientId) {
  const now = new Date().toISOString();
  const rows = await sbGet('appointments',
    `patient_id=eq.${patientId}&is_cancelled=eq.false&starts_at=gt.${now}&select=id&limit=1`);
  return rows.length > 0;
}

async function addToQueue(patient, triggerKey, settings, template) {
  const isReview = triggerKey.startsWith('review_');
  const token = Buffer.from(`${patient.id}:${triggerKey}:${Date.now()}`).toString('base64url');
  const vars = {
    first_name:   patient.first_name,
    rating_link:  isReview ? `${settings.rating_page_base_url}?t=${token}` : '',
    booking_link: settings.booking_link,
    booking_link_html: `<a href="${settings.booking_link}">Book here</a>`,
  };
  await sbPost('message_queue', {
    patient_id:    patient.id,
    patient_name:  `${patient.first_name} ${patient.last_name}`,
    patient_email: patient.email,
    patient_phone: patient.phone,
    trigger_key:   triggerKey,
    sms_body:      renderTemplate(template.sms_body, vars),
    email_subject: renderTemplate(template.email_subject, vars),
    email_body:    renderTemplate(template.email_body, vars),
    status:        'pending',
  });
  await httpRequest('POST', `${SUPABASE_URL}/rest/v1/patient_suppressions`,
    Object.assign({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }, supabaseHeaders),
    { patient_id: patient.id, trigger_key: triggerKey, last_queued_at: new Date().toISOString() });
}

async function processCandidate(patient, triggerKey, settings, template, stats, label) {
  if (await hasFutureBooking(patient.id)) {
    console.log(`    ${patient.first_name} ${patient.last_name} — skipped (future booking)`);
    stats.skipped++; return;
  }
  if (await isAlreadyQueued(patient.id, triggerKey)) {
    console.log(`    ${patient.first_name} ${patient.last_name} — skipped (already queued)`);
    stats.skipped++; return;
  }
  const contact = await getPatientContact(patient.id);
  await sleep(300);
  patient.email = contact.email;
  patient.phone = contact.phone;
  await addToQueue(patient, triggerKey, settings, template);
  console.log(`    ✓ ${patient.first_name} ${patient.last_name} [${label}]`);
  stats.queued++;
}

async function checkReviewTriggers(settings, stats) {
  console.log('\n── Review Triggers ──');
  const milestones = [
    { count: 1,  triggerKey: 'review_1st'  },
    { count: 5,  triggerKey: 'review_5th'  },
    { count: 20, triggerKey: 'review_20th' },
  ];
  const now = new Date();
  const windowStart = new Date(now - 48 * 60 * 60 * 1000).toISOString();
  const windowEnd   = new Date(now - 20 * 60 * 60 * 1000).toISOString();

  const allCompleted = await sbGet('appointments',
    'is_completed=eq.true&is_cancelled=eq.false&is_dna=eq.false&select=patient_id,starts_at');

  const countMap = {};
  const latestMap = {};
  for (const row of allCompleted) {
    countMap[row.patient_id] = (countMap[row.patient_id] || 0) + 1;
    if (!latestMap[row.patient_id] || row.starts_at > latestMap[row.patient_id])
      latestMap[row.patient_id] = row.starts_at;
  }

  for (const { count, triggerKey } of milestones) {
    console.log(`\n  Checking ${triggerKey}...`);
    const template = await getTemplate(triggerKey);
    if (!template) { console.log('  Inactive — skipping'); continue; }

    const eligibleIds = Object.entries(countMap)
      .filter(([id, c]) => c === count && latestMap[id] >= windowStart && latestMap[id] <= windowEnd)
      .map(([id]) => Number(id));

    console.log(`  ${eligibleIds.length} candidate(s)`);
    if (!eligibleIds.length) continue;

    const patients = await sbGet('patients', `id=in.(${eligibleIds.join(',')})&select=id,first_name,last_name`);
    for (const p of patients) await processCandidate(p, triggerKey, settings, template, stats, `${count} appts`);
  }
}

async function checkReactivationTriggers(settings, stats) {
  console.log('\n── Re-activation Triggers ──');
  const segments = [
    { triggerKey: 'reactivation_3m',  minDays: 90,  maxDays: 180   },
    { triggerKey: 'reactivation_6m',  minDays: 180, maxDays: 365   },
    { triggerKey: 'reactivation_12m', minDays: 365, maxDays: 99999 },
  ];
  const now = new Date();

  const allCompleted = await sbGet('appointments', 'is_completed=eq.true&is_cancelled=eq.false&select=patient_id,starts_at');
  const globalLatest = {};
  for (const row of allCompleted) {
    if (!globalLatest[row.patient_id] || row.starts_at > globalLatest[row.patient_id])
      globalLatest[row.patient_id] = row.starts_at;
  }

  for (const { triggerKey, minDays, maxDays } of segments) {
    console.log(`\n  Checking ${triggerKey}...`);
    const template = await getTemplate(triggerKey);
    if (!template) { console.log('  Inactive — skipping'); continue; }

    const cutoffMin = new Date(now - maxDays * 864e5).toISOString();
    const cutoffMax = new Date(now - minDays * 864e5).toISOString();

    const eligibleIds = Object.entries(globalLatest)
      .filter(([, latest]) => latest >= cutoffMin && latest <= cutoffMax)
      .map(([id]) => Number(id));

    console.log(`  ${eligibleIds.length} candidate(s)`);
    if (!eligibleIds.length) continue;

    const patients = await sbGet('patients', `id=in.(${eligibleIds.join(',')})&select=id,first_name,last_name`);
    for (const p of patients) await processCandidate(p, triggerKey, settings, template, stats, `${minDays}d inactive`);
  }
}

async function checkBirthdayTrigger(settings, stats) {
  console.log('\n── Birthday Trigger ──');
  const template = await getTemplate('birthday');
  if (!template) { console.log('  Inactive — skipping'); return; }

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }));
  const todayMonth = now.getMonth() + 1;
  const todayDay   = now.getDate();

  const all = await sbGet('patients', 'select=id,first_name,last_name,dob&dob=not.is.null');
  const birthdays = all.filter(p => {
    if (!p.dob) return false;
    const [, m, d] = p.dob.split('-').map(Number);
    return m === todayMonth && d === todayDay;
  });

  console.log(`  ${birthdays.length} birthday(s) today`);
  for (const p of birthdays) await processCandidate(p, 'birthday', settings, template, stats, 'birthday');
}

async function checkDNATrigger(settings, stats) {
  console.log('\n── DNA Trigger ──');
  const template = await getTemplate('dna');
  if (!template) { console.log('  Inactive — skipping'); return; }

  const now = new Date();
  const windowStart = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // 48hrs ago
  const windowEnd   = new Date(now - 20 * 60 * 60 * 1000).toISOString(); // 20hrs ago

  // Find appointments marked as DNA in the 20-48hr window
  const appts = await sbGet('appointments',
    `is_dna=eq.true&starts_at=gte.${windowStart}&starts_at=lte.${windowEnd}&select=patient_id,starts_at`);

  if (!appts || appts.length === 0) { console.log('  No DNA appointments in window'); return; }

  const patientIds = [...new Set(appts.map(a => a.patient_id))];
  console.log(`  ${patientIds.length} candidate(s)`);

  const patients = await sbGet('patients', `id=in.(${patientIds.join(',')})&select=id,first_name,last_name,email,phone`);

  for (const patient of patients) {
    await processCandidate(patient, 'dna', settings, template, stats, 'DNA');
  }
}

async function checkCancelledNoRebookTrigger(settings, stats) {
  console.log('\n── Cancelled No Rebook Trigger ──');
  const template = await getTemplate('cancelled_no_rebook');
  if (!template) { console.log('  Inactive — skipping'); return; }

  const now = new Date();
  const windowStart = new Date(now - 48 * 60 * 60 * 1000).toISOString();
  const windowEnd   = new Date(now - 20 * 60 * 60 * 1000).toISOString();

  // Find appointments cancelled in the 20-48hr window
  const appts = await sbGet('appointments',
    `is_cancelled=eq.true&cancelled_at=gte.${windowStart}&cancelled_at=lte.${windowEnd}&select=patient_id,cancelled_at`);

  if (!appts || appts.length === 0) { console.log('  No cancellations in window'); return; }

  const patientIds = [...new Set(appts.map(a => a.patient_id))];
  console.log(`  ${patientIds.length} cancellation(s) — checking for rebooking...`);

  const patients = await sbGet('patients', `id=in.(${patientIds.join(',')})&select=id,first_name,last_name,email,phone`);

  for (const patient of patients) {
    // Check if they have booked a future appointment since cancelling
    const futureAppts = await sbGet('appointments',
      `patient_id=eq.${patient.id}&is_cancelled=eq.false&starts_at=gt.${now.toISOString()}&select=id&limit=1`);
    if (futureAppts && futureAppts.length > 0) {
      console.log(`    ${patient.first_name} ${patient.last_name} — skipped (has future booking)`);
      stats.skipped++;
      continue;
    }
    await processCandidate(patient, 'cancelled_no_rebook', settings, template, stats, 'cancelled no rebook');
  }
}

async function main() {
  console.log('============================================================');
  console.log('BEP Comms — Queue Builder — ' + new Date().toISOString());
  console.log('============================================================');
  const settings = await getSettings();
  const stats = { queued: 0, skipped: 0, errors: 0 };
  try { await checkReviewTriggers(settings, stats); } catch(e) { console.error('Review error:', e.message); stats.errors++; }
  try { await checkReactivationTriggers(settings, stats); } catch(e) { console.error('Reactivation error:', e.message); stats.errors++; }
  try { await checkBirthdayTrigger(settings, stats); } catch(e) { console.error('Birthday error:', e.message); stats.errors++; }
  try { await checkDNATrigger(settings, stats); } catch(e) { console.error('DNA error:', e.message); stats.errors++; }
  try { await checkCancelledNoRebookTrigger(settings, stats); } catch(e) { console.error('Cancelled no rebook error:', e.message); stats.errors++; }
  console.log('\n============================================================');
  console.log(`Done — Queued: ${stats.queued} | Skipped: ${stats.skipped} | Errors: ${stats.errors}`);
  console.log('============================================================');
  if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
