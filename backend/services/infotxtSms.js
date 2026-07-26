// InfoTXT SMS automation.
//
// A custom list of tag → message rules (the `sms_tag_rules` table). When a POS
// order gains a tag that matches an enabled rule, the order's customer is texted
// once via the InfoTXT SMS gateway (https://ph.myinfotxt.com/). Each (order, tag)
// pair is recorded in `sms_send_log` so a tag never re-sends on later syncs.
//
// Config is stored as a single row in integration_settings (provider 'infotxt'):
//   enabled   → master on/off
//   base_url  → InfoTXT send-SMS endpoint
//   api_key   → InfoTXT ApiKey
//   page_id   → InfoTXT UserID
//   name      → SIM slot (optional)
//
// Implements the InfoTXT Cloud API v2.2 Send SMS endpoint
// (GET https://api.myinfotxt.com/v2/send.php?UserID=&ApiKey=&Mobile=&SMS=&SIM=).
// Success is JSON {"status":"00","smsid":"…"}; any other status is an error.

const PROVIDER = 'infotxt';
const DEFAULT_ENDPOINT = 'https://api.myinfotxt.com/v2/send.php';
const DEFAULT_STATUS_ENDPOINT = 'https://api.myinfotxt.com/v2/status.php';

// status.php lives beside send.php, so derive it from whatever send endpoint is
// configured rather than storing a second URL the admin has to keep in sync.
function statusEndpointFrom(sendEndpoint) {
  const s = String(sendEndpoint || '').trim();
  if (!s) return DEFAULT_STATUS_ENDPOINT;
  return s.includes('send.php') ? s.replace('send.php', 'status.php') : DEFAULT_STATUS_ENDPOINT;
}

// status.php status codes (API guide v2.2 p.2) → our sms_send_log.status values.
// Note these are a DIFFERENT scale from send.php's "00"/"01"… codes.
const GATEWAY_STATUS = { 0: 'queued', 1: 'delivered', 2: 'failed' };

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function boolToInt(value) {
  return value ? 1 : 0;
}

// ─── Config ────────────────────────────────────────────────
async function getConfigRow(db) {
  return await db.prepare(
    "SELECT * FROM integration_settings WHERE provider = ? AND connection_id = ''"
  ).get(PROVIDER) || null;
}

async function getConfig(db) {
  const row = await getConfigRow(db);
  return {
    enabled: Boolean(row?.enabled),
    endpoint: row?.base_url || '',
    user_id: row?.page_id || '',
    sim: row?.name || '',
    has_api_key: Boolean(row?.api_key),
    notes: row?.notes || '',
  };
}

// Internal: config plus the raw api_key, for the sender only.
async function getConfigWithKey(db) {
  const row = await getConfigRow(db);
  return {
    enabled: Boolean(row?.enabled),
    endpoint: row?.base_url || '',
    user_id: row?.page_id || '',
    sim: row?.name || '',
    api_key: row?.api_key || '',
  };
}

async function saveConfig(db, payload = {}) {
  const current = await getConfigRow(db);
  const enabled = boolToInt(payload.enabled);
  // A cleared endpoint field resets to the known-good default (send.php) rather
  // than silently keeping a previous (possibly wrong) value.
  const endpointProvided = payload.endpoint !== undefined || payload.base_url !== undefined;
  const endpoint = endpointProvided
    ? (stringOrNull(payload.endpoint || payload.base_url) || DEFAULT_ENDPOINT)
    : (current?.base_url || DEFAULT_ENDPOINT);
  const userId = stringOrNull(payload.user_id) || current?.page_id || null;
  // SIM is optional and clearable: honour an explicitly-sent blank.
  const sim = payload.sim !== undefined ? stringOrNull(payload.sim) : (current?.name || null);
  const notes = payload.notes !== undefined ? String(payload.notes || '') : (current?.notes || '');
  // Blank api_key means "keep the saved one".
  const apiKey = stringOrNull(payload.api_key) || current?.api_key || null;

  if (current) {
    await db.prepare(`
      UPDATE integration_settings
      SET enabled = ?, base_url = ?, page_id = ?, name = ?, api_key = ?, notes = ?, updated_at = datetime('now')
      WHERE provider = ? AND connection_id = ''
    `).run(enabled, endpoint, userId, sim, apiKey, notes, PROVIDER);
  } else {
    await db.prepare(`
      INSERT INTO integration_settings (provider, connection_id, page_id, name, enabled, base_url, api_key, sync_mode, notes)
      VALUES (?, '', ?, ?, ?, ?, ?, 'push_only', ?)
    `).run(PROVIDER, userId, sim, enabled, endpoint, apiKey, notes);
  }
  return getConfig(db);
}

// ─── Tag rules ─────────────────────────────────────────────
async function listRules(db) {
  const rows = await db.prepare(
    'SELECT tag, message, enabled FROM sms_tag_rules ORDER BY tag'
  ).all();
  return rows.map((r) => ({ tag: r.tag, message: r.message || '', enabled: Boolean(r.enabled) }));
}

async function upsertRule(db, payload = {}) {
  const tag = stringOrNull(payload.tag);
  if (!tag) throw new Error('tag is required');
  const message = String(payload.message || '');
  const enabled = boolToInt(payload.enabled);
  await db.prepare(`
    INSERT INTO sms_tag_rules (tag, message, enabled, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(tag) DO UPDATE SET
      message = excluded.message,
      enabled = excluded.enabled,
      updated_at = datetime('now')
  `).run(tag, message, enabled);
  invalidateRulesCache();
  return { tag, message, enabled: Boolean(enabled) };
}

async function deleteRule(db, payload = {}) {
  const tag = stringOrNull(payload.tag);
  if (!tag) throw new Error('tag is required');
  await db.prepare('DELETE FROM sms_tag_rules WHERE tag = ?').run(tag);
  invalidateRulesCache();
  return { tag, deleted: true };
}

async function listSendLog(db, { limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  return await db.prepare(
    `SELECT shop_id, external_id, tag, phone, message, status, error, smsid, checked_at, sent_at
     FROM sms_send_log ORDER BY sent_at DESC, id DESC LIMIT ?`
  ).all(lim);
}

// Short-lived cache of enabled rules — maybeSendForOrder runs per order on every
// sync cycle, so avoid a SELECT per order. Writes invalidate it immediately.
const RULES_TTL_MS = 30_000;
let rulesCache = { expiresAt: 0, rules: null };
function invalidateRulesCache() { rulesCache = { expiresAt: 0, rules: null }; }

async function getEnabledRules(db) {
  const now = Date.now();
  if (rulesCache.rules && rulesCache.expiresAt > now) return rulesCache.rules;
  const rows = await db.prepare(
    "SELECT tag, message FROM sms_tag_rules WHERE enabled = 1 AND TRIM(message) != ''"
  ).all();
  const rules = rows.map((r) => ({ tag: r.tag, tagLower: String(r.tag).toLowerCase(), message: r.message }));
  rulesCache = { expiresAt: now + RULES_TTL_MS, rules };
  return rules;
}

// ─── Phone + template ──────────────────────────────────────
// Normalise a PH mobile number to local 11-digit 09XXXXXXXXX form. Adjust here
// if InfoTXT expects 639XXXXXXXXX or +639XXXXXXXXX instead.
function normalizePhPhone(raw) {
  let d = String(raw || '').replace(/[^\d]/g, '');
  if (!d) return null;
  if (d.startsWith('63') && d.length === 12) d = '0' + d.slice(2);
  else if (d.startsWith('9') && d.length === 10) d = '0' + d;
  else if (d.startsWith('00')) d = d.slice(2);
  return d;
}

// Case-insensitive lookup of the first matching key in a flat object.
function pickKey(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const lower = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function renderTemplate(template, ctx = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => {
    const v = ctx[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

// ─── Sender (InfoTXT Cloud API v2.2 Send SMS) ──────────────
function buildSendRequest({ endpoint, userId, apiKey, sim, mobile, message }) {
  const url = new URL(endpoint || DEFAULT_ENDPOINT);
  url.searchParams.set('UserID', userId);
  url.searchParams.set('ApiKey', apiKey);
  url.searchParams.set('Mobile', mobile);
  url.searchParams.set('SMS', message);
  if (sim) url.searchParams.set('SIM', sim);
  return { url: url.toString(), options: { method: 'GET', signal: AbortSignal.timeout(15000) } };
}

async function sendSms(db, { number, message }) {
  const cfg = await getConfigWithKey(db);
  if (!cfg.api_key || !cfg.user_id) {
    return { ok: false, status: 'skipped', error: 'InfoTXT UserID/ApiKey not configured' };
  }
  const phone = normalizePhPhone(number);
  if (!phone) return { ok: false, status: 'skipped', error: 'no/invalid phone' };
  try {
    const { url, options } = buildSendRequest({
      endpoint: cfg.endpoint, userId: cfg.user_id, apiKey: cfg.api_key, sim: cfg.sim, mobile: phone, message,
    });
    const res = await fetch(url, options);
    const body = await res.text().catch(() => '');
    const raw = body.slice(0, 300);
    let json = null;
    try { json = JSON.parse(body); } catch { /* non-JSON response */ }
    if (!res.ok) {
      return { ok: false, status: 'failed', error: `HTTP ${res.status}: ${raw}`, raw, phone };
    }
    // InfoTXT success is {"status":"00","smsid":"…"}. Look up keys
    // case-insensitively so any casing (status/Status, smsid/SMSID) is matched.
    const gwStatus = pickKey(json, 'status');
    const gwSmsId = pickKey(json, 'smsid', 'sms_id', 'id');
    const gwError = pickKey(json, 'error', 'message');
    // Only a real smsid (or explicit status 00 WITH an smsid) counts as sent.
    // A status with no smsid is treated as not-sent so failures aren't masked.
    if (json && gwSmsId && String(gwStatus) === '00') {
      return { ok: true, status: 'sent', smsid: gwSmsId, raw, phone };
    }
    // status:null + smsid "NULL" means InfoTXT authenticated the request but the
    // physical SIM/device never dispatched it — a device-side failure, not a
    // credential/parameter problem (those return numeric statuses 01–05 + error).
    const dispatchFailed = json
      && (gwStatus === null || gwStatus === undefined)
      && (gwSmsId == null || String(gwSmsId).toUpperCase() === 'NULL');
    const err = json
      ? (gwError
          || (dispatchFailed
            ? 'InfoTXT could not dispatch — check the SIM/device is online and has load, and the correct SIM is selected'
            : `gateway status ${gwStatus ?? 'none'}, no smsid`))
      : (raw || 'empty response');
    return { ok: false, status: 'failed', error: err, raw, phone };
  } catch (err) {
    return { ok: false, status: 'failed', error: err.message, phone };
  }
}

// ─── Delivery reconciliation (status.php) ──────────────────
// send.php returning "00" only means InfoTXT QUEUED the message. status.php
// resolves what actually happened, so a queued-then-failed SMS stops being
// recorded as a success. API guide v2.2 p.2.
async function fetchGatewayStatus(endpoint, smsid) {
  const url = new URL(statusEndpointFrom(endpoint));
  url.searchParams.set('smsid', smsid);
  const res = await fetch(url.toString(), { method: 'GET', signal: AbortSignal.timeout(15000) });
  const body = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  let json = null;
  try { json = JSON.parse(body); } catch { /* non-JSON response */ }
  if (!json) return { ok: false, error: body.slice(0, 200) || 'empty response' };
  const code = pickKey(json, 'status');
  // Unknown codes are left alone rather than guessed at — a future gateway
  // status must not silently mark a delivered message as failed.
  const mapped = GATEWAY_STATUS[parseInt(code, 10)];
  if (!mapped) return { ok: false, error: `unrecognised gateway status ${code ?? 'none'}` };
  return { ok: true, status: mapped };
}

// Sweep unresolved rows and update them in place. Best-effort per row: one bad
// smsid must not abort the batch. Returns a per-status tally.
async function reconcileSendLog(db, { limit = 100 } = {}) {
  const cfg = await getConfigWithKey(db);
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));

  // Only rows we sent and have not yet resolved. 'sent' is the historical value
  // written at queue time; 'queued' is what a previous sweep left behind.
  const rows = await db.prepare(`
    SELECT id, smsid FROM sms_send_log
    WHERE smsid IS NOT NULL AND smsid != '' AND status IN ('sent', 'queued')
    ORDER BY sent_at DESC, id DESC LIMIT ?
  `).all(lim);

  const tally = { checked: 0, delivered: 0, failed: 0, queued: 0, errors: 0 };
  for (const row of rows) {
    tally.checked += 1;
    let result;
    try {
      result = await fetchGatewayStatus(cfg.endpoint, row.smsid);
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result.ok) {
      tally.errors += 1;
      continue;
    }
    tally[result.status] += 1;
    await db.prepare(
      "UPDATE sms_send_log SET status = ?, checked_at = datetime('now') WHERE id = ?"
    ).run(result.status, row.id);
  }
  return tally;
}

// Look up one smsid on demand — used by the admin test panel to confirm a test
// message actually reached the handset, not merely that it was queued.
async function checkSmsStatus(db, { smsid } = {}) {
  const id = stringOrNull(smsid);
  if (!id) throw new Error('smsid is required');
  const cfg = await getConfigWithKey(db);
  const result = await fetchGatewayStatus(cfg.endpoint, id);
  return result.ok
    ? { ok: true, smsid: id, status: result.status }
    : { ok: false, smsid: id, error: result.error };
}

// Throttled automatic sweep, called from the POS sync cycle. The cycle can run
// every few minutes, but each unresolved row costs one HTTP call and a queued
// SMS takes a while to settle — so cap how often the sweep actually fires.
const RECONCILE_THROTTLE_MS = 15 * 60 * 1000;
let reconcileLastRunAt = 0;

async function maybeReconcile(db, { force = false } = {}) {
  const cfg = await getConfigWithKey(db);
  if (!cfg.enabled) return null;
  if (!force && Date.now() - reconcileLastRunAt < RECONCILE_THROTTLE_MS) return null;
  reconcileLastRunAt = Date.now();
  return reconcileSendLog(db, { limit: 100 });
}

// Admin "send a test SMS" — bypasses rules/dedup.
async function sendTest(db, { number, message }) {
  if (!stringOrNull(number)) throw new Error('number is required');
  const result = await sendSms(db, { number, message: message || 'InfoTXT test message from YNT Dashboard.' });
  return result;
}

// ─── Trigger (called from POS sync upsertOrder) ────────────
// ctx: { shopId, externalId, tagText (lowercased joined tags), customerName,
//        customerPhone, orderRef, cod, product }
// Best-effort: callers wrap in try/catch; never throws.
async function maybeSendForOrder(db, ctx = {}) {
  const cfg = await getConfigWithKey(db);
  if (!cfg.enabled) return;
  const phone = stringOrNull(ctx.customerPhone);
  if (!phone) return;
  const tagText = String(ctx.tagText || '');
  if (!tagText) return;

  const rules = await getEnabledRules(db);
  if (!rules.length) return;

  const shopId = stringOrNull(ctx.shopId);
  const externalId = stringOrNull(ctx.externalId);
  if (!externalId) return;

  for (const rule of rules) {
    if (!tagText.includes(rule.tagLower)) continue;

    // Dedup: already texted for this order+tag?
    const already = await db.prepare(
      'SELECT 1 FROM sms_send_log WHERE shop_id = ? AND external_id = ? AND tag = ?'
    ).get(shopId, externalId, rule.tag);
    if (already) continue;

    const message = renderTemplate(rule.message, {
      name: ctx.customerName || '',
      phone,
      order_ref: ctx.orderRef || externalId,
      cod: ctx.cod ?? '',
      product: ctx.product || '',
      rider: ctx.rider || '',
      rider_number: ctx.riderNumber || '',
      tag: rule.tag,
    });

    const result = await sendSms(db, { number: phone, message });

    // smsid is kept so reconcileSendLog can later resolve queued → delivered/failed.
    await db.prepare(`
      INSERT INTO sms_send_log (shop_id, external_id, tag, phone, message, status, error, smsid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, external_id, tag) DO NOTHING
    `).run(shopId, externalId, rule.tag, result.phone || phone, message, result.status, result.error || null, result.smsid || null);
  }
}

module.exports = {
  PROVIDER,
  getConfig,
  saveConfig,
  listRules,
  upsertRule,
  deleteRule,
  listSendLog,
  reconcileSendLog,
  maybeReconcile,
  checkSmsStatus,
  sendTest,
  maybeSendForOrder,
  normalizePhPhone,
  renderTemplate,
};
