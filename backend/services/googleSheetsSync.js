const crypto = require('crypto');

const PROVIDER = 'google_sheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const DEFAULT_RANGE = 'Orders!A:Z';
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function numberOrDefault(value, fallback = 0) {
  const cleaned = typeof value === 'string'
    ? value.replace(/[^\d.-]/g, '')
    : value;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolToInt(value) {
  return value ? 1 : 0;
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

function truncate(value, length = 500) {
  if (!value) return null;
  const text = String(value);
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizePrivateKey(value) {
  const text = stringOrNull(value);
  if (!text) return null;

  let key = text;

  // Extract from full service account JSON if pasted
  try {
    const parsed = JSON.parse(key);
    if (parsed?.private_key) key = String(parsed.private_key);
  } catch {}

  // Convert literal \n sequences to real newlines, strip carriage returns
  key = key.replace(/\\n/g, '\n').replace(/\r/g, '').trim();

  return key;
}

function parseServiceAccountJson(value) {
  const text = stringOrNull(value);
  if (!text || !text.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed?.type !== 'service_account') return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeHeaderKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseSheetNames(value) {
  const text = stringOrNull(value);
  if (!text) return [];
  const names = text
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return names.length ? [...new Set(names)] : [];
}

function shouldAutoDiscoverTabs(names) {
  if (!Array.isArray(names) || names.length === 0) return true;
  return names.some((name) => {
    const normalized = String(name || '').trim().toLowerCase();
    return normalized === '*' || normalized === 'all';
  });
}

function buildSheetRange(sheetName) {
  const escapedSheetName = String(sheetName || 'Orders').replace(/'/g, "''");
  return `'${escapedSheetName}'!A:Z`;
}

function getFirstValue(row, aliases = []) {
  for (const alias of aliases) {
    const key = normalizeHeaderKey(alias);
    if (key && Object.prototype.hasOwnProperty.call(row, key)) {
      return row[key];
    }
  }
  return null;
}

function normalizeStatus(value) {
  const text = stringOrNull(value);
  if (!text) return 'Confirmed';

  const normalized = text.toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (['confirmed', 'confirm', 'purchased'].includes(normalized)) return 'Confirmed';
  if (['waiting for pickup', 'waiting pickup', 'waiting for pick up', 'waiting pick up', 'packaging'].includes(normalized)) return 'Waiting for pickup';
  if (['new', 'draft', 'created'].includes(normalized)) return 'New';
  if (['pending'].includes(normalized)) return 'Confirmed';
  if (['shipped', 'shipping', 'submitted', 'in transit', 'delivering'].includes(normalized)) return 'Shipped';
  if (['delivered', 'complete', 'completed', 'success'].includes(normalized)) return 'Delivered';
  if (['returned', 'return', 'rts', 'return to sender', 'failed delivery'].includes(normalized)) return 'Returned';
  if (['returning', 'for return', 'returning to seller'].includes(normalized)) return 'Returning';
  if (['canceled', 'cancelled', 'removed', 'deleted'].includes(normalized)) return 'Canceled';
  return 'Confirmed';
}

function formatDateParts(year, month, day) {
  if (!year || !month || !day) return null;
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeSheetDate(value) {
  const text = stringOrNull(value);
  if (!text) return new Date().toISOString().slice(0, 10);

  const isoMatch = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    return formatDateParts(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]))
      || new Date().toISOString().slice(0, 10);
  }

  const slashMatch = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (slashMatch) {
    const first = Number(slashMatch[1]);
    const second = Number(slashMatch[2]);
    const year = Number(slashMatch[3]);
    const preferDayFirst = String(process.env.GOOGLE_SHEETS_DATE_FORMAT || '').toLowerCase().startsWith('d');
    const month = first > 12 || preferDayFirst ? second : first;
    const day = first > 12 || preferDayFirst ? first : second;
    return formatDateParts(year, month, day) || new Date().toISOString().slice(0, 10);
  }

  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 0 && serial < 100000) {
    const epoch = Date.UTC(1899, 11, 30);
    const date = new Date(epoch + Math.floor(serial) * 24 * 60 * 60 * 1000);
    return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
      || new Date().toISOString().slice(0, 10);
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return formatDateParts(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate())
      || new Date().toISOString().slice(0, 10);
  }

  return new Date().toISOString().slice(0, 10);
}

async function getSetting(db) {
  return await db.prepare("SELECT * FROM integration_settings WHERE provider = ? AND connection_id = ''").get(PROVIDER) || null;
}

async function getPublicSetting(db) {
  const setting = await getSetting(db);
  if (!setting) {
    return {
      provider: PROVIDER,
      configured: false,
      enabled: false,
      spreadsheet_id: null,
      sheet_name: '',
      auto_discover_tabs: true,
      sync_mode: 'manual',
      sync_interval_ms: DEFAULT_SYNC_INTERVAL_MS,
      has_service_account_email: false,
      has_private_key: false,
      notes: null,
    };
  }

  const storedSheetName = setting.page_id || '';
  return {
    provider: PROVIDER,
    configured: true,
    enabled: Boolean(setting.enabled),
    spreadsheet_id: setting.base_url || null,
    sheet_name: storedSheetName,
    auto_discover_tabs: shouldAutoDiscoverTabs(parseSheetNames(storedSheetName)),
    sync_mode: setting.sync_mode || 'manual',
    sync_interval_ms: numberOrDefault(setting.page_access_token, DEFAULT_SYNC_INTERVAL_MS),
    has_service_account_email: Boolean(setting.api_key),
    has_private_key: Boolean(setting.user_access_token),
    private_key_id: setting.webhook_secret || null,
    notes: setting.notes || null,
    updated_at: setting.updated_at,
  };
}

async function saveSetting(db, payload = {}) {
  const current = await getSetting(db);
  const serviceAccountJson = parseServiceAccountJson(payload.private_key)
    || parseServiceAccountJson(payload.service_account_json);
  const next = {
    enabled: payload.enabled ?? current?.enabled ?? 0,
    spreadsheet_id: payload.spreadsheet_id ?? current?.base_url ?? process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? null,
    sheet_name: payload.sheet_name ?? current?.page_id ?? process.env.GOOGLE_SHEETS_SHEET_NAME ?? '',
    service_account_email: serviceAccountJson?.client_email ?? payload.service_account_email ?? current?.api_key ?? process.env.GOOGLE_SHEETS_CLIENT_EMAIL ?? null,
    private_key: serviceAccountJson?.private_key ?? payload.private_key ?? current?.user_access_token ?? process.env.GOOGLE_SHEETS_PRIVATE_KEY ?? null,
    private_key_id: serviceAccountJson?.private_key_id ?? payload.private_key_id ?? current?.webhook_secret ?? process.env.GOOGLE_SHEETS_PRIVATE_KEY_ID ?? null,
    sync_mode: payload.sync_mode ?? current?.sync_mode ?? process.env.GOOGLE_SHEETS_SYNC_MODE ?? 'manual',
    sync_interval_ms: String(payload.sync_interval_ms ?? current?.page_access_token ?? process.env.GOOGLE_SHEETS_SYNC_INTERVAL_MS ?? DEFAULT_SYNC_INTERVAL_MS),
    notes: payload.notes ?? current?.notes ?? null,
  };

  if (current) {
    await db.prepare(`
      UPDATE integration_settings
      SET enabled = ?, base_url = ?, api_key = ?, user_access_token = ?, page_id = ?, page_access_token = ?,
          webhook_secret = ?, sync_mode = ?, notes = ?, updated_at = datetime('now')
      WHERE provider = ? AND connection_id = ''
    `).run(
      boolToInt(next.enabled),
      next.spreadsheet_id,
      next.service_account_email,
      next.private_key,
      next.sheet_name,
      next.sync_interval_ms,
      next.private_key_id,
      next.sync_mode,
      next.notes,
      PROVIDER
    );
  } else {
    await db.prepare(`
      INSERT INTO integration_settings (
        provider, connection_id, enabled, base_url, api_key, user_access_token, page_id, page_access_token, webhook_secret, sync_mode, notes
      )
      VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      PROVIDER,
      boolToInt(next.enabled),
      next.spreadsheet_id,
      next.service_account_email,
      next.private_key,
      next.sheet_name,
      next.sync_interval_ms,
      next.private_key_id,
      next.sync_mode,
      next.notes
    );
  }

  return await getPublicSetting(db);
}

async function startRun(db, triggerType, payloadSummary) {
  const result = await db.prepare(`
    INSERT INTO integration_sync_runs (provider, direction, trigger_type, payload_summary)
    VALUES (?, 'inbound', ?, ?)
  `).run(PROVIDER, triggerType, safeJson(payloadSummary));

  return Number(result.lastInsertRowid);
}

async function finishRun(db, runId, status, resultSummary, errorMessage) {
  await db.prepare(`
    UPDATE integration_sync_runs
    SET status = ?, result_summary = ?, error_message = ?, finished_at = datetime('now')
    WHERE id = ?
  `).run(status, safeJson(resultSummary), errorMessage || null, runId);
}

async function upsertSourceLink(db, entityType, externalId, localTable, localId) {
  if (!externalId) return;

  await db.prepare(`
    INSERT INTO integration_source_links (provider, entity_type, external_id, local_table, local_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, entity_type, external_id)
    DO UPDATE SET local_table = excluded.local_table, local_id = excluded.local_id, last_synced_at = datetime('now')
  `).run(PROVIDER, entityType, String(externalId), localTable, String(localId));
}

function buildAccessTokenRequestBody(clientEmail, privateKey, privateKeyId) {
  const now = Math.floor(Date.now() / 1000);
  const header = privateKeyId
    ? { alg: 'RS256', typ: 'JWT', kid: privateKeyId }
    : { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;

  // createPrivateKey() avoids OpenSSL 3 "DECODER routines:unsupported" on raw PEM strings
  let keyObject;
  try {
    keyObject = crypto.createPrivateKey({ key: privateKey, format: 'pem' });
  } catch (err) {
    throw new Error(`Invalid private key — check PEM format: ${err.message}`);
  }

  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), keyObject)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const assertion = `${unsigned}.${signature}`;

  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
}

async function requestGoogleAccessToken(clientEmail, privateKey, privateKeyId) {
  const body = buildAccessTokenRequestBody(clientEmail, privateKey, privateKeyId);
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Google token request failed (${response.status})`);
  }
  return data.access_token;
}

async function fetchSheetRows(spreadsheetId, range, accessToken) {
  const encodedRange = encodeURIComponent(range);
  const response = await fetch(`${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `Google Sheets request failed (${response.status})`);
  }
  return Array.isArray(data.values) ? data.values : [];
}

async function fetchSpreadsheetTabs(spreadsheetId, accessToken) {
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(title,hidden)`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `Google Sheets metadata request failed (${response.status})`);
  }
  const sheets = Array.isArray(data.sheets) ? data.sheets : [];
  return sheets
    .map((sheet) => sheet?.properties)
    .filter((props) => props && !props.hidden && stringOrNull(props.title))
    .map((props) => String(props.title).trim());
}

function rowsToObjects(rows) {
  const [header = [], ...items] = rows;
  const keys = header.map((value, index) => normalizeHeaderKey(value) || `column_${index + 1}`);
  return items
    .filter((row) => Array.isArray(row) && row.some((value) => String(value || '').trim() !== ''))
    .map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index] ?? null])));
}

function normalizeOrderRecord(row, sheetName) {
  const pageName = stringOrNull(getFirstValue(row, ['page', 'page_name', 'page name', 'chat_page', 'chat page', 'account', 'account_name', 'shop', 'shop_name', 'fb_page', 'fb page', 'facebook_page', 'facebook page']));
  const externalId = stringOrNull(getFirstValue(row, [
    'order_ref',
    'external_id',
    'id',
    'order id',
    'order no',
    'order number',
    'reference',
    'ref',
    'tracking_no',
    'tracking_number',
  ]));
  const trackingNo = stringOrNull(getFirstValue(row, [
    'tracking_no',
    'tracking_number',
    'tracking',
    'tracking id',
    'tracking_id',
    'tracking number',
    'waybill',
    'waybill no',
    'waybill number',
    'awb',
    'airway bill',
  ]));
  const explicitOrderRef = stringOrNull(getFirstValue(row, [
    'order_ref',
    'order_id',
    'order id',
    'order no',
    'order number',
    'reference',
    'ref',
    'id',
  ]));
  const rawOrderDate = getFirstValue(row, [
    'order_date',
    'order date',
    'day_created',
    'date_created',
    'created_at',
    'date',
    'created_date',
    'inserted_at',
    'updated_at',
  ]);
  const orderDate = normalizeSheetDate(rawOrderDate);
  const customerName = getFirstValue(row, [
    'customer',
    'customer_name',
    'customer name',
    'name',
    'buyer_name',
    'buyer name',
    'recipient_name',
    'recipient name',
    'full_name',
    'full name',
    'bill_full_name',
    'bill full name',
  ]);
  const phone = getFirstValue(row, [
    'phone',
    'phone_number',
    'phone number',
    'mobile',
    'mobile_number',
    'contact_number',
    'contact number',
    'cellphone',
    'cellphone_number',
    'bill_phone_number',
    'bill phone number',
  ]);
  const product = getFirstValue(row, [
    'product',
    'product_name',
    'product name',
    'item',
    'items',
    'variation',
    'variation_name',
    'variation name',
    'sku',
    'package',
  ]);
  const tags = getFirstValue(row, [
    'tags',
    'tag',
    'labels',
    'label',
    'pancake_tags',
    'pancake tags',
    'pos_tags',
    'pos tags',
  ]);
  const confirmedBy = getFirstValue(row, [
    'confirmed_by',
    'confirmed by',
    'confirmer',
    'confirmed_by_name',
    'confirmed by name',
    'agent',
    'agent_name',
    'agent name',
    'staff',
    'staff_name',
    'staff name',
    'seller',
    'seller_name',
    'seller name',
    'handled_by',
    'handled by',
  ]);
  const rawAttempts = getFirstValue(row, [
    'attempts',
    'attempt',
    'attempt_no',
    'attempt no',
    'attempt_number',
    'attempt number',
    'delivery_attempt',
    'delivery attempt',
    'delivery_attempt_counts',
    'delivery attempt counts',
    'delivery_attempts',
    'delivery attempts',
    'attempt_count',
    'attempt count',
  ]);
  const stableFallback = crypto
    .createHash('sha1')
    .update(safeJson({
      sheetName,
      trackingNo,
      customer: customerName,
      phone,
      product,
      orderDate,
    }))
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();

  return {
    externalId: externalId || trackingNo || stableFallback,
    order_ref: explicitOrderRef || (trackingNo ? `GS-${trackingNo}` : `GS-${normalizeHeaderKey(sheetName).toUpperCase()}-${stableFallback}`),
    tracking_no: trackingNo,
    customer: stringOrNull(customerName) || 'Unknown Customer',
    phone: stringOrNull(phone),
    product: stringOrNull(product) || 'Unknown Product',
    tags: stringOrNull(tags),
    confirmed_by: stringOrNull(confirmedBy),
    attempts: Math.max(1, Math.round(numberOrDefault(rawAttempts, 1))),
    qty: Math.max(1, Math.round(numberOrDefault(getFirstValue(row, ['qty', 'quantity', 'total_quantity', 'total quantity']), 1))),
    cod_amount: numberOrDefault(getFirstValue(row, ['cod_amount', 'cod', 'amount', 'price', 'total', 'total_price', 'total price', 'money_to_collect']), 0),
    status: normalizeStatus(getFirstValue(row, ['status', 'status_name', 'status name', 'order_status', 'order status'])),
    courier: stringOrNull(getFirstValue(row, ['courier', 'shipper', 'shipping_provider', 'shipping provider', 'logistics', 'delivery_partner', 'delivery partner'])),
    order_date: orderDate,
    source_sheet: pageName || stringOrNull(sheetName) || 'Orders',
  };
}


async function safeUpsertSourceLink(db, entityType, externalId, localTable, localId) {
  try {
    await upsertSourceLink(db, entityType, externalId, localTable, localId);
  } catch (error) {
    console.warn(`[google_sheets] source link skipped: ${error.message}`);
  }
}

async function upsertGoogleOrder(db, normalized, rawRow, spreadsheetId, sheetName, rowNumber) {
  const externalId = stringOrNull(normalized.externalId);
  if (!externalId) return null;

  const rawStatus = stringOrNull(getFirstValue(rawRow, [
    'status', 'status_name', 'status name', 'order_status', 'order status',
  ]));
  const chatPage = stringOrNull(getFirstValue(rawRow, [
    'chat_page', 'chat page', 'page', 'page_name', 'page name',
    'account', 'account_name', 'shop', 'shop_name',
    'fb_page', 'fb page', 'facebook_page', 'facebook page',
  ]));
  const tag = stringOrNull(getFirstValue(rawRow, ['tag', 'tags', 'label', 'labels']));
  const pancakeTags = stringOrNull(getFirstValue(rawRow, [
    'pancake_tags', 'pancake tags', 'pos_tags', 'pos tags',
  ]));
  const internalNotes = stringOrNull(getFirstValue(rawRow, [
    'internal_notes', 'internal notes', 'internal_note', 'internal note',
    'notes', 'note', 'remarks', 'remark', 'comment', 'comments',
    'admin_note', 'admin notes', 'agent_notes', 'agent notes',
  ]));
  const address = stringOrNull(getFirstValue(rawRow, [
    'address', 'shipping_address', 'shipping address', 'street_address', 'street address',
    'full_address', 'full address', 'bill_address', 'bill address',
    'delivery_address', 'delivery address', 'street', 'location',
  ]));
  const province = stringOrNull(getFirstValue(rawRow, [
    'province', 'state', 'region', 'bill_state', 'bill state',
    'shipping_state', 'shipping state', 'bill_province', 'bill province',
    'shipping_province', 'shipping province',
  ]));

  await db.prepare(`
    INSERT INTO google_orders (
      external_id, tracking_no, customer_name, customer_phone, product_name,
      quantity, cod, status, status_normalized, courier, day_created, chat_page,
      confirmed_by, delivery_attempts, tag, pancake_tags,
      internal_notes, address, province,
      spreadsheet_id, source_sheet, sheet_row_number, raw_row, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(external_id) DO UPDATE SET
      tracking_no = excluded.tracking_no,
      customer_name = excluded.customer_name,
      customer_phone = excluded.customer_phone,
      product_name = excluded.product_name,
      quantity = excluded.quantity,
      cod = excluded.cod,
      status = excluded.status,
      status_normalized = excluded.status_normalized,
      courier = excluded.courier,
      day_created = excluded.day_created,
      chat_page = excluded.chat_page,
      confirmed_by = COALESCE(excluded.confirmed_by, google_orders.confirmed_by),
      delivery_attempts = excluded.delivery_attempts,
      tag = excluded.tag,
      pancake_tags = excluded.pancake_tags,
      internal_notes = excluded.internal_notes,
      address = excluded.address,
      province = excluded.province,
      spreadsheet_id = excluded.spreadsheet_id,
      source_sheet = excluded.source_sheet,
      sheet_row_number = excluded.sheet_row_number,
      raw_row = excluded.raw_row,
      updated_at = datetime('now')
  `).run(
    externalId,
    normalized.tracking_no,
    normalized.customer,
    normalized.phone,
    normalized.product,
    normalized.qty,
    normalized.cod_amount,
    rawStatus,
    normalized.status,
    normalized.courier,
    normalized.order_date,
    chatPage,
    normalized.confirmed_by,
    normalized.attempts,
    tag,
    pancakeTags,
    internalNotes,
    address,
    province,
    spreadsheetId,
    sheetName,
    rowNumber,
    safeJson(rawRow)
  );
  return externalId;
}

async function upsertOrder(db, record) {
  const existingByOrderRef = await db.prepare('SELECT id FROM orders WHERE order_ref = ?').get(record.order_ref);
  if (existingByOrderRef) {
    await db.prepare(`
      UPDATE orders
      SET tracking_no = ?,
          customer = ?,
          phone = ?,
          product = ?,
          tags = ?,
          qty = ?,
          cod_amount = ?,
          status = ?,
          courier = ?,
          source_sheet = ?,
          confirmed_by = COALESCE(?, confirmed_by),
          attempts = ?,
          order_date = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      record.tracking_no,
      record.customer,
      record.phone,
      record.product,
      record.tags,
      record.qty,
      record.cod_amount,
      record.status,
      record.courier,
      record.source_sheet,
      record.confirmed_by,
      record.attempts,
      record.order_date,
      existingByOrderRef.id
    );
    return Number(existingByOrderRef.id);
  }

  const existingByTracking = record.tracking_no
    ? await db.prepare('SELECT id FROM orders WHERE tracking_no = ? ORDER BY updated_at DESC, id DESC LIMIT 1').get(record.tracking_no)
    : null;

  if (existingByTracking) {
    await db.prepare(`
      UPDATE orders
      SET tracking_no = ?,
          customer = ?,
          phone = ?,
          product = ?,
          tags = ?,
          qty = ?,
          cod_amount = ?,
          status = ?,
          courier = ?,
          source_sheet = ?,
          confirmed_by = COALESCE(?, confirmed_by),
          attempts = ?,
          order_date = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      record.tracking_no,
      record.customer,
      record.phone,
      record.product,
      record.tags,
      record.qty,
      record.cod_amount,
      record.status,
      record.courier,
      record.source_sheet,
      record.confirmed_by,
      record.attempts,
      record.order_date,
      existingByTracking.id
    );
    return Number(existingByTracking.id);
  }

  const result = await db.prepare(`
    INSERT INTO orders (
      order_ref, tracking_no, customer, phone, product, tags, qty, cod_amount, status, courier, source_sheet, confirmed_by, attempts, order_date, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(order_ref) DO UPDATE SET
      tracking_no = excluded.tracking_no,
      customer = excluded.customer,
      phone = excluded.phone,
      product = excluded.product,
      tags = excluded.tags,
      qty = excluded.qty,
      cod_amount = excluded.cod_amount,
      status = excluded.status,
      courier = excluded.courier,
      source_sheet = excluded.source_sheet,
      confirmed_by = COALESCE(excluded.confirmed_by, orders.confirmed_by),
      attempts = excluded.attempts,
      order_date = excluded.order_date,
      updated_at = datetime('now')
  `).run(
    record.order_ref,
    record.tracking_no,
    record.customer,
    record.phone,
    record.product,
    record.tags,
    record.qty,
    record.cod_amount,
    record.status,
    record.courier,
    record.source_sheet,
    record.confirmed_by,
    record.attempts,
    record.order_date
  );

  const insertedId = Number(result.lastInsertRowid || 0);
  const local = await db.prepare('SELECT id FROM orders WHERE order_ref = ?').get(record.order_ref);
  return insertedId || Number(local?.id || 0);
}

async function deleteDuplicateSyncedOrders(db) {
  const result = await db.prepare(`
    DELETE FROM orders
    WHERE tracking_no IS NOT NULL
      AND TRIM(tracking_no) <> ''
      AND id NOT IN (
        SELECT MAX(id)
        FROM orders
        WHERE tracking_no IS NOT NULL AND TRIM(tracking_no) <> ''
        GROUP BY tracking_no
      )
      AND tracking_no IN (
        SELECT tracking_no
        FROM orders
        WHERE tracking_no IS NOT NULL AND TRIM(tracking_no) <> ''
        GROUP BY tracking_no
        HAVING COUNT(*) > 1
      )
  `).run();

  return Number(result.changes || 0);
}

async function getCounts(db) {
  return {
    orders: (await db.prepare('SELECT COUNT(*) AS count FROM orders').get()).count,
  };
}

async function collectSheetData(db, payload = {}, triggerType = 'manual') {
  const setting = await getSetting(db);
  const enabled = payload.enabled ?? setting?.enabled ?? process.env.GOOGLE_SHEETS_SYNC_ENABLED ?? 0;
  if (!enabled && triggerType === 'scheduled') {
    return { skipped: true, reason: 'Google Sheets sync is disabled.' };
  }

  const spreadsheetId = stringOrNull(payload.spreadsheet_id || setting?.base_url || process.env.GOOGLE_SHEETS_SPREADSHEET_ID);
  const configuredSheetNames = parseSheetNames(payload.sheet_name || setting?.page_id || process.env.GOOGLE_SHEETS_SHEET_NAME);
  const autoDiscover = shouldAutoDiscoverTabs(configuredSheetNames);
  const explicitNames = autoDiscover
    ? configuredSheetNames.filter((name) => {
        const n = String(name || '').trim().toLowerCase();
        return n && n !== '*' && n !== 'all';
      })
    : configuredSheetNames;
  const clientEmail = stringOrNull(payload.service_account_email || setting?.api_key || process.env.GOOGLE_SHEETS_CLIENT_EMAIL);
  const privateKey = normalizePrivateKey(payload.private_key || setting?.user_access_token || process.env.GOOGLE_SHEETS_PRIVATE_KEY);
  const privateKeyId = stringOrNull(payload.private_key_id || setting?.webhook_secret || process.env.GOOGLE_SHEETS_PRIVATE_KEY_ID);
  const entityType = 'orders';

  if (!spreadsheetId || !clientEmail || !privateKey) {
    throw new Error('Missing Google Sheets configuration. Save spreadsheet ID, service account email, and private key first.');
  }

  const runId = await startRun(db, triggerType, {
    spreadsheet_id: spreadsheetId,
    sheet_names: configuredSheetNames,
    auto_discover: autoDiscover,
    entity_type: entityType,
  });

  const result = {
    spreadsheet_id: spreadsheetId,
    sheet_name: configuredSheetNames.join(', '),
    sheet_names: [],
    auto_discover: autoDiscover,
    entity_type: entityType,
    imported: 0,
    updated: 0,
    total_rows: 0,
    failed_rows: [],
    first_error: null,
    error_counts: {},
    sheets: [],
  };

  try {
    const accessToken = await requestGoogleAccessToken(clientEmail, privateKey, privateKeyId);

    let sheetNames;
    if (autoDiscover) {
      const discovered = await fetchSpreadsheetTabs(spreadsheetId, accessToken);
      sheetNames = [...new Set([...explicitNames, ...discovered])];
      if (!sheetNames.length) {
        throw new Error('No visible tabs found in this spreadsheet.');
      }
    } else {
      sheetNames = explicitNames;
    }
    result.sheet_names = sheetNames;

    for (const sheetName of sheetNames) {
      const range = stringOrNull(payload.range) || buildSheetRange(sheetName);
      const rows = await fetchSheetRows(spreadsheetId, range, accessToken);
      const records = rowsToObjects(rows);
      const sheetSummary = {
        sheet_name: sheetName,
        range,
        sample_headers: rows[0] || [],
        total_rows: records.length,
        imported: 0,
        updated: 0,
        failed: 0,
      };

      result.total_rows += records.length;

      for (let index = 0; index < records.length; index += 1) {
        const row = records[index];
        try {
          const normalized = normalizeOrderRecord(row, sheetName);
          await upsertGoogleOrder(db, normalized, row, spreadsheetId, sheetName, index + 2);
          const existing = normalized.tracking_no
            ? await db.prepare(`
                SELECT id FROM orders
                WHERE order_ref = ? OR tracking_no = ?
                LIMIT 1
              `).get(normalized.order_ref, normalized.tracking_no)
            : await db.prepare(`
                SELECT id FROM orders
                WHERE order_ref = ?
                LIMIT 1
              `).get(normalized.order_ref);
          const localId = await upsertOrder(db, normalized);
          if (existing?.id) {
            result.updated += 1;
            sheetSummary.updated += 1;
          } else {
            result.imported += 1;
            sheetSummary.imported += 1;
          }
          await safeUpsertSourceLink(db, entityType, `${sheetName}:${normalized.externalId || normalized.order_ref}`, 'orders', localId);
        } catch (error) {
          const errorMessage = truncate(error.message, 240);
          if (!result.first_error) {
            result.first_error = {
              sheet_name: sheetName,
              row_number: index + 2,
              error: errorMessage,
            };
          }
          result.error_counts[errorMessage] = (result.error_counts[errorMessage] || 0) + 1;
          result.failed_rows.push({
            sheet_name: sheetName,
            row_number: index + 2,
            error: errorMessage,
          });
          sheetSummary.failed += 1;
        }
      }

      result.sheets.push(sheetSummary);
    }

    result.duplicates_deleted = await deleteDuplicateSyncedOrders(db);
    const status = result.failed_rows.length ? 'partial' : 'success';
    await finishRun(db, runId, status, result, null);
    return result;
  } catch (error) {
    await finishRun(db, runId, 'failed', result, truncate(error.message));
    throw error;
  }
}

async function runScheduledSync(db) {
  const setting = await getSetting(db);
  const syncMode = setting?.sync_mode || process.env.GOOGLE_SHEETS_SYNC_MODE || 'manual';
  const enabled = Boolean(setting?.enabled ?? (String(process.env.GOOGLE_SHEETS_SYNC_ENABLED || '').toLowerCase() === 'true'));

  if (!enabled || syncMode === 'manual') {
    return { skipped: true, reason: 'Automatic Google Sheets sync is disabled.' };
  }

  return await collectSheetData(db, {}, 'scheduled');
}

async function getLatestFinishedRun(db) {
  return await db.prepare(`
    SELECT status, finished_at
    FROM integration_sync_runs
    WHERE provider = ? AND finished_at IS NOT NULL AND status IN ('success', 'partial')
    ORDER BY finished_at DESC
    LIMIT 1
  `).get(PROVIDER) || null;
}

async function shouldUseSheetsAsSource(setting) {
  const syncMode = setting?.sync_mode || process.env.GOOGLE_SHEETS_SYNC_MODE || 'manual';
  const enabled = Boolean(setting?.enabled ?? (String(process.env.GOOGLE_SHEETS_SYNC_ENABLED || '').toLowerCase() === 'true'));
  return enabled && ['automatic', 'source_of_data'].includes(syncMode);
}

async function ensureFreshSourceData(db) {
  const setting = await getSetting(db);
  if (!(await shouldUseSheetsAsSource(setting))) {
    return { skipped: true, reason: 'Google Sheets is not configured as an order source.' };
  }

  const latestRun = await getLatestFinishedRun(db);
  const intervalMs = await getSyncIntervalMs(db);
  const finishedAt = latestRun?.finished_at ? new Date(latestRun.finished_at.replace(' ', 'T')) : null;
  const isFresh = finishedAt && !Number.isNaN(finishedAt.getTime()) && (Date.now() - finishedAt.getTime()) < intervalMs;
  if (isFresh) {
    return { skipped: true, reason: 'Google Sheets source data is already fresh.' };
  }

  return await collectSheetData(db, {}, 'source_read');
}

async function getStatus(db) {
  const setting = await getPublicSetting(db);
  const latestRuns = await db.prepare(`
    SELECT id, status, trigger_type, payload_summary, result_summary, error_message, started_at, finished_at
    FROM integration_sync_runs
    WHERE provider = ?
    ORDER BY started_at DESC
    LIMIT 10
  `).all(PROVIDER);

  return {
    ...setting,
    latest_runs: latestRuns.map((run) => ({
      ...run,
      payload_summary: run.payload_summary ? JSON.parse(run.payload_summary) : null,
      result_summary: run.result_summary ? JSON.parse(run.result_summary) : null,
    })),
    local_counts: await getCounts(db),
  };
}

async function getSyncIntervalMs(db) {
  const setting = await getSetting(db);
  return Math.max(
    60 * 1000,
    numberOrDefault(setting?.page_access_token || process.env.GOOGLE_SHEETS_SYNC_INTERVAL_MS, DEFAULT_SYNC_INTERVAL_MS)
  );
}

module.exports = {
  PROVIDER,
  DEFAULT_RANGE,
  getStatus,
  getPublicSetting,
  saveSetting,
  collectSheetData,
  ensureFreshSourceData,
  runScheduledSync,
  getSyncIntervalMs,
};
