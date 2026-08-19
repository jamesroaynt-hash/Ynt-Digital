// Read-only Google Sheets connection behind the Sales Marketing Tracker page.
//
// This is a SECOND, independent spreadsheet connection: it shares the
// google_sheets provider row family but lives under its own connection_id, so
// it never touches the credentials, spreadsheet, or synced orders of the main
// Google Sheets integration. Nothing here writes back to Google and nothing is
// imported into dashboard tables — the page fetches tabs and rows live and
// displays them.
const googleSheetsSync = require('./googleSheetsSync');

const PROVIDER = 'google_sheets';
const CONNECTION_ID = 'sales_tracker';
// Wide enough for a tracker sheet without pulling unbounded columns.
const COLUMN_RANGE = 'A:AZ';
const MAX_ROWS = 2000;

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function boolToInt(value) {
  return value ? 1 : 0;
}

// Accepts a bare id or a full Google Sheets URL, so whoever connects the sheet
// can paste whatever the browser gave them.
function extractSpreadsheetId(value) {
  const text = stringOrNull(value);
  if (!text) return null;
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : text;
}

async function getSetting(db) {
  return await db
    .prepare('SELECT * FROM integration_settings WHERE provider = ? AND connection_id = ?')
    .get(PROVIDER, CONNECTION_ID) || null;
}

// Never returns the private key itself — only whether one is stored.
async function getPublicSetting(db) {
  const setting = await getSetting(db);
  if (!setting) {
    return {
      provider: PROVIDER,
      connection_id: CONNECTION_ID,
      configured: false,
      enabled: false,
      spreadsheet_id: null,
      service_account_email: null,
      has_private_key: false,
      notes: null,
      updated_at: null,
    };
  }

  return {
    provider: PROVIDER,
    connection_id: CONNECTION_ID,
    configured: Boolean(setting.base_url && setting.api_key && setting.user_access_token),
    enabled: Boolean(setting.enabled),
    spreadsheet_id: setting.base_url || null,
    service_account_email: setting.api_key || null,
    has_private_key: Boolean(setting.user_access_token),
    notes: setting.notes || null,
    updated_at: setting.updated_at,
  };
}

async function saveSetting(db, payload = {}) {
  const current = await getSetting(db);
  // A pasted service account JSON blob carries all three credential fields.
  const serviceAccountJson = googleSheetsSync.parseServiceAccountJson(payload.private_key)
    || googleSheetsSync.parseServiceAccountJson(payload.service_account_json);

  const next = {
    enabled: payload.enabled ?? current?.enabled ?? 0,
    spreadsheet_id: payload.spreadsheet_id !== undefined
      ? extractSpreadsheetId(payload.spreadsheet_id)
      : (current?.base_url ?? null),
    service_account_email: serviceAccountJson?.client_email
      ?? stringOrNull(payload.service_account_email)
      ?? current?.api_key
      ?? null,
    private_key: serviceAccountJson?.private_key
      ?? stringOrNull(payload.private_key)
      ?? current?.user_access_token
      ?? null,
    private_key_id: serviceAccountJson?.private_key_id
      ?? stringOrNull(payload.private_key_id)
      ?? current?.webhook_secret
      ?? null,
    notes: payload.notes ?? current?.notes ?? null,
  };

  if (current) {
    await db.prepare(`
      UPDATE integration_settings
      SET enabled = ?, base_url = ?, api_key = ?, user_access_token = ?, webhook_secret = ?,
          notes = ?, updated_at = datetime('now')
      WHERE provider = ? AND connection_id = ?
    `).run(
      boolToInt(next.enabled),
      next.spreadsheet_id,
      next.service_account_email,
      next.private_key,
      next.private_key_id,
      next.notes,
      PROVIDER,
      CONNECTION_ID
    );
  } else {
    await db.prepare(`
      INSERT INTO integration_settings (
        provider, connection_id, name, enabled, base_url, api_key, user_access_token,
        webhook_secret, sync_mode, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pull_only', ?)
    `).run(
      PROVIDER,
      CONNECTION_ID,
      'Sales Marketing Tracker',
      boolToInt(next.enabled),
      next.spreadsheet_id,
      next.service_account_email,
      next.private_key,
      next.private_key_id,
      next.notes
    );
  }

  return await getPublicSetting(db);
}

async function deleteSetting(db) {
  await db
    .prepare('DELETE FROM integration_settings WHERE provider = ? AND connection_id = ?')
    .run(PROVIDER, CONNECTION_ID);
  return await getPublicSetting(db);
}

// Resolves the stored credentials into a short-lived Google access token.
// Throws a message the UI can show verbatim when the connection is incomplete.
async function getAccessToken(db) {
  const setting = await getSetting(db);
  if (!setting) throw new Error('No spreadsheet connected yet.');
  if (!setting.enabled) throw new Error('This spreadsheet connection is turned off.');

  const spreadsheetId = stringOrNull(setting.base_url);
  const clientEmail = stringOrNull(setting.api_key);
  const privateKey = googleSheetsSync.normalizePrivateKey(setting.user_access_token);
  if (!spreadsheetId) throw new Error('No spreadsheet ID saved.');
  if (!clientEmail || !privateKey) throw new Error('Service account credentials are incomplete.');

  const accessToken = await googleSheetsSync.requestGoogleAccessToken(
    clientEmail,
    privateKey,
    stringOrNull(setting.webhook_secret)
  );
  return { accessToken, spreadsheetId };
}

// Every visible tab on the connected spreadsheet.
async function listTabs(db) {
  const { accessToken, spreadsheetId } = await getAccessToken(db);
  const tabs = await googleSheetsSync.fetchSpreadsheetTabs(spreadsheetId, accessToken);
  return { spreadsheet_id: spreadsheetId, tabs };
}

// One tab as a header row plus raw cell rows. Values are passed through exactly
// as Google returns them — this is a viewer, so nothing is parsed or coerced.
async function getTab(db, sheetName) {
  const name = stringOrNull(sheetName);
  if (!name) throw new Error('Sheet name is required.');

  const { accessToken, spreadsheetId } = await getAccessToken(db);
  const range = `'${name.replace(/'/g, "''")}'!${COLUMN_RANGE}`;
  const values = await googleSheetsSync.fetchSheetRows(spreadsheetId, range, accessToken);

  const [header = [], ...body] = values;
  const headers = header.map((cell, index) => stringOrNull(cell) || `Column ${index + 1}`);
  const width = headers.length;
  const rows = body
    .filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim() !== ''))
    .slice(0, MAX_ROWS)
    // Google omits trailing empty cells, so pad every row to the header width.
    .map((row) => Array.from({ length: width }, (_, i) => (row[i] ?? '')));

  return {
    sheet_name: name,
    spreadsheet_id: spreadsheetId,
    headers,
    rows,
    total_rows: Math.max(0, body.length),
    truncated: body.length > MAX_ROWS,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = {
  PROVIDER,
  CONNECTION_ID,
  MAX_ROWS,
  getPublicSetting,
  saveSetting,
  deleteSetting,
  listTabs,
  getTab,
};
