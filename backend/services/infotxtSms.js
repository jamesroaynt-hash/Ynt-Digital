const PROVIDER = 'infotxt';
const DEFAULT_BASE_URL = 'https://api.myinfotxt.com/v2';
// Only used if a rule somehow has no message of its own; every rule the UI
// creates carries one, so this is a safety net rather than a real default.
const DEFAULT_RIDER_TEMPLATE ='YNT Delivery: Hi {rider}, order {tracking} for {customer} is now {status}. COD: {cod}. Please check and update after delivery attempt.';
const SEND_TIMEOUT_MS = 15000;
// How long a sent/failed SMS stays in sms_logs before it is deleted. This is
// also the dedupe window: the log row is what stops a trigger from re-sending
// (see sendRiderSms), so orders older than this are skipped entirely rather
// than risk a second text once their row is gone.
const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.SMS_LOG_RETENTION_DAYS || 3));

function stringOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function boolToInt(value) {
  return value ? 1 : 0;
}

// `undefined` means the caller left the field out (keep what is stored); an
// empty string means the caller cleared it on purpose (store NULL so the
// env/default fallback takes over again).
function patchedValue(incoming, current) {
  if (incoming === undefined) return current ?? null;
  return stringOrNull(incoming);
}

// Riders arrive in whatever shape the courier stored them: the `】sprinter【`
// status string captures 9-13 bare digits, and Bigate's delivery_tel is free
// text. Accept the country code with or without + / 00, and a bare 9XXXXXXXXX
// that is missing the trunk zero, then hand InfoTXT the 09XXXXXXXXX it wants.
function normalizeMobile(value) {
  let text = String(value ?? '').replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (/^63\d{10}$/.test(text)) text = text.slice(2);
  if (/^9\d{9}$/.test(text)) text = `0${text}`;
  return /^09\d{9}$/.test(text) ? text : '';
}

function normalizeTag(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Pancake hands tags back in a dozen shapes (string, {name}, {tag_name}, …), so
// flatten whatever we were given into one lowercase haystack and match the
// configured tags as substrings — the same loose match the pickup_log uses.
function orderTagText(posOrder = {}) {
  if (posOrder.tag_text !== undefined) return normalizeTag(posOrder.tag_text);
  const raw = posOrder.tags || posOrder.customer_tags || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return normalizeTag(list
    .map((t) => (typeof t === 'string' ? t : (t?.name || t?.tag_name || t?.label || '')))
    .join(' '));
}

function truncate(value, max = 240) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function formatPeso(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return n.toLocaleString('en-PH', { maximumFractionDigits: 2 });
}

function renderTemplate(template, row = {}) {
  const values = {
    rider: row.sprinter_name || 'Rider',
    rider_phone: row.sprinter_tel || '',
    status: row.status_name || '',
    tag: row.matched_tag || '',
    tracking: row.tracking_no || row.external_id || '',
    order_id: row.external_id || '',
    shop: row.page_name || row.shop_id || '',
    customer: row.customer_name || '',
    customer_phone: row.customer_phone || '',
    product: row.note_product || '',
    cod: formatPeso(row.cod),
  };
  return String(template || DEFAULT_RIDER_TEMPLATE).replace(/\{([a-z_]+)\}/gi, (_, key) => values[key] ?? '');
}

function publicSettingFromRow(row) {
  if (!row) {
    return {
      provider: PROVIDER,
      configured: Boolean(process.env.INFOTXT_USER_ID && process.env.INFOTXT_API_KEY),
      enabled: process.env.INFOTXT_ENABLED === 'true',
      base_url: process.env.INFOTXT_BASE_URL || DEFAULT_BASE_URL,
      user_id: process.env.INFOTXT_USER_ID || '',
      has_api_key: Boolean(process.env.INFOTXT_API_KEY),
      default_sim: process.env.INFOTXT_DEFAULT_SIM || '',
      rider_template: process.env.INFOTXT_RIDER_TEMPLATE || DEFAULT_RIDER_TEMPLATE,
      notes: null,
    };
  }

  const userId = row.user_id || process.env.INFOTXT_USER_ID || '';
  return {
    provider: PROVIDER,
    configured: Boolean(userId && (row.api_key || process.env.INFOTXT_API_KEY)),
    enabled: Boolean(row.enabled),
    base_url: row.base_url || process.env.INFOTXT_BASE_URL || DEFAULT_BASE_URL,
    user_id: userId,
    has_api_key: Boolean(row.api_key || process.env.INFOTXT_API_KEY),
    default_sim: row.default_sim || '',
    rider_template: row.rider_template || DEFAULT_RIDER_TEMPLATE,
    notes: row.notes || null,
    updated_at: row.updated_at,
  };
}

async function getSetting(db) {
  return await db.prepare('SELECT * FROM sms_settings WHERE provider = ?').get(PROVIDER) || null;
}

async function getPublicSetting(db) {
  return publicSettingFromRow(await getSetting(db));
}

async function getPrivateSetting(db) {
  const row = await getSetting(db);
  return {
    enabled: row ? Boolean(row.enabled) : process.env.INFOTXT_ENABLED === 'true',
    base_url: stringOrNull(row?.base_url) || process.env.INFOTXT_BASE_URL || DEFAULT_BASE_URL,
    user_id: stringOrNull(row?.user_id) || process.env.INFOTXT_USER_ID || '',
    api_key: stringOrNull(row?.api_key) || process.env.INFOTXT_API_KEY || '',
    default_sim: stringOrNull(row?.default_sim) || process.env.INFOTXT_DEFAULT_SIM || '',
    rider_template: stringOrNull(row?.rider_template) || process.env.INFOTXT_RIDER_TEMPLATE || DEFAULT_RIDER_TEMPLATE,
  };
}

async function saveSetting(db, payload = {}) {
  const current = await getSetting(db);
  const next = {
    enabled: payload.enabled ?? current?.enabled ?? 0,
    base_url: patchedValue(payload.base_url, current?.base_url),
    user_id: patchedValue(payload.user_id, current?.user_id),
    api_key: patchedValue(payload.api_key, current?.api_key),
    default_sim: patchedValue(payload.default_sim, current?.default_sim),
    rider_template: patchedValue(payload.rider_template, current?.rider_template),
    notes: payload.notes === undefined ? (current?.notes ?? null) : stringOrNull(payload.notes),
  };

  if (current) {
    await db.prepare(`
      UPDATE sms_settings
      SET enabled = ?, base_url = ?, user_id = ?, api_key = ?, default_sim = ?,
          rider_template = ?, notes = ?, updated_at = datetime('now')
      WHERE provider = ?
    `).run(
      boolToInt(next.enabled),
      next.base_url,
      next.user_id,
      next.api_key,
      next.default_sim,
      next.rider_template,
      next.notes,
      PROVIDER
    );
  } else {
    await db.prepare(`
      INSERT INTO sms_settings (
        provider, enabled, base_url, user_id, api_key, default_sim, rider_template, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      PROVIDER,
      boolToInt(next.enabled),
      next.base_url,
      next.user_id,
      next.api_key,
      next.default_sim,
      next.rider_template,
      next.notes
    );
  }

  return await getPublicSetting(db);
}

async function sendSms(db, payload = {}) {
  const setting = await getPrivateSetting(db);
  if (!setting.enabled) throw new Error('Infotxt SMS is disabled.');
  if (!setting.user_id) throw new Error('Infotxt UserID is missing.');
  if (!setting.api_key) throw new Error('Infotxt API key is missing.');

  const mobile = normalizeMobile(payload.mobile);
  const sms = String(payload.sms || payload.message || '').trim();
  if (!mobile) throw new Error('Mobile must use 09XXXXXXXXX format.');
  if (!sms) throw new Error('SMS message is required.');

  const params = new URLSearchParams({
    UserID: setting.user_id,
    ApiKey: setting.api_key,
    Mobile: mobile,
    SMS: sms,
  });
  const sim = stringOrNull(payload.sim) || setting.default_sim;
  if (sim) params.set('SIM', sim);

  const baseUrl = String(setting.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let response;
  try {
    response = await fetch(`${baseUrl}/send.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`Infotxt did not respond within ${SEND_TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Infotxt request failed: ${error.message}`);
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Infotxt returned a non-JSON response: ${text.slice(0, 160)}`);
  }

  if (!response.ok) {
    throw new Error(data?.error || data?.message || `Infotxt HTTP ${response.status}`);
  }
  if (String(data.status) !== '00') {
    throw new Error(data?.error || `Infotxt rejected the SMS with status ${data.status}`);
  }

  return {
    ok: true,
    status: String(data.status),
    smsid: data.smsid || null,
    mobile,
  };
}

// Relies on the UNIQUE(provider, event_key) index rather than a read-then-write
// check so two sync workers racing on the same order can't both send.
async function insertSmsLog(db, row) {
  const result = await db.prepare(`
    INSERT INTO sms_logs (
      provider, event_key, direction, recipient_name, mobile, message, status,
      smsid, related_table, related_id, error_message
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, event_key) DO NOTHING
  `).run(
    row.provider,
    row.event_key,
    row.direction || 'outbound',
    row.recipient_name || null,
    row.mobile || null,
    row.message || null,
    row.status || 'pending',
    row.smsid || null,
    row.related_table || null,
    row.related_id || null,
    row.error_message || null
  );
  if (!result?.changes) return { inserted: false };
  return { inserted: true, id: result.lastInsertRowid };
}

async function updateSmsLog(db, id, patch = {}) {
  await db.prepare(`
    UPDATE sms_logs
    SET status = ?, smsid = ?, error_message = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(patch.status, patch.smsid || null, patch.error_message || null, id);
}

// Trigger rules. One row per (type, value) — a status can only carry one
// message, which is what the UNIQUE index enforces.
const RULE_TYPES = new Set(['status', 'tag']);

// Labels match what the rest of the dashboard shows for the same raw
// status_name; the order is Pancake's own status code order.
const POS_STATUS_LABELS = [
  ['new', 'New'],
  ['submitted', 'Confirmed'],
  ['pending', 'Waiting for pickup'],
  ['wait_print', 'Waiting for pickup (print)'],
  ['waitting', 'Waiting for pickup'],
  ['shipped', 'Shipped'],
  ['delivered', 'Delivered'],
  ['returning', 'Returning'],
  ['returned', 'Returned'],
  ['canceled', 'Canceled'],
  ['removed', 'Removed'],
];
const POS_STATUS_ORDER = new Map(POS_STATUS_LABELS.map(([value], i) => [value, i]));
const POS_STATUS_LABEL = new Map(POS_STATUS_LABELS);

// The statuses this POS actually produces, so the trigger dropdown can't offer
// one that never arrives (or miss one we didn't know about).
async function listPosStatuses(db) {
  const rows = await db.prepare(`
    SELECT status_name, COUNT(*) AS orders
    FROM pos_orders
    WHERE status_name IS NOT NULL AND status_name <> ''
    GROUP BY status_name
  `).all();

  return (rows || [])
    .map((row) => ({
      value: row.status_name,
      label: POS_STATUS_LABEL.get(row.status_name)
        || row.status_name.charAt(0).toUpperCase() + row.status_name.slice(1).replace(/_/g, ' '),
      orders: Number(row.orders) || 0,
    }))
    .sort((a, b) => (POS_STATUS_ORDER.get(a.value) ?? 99) - (POS_STATUS_ORDER.get(b.value) ?? 99)
      || a.value.localeCompare(b.value));
}

async function listRules(db, options = {}) {
  const where = ['provider = ?'];
  const params = [PROVIDER];
  if (options.enabledOnly) where.push('enabled = 1');
  const rows = await db.prepare(`
    SELECT id, trigger_type, trigger_value, message, enabled, created_at, updated_at
    FROM sms_rules
    WHERE ${where.join(' AND ')}
    ORDER BY id ASC
  `).all(...params);
  return (rows || []).map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
}

async function saveRule(db, payload = {}) {
  const triggerType = RULE_TYPES.has(payload.trigger_type) ? payload.trigger_type : 'status';
  const triggerValue = normalizeTag(payload.trigger_value);
  const message = String(payload.message ?? '').trim();
  const id = Number(payload.id) || null;
  if (!triggerValue) throw new Error('Pick what the message should trigger on.');
  if (!message) throw new Error('Message content is required.');

  const clash = await db.prepare(
    'SELECT id FROM sms_rules WHERE provider = ? AND trigger_type = ? AND trigger_value = ?'
  ).get(PROVIDER, triggerType, triggerValue);
  if (clash && clash.id !== id) throw new Error('There is already a message for that trigger.');

  if (id) {
    await db.prepare(`
      UPDATE sms_rules
      SET trigger_type = ?, trigger_value = ?, message = ?, enabled = ?, updated_at = datetime('now')
      WHERE id = ? AND provider = ?
    `).run(triggerType, triggerValue, message, boolToInt(payload.enabled ?? true), id, PROVIDER);
  } else {
    await db.prepare(`
      INSERT INTO sms_rules (provider, trigger_type, trigger_value, message, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(PROVIDER, triggerType, triggerValue, message, boolToInt(payload.enabled ?? true));
  }
  return await listRules(db);
}

async function setRuleEnabled(db, id, enabled) {
  await db.prepare(
    "UPDATE sms_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ? AND provider = ?"
  ).run(boolToInt(enabled), Number(id), PROVIDER);
  return await listRules(db);
}

async function deleteRule(db, id) {
  await db.prepare('DELETE FROM sms_rules WHERE id = ? AND provider = ?').run(Number(id), PROVIDER);
  return await listRules(db);
}

async function listSmsLogs(db, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const status = stringOrNull(options.status);
  const where = ['provider = ?'];
  const params = [PROVIDER];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const rows = await db.prepare(`
    SELECT id, event_key, direction, recipient_name, mobile, message, status,
           smsid, related_table, related_id, error_message, created_at, updated_at
    FROM sms_logs
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT ${limit}
  `).all(...params);
  return { logs: rows || [], limit };
}

// Drops SMS logs older than the retention window. Date comparison uses a plain
// substr(CAST(...)) text compare so it behaves identically on SQLite (TEXT
// created_at) and Postgres (TIMESTAMPTZ) without engine-specific casts. The
// table is small, so this is a single statement rather than a batched delete.
async function pruneSmsLogs(db, { retentionDays = LOG_RETENTION_DAYS } = {}) {
  const days = Math.max(1, Number(retentionDays) || LOG_RETENTION_DAYS);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const result = await db.prepare(
    'DELETE FROM sms_logs WHERE substr(CAST(created_at AS TEXT), 1, 10) < ?'
  ).run(cutoff);
  return {
    provider: PROVIDER,
    retention_days: days,
    cutoff_date: cutoff,
    deleted_sms_logs: Number(result.changes || 0),
  };
}

// Texts whoever is assigned to the order as its rider. Two triggers, both
// optional and both aimed at the same recipient:
//
//   status — the order's status changed into one of the configured statuses
//   tag    — the order carries one of the configured trigger tags
//
// Neither needs a before/after diff to stay quiet: the UNIQUE(provider,
// event_key) index on sms_logs is what makes each one fire exactly once, so a
// tag that sits on an order for weeks still only sends the day it lands.
// The rider's mobile is part of the event key, so swapping riders mid-delivery
// re-notifies the new rider for the same status instead of going silent.
//
// Because that dedupe lives in sms_logs, and sms_logs is pruned after
// LOG_RETENTION_DAYS, orders older than the window are skipped outright: their
// log row may already be gone, and a still-attached trigger tag would otherwise
// text the rider a second time the next time the order is touched.
//
// At most one SMS leaves per call: we claim the first trigger that hasn't been
// logged yet and stop. An order that shows up already matching three triggers
// therefore sends one per sync cycle rather than three at once.
async function sendRiderSms(db, posOrder = {}, options = {}) {
  const setting = await getPrivateSetting(db);
  if (!setting.enabled) return { skipped: 'disabled' };

  const rules = await listRules(db, { enabledOnly: true });
  if (!rules.length) return { skipped: 'no_rules' };

  const status = normalizeTag(posOrder.status_name);
  const tagText = orderTagText(posOrder);
  const triggers = rules
    .filter((rule) => (rule.trigger_type === 'status'
      ? Boolean(posOrder.status_changed) && status === normalizeTag(rule.trigger_value)
      : tagText.includes(normalizeTag(rule.trigger_value))))
    .map((rule) => ({ kind: rule.trigger_type, value: normalizeTag(rule.trigger_value), message: rule.message }));

  if (!triggers.length) return { skipped: 'no_trigger_match' };

  const shopId = stringOrNull(posOrder.shop_id) || 'unknown';
  const externalId = stringOrNull(posOrder.external_id);
  if (!externalId) return { skipped: 'missing_order_id' };

  // Outside the log-retention window the dedupe row can no longer be trusted.
  // An order with no timestamp at all still sends — that is rare, and going
  // quiet on a live order is the worse failure.
  const placedOn = String(posOrder.inserted_at_remote || '').slice(0, 10);
  const oldestSendable = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  if (placedOn && placedOn < oldestSendable) return { skipped: 'order_older_than_log_retention' };

  // A trigger matched but the rider is unreachable. Record it instead of
  // returning quietly — otherwise the only symptom is an SMS that never
  // arrives, with nothing in the log to explain why.
  const rawTel = stringOrNull(posOrder.sprinter_tel);
  const mobile = normalizeMobile(rawTel);
  if (!mobile) {
    const reason = rawTel
      ? `Rider number is not a usable PH mobile: ${rawTel}`
      : 'Order has no rider number.';
    await insertSmsLog(db, {
      provider: PROVIDER,
      event_key: `rider-unreachable:${shopId}:${externalId}:${triggers[0].value}:${rawTel || 'none'}`,
      recipient_name: posOrder.sprinter_name || null,
      mobile: rawTel || 'n/a',
      message: truncate(renderTemplate(triggers[0].message || setting.rider_template, posOrder), 1550),
      status: 'failed',
      related_table: 'pos_orders',
      related_id: `${shopId}::${externalId}`,
      error_message: reason,
    });
    return { skipped: 'missing_rider_number', reason };
  }
  if (!stringOrNull(posOrder.sprinter_name)) return { skipped: 'missing_rider_name' };

  for (const trigger of triggers) {
    const eventKey = `rider-${trigger.kind}:${shopId}:${externalId}:${trigger.value}:${mobile}`;
    const message = truncate(renderTemplate(trigger.message || setting.rider_template, {
      ...posOrder,
      matched_tag: trigger.kind === 'tag' ? trigger.value : '',
    }), 1550);
    const log = await insertSmsLog(db, {
      provider: PROVIDER,
      event_key: eventKey,
      recipient_name: posOrder.sprinter_name,
      mobile,
      message,
      status: 'pending',
      related_table: 'pos_orders',
      related_id: `${shopId}::${externalId}`,
    });
    if (!log.inserted) continue; // already sent for this trigger

    try {
      const result = await sendSms(db, { mobile, message, sim: options.sim });
      await updateSmsLog(db, log.id, { status: 'sent', smsid: result.smsid || null });
      return { sent: true, trigger, smsid: result.smsid || null, event_key: eventKey };
    } catch (error) {
      await updateSmsLog(db, log.id, { status: 'failed', error_message: truncate(error.message, 500) });
      return { sent: false, trigger, error: error.message, event_key: eventKey };
    }
  }

  return { skipped: 'duplicate', triggers };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_RIDER_TEMPLATE,
  getPublicSetting,
  saveSetting,
  sendSms,
  sendRiderSms,
  listPosStatuses,
  listRules,
  saveRule,
  setRuleEnabled,
  deleteRule,
  listSmsLogs,
  pruneSmsLogs,
  normalizeMobile,
};
