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
  const parsed = Number(value);
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
  return text ? text.replace(/\\n/g, '\n') : null;
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
  if (!text) return ['Orders'];
  const names = text
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return names.length ? [...new Set(names)] : ['Orders'];
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
  if (!text) return 'Pending';

  const normalized = text.toLowerCase();
  if (normalized === 'pending') return 'Pending';
  if (normalized === 'shipped') return 'Shipped';
  if (normalized === 'delivered') return 'Delivered';
  if (normalized === 'returned') return 'Returned';
  if (normalized === 'returning') return 'Returning';
  return 'Pending';
}

function getSetting(db) {
  return db.prepare('SELECT * FROM integration_settings WHERE provider = ?').get(PROVIDER) || null;
}

function getPublicSetting(db) {
  const setting = getSetting(db);
  if (!setting) {
    return {
      provider: PROVIDER,
      configured: false,
      enabled: false,
      spreadsheet_id: null,
      sheet_name: 'Orders',
      sync_mode: 'manual',
      sync_interval_ms: DEFAULT_SYNC_INTERVAL_MS,
      has_service_account_email: false,
      has_private_key: false,
      notes: null,
    };
  }

  return {
    provider: PROVIDER,
    configured: true,
    enabled: Boolean(setting.enabled),
    spreadsheet_id: setting.base_url || null,
    sheet_name: setting.page_id || 'Orders',
    sync_mode: setting.sync_mode || 'manual',
    sync_interval_ms: numberOrDefault(setting.page_access_token, DEFAULT_SYNC_INTERVAL_MS),
    has_service_account_email: Boolean(setting.api_key),
    has_private_key: Boolean(setting.user_access_token),
    notes: setting.notes || null,
    updated_at: setting.updated_at,
  };
}

function saveSetting(db, payload = {}) {
  const current = getSetting(db);
  const next = {
    enabled: payload.enabled ?? current?.enabled ?? 0,
    spreadsheet_id: payload.spreadsheet_id ?? current?.base_url ?? process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? null,
    sheet_name: payload.sheet_name ?? current?.page_id ?? process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Orders',
    service_account_email: payload.service_account_email ?? current?.api_key ?? process.env.GOOGLE_SHEETS_CLIENT_EMAIL ?? null,
    private_key: payload.private_key ?? current?.user_access_token ?? process.env.GOOGLE_SHEETS_PRIVATE_KEY ?? null,
    sync_mode: payload.sync_mode ?? current?.sync_mode ?? process.env.GOOGLE_SHEETS_SYNC_MODE ?? 'manual',
    sync_interval_ms: String(payload.sync_interval_ms ?? current?.page_access_token ?? process.env.GOOGLE_SHEETS_SYNC_INTERVAL_MS ?? DEFAULT_SYNC_INTERVAL_MS),
    notes: payload.notes ?? current?.notes ?? null,
  };

  if (current) {
    db.prepare(`
      UPDATE integration_settings
      SET enabled = ?, base_url = ?, api_key = ?, user_access_token = ?, page_id = ?, page_access_token = ?,
          sync_mode = ?, notes = ?, updated_at = datetime('now')
      WHERE provider = ?
    `).run(
      boolToInt(next.enabled),
      next.spreadsheet_id,
      next.service_account_email,
      next.private_key,
      next.sheet_name,
      next.sync_interval_ms,
      next.sync_mode,
      next.notes,
      PROVIDER
    );
  } else {
    db.prepare(`
      INSERT INTO integration_settings (
        provider, enabled, base_url, api_key, user_access_token, page_id, page_access_token, sync_mode, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      PROVIDER,
      boolToInt(next.enabled),
      next.spreadsheet_id,
      next.service_account_email,
      next.private_key,
      next.sheet_name,
      next.sync_interval_ms,
      next.sync_mode,
      next.notes
    );
  }

  return getPublicSetting(db);
}

function startRun(db, triggerType, payloadSummary) {
  const result = db.prepare(`
    INSERT INTO integration_sync_runs (provider, direction, trigger_type, payload_summary)
    VALUES (?, 'inbound', ?, ?)
  `).run(PROVIDER, triggerType, safeJson(payloadSummary));

  return Number(result.lastInsertRowid);
}

function finishRun(db, runId, status, resultSummary, errorMessage) {
  db.prepare(`
    UPDATE integration_sync_runs
    SET status = ?, result_summary = ?, error_message = ?, finished_at = datetime('now')
    WHERE id = ?
  `).run(status, safeJson(resultSummary), errorMessage || null, runId);
}

function recordRaw(db, entityType, externalId, payload, outcome = {}) {
  db.prepare(`
    INSERT INTO integration_raw_records (provider, entity_type, external_id, mapped_table, local_id, sync_status, error_message, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    PROVIDER,
    entityType,
    stringOrNull(externalId),
    outcome.mappedTable || null,
    outcome.localId ? String(outcome.localId) : null,
    outcome.status || 'stored',
    outcome.errorMessage || null,
    safeJson(payload)
  );
}

function upsertSourceLink(db, entityType, externalId, localTable, localId) {
  if (!externalId) return;

  db.prepare(`
    INSERT INTO integration_source_links (provider, entity_type, external_id, local_table, local_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, entity_type, external_id)
    DO UPDATE SET local_table = excluded.local_table, local_id = excluded.local_id, last_synced_at = datetime('now')
  `).run(PROVIDER, entityType, String(externalId), localTable, String(localId));
}

function buildAccessTokenRequestBody(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey)
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

async function requestGoogleAccessToken(clientEmail, privateKey) {
  const body = buildAccessTokenRequestBody(clientEmail, privateKey);
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

function rowsToObjects(rows) {
  const [header = [], ...items] = rows;
  const keys = header.map((value, index) => normalizeHeaderKey(value) || `column_${index + 1}`);
  return items
    .filter((row) => Array.isArray(row) && row.some((value) => String(value || '').trim() !== ''))
    .map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index] ?? null])));
}

function normalizeOrderRecord(row, sheetName) {
  const externalId = stringOrNull(getFirstValue(row, [
    'order_ref',
    'external_id',
    'id',
    'tracking_no',
    'tracking_number',
  ]));
  return {
    externalId,
    order_ref: stringOrNull(getFirstValue(row, ['order_ref', 'order_id', 'id']))
      || `GS-${normalizeHeaderKey(sheetName).toUpperCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    tracking_no: stringOrNull(getFirstValue(row, ['tracking_no', 'tracking_number', 'tracking', 'tracking id', 'tracking_id', 'waybill'])),
    customer: stringOrNull(getFirstValue(row, ['customer', 'customer_name', 'name', 'buyer_name', 'recipient_name'])) || 'Unknown Customer',
    phone: stringOrNull(getFirstValue(row, ['phone', 'phone_number', 'mobile', 'contact_number'])),
    product: stringOrNull(getFirstValue(row, ['product', 'product_name', 'item', 'items'])) || 'Unknown Product',
    qty: Math.max(1, Math.round(numberOrDefault(getFirstValue(row, ['qty', 'quantity']), 1))),
    cod_amount: numberOrDefault(getFirstValue(row, ['cod_amount', 'cod', 'amount']), 0),
    status: normalizeStatus(getFirstValue(row, ['status'])),
    courier: stringOrNull(getFirstValue(row, ['courier', 'shipper', 'shipping_provider', 'logistics', 'delivery_partner'])),
    order_date: stringOrNull(getFirstValue(row, ['order_date', 'day_created', 'date_created', 'created_at', 'date', 'created_date']))
      || new Date().toISOString().slice(0, 10),
    source_sheet: stringOrNull(sheetName) || 'Orders',
  };
}

function upsertOrder(db, record) {
  const result = db.prepare(`
    INSERT INTO orders (
      order_ref, tracking_no, customer, phone, product, qty, cod_amount, status, courier, source_sheet, order_date, created_by, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(order_ref) DO UPDATE SET
      tracking_no = excluded.tracking_no,
      customer = excluded.customer,
      phone = excluded.phone,
      product = excluded.product,
      qty = excluded.qty,
      cod_amount = excluded.cod_amount,
      status = excluded.status,
      courier = excluded.courier,
      source_sheet = excluded.source_sheet,
      order_date = excluded.order_date,
      updated_at = datetime('now')
  `).run(
    record.order_ref,
    record.tracking_no,
    record.customer,
    record.phone,
    record.product,
    record.qty,
    record.cod_amount,
    record.status,
    record.courier,
    record.source_sheet,
    record.order_date
  );

  const insertedId = Number(result.lastInsertRowid || 0);
  const local = db.prepare('SELECT id FROM orders WHERE order_ref = ?').get(record.order_ref);
  return insertedId || Number(local?.id || 0);
}

function getCounts(db) {
  return {
    orders: db.prepare('SELECT COUNT(*) AS count FROM orders').get().count,
  };
}

async function collectSheetData(db, payload = {}, triggerType = 'manual') {
  const setting = getSetting(db);
  const enabled = payload.enabled ?? setting?.enabled ?? process.env.GOOGLE_SHEETS_SYNC_ENABLED ?? 0;
  if (!enabled && triggerType === 'scheduled') {
    return { skipped: true, reason: 'Google Sheets sync is disabled.' };
  }

  const spreadsheetId = stringOrNull(payload.spreadsheet_id || setting?.base_url || process.env.GOOGLE_SHEETS_SPREADSHEET_ID);
  const sheetNames = parseSheetNames(payload.sheet_name || setting?.page_id || process.env.GOOGLE_SHEETS_SHEET_NAME);
  const clientEmail = stringOrNull(payload.service_account_email || setting?.api_key || process.env.GOOGLE_SHEETS_CLIENT_EMAIL);
  const privateKey = normalizePrivateKey(payload.private_key || setting?.user_access_token || process.env.GOOGLE_SHEETS_PRIVATE_KEY);
  const entityType = 'orders';

  if (!spreadsheetId || !clientEmail || !privateKey) {
    throw new Error('Missing Google Sheets configuration. Save spreadsheet ID, service account email, and private key first.');
  }

  const runId = startRun(db, triggerType, {
    spreadsheet_id: spreadsheetId,
    sheet_names: sheetNames,
    entity_type: entityType,
  });

  const result = {
    spreadsheet_id: spreadsheetId,
    sheet_name: sheetNames.join(', '),
    sheet_names: sheetNames,
    entity_type: entityType,
    imported: 0,
    updated: 0,
    total_rows: 0,
    failed_rows: [],
    sheets: [],
  };

  try {
    const accessToken = await requestGoogleAccessToken(clientEmail, privateKey);
    for (const sheetName of sheetNames) {
      const range = stringOrNull(payload.range) || buildSheetRange(sheetName);
      const rows = await fetchSheetRows(spreadsheetId, range, accessToken);
      const records = rowsToObjects(rows);
      const sheetSummary = {
        sheet_name: sheetName,
        range,
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
          const existing = db.prepare('SELECT id FROM orders WHERE order_ref = ?').get(normalized.order_ref);
          const localId = upsertOrder(db, normalized);
          if (existing?.id) {
            result.updated += 1;
            sheetSummary.updated += 1;
          } else {
            result.imported += 1;
            sheetSummary.imported += 1;
          }
          recordRaw(db, entityType, `${sheetName}:${normalized.externalId || normalized.order_ref}`, row, {
            status: 'synced',
            mappedTable: 'orders',
            localId,
          });
          upsertSourceLink(db, entityType, `${sheetName}:${normalized.externalId || normalized.order_ref}`, 'orders', localId);
        } catch (error) {
          result.failed_rows.push({
            sheet_name: sheetName,
            row_number: index + 2,
            error: truncate(error.message, 240),
          });
          sheetSummary.failed += 1;
          recordRaw(db, entityType, `${sheetName}:${row.order_ref || row.id || `row-${index + 2}`}`, row, {
            status: 'error',
            mappedTable: 'orders',
            errorMessage: truncate(error.message, 240),
          });
        }
      }

      result.sheets.push(sheetSummary);
    }

    const status = result.failed_rows.length ? 'partial' : 'success';
    finishRun(db, runId, status, result, null);
    return result;
  } catch (error) {
    finishRun(db, runId, 'failed', result, truncate(error.message));
    throw error;
  }
}

async function runScheduledSync(db) {
  const setting = getSetting(db);
  const syncMode = setting?.sync_mode || process.env.GOOGLE_SHEETS_SYNC_MODE || 'manual';
  const enabled = Boolean(setting?.enabled ?? (String(process.env.GOOGLE_SHEETS_SYNC_ENABLED || '').toLowerCase() === 'true'));

  if (!enabled || syncMode === 'manual') {
    return { skipped: true, reason: 'Automatic Google Sheets sync is disabled.' };
  }

  return collectSheetData(db, {}, 'scheduled');
}

function getStatus(db) {
  const setting = getPublicSetting(db);
  const latestRuns = db.prepare(`
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
    local_counts: getCounts(db),
  };
}

function getSyncIntervalMs(db) {
  const setting = getSetting(db);
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
  runScheduledSync,
  getSyncIntervalMs,
};
