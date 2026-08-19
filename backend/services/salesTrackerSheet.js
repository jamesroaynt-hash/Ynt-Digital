// Read-only Google Sheets connection behind the Sales Marketing Tracker page.
//
// This is a SECOND, independent spreadsheet connection: it shares the
// google_sheets provider row family but lives under its own connection_id, so
// it never touches the credentials, spreadsheet, or synced orders of the main
// Google Sheets integration. Nothing here writes back to Google and nothing is
// imported into dashboard tables — the page fetches tabs and rows live and
// displays them.
const googleSheetsSync = require('./googleSheetsSync');

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

const PROVIDER = 'google_sheets';
const CONNECTION_ID = 'sales_tracker';
// Wide enough for a tracker sheet without pulling unbounded columns.
const COLUMN_LIMIT = 'AZ';
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

// One tab, mirrored: cell text plus the formatting Google reports for it, so
// the page can look like the spreadsheet rather than a generic table.
//
// The grid response is far heavier than a plain values fetch, so it is kept
// lean deliberately: a tight `fields` mask, a bounded range, and cell styles
// deduped into a palette that cells reference by index (a sheet reuses the
// same handful of formats thousands of times).
async function fetchSheetGrid(spreadsheetId, range, accessToken) {
  const fields = [
    'sheets(properties(title,gridProperties(frozenRowCount,frozenColumnCount))',
    'merges',
    'data(startRow,startColumn',
    'columnMetadata(pixelSize,hiddenByUser)',
    'rowMetadata(hiddenByUser)',
    'rowData(values(formattedValue,userEnteredFormat(backgroundColor,horizontalAlignment,wrapStrategy,textFormat(bold,italic,fontSize))))))',
  ].join(',');

  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}`
    + `?includeGridData=true&ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `Google Sheets request failed (${response.status})`);
  }
  return data.sheets?.[0] || null;
}

// Google gives channels as 0..1 floats and omits any channel that is 0.
function toCssColor(color) {
  if (!color || typeof color !== 'object') return null;
  const channel = (value) => Math.round(Math.min(1, Math.max(0, Number(value) || 0)) * 255);
  const [r, g, b] = [channel(color.red), channel(color.green), channel(color.blue)];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const ALIGN_MAP = { LEFT: 'left', CENTER: 'center', RIGHT: 'right' };

// Only non-default formatting survives, so the palette stays small.
function extractStyle(cell) {
  const format = cell?.userEnteredFormat;
  if (!format) return null;

  const style = {};
  const background = toCssColor(format.backgroundColor);
  // White is the sheet default; sending it for every cell doubles the payload.
  if (background && background !== '#ffffff') style.bg = background;

  // The sheet's font color is not carried through: the viewer picks text
  // color from each cell's background so nothing renders unreadable.
  const text = format.textFormat || {};
  if (text.bold) style.b = 1;
  if (text.italic) style.i = 1;
  if (text.fontSize) style.fs = Number(text.fontSize);

  const align = ALIGN_MAP[format.horizontalAlignment];
  if (align) style.a = align;
  if (format.wrapStrategy === 'WRAP') style.w = 1;

  return Object.keys(style).length ? style : null;
}

async function getTab(db, sheetName) {
  const name = stringOrNull(sheetName);
  if (!name) throw new Error('Sheet name is required.');

  const { accessToken, spreadsheetId } = await getAccessToken(db);
  const escapedName = name.replace(/'/g, "''");
  // Bounded up front so a huge tab cannot pull an unbounded grid.
  const range = `'${escapedName}'!A1:${COLUMN_LIMIT}${MAX_ROWS + 1}`;
  const sheet = await fetchSheetGrid(spreadsheetId, range, accessToken);
  if (!sheet) throw new Error(`Sheet "${name}" was not found on this spreadsheet.`);

  const grid = sheet.data?.[0] || {};
  const rowData = Array.isArray(grid.rowData) ? grid.rowData : [];
  const columnMetadata = Array.isArray(grid.columnMetadata) ? grid.columnMetadata : [];

  // Width is the widest populated row — trailing empty columns are dropped so
  // the table does not render a run of blank columns out to the range limit.
  let width = 0;
  rowData.forEach((row) => {
    const cells = row.values || [];
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      if (String(cells[i]?.formattedValue ?? '').trim() !== '') {
        width = Math.max(width, i + 1);
        break;
      }
    }
  });

  // Style palette: identical formats collapse to one entry cells point at.
  const styles = [];
  const styleIndex = new Map();
  const internStyle = (style) => {
    if (!style) return 0;
    const key = JSON.stringify(style);
    if (!styleIndex.has(key)) {
      styles.push(style);
      styleIndex.set(key, styles.length); // 0 is reserved for "no style"
    }
    return styleIndex.get(key);
  };

  const rows = rowData.map((row) => {
    const cells = row.values || [];
    return Array.from({ length: width }, (_, i) => {
      const cell = cells[i];
      return [String(cell?.formattedValue ?? ''), internStyle(extractStyle(cell))];
    });
  });

  // Trailing fully-blank rows carry no information in a viewer.
  while (rows.length && rows[rows.length - 1].every(([value]) => value === '')) rows.pop();

  const columnWidths = Array.from({ length: width }, (_, i) => {
    const meta = columnMetadata[i];
    if (meta?.hiddenByUser) return 0;
    return Number(meta?.pixelSize) || 0;
  });

  // Merges arrive as absolute sheet coordinates; the window starts at A1 here,
  // so only those landing inside the fetched grid are kept.
  const merges = (Array.isArray(sheet.merges) ? sheet.merges : [])
    .filter((m) => m.startRowIndex < rows.length && m.startColumnIndex < width)
    .map((m) => ({
      r: m.startRowIndex,
      c: m.startColumnIndex,
      rs: Math.min(m.endRowIndex, rows.length) - m.startRowIndex,
      cs: Math.min(m.endColumnIndex, width) - m.startColumnIndex,
    }))
    .filter((m) => m.rs > 0 && m.cs > 0 && (m.rs > 1 || m.cs > 1));

  return {
    sheet_name: name,
    spreadsheet_id: spreadsheetId,
    rows,
    styles,
    column_widths: columnWidths,
    merges,
    frozen_rows: Number(sheet.properties?.gridProperties?.frozenRowCount) || 0,
    frozen_columns: Number(sheet.properties?.gridProperties?.frozenColumnCount) || 0,
    truncated: rowData.length > MAX_ROWS,
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
