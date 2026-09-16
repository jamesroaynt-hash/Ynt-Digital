// Meta Marketing API integration: token handling, Graph API client, and the
// sync that copies ad accounts / campaigns / ad sets / ads / daily insights into
// the meta_* tables. Dashboards read those tables — never the API directly.
const crypto = require('crypto');

const GRAPH_BASE = 'https://graph.facebook.com';
const DEFAULT_API_VERSION = 'v24.0';

// Scopes the OAuth flow asks for. ads_read covers every read; ads_management is
// only needed for pause/activate/budget; pages_show_list names the Pages.
const OAUTH_SCOPES = ['ads_read', 'ads_management', 'pages_show_list'];

function apiVersion() {
  return process.env.META_API_VERSION || DEFAULT_API_VERSION;
}

function nowIso() {
  return new Date().toISOString();
}

// ─── Token encryption ─────────────────────────────────────────────────────────
// AES-256-GCM. META_TOKEN_ENC_KEY (64 hex chars) is the key; without it the key
// is derived from JWT_SECRET, which means rotating JWT_SECRET forces a reconnect.
function encryptionKey() {
  const raw = String(process.env.META_TOKEN_ENC_KEY || '').trim();
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(`meta-token:${process.env.JWT_SECRET || ''}`).digest();
}

function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptToken(payload) {
  const [version, iv, tag, data] = String(payload || '').split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Stored Meta token is unreadable');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// ─── Errors ───────────────────────────────────────────────────────────────────
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const AUTH_CODES = new Set([102, 190, 463, 467]);
const PERMISSION_CODES = new Set([10, 200, 294, 278]);

class MetaApiError extends Error {
  constructor(message, { status = 0, code = null, subcode = null, kind = 'api', fbtraceId = null } = {}) {
    super(message);
    this.name = 'MetaApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.kind = kind;
    this.fbtraceId = fbtraceId;
  }
}

function classifyError(status, body) {
  const err = body?.error || {};
  const code = Number(err.code) || null;
  let kind = 'api';
  if (AUTH_CODES.has(code)) kind = 'auth';
  else if (RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014)) kind = 'rate_limit';
  else if (PERMISSION_CODES.has(code) || (code >= 200 && code < 300)) kind = 'permission';
  else if (status >= 500 || code === 1 || code === 2 || err.is_transient) kind = 'transient';
  return new MetaApiError(friendlyMessage(kind, err.message || `Meta API request failed (${status})`), {
    status, code, subcode: err.error_subcode || null, kind, fbtraceId: err.fbtrace_id || null,
  });
}

function friendlyMessage(kind, raw) {
  if (kind === 'auth') return `Meta authorization expired or was revoked. Reconnect the Meta account. (${raw})`;
  if (kind === 'permission') return `This Meta account does not have permission for the requested object. (${raw})`;
  if (kind === 'rate_limit') return `Meta API rate limit reached. (${raw})`;
  return raw;
}

// ─── Graph API client ─────────────────────────────────────────────────────────
function appSecretProof(token) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One Graph call with retry on rate limits and transient failures. `path` is a
// Graph path ("me/adaccounts") or an absolute paging URL Meta handed back.
async function graphRequest(token, path, options = {}) {
  const {
    method = 'GET',
    params = {},
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    retries = 3,
  } = options;

  let url;
  let body;
  if (/^https:\/\//.test(path)) {
    url = new URL(path);
  } else {
    url = new URL(`${GRAPH_BASE}/${apiVersion()}/${String(path).replace(/^\//, '')}`);
    const all = { ...params };
    if (token) {
      all.access_token = token;
      const proof = appSecretProof(token);
      if (proof) all.appsecret_proof = proof;
    }
    const encoded = new URLSearchParams();
    for (const [key, value] of Object.entries(all)) {
      if (value === undefined || value === null) continue;
      encoded.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    if (method === 'GET') url.search = encoded.toString();
    else body = encoded;
  }

  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        body,
        headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      });
    } catch (error) {
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new MetaApiError(`Meta connection temporarily unavailable: ${error.message}`, { kind: 'network' });
    }

    let json = null;
    try { json = await response.json(); } catch { json = null; }
    if (response.ok && !json?.error) return json || {};

    const error = classifyError(response.status, json);
    const retryable = error.kind === 'rate_limit' || error.kind === 'transient';
    if (retryable && attempt < retries) {
      // Rate limits clear on a minutes scale; transient errors in seconds.
      const wait = error.kind === 'rate_limit' ? Math.min(60000, 10000 * 2 ** attempt) : 1000 * 2 ** attempt;
      await sleep(wait);
      continue;
    }
    throw error;
  }
}

async function graphPaginate(token, path, params, options = {}) {
  const maxPages = options.maxPages || 50;
  const rows = [];
  let next = path;
  let first = true;
  for (let page = 0; next && page < maxPages; page += 1) {
    const json = await graphRequest(token, next, first ? { ...options, params } : options);
    first = false;
    if (Array.isArray(json.data)) rows.push(...json.data);
    next = json.paging?.next || null;
  }
  return rows;
}

// ─── Token validation / OAuth ─────────────────────────────────────────────────
async function inspectToken(token, options = {}) {
  const me = await graphRequest(token, 'me', { ...options, params: { fields: 'id,name' } });
  let scopes = [];
  try {
    const perms = await graphRequest(token, 'me/permissions', options);
    scopes = (perms.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
  } catch {
    scopes = [];
  }
  let expiresAt = null;
  if (process.env.META_APP_ID && process.env.META_APP_SECRET) {
    try {
      const appToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
      const debug = await graphRequest(appToken, 'debug_token', { ...options, params: { input_token: token } });
      const exp = Number(debug?.data?.expires_at || 0);
      if (exp > 0) expiresAt = new Date(exp * 1000).toISOString();
    } catch {
      expiresAt = null;
    }
  }
  if (scopes.length && !scopes.includes('ads_read') && !scopes.includes('ads_management')) {
    throw new MetaApiError('This token is missing the ads_read permission, so no ad data can be read.', { kind: 'permission' });
  }
  return { meta_user_id: me.id, meta_user_name: me.name, scopes, token_expires_at: expiresAt };
}

function oauthConfigured() {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_REDIRECT_URI);
}

function buildOAuthUrl(state) {
  const url = new URL(`https://www.facebook.com/${apiVersion()}/dialog/oauth`);
  url.searchParams.set('client_id', process.env.META_APP_ID);
  url.searchParams.set('redirect_uri', process.env.META_REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', OAUTH_SCOPES.join(','));
  url.searchParams.set('response_type', 'code');
  return url.toString();
}

// code → short-lived user token → long-lived (~60 day) user token.
async function exchangeOAuthCode(code, options = {}) {
  const shortLived = await graphRequest('', 'oauth/access_token', {
    ...options,
    params: {
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: process.env.META_REDIRECT_URI,
      code,
    },
  });
  const longLived = await graphRequest('', 'oauth/access_token', {
    ...options,
    params: {
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: shortLived.access_token,
    },
  });
  return longLived.access_token || shortLived.access_token;
}

// ─── Value parsing ────────────────────────────────────────────────────────────
// Currencies Meta reports budgets in whole units rather than cents.
const ZERO_DECIMAL_CURRENCIES = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);

function budgetFromMinor(value, currency) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return ZERO_DECIMAL_CURRENCIES.has(String(currency || '').toUpperCase()) ? n : n / 100;
}

function budgetToMinor(value, currency) {
  const n = Number(value);
  return ZERO_DECIMAL_CURRENCIES.has(String(currency || '').toUpperCase()) ? Math.round(n) : Math.round(n * 100);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Meta reports the same conversion under several action types (omni_purchase
// already includes pixel + on-Facebook purchases). Take the first present type
// in priority order instead of summing, which would double count.
const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase'];
const LEAD_TYPES = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
const MESSAGE_TYPES = ['onsite_conversion.messaging_conversation_started_7d'];

function pickAction(list, types) {
  if (!Array.isArray(list)) return 0;
  for (const type of types) {
    const hit = list.find((item) => item.action_type === type);
    if (hit) return num(hit.value);
  }
  return 0;
}

function parseInsightRow(row, pageByAd) {
  const keep = (list) => (Array.isArray(list)
    ? list.filter((a) => [...PURCHASE_TYPES, ...LEAD_TYPES, ...MESSAGE_TYPES, 'link_click'].includes(a.action_type))
    : []);
  const accountId = row.account_id ? `act_${row.account_id}` : null;
  return {
    date: row.date_start,
    ad_account_id: accountId,
    page_id: pageByAd.get(row.ad_id) || null,
    campaign_id: row.campaign_id || null,
    adset_id: row.adset_id || null,
    ad_id: row.ad_id,
    spend: num(row.spend),
    impressions: Math.round(num(row.impressions)),
    reach: Math.round(num(row.reach)),
    clicks: Math.round(num(row.clicks)),
    link_clicks: Math.round(num(row.inline_link_clicks)),
    ctr: numOrNull(row.ctr),
    cpc: numOrNull(row.cpc),
    cpm: numOrNull(row.cpm),
    frequency: numOrNull(row.frequency),
    purchases: pickAction(row.actions, PURCHASE_TYPES),
    purchase_value: pickAction(row.action_values, PURCHASE_TYPES),
    leads: pickAction(row.actions, LEAD_TYPES),
    messages: pickAction(row.actions, MESSAGE_TYPES),
    actions_json: JSON.stringify({ actions: keep(row.actions), action_values: keep(row.action_values) }),
  };
}

function pageIdFromCreative(creative) {
  if (!creative) return null;
  if (creative.actor_id) return String(creative.actor_id);
  const story = String(creative.effective_object_story_id || '');
  return story.includes('_') ? story.split('_')[0] : null;
}

// ─── Upserts ──────────────────────────────────────────────────────────────────
// Batched multi-row upsert. The WHERE ... IS DISTINCT FROM guard skips rows that
// did not change, so a 15-minute re-sync of an idle account writes nothing.
async function upsertRows(db, table, conflictCols, columns, rows, batchSize = 200) {
  if (!rows.length) return { written: 0 };
  const updatable = columns.filter((c) => !conflictCols.includes(c));
  const setSql = updatable.map((c) => `${c} = excluded.${c}`).join(', ');
  const guard = updatable.map((c) => `${table}.${c} IS DISTINCT FROM excluded.${c}`).join(' OR ');
  let written = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    // Postgres rejects a statement that touches the same conflict key twice.
    const seen = new Map();
    for (const row of rows.slice(i, i + batchSize)) {
      seen.set(conflictCols.map((c) => row[c]).join(''), row);
    }
    const batch = [...seen.values()];
    const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    const params = batch.flatMap((row) => columns.map((c) => (row[c] === undefined ? null : row[c])));
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}
      ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${setSql}, updated_at = datetime('now')
      WHERE ${guard}`;
    const result = await db.prepare(sql).run(...params);
    written += Number(result.changes || 0);
  }
  return { written };
}

async function countWhere(db, table, column, value) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value);
  return Number(row?.n || 0);
}

// ─── Sync logs ────────────────────────────────────────────────────────────────
async function startLog(db, { connectionId, adAccountId = null, entityType, trigger }) {
  const result = await db.prepare(`
    INSERT INTO meta_sync_logs (connection_id, ad_account_id, entity_type, sync_trigger, started_at, status)
    VALUES (?, ?, ?, ?, ?, 'running')
  `).run(connectionId, adAccountId, entityType, trigger, nowIso());
  return Number(result.lastInsertRowid);
}

async function finishLog(db, id, { status, processed = 0, created = 0, updated = 0, error = null }) {
  await db.prepare(`
    UPDATE meta_sync_logs
    SET completed_at = ?, status = ?, records_processed = ?, records_created = ?, records_updated = ?, error_message = ?
    WHERE id = ?
  `).run(nowIso(), status, processed, created, updated, error ? String(error).slice(0, 1000) : null, id);
}

// Runs one entity step with a log row around it. Returns the step's error (or
// null) so the caller can decide whether to continue.
async function loggedStep(db, meta, fn) {
  const logId = await startLog(db, meta);
  try {
    const counts = await fn();
    await finishLog(db, logId, { status: 'success', ...counts });
    return null;
  } catch (error) {
    await finishLog(db, logId, { status: 'failed', error: error.message });
    return error;
  }
}

// ─── Dates ────────────────────────────────────────────────────────────────────
function todayInZone(timeZone, now = new Date()) {
  try {
    return now.toLocaleDateString('en-CA', { timeZone: timeZone || 'Asia/Manila' });
  } catch {
    return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  }
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Which days to pull insights for. First sync backfills META_BACKFILL_DAYS;
// afterwards only the trailing window is refreshed, because Meta keeps revising
// the last ~3 days as late conversions attribute. Older days are left alone
// unless a caller asks for a reconciliation with `days`.
function insightsWindow(account, { days = null, now = new Date() } = {}) {
  const today = todayInZone(account.timezone_name, now);
  const backfill = Math.max(1, Math.min(1095, Number(process.env.META_BACKFILL_DAYS || 30)));
  const trailing = Math.max(1, Math.min(28, Number(process.env.META_REFRESH_DAYS || 3)));
  if (days) return { since: addDays(today, -(Math.min(1095, Number(days)) - 1)), until: today };
  if (!account.last_insights_date) return { since: addDays(today, -(backfill - 1)), until: today };
  const trailingStart = addDays(today, -(trailing - 1));
  const since = account.last_insights_date < trailingStart ? addDays(account.last_insights_date, -(trailing - 1)) : trailingStart;
  return { since, until: today };
}

function chunkRange(since, until, size = 7) {
  const chunks = [];
  for (let start = since; start <= until; start = addDays(start, size)) {
    const end = addDays(start, size - 1);
    chunks.push({ since: start, until: end < until ? end : until });
  }
  return chunks;
}

// ─── Sync ─────────────────────────────────────────────────────────────────────
const runningConnections = new Set();

async function loadConnectionToken(db, connectionId) {
  const connection = await db.prepare('SELECT * FROM meta_connections WHERE id = ?').get(connectionId);
  if (!connection) throw new Error('Meta connection not found');
  return { connection, token: decryptToken(connection.access_token_encrypted) };
}

async function syncAccountsAndPages(db, connectionId, token, trigger, options) {
  let accounts = [];
  const accountError = await loggedStep(db, { connectionId, entityType: 'ad_accounts', trigger }, async () => {
    accounts = await graphPaginate(token, 'me/adaccounts', {
      fields: 'id,account_id,name,currency,timezone_name,account_status,spend_cap,amount_spent,business{id,name}',
      limit: 200,
    }, options);
    const before = await countWhere(db, 'meta_ad_accounts', 'connection_id', connectionId);
    const rows = accounts.map((a) => ({
      connection_id: connectionId,
      meta_ad_account_id: a.id,
      name: a.name || a.id,
      currency: a.currency || null,
      timezone_name: a.timezone_name || null,
      account_status: numOrNull(a.account_status),
      spend_cap: budgetFromMinor(a.spend_cap, a.currency),
      amount_spent: budgetFromMinor(a.amount_spent, a.currency),
      business_id: a.business?.id || null,
      business_name: a.business?.name || null,
    }));
    const { written } = await upsertRows(db, 'meta_ad_accounts', ['meta_ad_account_id'],
      ['connection_id', 'meta_ad_account_id', 'name', 'currency', 'timezone_name', 'account_status', 'spend_cap', 'amount_spent', 'business_id', 'business_name'],
      rows);
    const after = await countWhere(db, 'meta_ad_accounts', 'connection_id', connectionId);
    return { processed: rows.length, created: Math.max(0, after - before), updated: Math.max(0, written - (after - before)) };
  });
  if (accountError) throw accountError;

  // Pages are for naming only — a token without pages_show_list still syncs ads.
  await loggedStep(db, { connectionId, entityType: 'pages', trigger }, async () => {
    const pages = await graphPaginate(token, 'me/accounts', { fields: 'id,name,category', limit: 200 }, options);
    const rows = pages.map((p) => ({ connection_id: connectionId, meta_page_id: p.id, name: p.name || p.id, category: p.category || null }));
    const { written } = await upsertRows(db, 'meta_pages', ['meta_page_id'], ['connection_id', 'meta_page_id', 'name', 'category'], rows);
    return { processed: rows.length, updated: written };
  });
}

async function syncAdAccount(db, connectionId, token, account, trigger, options) {
  const act = account.meta_ad_account_id;
  const currency = account.currency;
  const errors = [];
  const step = async (entityType, fn) => {
    const error = await loggedStep(db, { connectionId, adAccountId: act, entityType, trigger }, fn);
    if (error) errors.push({ entityType, error });
    return error;
  };
  const countedUpsert = async (table, keyCol, columns, rows) => {
    const before = await countWhere(db, table, 'ad_account_id', act);
    const { written } = await upsertRows(db, table, [keyCol], columns, rows);
    const after = await countWhere(db, table, 'ad_account_id', act);
    const created = Math.max(0, after - before);
    return { processed: rows.length, created, updated: Math.max(0, written - created) };
  };

  // Promotable pages fill in names for pages the token does not admin.
  await loggedStep(db, { connectionId, adAccountId: act, entityType: 'promote_pages', trigger }, async () => {
    const pages = await graphPaginate(token, `${act}/promote_pages`, { fields: 'id,name,category', limit: 200 }, options);
    const rows = pages.map((p) => ({ connection_id: connectionId, meta_page_id: p.id, name: p.name || p.id, category: p.category || null }));
    const { written } = await upsertRows(db, 'meta_pages', ['meta_page_id'], ['connection_id', 'meta_page_id', 'name', 'category'], rows);
    return { processed: rows.length, updated: written };
  });

  const campaignError = await step('campaigns', async () => {
    const list = await graphPaginate(token, `${act}/campaigns`, {
      fields: 'id,name,objective,status,effective_status,buying_type,daily_budget,lifetime_budget,created_time,updated_time',
      limit: 500,
    }, options);
    return countedUpsert('meta_campaigns', 'meta_campaign_id',
      ['ad_account_id', 'meta_campaign_id', 'name', 'objective', 'status', 'effective_status', 'buying_type', 'daily_budget', 'lifetime_budget', 'created_time', 'updated_time'],
      list.map((c) => ({
        ad_account_id: act, meta_campaign_id: c.id, name: c.name, objective: c.objective || null,
        status: c.status || null, effective_status: c.effective_status || null, buying_type: c.buying_type || null,
        daily_budget: budgetFromMinor(c.daily_budget, currency), lifetime_budget: budgetFromMinor(c.lifetime_budget, currency),
        created_time: c.created_time || null, updated_time: c.updated_time || null,
      })));
  });
  if (campaignError?.kind === 'auth') return { errors };

  await step('adsets', async () => {
    const list = await graphPaginate(token, `${act}/adsets`, {
      fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting,created_time,updated_time',
      limit: 500,
    }, options);
    return countedUpsert('meta_adsets', 'meta_adset_id',
      ['ad_account_id', 'campaign_id', 'meta_adset_id', 'name', 'status', 'effective_status', 'daily_budget', 'lifetime_budget', 'optimization_goal', 'billing_event', 'targeting_json', 'created_time', 'updated_time'],
      list.map((s) => ({
        ad_account_id: act, campaign_id: s.campaign_id, meta_adset_id: s.id, name: s.name,
        status: s.status || null, effective_status: s.effective_status || null,
        daily_budget: budgetFromMinor(s.daily_budget, currency), lifetime_budget: budgetFromMinor(s.lifetime_budget, currency),
        optimization_goal: s.optimization_goal || null, billing_event: s.billing_event || null,
        targeting_json: s.targeting ? JSON.stringify(s.targeting) : null,
        created_time: s.created_time || null, updated_time: s.updated_time || null,
      })));
  });

  await step('ads', async () => {
    const list = await graphPaginate(token, `${act}/ads`, {
      fields: 'id,name,campaign_id,adset_id,status,effective_status,created_time,updated_time,creative{id,actor_id,effective_object_story_id,thumbnail_url}',
      limit: 500,
    }, options);
    return countedUpsert('meta_ads', 'meta_ad_id',
      ['ad_account_id', 'campaign_id', 'adset_id', 'meta_ad_id', 'name', 'status', 'effective_status', 'creative_id', 'page_id', 'thumbnail_url', 'created_time', 'updated_time'],
      list.map((ad) => ({
        ad_account_id: act, campaign_id: ad.campaign_id, adset_id: ad.adset_id, meta_ad_id: ad.id, name: ad.name,
        status: ad.status || null, effective_status: ad.effective_status || null,
        creative_id: ad.creative?.id || null, page_id: pageIdFromCreative(ad.creative),
        thumbnail_url: ad.creative?.thumbnail_url || null,
        created_time: ad.created_time || null, updated_time: ad.updated_time || null,
      })));
  });

  const window = insightsWindow(account, options);
  await step('insights', async () => {
    const pageRows = await db.prepare('SELECT meta_ad_id, page_id FROM meta_ads WHERE ad_account_id = ? AND page_id IS NOT NULL').all(act);
    const pageByAd = new Map(pageRows.map((r) => [r.meta_ad_id, r.page_id]));
    let processed = 0;
    let written = 0;
    for (const chunk of chunkRange(window.since, window.until)) {
      const list = await graphPaginate(token, `${act}/insights`, {
        level: 'ad',
        time_increment: 1,
        time_range: { since: chunk.since, until: chunk.until },
        fields: 'date_start,account_id,campaign_id,adset_id,ad_id,spend,impressions,reach,clicks,inline_link_clicks,ctr,cpc,cpm,frequency,actions,action_values',
        limit: 500,
      }, options);
      const rows = list.filter((r) => r.ad_id && r.date_start).map((r) => parseInsightRow(r, pageByAd));
      processed += rows.length;
      const result = await upsertRows(db, 'meta_insights_daily', ['ad_id', 'date'],
        ['date', 'ad_account_id', 'page_id', 'campaign_id', 'adset_id', 'ad_id', 'spend', 'impressions', 'reach', 'clicks', 'link_clicks', 'ctr', 'cpc', 'cpm', 'frequency', 'purchases', 'purchase_value', 'leads', 'messages', 'actions_json'],
        rows);
      written += result.written;
    }
    // Only advance the watermark once the whole window landed.
    await db.prepare("UPDATE meta_ad_accounts SET last_insights_date = ?, last_sync_at = ?, updated_at = datetime('now') WHERE meta_ad_account_id = ?")
      .run(window.until, nowIso(), act);
    return { processed, updated: written };
  });

  return { errors, window };
}

// Sync one connection end to end. Never throws for API failures: the outcome is
// written to the connection row and sync logs, and returned.
async function syncConnection(db, connectionId, options = {}) {
  const trigger = options.trigger || 'manual';
  if (runningConnections.has(connectionId)) {
    return { connection_id: connectionId, status: 'skipped', message: 'A sync for this connection is already running.' };
  }
  runningConnections.add(connectionId);
  const startedAt = nowIso();
  const summary = { connection_id: connectionId, status: 'success', accounts: [], errors: [] };
  try {
    let loaded;
    try {
      loaded = await loadConnectionToken(db, connectionId);
    } catch (error) {
      await db.prepare("UPDATE meta_connections SET status = 'error', last_error = ?, last_sync_at = ?, updated_at = datetime('now') WHERE id = ?")
        .run(error.message, startedAt, connectionId);
      return { ...summary, status: 'failed', errors: [error.message] };
    }
    const { connection, token } = loaded;
    if (connection.status === 'disabled') {
      return { ...summary, status: 'skipped', message: 'Connection is disabled.' };
    }

    await syncAccountsAndPages(db, connectionId, token, trigger, options);

    const accounts = await db.prepare(`
      SELECT * FROM meta_ad_accounts
      WHERE connection_id = ? AND enabled = 1 ${options.adAccountId ? 'AND meta_ad_account_id = ?' : ''}
      ORDER BY name
    `).all(...[connectionId, options.adAccountId].filter(Boolean));

    for (const account of accounts) {
      const result = await syncAdAccount(db, connectionId, token, account, trigger, options);
      summary.accounts.push({ ad_account_id: account.meta_ad_account_id, name: account.name, window: result.window || null, errors: result.errors.length });
      for (const { entityType, error } of result.errors) {
        summary.errors.push(`${account.name} ${entityType}: ${error.message}`);
        if (error.kind === 'auth') throw error;
      }
    }

    summary.status = summary.errors.length ? 'partial' : 'success';
    await db.prepare(`
      UPDATE meta_connections
      SET status = 'connected', last_error = ?, last_sync_at = ?, last_success_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(summary.errors.length ? summary.errors.slice(0, 3).join(' | ').slice(0, 1000) : null, startedAt,
      summary.errors.length ? connection.last_success_at : nowIso(), connectionId);
    return summary;
  } catch (error) {
    const status = error.kind === 'auth' ? 'expired' : 'error';
    await db.prepare("UPDATE meta_connections SET status = ?, last_error = ?, last_sync_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, String(error.message).slice(0, 1000), startedAt, connectionId);
    return { ...summary, status: 'failed', errors: [...summary.errors, error.message] };
  } finally {
    runningConnections.delete(connectionId);
  }
}

async function syncAllConnections(db, options = {}) {
  const connections = await db.prepare("SELECT id FROM meta_connections WHERE status IN ('connected', 'error') ORDER BY id").all();
  const results = [];
  for (const { id } of connections) {
    results.push(await syncConnection(db, Number(id), options));
  }
  return results;
}

// ─── Management calls ─────────────────────────────────────────────────────────
async function updateEntity(db, { level, metaId, fields }, options = {}) {
  const table = { campaign: ['meta_campaigns', 'meta_campaign_id'], adset: ['meta_adsets', 'meta_adset_id'], ad: ['meta_ads', 'meta_ad_id'] }[level];
  if (!table) throw new Error('Unknown level');
  const entity = await db.prepare(`SELECT * FROM ${table[0]} WHERE ${table[1]} = ?`).get(metaId);
  if (!entity) throw new Error('Entity not found');
  const account = await db.prepare('SELECT * FROM meta_ad_accounts WHERE meta_ad_account_id = ?').get(entity.ad_account_id);
  if (!account?.connection_id) throw new Error('No Meta connection owns this ad account');
  const { token } = await loadConnectionToken(db, account.connection_id);
  await graphRequest(token, metaId, { ...options, method: 'POST', params: fields, retries: 1 });
  // Read back what Meta now reports rather than assuming the write took effect.
  const readFields = level === 'ad' ? 'status,effective_status' : 'status,effective_status,daily_budget';
  const fresh = await graphRequest(token, metaId, { ...options, params: { fields: readFields } }).catch(() => null);
  return { entity, account, fresh };
}

// ─── Billing ──────────────────────────────────────────────────────────────────
// Read live from Meta on request and never stored: balance and payment method
// change on Meta's side, a stale copy would be worse than none, and a snapshot
// table would grow for no reason. Spend history already lives in
// meta_insights_daily, so this only adds what that cannot answer.
const ACCOUNT_STATUS = {
  1: 'Active',
  2: 'Disabled',
  3: 'Unsettled',
  7: 'Pending risk review',
  8: 'Pending settlement',
  9: 'In grace period',
  100: 'Pending closure',
  101: 'Closed',
};

const BILLING_FIELDS = 'name,currency,account_status,disable_reason,amount_spent,spend_cap,balance,is_prepay_account,adtrust_dsl,funding_source_details{id,type,display_string},business{id,name}';
// Meta rejects the whole request over one unknown field (code 100), so a
// narrower list is tried before giving up — an API version can drop a field.
const BILLING_FIELDS_MIN = 'name,currency,account_status,amount_spent,spend_cap,balance';

async function accountBilling(db, adAccountId, options = {}) {
  const account = await db.prepare('SELECT * FROM meta_ad_accounts WHERE meta_ad_account_id = ?').get(adAccountId);
  if (!account) throw Object.assign(new Error('Ad account not found in synced data'), { statusCode: 404 });
  if (!account.connection_id) throw Object.assign(new Error('This ad account is not connected'), { statusCode: 409 });
  const { token } = await loadConnectionToken(db, account.connection_id);

  let live;
  try {
    live = await graphRequest(token, adAccountId, { ...options, params: { fields: BILLING_FIELDS }, retries: 1 });
  } catch (error) {
    if (error.code !== 100) throw error;
    live = await graphRequest(token, adAccountId, { ...options, params: { fields: BILLING_FIELDS_MIN }, retries: 1 });
  }

  const currency = live.currency || account.currency;
  // Meta writes "no limit" as 0 for both caps; showing that as a 0 cap would
  // read as "delivery stopped".
  const capOrNull = (value) => {
    const amount = budgetFromMinor(value, currency);
    return amount ? amount : null;
  };
  return {
    ad_account_id: adAccountId,
    name: live.name || account.name,
    currency,
    timezone_name: account.timezone_name,
    account_status: Number(live.account_status ?? account.account_status) || null,
    account_status_label: ACCOUNT_STATUS[Number(live.account_status ?? account.account_status)] || 'Unknown',
    disable_reason: live.disable_reason ?? null,
    // Lifetime spend on the account, as Meta bills it — not the same as the
    // date-range spend the reports sum from meta_insights_daily.
    amount_spent: budgetFromMinor(live.amount_spent, currency),
    spend_cap: capOrNull(live.spend_cap),
    // Prepaid credit left, or the amount run up since the last bill on a
    // postpaid (card) account.
    balance: budgetFromMinor(live.balance, currency),
    is_prepay: live.is_prepay_account === true || live.is_prepay_account === 1,
    daily_spend_limit: capOrNull(live.adtrust_dsl),
    funding_source: live.funding_source_details?.display_string || null,
    funding_source_type: live.funding_source_details?.type ?? null,
    business_name: live.business?.name || account.business_name || null,
  };
}

// The billed charges themselves — the same rows Meta shows under Billing &
// payments, including the VAT invoice id and the card reference per charge.
// Meta gates this edge behind account-admin access, so a refusal is reported
// as a note rather than failing the page.
const CHARGE_FIELDS = 'id,time,charge_type,status,amount,payment_option,product_type,transaction_type,tracking_id,vat_invoice_id,credential_id,billing_start_time,billing_end_time,billed_amount_details{currency,total_amount,tax_amount}';
// An API version can drop a field and Meta then rejects the whole request
// (code 100), so the older, narrower list is tried before giving up.
const CHARGE_FIELDS_MIN = 'id,time,charge_type,status,amount,billed_amount_details,payment_option';

// "Ad credit" is a payment method, not a refund: Meta pays for the spend out of
// a credit balance and the row is still a positive, paid charge.
function isAdCredit(row) {
  // Matched narrowly: "credit_card" is the opposite of an ad credit, so a bare
  // /credit/ test would flip every card charge.
  return /ad[_\s-]?credit|coupon/i.test([row.payment_option, row.product_type, row.charge_type].filter(Boolean).join(' '));
}

async function accountCharges(db, adAccountId, options = {}) {
  const account = await db.prepare('SELECT * FROM meta_ad_accounts WHERE meta_ad_account_id = ?').get(adAccountId);
  if (!account?.connection_id) return { charges: [], note: 'This ad account is not connected.' };
  const { token } = await loadConnectionToken(db, account.connection_id);
  const limit = Math.min(500, Number(options.limit) || 100);
  try {
    let json;
    try {
      json = await graphRequest(token, `${adAccountId}/transactions`, { ...options, params: { fields: CHARGE_FIELDS, limit }, retries: 1 });
    } catch (error) {
      if (error.code !== 100) throw error;
      json = await graphRequest(token, `${adAccountId}/transactions`, { ...options, params: { fields: CHARGE_FIELDS_MIN, limit }, retries: 1 });
    }
    const charges = (json.data || []).map((row) => {
      const currency = row.billed_amount_details?.currency || account.currency;
      return {
        id: row.id,
        time: row.time || null,
        billing_start_time: row.billing_start_time || null,
        billing_end_time: row.billing_end_time || null,
        charge_type: row.charge_type || null,
        transaction_type: row.transaction_type ?? null,
        product_type: row.product_type ?? null,
        status: row.status || null,
        payment_option: row.payment_option || null,
        is_ad_credit: isAdCredit(row),
        // The reference Meta prints under the card on its own billing table.
        tracking_id: row.tracking_id || null,
        vat_invoice_id: row.vat_invoice_id || null,
        credential_id: row.credential_id || null,
        currency,
        amount: row.billed_amount_details?.total_amount !== undefined
          ? budgetFromMinor(row.billed_amount_details.total_amount, currency)
          : budgetFromMinor(row.amount, currency),
        tax_amount: row.billed_amount_details?.tax_amount !== undefined
          ? budgetFromMinor(row.billed_amount_details.tax_amount, currency)
          : null,
      };
    });
    return { charges, note: null };
  } catch (error) {
    return { charges: [], note: `Meta did not return the charge history: ${error.message}` };
  }
}

// What the card was actually charged, per calendar month. Meta's status wording
// varies by account and API version, so the split is driven by the text rather
// than by a fixed enum, and the raw status stays visible in the charge list so
// a figure can always be traced back.
const NOT_PAID = /fail|declin|cancel|void|dispute|error/i;
const REFUND = /refund|chargeback|reversal|credit memo/i;
const PENDING = /pending|process|review|authoriz/i;

function chargesByMonth(charges = []) {
  const months = new Map();
  for (const charge of charges) {
    const month = String(charge.time || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const row = months.get(month) || { month, paid: 0, ad_credit: 0, refunded: 0, pending: 0, failed: 0, count: 0, currency: charge.currency || null };
    const amount = Number(charge.amount || 0);
    const status = String(charge.status || '');
    if (charge.is_ad_credit) row.ad_credit += amount;
    else if (REFUND.test(status) || REFUND.test(String(charge.charge_type || '')) || amount < 0) row.refunded += Math.abs(amount);
    else if (NOT_PAID.test(status)) row.failed += amount;
    else if (PENDING.test(status)) row.pending += amount;
    else row.paid += amount;
    row.count += 1;
    if (!row.currency) row.currency = charge.currency || null;
    months.set(month, row);
  }
  return [...months.values()]
    .map((row) => ({ ...row, net_paid: row.paid - row.refunded }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
}

// ─── Creative preview ─────────────────────────────────────────────────────────
// Meta renders the ad itself — video, copy, CTA — and hands back an <iframe>
// pointing at a short-lived signed URL on its own domain. Nothing is stored and
// nothing streams through this server: the viewer's browser loads the video
// straight from Meta's CDN. The URL expires, so it is fetched per view and
// never cached in the database.
const AD_PREVIEW_FORMATS = {
  mobile: 'MOBILE_FEED_STANDARD',
  desktop: 'DESKTOP_FEED_STANDARD',
  story: 'MOBILE_FEED_BASIC',
  reels: 'FACEBOOK_REELS_MOBILE',
  instagram: 'INSTAGRAM_STANDARD',
};

// Meta returns the whole iframe tag; the browser only needs its src.
function iframeSrc(body) {
  const match = /src="([^"]+)"/.exec(String(body || ''));
  if (!match) return null;
  return match[1].replace(/&amp;/g, '&');
}

async function adPreview(db, adId, options = {}) {
  const ad = await db.prepare('SELECT * FROM meta_ads WHERE meta_ad_id = ?').get(adId);
  if (!ad) throw Object.assign(new Error('Ad not found in synced data'), { statusCode: 404 });
  const account = await db.prepare('SELECT * FROM meta_ad_accounts WHERE meta_ad_account_id = ?').get(ad.ad_account_id);
  if (!account?.connection_id) throw Object.assign(new Error('This ad account is not connected, so Meta cannot render its preview'), { statusCode: 409 });
  const format = AD_PREVIEW_FORMATS[String(options.format || 'mobile')] || AD_PREVIEW_FORMATS.mobile;
  const { token } = await loadConnectionToken(db, account.connection_id);
  const json = await graphRequest(token, `${adId}/previews`, { ...options, params: { ad_format: format }, retries: 1 });
  const src = iframeSrc(json?.data?.[0]?.body);
  if (!src) throw Object.assign(new Error('Meta returned no preview for this ad'), { statusCode: 404 });
  return { ad_id: adId, format, iframe_src: src };
}

module.exports = {
  OAUTH_SCOPES,
  MetaApiError,
  encryptToken,
  decryptToken,
  graphRequest,
  graphPaginate,
  inspectToken,
  oauthConfigured,
  buildOAuthUrl,
  exchangeOAuthCode,
  budgetFromMinor,
  budgetToMinor,
  parseInsightRow,
  pageIdFromCreative,
  upsertRows,
  insightsWindow,
  chunkRange,
  todayInZone,
  addDays,
  syncConnection,
  syncAllConnections,
  updateEntity,
  ACCOUNT_STATUS,
  accountBilling,
  accountCharges,
  isAdCredit,
  chargesByMonth,
  AD_PREVIEW_FORMATS,
  iframeSrc,
  adPreview,
  isSyncRunning: (id) => runningConnections.has(id),
};
