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
//   api_key   → InfoTXT API key
//   name      → registered Sender ID / mask
//
// NOTE: InfoTXT does not publish its HTTP API. The actual request shape lives in
// ONE place — buildSendRequest() below — so once the real endpoint/params are
// confirmed, only that function needs adjusting.

const PROVIDER = 'infotxt';

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
    sender_id: row?.name || '',
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
    sender_id: row?.name || '',
    api_key: row?.api_key || '',
  };
}

async function saveConfig(db, payload = {}) {
  const current = await getConfigRow(db);
  const enabled = boolToInt(payload.enabled);
  const endpoint = stringOrNull(payload.endpoint || payload.base_url) || current?.base_url || null;
  const senderId = stringOrNull(payload.sender_id || payload.name) || current?.name || null;
  const notes = payload.notes !== undefined ? String(payload.notes || '') : (current?.notes || '');
  // Blank api_key means "keep the saved one".
  const incomingKey = stringOrNull(payload.api_key);
  const apiKey = incomingKey || current?.api_key || null;

  if (current) {
    await db.prepare(`
      UPDATE integration_settings
      SET enabled = ?, base_url = ?, name = ?, api_key = ?, notes = ?, updated_at = datetime('now')
      WHERE provider = ? AND connection_id = ''
    `).run(enabled, endpoint, senderId, apiKey, notes, PROVIDER);
  } else {
    await db.prepare(`
      INSERT INTO integration_settings (provider, connection_id, name, enabled, base_url, api_key, sync_mode, notes)
      VALUES (?, '', ?, ?, ?, ?, 'push_only', ?)
    `).run(PROVIDER, senderId, enabled, endpoint, apiKey, notes);
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
    `SELECT shop_id, external_id, tag, phone, message, status, error, sent_at
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

function renderTemplate(template, ctx = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => {
    const v = ctx[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

// ─── Sender (the one InfoTXT-specific piece) ───────────────
// Build the actual HTTP request to InfoTXT. CONFIRM against InfoTXT's real API
// and adjust the URL/params/method here only.
function buildSendRequest({ endpoint, apiKey, senderId, number, message }) {
  const url = new URL(endpoint);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('number', number);
  url.searchParams.set('message', message);
  if (senderId) url.searchParams.set('sender', senderId);
  return { url: url.toString(), options: { method: 'GET', signal: AbortSignal.timeout(15000) } };
}

async function sendSms(db, { number, message }) {
  const cfg = await getConfigWithKey(db);
  if (!cfg.endpoint || !cfg.api_key) {
    return { ok: false, status: 'skipped', error: 'InfoTXT endpoint/api key not configured' };
  }
  const phone = normalizePhPhone(number);
  if (!phone) return { ok: false, status: 'skipped', error: 'no/invalid phone' };
  try {
    const { url, options } = buildSendRequest({
      endpoint: cfg.endpoint, apiKey: cfg.api_key, senderId: cfg.sender_id, number: phone, message,
    });
    const res = await fetch(url, options);
    const body = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, status: 'failed', error: `HTTP ${res.status}: ${body.slice(0, 200)}`, phone };
    return { ok: true, status: 'sent', body: body.slice(0, 200), phone };
  } catch (err) {
    return { ok: false, status: 'failed', error: err.message, phone };
  }
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

    await db.prepare(`
      INSERT INTO sms_send_log (shop_id, external_id, tag, phone, message, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, external_id, tag) DO NOTHING
    `).run(shopId, externalId, rule.tag, result.phone || phone, message, result.status, result.error || null);
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
  sendTest,
  maybeSendForOrder,
  normalizePhPhone,
  renderTemplate,
};
