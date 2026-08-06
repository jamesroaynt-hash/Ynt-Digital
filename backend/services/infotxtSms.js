const PROVIDER = 'infotxt';
const DEFAULT_BASE_URL = 'https://api.myinfotxt.com/v2';
// Only used if a rule somehow has no message of its own; every rule the UI
// creates carries one, so this is a safety net rather than a real default.
const DEFAULT_RIDER_TEMPLATE ='YNT Delivery: Hi {rider}, order {tracking} for {customer} is now {status}. COD: {cod}. Please check and update after delivery attempt.';
const SEND_TIMEOUT_MS = 15000;
// How long a sent/failed SMS stays in sms_logs before it is deleted.
const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.SMS_LOG_RETENTION_DAYS || 3));
// How long the "already texted" markers are kept. Much longer than the log,
// because this is what stops a trigger firing twice: an order can sit in
// delivery for weeks, and it must not re-text when its log row is cleared.
const SENT_EVENT_RETENTION_DAYS = Math.max(
  LOG_RETENTION_DAYS,
  Number(process.env.SMS_DEDUPE_RETENTION_DAYS || 60)
);

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

// Who a rule texts. Anything unrecognised is a rider rule: that is what every
// rule was before customer messages existed.
const RECIPIENTS = new Set(['rider', 'customer']);
function normalizeRecipient(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return RECIPIENTS.has(text) ? text : 'rider';
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

// {product name} and {product_name} are the same placeholder: spacing and case
// are ignored so a template can read the way a person would write it.
function templateKey(key) {
  return String(key).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function renderTemplate(template, row = {}) {
  const product = row.note_product || '';
  const page = row.page_name || '';
  const values = {
    rider: row.sprinter_name || 'Rider',
    rider_phone: row.sprinter_tel || '',
    status: row.status_name || '',
    tag: row.matched_tag || '',
    tracking: row.tracking_no || row.external_id || '',
    order_id: row.external_id || '',
    shop: page || row.shop_id || '',
    customer: row.customer_name || '',
    customer_name: row.customer_name || '',
    customer_phone: row.customer_phone || '',
    product,
    product_name: product,
    page,
    page_name: page,
    cod: formatPeso(row.cod),
  };
  // An unknown placeholder is left standing rather than deleted: braces in a
  // promo ("{50% OFF}") stay readable, and a mistyped {tracing} shows up as a
  // mistake instead of silently blanking part of the message.
  return String(template || DEFAULT_RIDER_TEMPLATE).replace(/\{([a-z0-9_ -]+)\}/gi, (whole, key) => {
    const value = values[templateKey(key)];
    return value === undefined ? whole : value;
  });
}

// Placeholders that need an order behind them. Used to decide whether a blast
// has to look its recipients up at all — a plain promo message shouldn't pay
// for the lookup.
const ORDER_PLACEHOLDERS = new Set(['product', 'product_name', 'page', 'page_name', 'customer', 'customer_name', 'shop']);
function templateNeedsOrderData(template) {
  const matches = String(template ?? '').match(/\{([a-z0-9_ -]+)\}/gi) || [];
  return matches.some((match) => ORDER_PLACEHOLDERS.has(templateKey(match.slice(1, -1))));
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

  invalidateSendConfig();
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

// Claims an event so it is only ever texted once. Relies on the primary key
// rather than a read-then-write check, so two sync workers racing on the same
// order can't both send: exactly one INSERT reports a row.
async function claimSmsEvent(db, eventKey) {
  const result = await db.prepare(`
    INSERT INTO sms_sent_events (provider, event_key)
    VALUES (?, ?)
    ON CONFLICT (provider, event_key) DO NOTHING
  `).run(PROVIDER, eventKey);
  return Boolean(result?.changes);
}

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
    SELECT id, recipient, trigger_type, trigger_value, message, enabled, created_at, updated_at
    FROM sms_rules
    WHERE ${where.join(' AND ')}
    ORDER BY id ASC
  `).all(...params);
  return (rows || []).map((row) => ({
    ...row,
    recipient: normalizeRecipient(row.recipient),
    enabled: Boolean(row.enabled),
  }));
}

async function saveRule(db, payload = {}) {
  const recipient = normalizeRecipient(payload.recipient);
  const triggerType = RULE_TYPES.has(payload.trigger_type) ? payload.trigger_type : 'status';
  const triggerValue = normalizeTag(payload.trigger_value);
  const message = String(payload.message ?? '').trim();
  const id = Number(payload.id) || null;
  if (!triggerValue) throw new Error('Pick what the message should trigger on.');
  if (!message) throw new Error('Message content is required.');

  // Scoped to the recipient: the same trigger can text the rider and the
  // customer, they just cannot each have two messages for it.
  const clash = await db.prepare(
    'SELECT id FROM sms_rules WHERE provider = ? AND recipient = ? AND trigger_type = ? AND trigger_value = ?'
  ).get(PROVIDER, recipient, triggerType, triggerValue);
  if (clash && clash.id !== id) {
    throw new Error(`There is already a ${recipient} message for that trigger.`);
  }

  if (id) {
    await db.prepare(`
      UPDATE sms_rules
      SET recipient = ?, trigger_type = ?, trigger_value = ?, message = ?, enabled = ?, updated_at = datetime('now')
      WHERE id = ? AND provider = ?
    `).run(recipient, triggerType, triggerValue, message, boolToInt(payload.enabled ?? true), id, PROVIDER);
  } else {
    await db.prepare(`
      INSERT INTO sms_rules (provider, recipient, trigger_type, trigger_value, message, enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(PROVIDER, recipient, triggerType, triggerValue, message, boolToInt(payload.enabled ?? true));
  }
  invalidateSendConfig();
  return await listRules(db);
}

async function setRuleEnabled(db, id, enabled) {
  await db.prepare(
    "UPDATE sms_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ? AND provider = ?"
  ).run(boolToInt(enabled), Number(id), PROVIDER);
  invalidateSendConfig();
  return await listRules(db);
}

async function deleteRule(db, id) {
  await db.prepare('DELETE FROM sms_rules WHERE id = ? AND provider = ?').run(Number(id), PROVIDER);
  invalidateSendConfig();
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

// Drops SMS logs older than the retention window, and the send markers on their
// own longer one. Date comparison uses a plain substr(CAST(...)) text compare so
// it behaves identically on SQLite (TEXT created_at) and Postgres (TIMESTAMPTZ)
// without engine-specific casts. Both tables are small, so these are single
// statements rather than batched deletes.
async function pruneSmsLogs(db, {
  retentionDays = LOG_RETENTION_DAYS,
  dedupeRetentionDays = SENT_EVENT_RETENTION_DAYS,
} = {}) {
  const dayString = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const days = Math.max(1, Number(retentionDays) || LOG_RETENTION_DAYS);
  const dedupeDays = Math.max(days, Number(dedupeRetentionDays) || SENT_EVENT_RETENTION_DAYS);
  const cutoff = dayString(days);

  const logResult = await db.prepare(
    'DELETE FROM sms_logs WHERE substr(CAST(created_at AS TEXT), 1, 10) < ?'
  ).run(cutoff);
  const eventResult = await db.prepare(
    'DELETE FROM sms_sent_events WHERE provider = ? AND substr(CAST(created_at AS TEXT), 1, 10) < ?'
  ).run(PROVIDER, dayString(dedupeDays));

  return {
    provider: PROVIDER,
    retention_days: days,
    dedupe_retention_days: dedupeDays,
    cutoff_date: cutoff,
    deleted_sms_logs: Number(logResult.changes || 0),
    deleted_sent_events: Number(eventResult.changes || 0),
  };
}

// The settings row and the rule list are read once per changed order, which is
// every order the POS sync touches. Both change by hand, minutes apart at most,
// so they are cached briefly rather than re-read thousands of times a cycle.
// Edits made through this process clear it immediately; another replica's edit
// takes effect within the TTL.
const SEND_CONFIG_TTL_MS = 60 * 1000;
let sendConfigCache = null;

function invalidateSendConfig() {
  sendConfigCache = null;
}

async function getSendConfig(db) {
  if (sendConfigCache && Date.now() < sendConfigCache.expiresAt) return sendConfigCache.value;
  const [setting, rules] = await Promise.all([
    getPrivateSetting(db),
    listRules(db, { enabledOnly: true }),
  ]);
  const value = { setting, rules };
  sendConfigCache = { value, expiresAt: Date.now() + SEND_CONFIG_TTL_MS };
  return value;
}

// Who each rule texts, and where that number comes from on the order. The
// customer's name is optional — plenty of orders carry only a phone — but a
// rider rule with no rider name would render "Hi Rider", so that one is
// required the way it always was.
const RECIPIENT_FIELDS = {
  rider: { tel: 'sprinter_tel', name: 'sprinter_name', label: 'Rider', requireName: true },
  customer: { tel: 'customer_phone', name: 'customer_name', label: 'Customer', requireName: false },
};

// Texts the order's rider, its customer, or both, depending on what each
// enabled rule is addressed to. Two triggers, both optional:
//
//   status — the order's status changed into one of the configured statuses
//   tag    — the order carries one of the configured trigger tags
//
// Neither needs a before/after diff to stay quiet: a row in sms_sent_events is
// what makes each one fire exactly once, so a tag that sits on an order for
// weeks still only sends the day it lands. The recipient's mobile is part of
// the event key, so swapping riders mid-delivery re-notifies the new rider for
// the same status instead of going silent, and a corrected customer number
// re-sends rather than staying lost.
//
// Orders are considered by when they were last updated, not when they were
// placed: an order booked last week and handed to a rider today is exactly the
// case this automation is for. Only orders untouched for longer than the
// dedupe window drop out, since past that their marker may be gone.
//
// At most one SMS leaves per recipient per call: we claim the first trigger
// that hasn't been logged yet and stop. An order that shows up already matching
// three triggers sends one per sync cycle rather than three at once — but the
// rider and the customer are independent, so both can go out together.
async function sendOrderSms(db, posOrder = {}, options = {}) {
  const { setting, rules } = await getSendConfig(db);
  if (!setting.enabled) return { skipped: 'disabled' };
  if (!rules.length) return { skipped: 'no_rules' };

  const status = normalizeTag(posOrder.status_name);
  const tagText = orderTagText(posOrder);
  const matched = rules
    .filter((rule) => (rule.trigger_type === 'status'
      ? Boolean(posOrder.status_changed) && status === normalizeTag(rule.trigger_value)
      : tagText.includes(normalizeTag(rule.trigger_value))))
    .map((rule) => ({
      recipient: rule.recipient,
      kind: rule.trigger_type,
      value: normalizeTag(rule.trigger_value),
      message: rule.message,
    }));

  if (!matched.length) return { skipped: 'no_trigger_match' };

  const shopId = stringOrNull(posOrder.shop_id) || 'unknown';
  const externalId = stringOrNull(posOrder.external_id);
  if (!externalId) return { skipped: 'missing_order_id' };

  // Past the dedupe window the "already texted" marker may be gone, so a still
  // attached tag could text twice. An order with no timestamp at all still
  // sends — that is rare, and going quiet on a live order is the worse failure.
  const touchedOn = String(posOrder.updated_at_remote || posOrder.inserted_at_remote || '').slice(0, 10);
  const oldestSendable = new Date(Date.now() - SENT_EVENT_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  if (touchedOn && touchedOn < oldestSendable) return { skipped: 'order_not_updated_recently' };

  const results = [];
  for (const recipient of Object.keys(RECIPIENT_FIELDS)) {
    const triggers = matched.filter((t) => t.recipient === recipient);
    if (!triggers.length) continue;
    results.push({
      recipient,
      ...await sendToRecipient(db, posOrder, { recipient, triggers, setting, shopId, externalId, options }),
    });
  }

  return results.length === 1 ? results[0] : { results };
}

async function sendToRecipient(db, posOrder, { recipient, triggers, setting, shopId, externalId, options }) {
  const fields = RECIPIENT_FIELDS[recipient];

  // A trigger matched but the recipient is unreachable. Record it instead of
  // returning quietly — otherwise the only symptom is an SMS that never
  // arrives, with nothing in the log to explain why.
  const rawTel = stringOrNull(posOrder[fields.tel]);
  const mobile = normalizeMobile(rawTel);
  if (!mobile) {
    const reason = rawTel
      ? `${fields.label} number is not a usable PH mobile: ${rawTel}`
      : `Order has no ${recipient} number.`;
    const unreachableKey = `${recipient}-unreachable:${shopId}:${externalId}:${triggers[0].value}:${rawTel || 'none'}`;
    // Claimed like a real send so the log records it once, not on every sync.
    if (await claimSmsEvent(db, unreachableKey)) {
      await insertSmsLog(db, {
        provider: PROVIDER,
        event_key: unreachableKey,
        recipient_name: posOrder[fields.name] || null,
        mobile: rawTel || 'n/a',
        message: truncate(renderTemplate(triggers[0].message || setting.rider_template, posOrder), 1550),
        status: 'failed',
        related_table: 'pos_orders',
        related_id: `${shopId}::${externalId}`,
        error_message: reason,
      });
    }
    return { skipped: `missing_${recipient}_number`, reason };
  }
  if (fields.requireName && !stringOrNull(posOrder[fields.name])) {
    return { skipped: `missing_${recipient}_name` };
  }

  for (const trigger of triggers) {
    const eventKey = `${recipient}-${trigger.kind}:${shopId}:${externalId}:${trigger.value}:${mobile}`;
    const message = truncate(renderTemplate(trigger.message || setting.rider_template, {
      ...posOrder,
      matched_tag: trigger.kind === 'tag' ? trigger.value : '',
    }), 1550);
    if (!await claimSmsEvent(db, eventKey)) continue; // already sent for this trigger
    const log = await insertSmsLog(db, {
      provider: PROVIDER,
      event_key: eventKey,
      recipient_name: posOrder[fields.name] || null,
      mobile,
      message,
      status: 'pending',
      related_table: 'pos_orders',
      related_id: `${shopId}::${externalId}`,
    });

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

/* ─── SMS BLAST ─────────────────────────────────────────────
 * A one-off send to a list of numbers, unrelated to the trigger rules: no
 * dedupe marker (the same promo may legitimately go out twice) and no order to
 * render placeholders from. Every message still lands in sms_logs, tagged with
 * the batch it belongs to so a blast can be read back as a unit.
 */
const BLAST_MAX_RECIPIENTS = Math.max(1, Number(process.env.SMS_BLAST_MAX || 500));
// Spread the sends so a large blast doesn't arrive at Infotxt as one burst.
const BLAST_DELAY_MS = Math.max(0, Number(process.env.SMS_BLAST_DELAY_MS || 200));
// Ceiling on rows read when building a list from orders, before dedupe. One
// customer usually has several orders, so this is well above the send cap.
const BLAST_QUERY_ROWS = 20000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Accepts an array of numbers or one pasted blob (newline / comma / semicolon
// separated). Returns the usable numbers de-duplicated in input order, plus
// whatever could not be read as a PH mobile so the UI can say what it dropped.
function normalizeMobileList(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input ?? '').split(/[\n\r,;]+/);
  const mobiles = [];
  const seen = new Set();
  const invalid = [];
  for (const entry of raw) {
    const text = String(entry ?? '').trim();
    if (!text) continue;
    const mobile = normalizeMobile(text);
    if (!mobile) { invalid.push(truncate(text, 24)); continue; }
    if (seen.has(mobile)) continue;
    seen.add(mobile);
    mobiles.push(mobile);
  }
  return { mobiles, invalid };
}

// The Manila business day of an order, mirroring posManilaExprs in routes/_all.js
// so a blast's date range selects exactly what the dashboard's does. Two things
// this has to get right: early syncs wrote a bad inserted_at_remote, so the raw
// payload's inserted_at wins where it exists; and POS timestamps are UTC while
// the business day is Manila, so an order placed 00:00-08:00 Manila is still on
// the previous UTC day and has to be shifted before its date is sliced.
function posManilaExprs(db) {
  const effectiveInsertedAt = db.type === 'postgres'
    ? "COALESCE(NULLIF(raw_payload::jsonb ->> 'inserted_at', ''), inserted_at_remote)"
    : "COALESCE(NULLIF(json_extract(CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END, '$.inserted_at'), ''), inserted_at_remote)";
  const manilaDay = db.type === 'postgres'
    ? `to_char((${effectiveInsertedAt})::timestamp + interval '8 hours', 'YYYY-MM-DD')`
    : `date(${effectiveInsertedAt}, '+8 hours')`;
  return { effectiveInsertedAt, manilaDay };
}

function blastWhere(db, filters = {}) {
  const where = ["customer_phone IS NOT NULL", "customer_phone <> ''"];
  const params = [];
  const shopId = stringOrNull(filters.shop_id);
  const status = stringOrNull(filters.status);
  const tag = normalizeTag(filters.tag);
  const from = stringOrNull(filters.from);
  const to = stringOrNull(filters.to);
  if (shopId) { where.push('shop_id = ?'); params.push(shopId); }
  if (status) { where.push('status_name = ?'); params.push(status); }
  // Loose substring match on the raw tags_json, the same match the tag triggers
  // and the rest of the dashboard use — a tag is stored per shop under its own
  // id, so the name is the only thing that compares across shops.
  if (tag) { where.push("LOWER(COALESCE(tags_json, '')) LIKE ?"); params.push(`%${tag}%`); }
  if (from || to) {
    const { manilaDay } = posManilaExprs(db);
    if (from) { where.push(`${manilaDay} >= ?`); params.push(from.slice(0, 10)); }
    if (to) { where.push(`${manilaDay} <= ?`); params.push(to.slice(0, 10)); }
  }
  return { where, params };
}

// A grouped column that carries the newest row's value for `column`, for the
// {product name} / {page name} placeholders: MAX() on its own would pick the
// alphabetical winner, so each value is prefixed with its zero-padded id and
// the prefix is stripped off again in JS. Beats a second per-recipient query —
// a repeat customer is texted about what they last bought, in one pass.
function latestValueExpr(db, column, alias) {
  const idKey = db.type === 'postgres' ? "lpad(id::text, 12, '0')" : "printf('%012d', id)";
  return `MAX(${idKey} || '|' || COALESCE(${column}, '')) AS ${alias}`;
}

function latestValue(value) {
  const text = String(value ?? '');
  const cut = text.indexOf('|');
  return cut === -1 ? '' : text.slice(cut + 1).trim();
}

// Distinct customer numbers from POS orders, for blasting a segment rather than
// a pasted list.
async function listBlastRecipients(db, filters = {}) {
  const { where, params } = blastWhere(db, filters);

  const rows = await db.prepare(`
    SELECT customer_phone,
           COUNT(*) AS orders,
           ${latestValueExpr(db, 'customer_name', 'customer_name')},
           ${latestValueExpr(db, 'note_product', 'note_product')},
           ${latestValueExpr(db, 'page_name', 'page_name')}
    FROM pos_orders
    WHERE ${where.join(' AND ')}
    GROUP BY customer_phone
    ORDER BY COUNT(*) DESC
    LIMIT ${BLAST_QUERY_ROWS}
  `).all(...params);

  // One customer can appear under several raw formats (+63…, 0…), so dedupe
  // again on the normalized number rather than trusting the GROUP BY.
  const seen = new Map();
  let unusable = 0;
  let orders = 0;
  let missingProduct = 0;
  let missingPage = 0;
  for (const row of rows || []) {
    orders += Number(row.orders) || 0;
    const mobile = normalizeMobile(row.customer_phone);
    if (!mobile) { unusable += 1; continue; }
    if (seen.has(mobile)) continue;
    const recipient = {
      mobile,
      name: latestValue(row.customer_name) || null,
      product: latestValue(row.note_product),
      page: latestValue(row.page_name),
    };
    if (!recipient.product) missingProduct += 1;
    if (!recipient.page) missingPage += 1;
    seen.set(mobile, recipient);
  }

  return {
    recipients: [...seen.values()],
    total: seen.size,
    // Matching orders behind those recipients. One customer usually has several,
    // so this is what explains a small recipient count against a big status.
    orders,
    unusable,
    // Recipients whose order carries no product / page name. Those placeholders
    // come out empty for them, so the UI can warn before the send.
    missing_product: missingProduct,
    missing_page: missingPage,
    truncated: (rows || []).length >= BLAST_QUERY_ROWS,
    max_recipients: BLAST_MAX_RECIPIENTS,
  };
}

// Placeholder values for a pasted list, where there is no filter to read them
// from. Matched on the formats a POS order stores a number in — a pasted number
// that was never an order, or was stored in some other shape, simply has no
// context and its placeholders come out blank.
const CONTEXT_LOOKUP_CHUNK = 200;
async function lookupBlastContext(db, mobiles = []) {
  const context = new Map();
  // Same input the send accepts: an array, or one pasted blob.
  const list = normalizeMobileList(mobiles).mobiles;
  for (let i = 0; i < list.length; i += CONTEXT_LOOKUP_CHUNK) {
    const chunk = list.slice(i, i + CONTEXT_LOOKUP_CHUNK);
    const variants = [];
    for (const mobile of chunk) {
      const bare = mobile.slice(1); // 9XXXXXXXXX
      variants.push(mobile, bare, `63${bare}`, `+63${bare}`);
    }
    const rows = await db.prepare(`
      SELECT customer_phone,
             ${latestValueExpr(db, 'customer_name', 'customer_name')},
             ${latestValueExpr(db, 'note_product', 'note_product')},
             ${latestValueExpr(db, 'page_name', 'page_name')}
      FROM pos_orders
      WHERE customer_phone IN (${variants.map(() => '?').join(',')})
      GROUP BY customer_phone
    `).all(...variants);
    for (const row of rows || []) {
      const mobile = normalizeMobile(row.customer_phone);
      if (!mobile || context.has(mobile)) continue;
      context.set(mobile, {
        customer_name: latestValue(row.customer_name),
        note_product: latestValue(row.note_product),
        page_name: latestValue(row.page_name),
      });
    }
  }
  return context;
}

// The same shape, built from a recipient list the filter already produced.
function blastContext(recipients = []) {
  const context = new Map();
  for (const recipient of recipients || []) {
    const mobile = normalizeMobile(recipient?.mobile);
    if (!mobile || context.has(mobile)) continue;
    context.set(mobile, {
      customer_name: recipient.name || '',
      note_product: recipient.product || '',
      page_name: recipient.page || '',
    });
  }
  return context;
}

// Shops that actually have orders with a customer number, for the shop filter.
async function listBlastShops(db) {
  const rows = await db.prepare(`
    SELECT shop_id, MAX(page_name) AS page_name, COUNT(*) AS orders
    FROM pos_orders
    WHERE shop_id IS NOT NULL AND shop_id <> ''
    GROUP BY shop_id
    ORDER BY COUNT(*) DESC
  `).all();
  return (rows || []).map((row) => ({
    shop_id: String(row.shop_id),
    label: stringOrNull(row.page_name) || String(row.shop_id),
    orders: Number(row.orders) || 0,
  }));
}

// Tag names in current use, for the blast's tag filter. Read from stored orders
// rather than the POS API: it needs no network call, and a tag no order carries
// is not one worth offering. Bounded to recent orders — the full table is large
// and older rows only add tags nobody uses any more.
const BLAST_TAG_SCAN_ROWS = 20000;
async function listBlastTags(db) {
  const rows = await db.prepare(`
    SELECT tags_json
    FROM pos_orders
    WHERE tags_json IS NOT NULL AND LENGTH(tags_json) > 2
    ORDER BY id DESC
    LIMIT ${BLAST_TAG_SCAN_ROWS}
  `).all();

  // Keyed by the lowercase name the filter matches on, but showing the label as
  // it was first seen, so the dropdown reads the way the POS spells it.
  const seen = new Map();
  for (const row of rows || []) {
    let tags;
    try {
      tags = JSON.parse(row.tags_json);
    } catch { continue; }
    if (!Array.isArray(tags)) continue;
    for (const entry of tags) {
      const label = String(typeof entry === 'string' ? entry : (entry?.name || entry?.tag_name || entry?.label || '')).trim();
      const key = normalizeTag(label);
      if (!key) continue;
      const current = seen.get(key);
      if (current) current.orders += 1;
      else seen.set(key, { value: key, label, orders: 1 });
    }
  }
  return [...seen.values()].sort((a, b) => b.orders - a.orders || a.label.localeCompare(b.label));
}

function newBatchId() {
  return `blast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Validates and claims the batch, then hands back a runner the caller starts in
// the background. Splitting it this way lets the route reject a bad blast with
// a 400 while a good one returns immediately — a few hundred sends take minutes,
// far longer than the proxy in front of this will hold a request open.
async function prepareBlast(db, payload = {}) {
  const setting = await getPrivateSetting(db);
  if (!setting.enabled) throw new Error('Infotxt SMS is switched off, so nothing would be sent.');
  if (!setting.user_id) throw new Error('Infotxt UserID is missing.');
  if (!setting.api_key) throw new Error('Infotxt API key is missing.');

  const message = String(payload.message ?? '').trim();
  if (!message) throw new Error('Message content is required.');

  const { mobiles, invalid } = normalizeMobileList(payload.mobiles);
  if (!mobiles.length) throw new Error('No usable PH mobile numbers (09XXXXXXXXX) in the recipient list.');
  if (mobiles.length > BLAST_MAX_RECIPIENTS) {
    throw new Error(`That is ${mobiles.length} recipients — send at most ${BLAST_MAX_RECIPIENTS} per blast.`);
  }

  const batchId = newBatchId();
  const body = truncate(message, 1550);
  const sim = stringOrNull(payload.sim);
  const sentBy = stringOrNull(payload.sent_by);
  // Per-recipient placeholder values, keyed by normalized mobile. Absent for a
  // plain message, and incomplete where a recipient has no order to read from —
  // renderTemplate blanks what it can't fill either way.
  const context = payload.context instanceof Map ? payload.context : new Map();

  return {
    batch_id: batchId,
    total: mobiles.length,
    invalid,
    run: async () => {
      let sent = 0;
      let failed = 0;
      for (const mobile of mobiles) {
        // Rendered per recipient, and logged as rendered, so the send log shows
        // the text that actually went out rather than the template.
        const text = truncate(renderTemplate(body, context.get(mobile) || {}), 1550);
        const log = await insertSmsLog(db, {
          provider: PROVIDER,
          event_key: `${batchId}:${mobile}`,
          recipient_name: sentBy ? `Blast by ${sentBy}` : 'Blast',
          mobile,
          message: text,
          status: 'pending',
          related_table: 'sms_blast',
          related_id: batchId,
        });
        try {
          const result = await sendSms(db, { mobile, message: text, sim });
          if (log.inserted) await updateSmsLog(db, log.id, { status: 'sent', smsid: result.smsid || null });
          sent += 1;
        } catch (error) {
          if (log.inserted) {
            await updateSmsLog(db, log.id, { status: 'failed', error_message: truncate(error.message, 500) });
          }
          failed += 1;
        }
        if (BLAST_DELAY_MS) await sleep(BLAST_DELAY_MS);
      }
      return { batch_id: batchId, total: mobiles.length, sent, failed };
    },
  };
}

// Progress for a running or finished blast, read straight off its log rows.
async function getBlastStatus(db, batchId) {
  const id = stringOrNull(batchId);
  if (!id) throw new Error('batch_id is required.');
  const rows = await db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM sms_logs
    WHERE provider = ? AND related_table = 'sms_blast' AND related_id = ?
    GROUP BY status
  `).all(PROVIDER, id);

  const counts = { sent: 0, failed: 0, pending: 0 };
  for (const row of rows || []) {
    counts[row.status] = (counts[row.status] || 0) + (Number(row.count) || 0);
  }
  const firstError = await db.prepare(`
    SELECT error_message FROM sms_logs
    WHERE provider = ? AND related_table = 'sms_blast' AND related_id = ? AND error_message IS NOT NULL
    ORDER BY id ASC LIMIT 1
  `).get(PROVIDER, id);

  return {
    batch_id: id,
    ...counts,
    processed: counts.sent + counts.failed,
    first_error: firstError?.error_message || null,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_RIDER_TEMPLATE,
  BLAST_MAX_RECIPIENTS,
  listBlastRecipients,
  listBlastShops,
  listBlastTags,
  lookupBlastContext,
  blastContext,
  templateNeedsOrderData,
  prepareBlast,
  getBlastStatus,
  normalizeMobileList,
  getPublicSetting,
  saveSetting,
  sendSms,
  sendOrderSms,
  listPosStatuses,
  listRules,
  saveRule,
  setRuleEnabled,
  deleteRule,
  listSmsLogs,
  pruneSmsLogs,
  normalizeMobile,
};
