/**
 * BEP Comms — Cloudflare Worker
 *
 * Worker Environment Variables (set in Cloudflare dashboard):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   DASHBOARD_EMAIL
 *   DASHBOARD_PASSWORD
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER
 *   SENDGRID_API_KEY
 *   SENDGRID_FROM_EMAIL
 *   SENDGRID_FROM_NAME
 */

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') return new Response('', { headers: cors });

    try {
      return await route(request, env, cors);
    } catch (e) {
      return json({ error: e.message }, 500, cors);
    }
  }
};

// ============================================================
// HELPERS
// ============================================================

function json(data, status, cors) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: cors });
}

function sb(env, table, params) {
  const key = env.SUPABASE_SERVICE_KEY;
  const url = `${env.SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  return fetch(url, {
    headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' },
  });
}

function sbPost(env, table, body, prefer) {
  const key = env.SUPABASE_SERVICE_KEY;
  return fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key, Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=minimal',
    },
    body: JSON.stringify(body),
  });
}

function sbPatch(env, table, filter, body) {
  const key = env.SUPABASE_SERVICE_KEY;
  return fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: key, Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
}

async function sbOne(env, table, params) {
  const res = await sb(env, table, params);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function getSettings(env) {
  const res = await sb(env, 'settings', 'select=key,value');
  const rows = await res.json();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function checkAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.replace('Bearer ', '').trim();
  if (!token) return false;
  try {
    const decoded = atob(token);
    return decoded.includes(':') && decoded.includes('@');
  } catch { return false; }
}

// ============================================================
// TWILIO
// ============================================================

async function sendSMS(env, to, body) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const auth = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM_NUMBER;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${sid}:${auth}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Twilio error: ' + (data.message || res.status));
  return data.sid;
}

// ============================================================
// SENDGRID
// ============================================================

async function sendEmail(env, to, subject, body) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.SENDGRID_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: env.SENDGRID_FROM_EMAIL, name: env.SENDGRID_FROM_NAME },
      subject,
      content: [{ type: 'text/plain', value: body }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('SendGrid error: ' + err.slice(0, 200));
  }
  return true;
}

// ============================================================
// CONVERSATION HELPERS
// ============================================================

async function ensureConversation(env, patientId, patientName, patientEmail, patientPhone) {
  // Find existing conversation
  const existing = await sbOne(env, 'conversations', `patient_id=eq.${patientId}&select=id`);
  if (existing) return existing.id;

  // Create new
  const res = await sbPost(env, 'conversations', {
    patient_id: patientId,
    patient_name: patientName,
    patient_email: patientEmail || null,
    patient_phone: patientPhone || null,
  }, 'return=representation');
  const rows = await res.json();
  return rows[0].id;
}

async function recordMessage(env, conversationId, patientId, direction, channel, body, subject, fromAddr, toAddr, providerId, status) {
  await sbPost(env, 'messages', {
    conversation_id: conversationId,
    patient_id: patientId,
    direction,
    channel,
    body,
    subject: subject || null,
    from_address: fromAddr || null,
    to_address: toAddr || null,
    provider_id: providerId || null,
    status: status || 'sent',
    read: direction === 'outbound',
  });

  // Update conversation last message
  await sbPatch(env, 'conversations', `patient_id=eq.${patientId}`, {
    last_message_at: new Date().toISOString(),
    last_message_preview: body.slice(0, 100),
    unread: direction === 'inbound',
    updated_at: new Date().toISOString(),
  });
}

// ============================================================
// ROUTER
// ============================================================

async function route(request, env, cors) {
  const url = new URL(request.url);
  const path = url.pathname;
  const action = url.searchParams.get('action') || '';

  // ── AUTH ──────────────────────────────────────────────────
  if (path === '/auth/login') {
    const body = await request.json().catch(() => ({}));
    const email = env.DASHBOARD_EMAIL || 'admin@beachsideep.com.au';
    const pass  = env.DASHBOARD_PASSWORD || 'changeme';
    if (body.email === email && body.password === pass) {
      const token = btoa(email + ':' + Date.now());
      return json({ token }, 200, cors);
    }
    return json({ error: 'Invalid credentials' }, 401, cors);
  }

  // ── TWILIO INBOUND WEBHOOK ─────────────────────────────────
  // Twilio posts form data to /webhooks/sms
  if (path === '/webhooks/sms' && request.method === 'POST') {
    const form = await request.formData();
    const from = form.get('From') || '';
    const body = form.get('Body') || '';
    const sid  = form.get('MessageSid') || '';

    // Find patient by phone number
    const patient = await sbOne(env, 'conversations',
      `patient_phone=eq.${encodeURIComponent(from)}&select=patient_id,patient_name,patient_email,patient_phone,id`);

    let convId;
    let patientId;

    if (patient) {
      convId = patient.id;
      patientId = patient.patient_id;
      await sbPatch(env, 'conversations', `id=eq.${convId}`, {
        last_message_at: new Date().toISOString(),
        last_message_preview: body.slice(0, 100),
        unread: true,
        updated_at: new Date().toISOString(),
      });
    } else {
      // Unknown number — create a placeholder conversation
      patientId = 0;
      const res = await sbPost(env, 'conversations', {
        patient_id: 0,
        patient_name: from,
        patient_phone: from,
      }, 'return=representation');
      const rows = await res.json();
      convId = rows[0].id;
    }

    await sbPost(env, 'messages', {
      conversation_id: convId,
      patient_id: patientId,
      direction: 'inbound',
      channel: 'sms',
      body,
      from_address: from,
      provider_id: sid,
      status: 'received',
      read: false,
    });

    // Twilio expects TwiML response
    return new Response('<Response></Response>', {
      headers: { 'Content-Type': 'text/xml' },
    });
  }

  // ── SENDGRID INBOUND WEBHOOK ───────────────────────────────
  // SendGrid Inbound Parse posts to /webhooks/email
  if (path === '/webhooks/email' && request.method === 'POST') {
    const form = await request.formData();
    const from    = form.get('from') || '';
    const subject = form.get('subject') || '';
    const text    = form.get('text') || form.get('html') || '';

    // Extract email address from "Name <email>" format
    const emailMatch = from.match(/<(.+)>/) || [null, from];
    const fromEmail = emailMatch[1].trim().toLowerCase();

    const patient = await sbOne(env, 'conversations',
      `patient_email=eq.${encodeURIComponent(fromEmail)}&select=patient_id,patient_name,patient_email,patient_phone,id`);

    let convId;
    let patientId;

    if (patient) {
      convId = patient.id;
      patientId = patient.patient_id;
      await sbPatch(env, 'conversations', `id=eq.${convId}`, {
        last_message_at: new Date().toISOString(),
        last_message_preview: text.slice(0, 100),
        unread: true,
        updated_at: new Date().toISOString(),
      });
    } else {
      patientId = 0;
      const res = await sbPost(env, 'conversations', {
        patient_id: 0,
        patient_name: from,
        patient_email: fromEmail,
      }, 'return=representation');
      const rows = await res.json();
      convId = rows[0].id;
    }

    await sbPost(env, 'messages', {
      conversation_id: convId,
      patient_id: patientId,
      direction: 'inbound',
      channel: 'email',
      subject,
      body: text.slice(0, 5000),
      from_address: fromEmail,
      status: 'received',
      read: false,
    });

    return new Response('OK', { status: 200 });
  }

  // ── RATING SUBMISSION (public — no auth required) ─────────
  if (action === 'submit_rating' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { token, score, feedback } = body;
    if (!token || !score) return json({ error: 'Missing token or score' }, 400, cors);

    let patientId, triggerKey;
    try {
      const decoded = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
      [patientId, triggerKey] = decoded.split(':');
    } catch {
      return json({ error: 'Invalid token' }, 400, cors);
    }

    const settings = await getSettings(env);
    const routedToGoogle = Number(score) >= 9;

    await sbPost(env, 'ratings', {
      patient_id: Number(patientId),
      trigger_key: triggerKey,
      score: Number(score),
      feedback: feedback || null,
      routed_to_google: routedToGoogle,
    });

    return json({
      ok: true,
      routed_to_google: routedToGoogle,
      google_review_link: routedToGoogle ? settings.google_review_link : null,
    }, 200, cors);
  }

  // ── ALL OTHER ROUTES REQUIRE AUTH ──────────────────────────
  if (!checkAuth(request, env)) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }

  // ── QUEUE ─────────────────────────────────────────────────
  if (action === 'get_queue') {
    const res = await sb(env, 'message_queue',
      'select=id,patient_id,patient_name,patient_email,patient_phone,trigger_key,sms_body,email_subject,email_body,queued_at&status=eq.pending&order=queued_at.asc');
    if (!res.ok) throw new Error('Supabase error ' + res.status);
    const rows = await res.json();
    // Add trigger_label manually
    const labelMap = {
      review_1st: 'Review Request — 1st Appointment',
      review_5th: 'Review Request — 5th Appointment',
      review_20th: 'Review Request — 20th Appointment',
      reactivation_3m: 'Re-activation — 3 Months Inactive',
      reactivation_6m: 'Re-activation — 6 Months Inactive',
      reactivation_12m: 'Re-activation — 12 Months Inactive',
      birthday: 'Birthday Message',
    };
    const queue = rows.map(r => ({ ...r, trigger_label: labelMap[r.trigger_key] || r.trigger_key }));
    return json({ queue }, 200, cors);
  }

  if (action === 'approve') {
    const body = await request.json().catch(() => ({}));
    const { id } = body;
    if (!id) return json({ error: 'Missing id' }, 400, cors);

    // Get the queue item
    const item = await sbOne(env, 'message_queue', `id=eq.${id}&select=*`);
    if (!item) return json({ error: 'Queue item not found' }, 404, cors);

    const settings = await getSettings(env);
    const errors = [];
    let smsSid = null;

    // Send SMS
    if (item.patient_phone && settings.sms_enabled === 'true') {
      try {
        smsSid = await sendSMS(env, item.patient_phone, item.sms_body);
      } catch (e) {
        errors.push('SMS: ' + e.message);
      }
    }

    // Send Email
    if (item.patient_email && settings.email_enabled === 'true') {
      try {
        await sendEmail(env, item.patient_email, item.email_subject, item.email_body);
      } catch (e) {
        errors.push('Email: ' + e.message);
      }
    }

    const status = errors.length === 0 ? 'sent' : 'failed';

    // Update queue item
    await sbPatch(env, 'message_queue', `id=eq.${id}`, {
      status,
      sent_at: new Date().toISOString(),
      reviewed_at: new Date().toISOString(),
      notes: errors.length ? errors.join('; ') : null,
    });

    // Log it
    await sbPost(env, 'message_log', {
      queue_id: id,
      patient_id: item.patient_id,
      trigger_key: item.trigger_key,
      channel: 'sms+email',
      status,
      provider_id: smsSid,
      error_message: errors.length ? errors.join('; ') : null,
    });

    // Update suppression last_sent_at
    await sbPatch(env, 'patient_suppressions',
      `patient_id=eq.${item.patient_id}&trigger_key=eq.${item.trigger_key}`,
      { last_sent_at: new Date().toISOString() }
    );

    // Create/update conversation record
    const convId = await ensureConversation(env,
      item.patient_id, item.patient_name, item.patient_email, item.patient_phone);

    // Record outbound SMS
    if (item.patient_phone && settings.sms_enabled === 'true') {
      await recordMessage(env, convId, item.patient_id, 'outbound', 'sms',
        item.sms_body, null, env.TWILIO_FROM_NUMBER, item.patient_phone, smsSid, status);
    }

    // Record outbound email
    if (item.patient_email && settings.email_enabled === 'true') {
      await recordMessage(env, convId, item.patient_id, 'outbound', 'email',
        item.email_body, item.email_subject, env.SENDGRID_FROM_EMAIL, item.patient_email, null, status);
    }

    return json({ ok: true, status, errors }, 200, cors);
  }

  if (action === 'skip') {
    const body = await request.json().catch(() => ({}));
    const { id, notes } = body;
    await sbPatch(env, 'message_queue', `id=eq.${id}`, {
      status: 'skipped',
      reviewed_at: new Date().toISOString(),
      notes: notes || null,
    });
    return json({ ok: true }, 200, cors);
  }

  // ── TEMPLATES ─────────────────────────────────────────────
  if (action === 'get_templates') {
    const res = await sb(env, 'message_templates', 'select=*&order=trigger_key');
    if (!res.ok) throw new Error('Supabase error ' + res.status);
    return json({ templates: await res.json() }, 200, cors);
  }

  if (action === 'update_template') {
    const body = await request.json().catch(() => ({}));
    const { id, sms_body, email_subject, email_body, is_active } = body;
    await sbPatch(env, 'message_templates', `id=eq.${id}`, {
      sms_body, email_subject, email_body, is_active,
      updated_at: new Date().toISOString(),
    });
    return json({ ok: true }, 200, cors);
  }

  // ── SEND HISTORY ──────────────────────────────────────────
  if (action === 'get_log') {
    const res = await sb(env, 'message_queue', 'select=patient_name,patient_id,trigger_key,sent_at,status,notes&status=in.(sent,failed,skipped)&order=sent_at.desc&limit=200');
    if (!res.ok) throw new Error('Supabase error ' + res.status);
    const labelMap = {
      review_1st: 'Review Request — 1st Appointment',
      review_5th: 'Review Request — 5th Appointment',
      review_20th: 'Review Request — 20th Appointment',
      reactivation_3m: 'Re-activation — 3 Months Inactive',
      reactivation_6m: 'Re-activation — 6 Months Inactive',
      reactivation_12m: 'Re-activation — 12 Months Inactive',
      birthday: 'Birthday Message',
    };
    const logRows = await res.json();
    return json({ log: logRows.map(r => ({ ...r, trigger_label: labelMap[r.trigger_key] || r.trigger_key })) }, 200, cors);
  }

  // ── RATINGS ───────────────────────────────────────────────
  if (action === 'get_ratings') {
    const res = await sb(env, 'ratings_with_names', 'select=*&order=submitted_at.desc&limit=200');
    if (!res.ok) throw new Error('Supabase error ' + res.status);
    return json({ ratings: await res.json() }, 200, cors);
  }

  // ── INBOX ─────────────────────────────────────────────────
  if (action === 'get_inbox') {
    const res = await sb(env, 'conversations', 'select=*&order=last_message_at.desc.nullslast');
    if (!res.ok) throw new Error('Supabase error ' + res.status);
    return json({ conversations: await res.json() }, 200, cors);
  }

  if (action === 'get_messages') {
    const convId = url.searchParams.get('conversation_id');
    if (!convId) return json({ error: 'Missing conversation_id' }, 400, cors);
    const res = await sb(env, 'messages',
      `conversation_id=eq.${convId}&select=*&order=created_at.asc`);
    if (!res.ok) throw new Error('Supabase error ' + res.status);

    // Mark all inbound messages in this conversation as read
    await sbPatch(env, 'messages',
      `conversation_id=eq.${convId}&direction=eq.inbound&read=eq.false`,
      { read: true }
    );
    await sbPatch(env, 'conversations', `id=eq.${convId}`, { unread: false });

    return json({ messages: await res.json() }, 200, cors);
  }

  if (action === 'send_message') {
    const body = await request.json().catch(() => ({}));
    const { conversation_id, channel, message, subject } = body;
    if (!conversation_id || !channel || !message) {
      return json({ error: 'Missing conversation_id, channel, or message' }, 400, cors);
    }

    const conv = await sbOne(env, 'conversations', `id=eq.${conversation_id}&select=*`);
    if (!conv) return json({ error: 'Conversation not found' }, 404, cors);

    let providerId = null;
    let status = 'sent';
    let error = null;

    if (channel === 'sms') {
      if (!conv.patient_phone) return json({ error: 'No phone number for this patient' }, 400, cors);
      try {
        providerId = await sendSMS(env, conv.patient_phone, message);
      } catch (e) {
        status = 'failed';
        error = e.message;
      }
    } else if (channel === 'email') {
      if (!conv.patient_email) return json({ error: 'No email address for this patient' }, 400, cors);
      try {
        await sendEmail(env, conv.patient_email, subject || 'Message from Beachside EP', message);
      } catch (e) {
        status = 'failed';
        error = e.message;
      }
    }

    await recordMessage(env, conversation_id, conv.patient_id,
      'outbound', channel, message, subject || null,
      channel === 'sms' ? env.TWILIO_FROM_NUMBER : env.SENDGRID_FROM_EMAIL,
      channel === 'sms' ? conv.patient_phone : conv.patient_email,
      providerId, status
    );

    if (error) return json({ ok: false, error }, 500, cors);
    return json({ ok: true }, 200, cors);
  }

  if (action === 'mark_read') {
    const body = await request.json().catch(() => ({}));
    const { conversation_id } = body;
    await sbPatch(env, 'messages',
      `conversation_id=eq.${conversation_id}&direction=eq.inbound`,
      { read: true }
    );
    await sbPatch(env, 'conversations', `id=eq.${conversation_id}`, { unread: false });
    return json({ ok: true }, 200, cors);
  }

  // ── SETTINGS ──────────────────────────────────────────────
  if (action === 'get_settings') {
    const settings = await getSettings(env);
    // Don't expose password
    delete settings.dashboard_password;
    return json({ settings }, 200, cors);
  }

  if (action === 'update_setting') {
    const body = await request.json().catch(() => ({}));
    const { key, value } = body;
    if (!key || value === undefined) return json({ error: 'Missing key or value' }, 400, cors);
    await sbPatch(env, 'settings', `key=eq.${key}`, {
      value, updated_at: new Date().toISOString(),
    });
    return json({ ok: true }, 200, cors);
  }

  return json({ error: 'Unknown action' }, 400, cors);
}
