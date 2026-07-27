const PROVIDER = 'infotxt';
const DEFAULT_BASE_URL = 'https://api.myinfotxt.com/v2';
const DEFAULT_RIDER_STATUSES = 'shipped';
const DEFAULT_RIDER_TEMPLATE = 'YNT Delivery: Hi {rider}, order {tracking} for {customer} is now {status}. COD: {cod}. Please check and update after delivery attempt.';
const SEND_TIMEOUT_MS = 15000;

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

function normalizeMobile(value) {
  const text = String(value ?? '').replace(/[^\d+]/g, '');
  if (/^\+639\d{9}$/.test(text)) return `0${text.slice(3)}`;
  if (/^639\d{9}$/.test(text)) return `0${text.slice(2)}`;
  if (/^09\d{9}$/.test(text)) return text;
  return '';
}

function normalizeStatus(value) {
  return String(value ?? '').trim().toLowerCase();
}

function parseStatusList(value) {
  return String(value || DEFAULT_RIDER_STATUSES)
    .split(',')
    .map(normalizeStatus)
    .filter(Boolean);
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
      rider_statuses: process.env.INFOTXT_RIDER_STATUSES || DEFAULT_RIDER_STATUSES,
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
    rider_statuses: row.rider_statuses || DEFAULT_RIDER_STATUSES,
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
    rider_statuses: stringOrNull(row?.rider_statuses) || process.env.INFOTXT_RIDER_STATUSES || DEFAULT_RIDER_STATUSES,
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
    rider_statuses: patchedValue(payload.rider_statuses, current?.rider_statuses),
    rider_template: patchedValue(payload.rider_template, current?.rider_template),
    notes: payload.notes === undefined ? (current?.notes ?? null) : stringOrNull(payload.notes),
  };

  if (current) {
    await db.prepare(`
      UPDATE sms_settings
      SET enabled = ?, base_url = ?, user_id = ?, api_key = ?, default_sim = ?,
          rider_statuses = ?, rider_template = ?, notes = ?, updated_at = datetime('now')
      WHERE provider = ?
    `).run(
      boolToInt(next.enabled),
      next.base_url,
      next.user_id,
      next.api_key,
      next.default_sim,
      next.rider_statuses,
      next.rider_template,
      next.notes,
      PROVIDER
    );
  } else {
    await db.prepare(`
      INSERT INTO sms_settings (
        provider, enabled, base_url, user_id, api_key, default_sim, rider_statuses, rider_template, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      PROVIDER,
      boolToInt(next.enabled),
      next.base_url,
      next.user_id,
      next.api_key,
      next.default_sim,
      next.rider_statuses,
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

async function sendRiderStatusSms(db, posOrder = {}, options = {}) {
  const setting = await getPrivateSetting(db);
  if (!setting.enabled) return { skipped: 'disabled' };

  const status = normalizeStatus(posOrder.status_name);
  const allowedStatuses = parseStatusList(setting.rider_statuses);
  if (!allowedStatuses.includes(status)) return { skipped: 'status_not_configured' };

  const mobile = normalizeMobile(posOrder.sprinter_tel);
  if (!mobile) return { skipped: 'missing_rider_number' };
  if (!stringOrNull(posOrder.sprinter_name)) return { skipped: 'missing_rider_name' };

  const shopId = stringOrNull(posOrder.shop_id) || 'unknown';
  const externalId = stringOrNull(posOrder.external_id);
  if (!externalId) return { skipped: 'missing_order_id' };

  const eventKey = `rider-status:${shopId}:${externalId}:${status}:${mobile}`;
  const message = truncate(renderTemplate(setting.rider_template, posOrder), 1550);
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
  if (!log.inserted) return { skipped: 'duplicate', event_key: eventKey };

  try {
    const result = await sendSms(db, { mobile, message, sim: options.sim });
    await updateSmsLog(db, log.id, { status: 'sent', smsid: result.smsid || null });
    return { sent: true, smsid: result.smsid || null, event_key: eventKey };
  } catch (error) {
    await updateSmsLog(db, log.id, { status: 'failed', error_message: truncate(error.message, 500) });
    return { sent: false, error: error.message, event_key: eventKey };
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_RIDER_STATUSES,
  DEFAULT_RIDER_TEMPLATE,
  getPublicSetting,
  saveSetting,
  sendSms,
  sendRiderStatusSms,
  listSmsLogs,
  normalizeMobile,
};
