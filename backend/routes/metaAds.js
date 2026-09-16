const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const meta = require('../services/metaAds');
const reports = require('../services/metaAdsReports');

// Sales & Marketing module: the same three roles marketing.js lets manage.
// Role text is typed by hand on accounts, so normalize it the way the frontend
// NAV_ACCESS lookup does.
const ALLOWED_ROLE_KEYS = new Set(['administrator', 'sales and marketing', 'sales and marketing tl']);

function roleKey(role) {
  return String(role || '').trim().toLowerCase().replace(/&/g, 'and').replace(/[\s_-]+/g, ' ');
}

function hasAccess(req, need) {
  const user = req.user || {};
  if (user.role === 'api_key') {
    const scopes = Array.isArray(user.scopes) ? user.scopes : [];
    return need === 'write' ? scopes.includes('meta:write') : (scopes.includes('meta:read') || scopes.includes('meta:write'));
  }
  return ALLOWED_ROLE_KEYS.has(roleKey(user.role));
}

function requireAccess(need) {
  return (req, res, next) => {
    if (hasAccess(req, need)) return next();
    const message = req.user?.role === 'api_key'
      ? `API key is missing the meta:${need} scope`
      : 'Sales and Marketing or Administrator access required';
    return res.status(403).json({ error: message });
  };
}

function actorOf(req) {
  const user = req.user || {};
  if (user.role === 'api_key') return { key: `key:${user.key_id}`, user_id: null, username: user.username, source: 'api_key' };
  return { key: `user:${user.id}`, user_id: user.id || null, username: user.username || user.name || null, source: 'dashboard' };
}

function serializeConnection(row, accounts = []) {
  return {
    id: Number(row.id),
    name: row.name,
    meta_user_id: row.meta_user_id,
    meta_user_name: row.meta_user_name,
    auth_type: row.auth_type,
    token_expires_at: row.token_expires_at,
    scopes: row.scopes ? String(row.scopes).split(',').filter(Boolean) : [],
    status: row.status,
    last_error: row.last_error,
    last_sync_at: row.last_sync_at,
    last_success_at: row.last_success_at,
    syncing: meta.isSyncRunning(Number(row.id)),
    created_at: row.created_at,
    ad_accounts: accounts.map((a) => ({
      id: a.meta_ad_account_id,
      name: a.name,
      currency: a.currency,
      timezone_name: a.timezone_name,
      account_status: a.account_status,
      business_name: a.business_name,
      enabled: Number(a.enabled) === 1,
      last_sync_at: a.last_sync_at,
      last_insights_date: a.last_insights_date,
    })),
  };
}

function sendError(res, error) {
  const status = error?.kind === 'auth' ? 401
    : error?.kind === 'permission' ? 403
      : error?.kind === 'rate_limit' ? 429
        : error?.kind === 'network' || error?.kind === 'transient' ? 503
          : error?.statusCode || 500;
  // 401 would make the dashboard think its own session expired and sign out.
  res.status(status === 401 ? 409 : status).json({ error: error?.message || 'Request failed', kind: error?.kind || null });
}

const CSV_COLUMNS = {
  common: [
    { key: 'effective_status', label: 'Delivery' },
    { key: 'spend', label: 'Amount Spent' },
    { key: 'impressions', label: 'Impressions' },
    { key: 'reach', label: 'Reach (sum of daily)' },
    { key: 'clicks', label: 'Clicks' },
    { key: 'link_clicks', label: 'Link Clicks' },
    { key: 'ctr', label: 'CTR %' },
    { key: 'cpc', label: 'CPC' },
    { key: 'cpm', label: 'CPM' },
    { key: 'messages', label: 'Messaging Conversations' },
    { key: 'cost_per_message', label: 'Cost per Message' },
    { key: 'purchases', label: 'Meta Purchases' },
    { key: 'purchase_value', label: 'Meta Purchase Value' },
    { key: 'roas', label: 'Meta ROAS' },
    { key: 'cpa', label: 'Meta CPA' },
    { key: 'pos_orders', label: 'POS Orders' },
    { key: 'cost_per_order', label: 'Cost per POS Order' },
    { key: 'delivered', label: 'Delivered' },
    { key: 'returned_total', label: 'Returned + Returning' },
    { key: 'gross_cod', label: 'Gross COD' },
    { key: 'delivered_cod', label: 'Delivered COD' },
    { key: 'returned_cod', label: 'Returned COD' },
    { key: 'rts_rate', label: 'RTS %' },
    { key: 'actual_roas', label: 'Actual ROAS' },
    { key: 'net_after_ads', label: 'Delivered COD - Spend' },
    { key: 'flag', label: 'Flag' },
  ],
  campaign: [{ key: 'ad_account_name', label: 'Ad Account' }, { key: 'name', label: 'Campaign' }, { key: 'id', label: 'Campaign ID' }, { key: 'objective', label: 'Objective' }, { key: 'daily_budget', label: 'Daily Budget' }],
  adset: [{ key: 'campaign_name', label: 'Campaign' }, { key: 'name', label: 'Ad Set' }, { key: 'id', label: 'Ad Set ID' }, { key: 'daily_budget', label: 'Daily Budget' }],
  ad: [{ key: 'page_name', label: 'Page' }, { key: 'campaign_name', label: 'Campaign' }, { key: 'adset_name', label: 'Ad Set' }, { key: 'name', label: 'Ad' }, { key: 'id', label: 'Ad ID' }],
  page: [{ key: 'name', label: 'Page' }, { key: 'id', label: 'Page ID' }],
  account: [{ key: 'name', label: 'Ad Account' }, { key: 'id', label: 'Ad Account ID' }, { key: 'currency', label: 'Currency' }],
};

const LEVEL_ROUTES = { campaigns: 'campaign', adsets: 'adset', ads: 'ad', pages: 'page', accounts: 'account' };
const ENTITY = {
  campaign: { table: 'meta_campaigns', idCol: 'meta_campaign_id', label: 'Campaign' },
  adset: { table: 'meta_adsets', idCol: 'meta_adset_id', label: 'Ad Set' },
  ad: { table: 'meta_ads', idCol: 'meta_ad_id', label: 'Ad' },
};

// ─── Confirmation tokens ──────────────────────────────────────────────────────
// A management action is two calls: preview returns what will change plus a
// short-lived signed token; execute only runs with that token, for the same
// actor, once. Nothing that spends or stops spend runs from a single request.
const CONFIRM_TTL_MS = 5 * 60 * 1000;
const usedConfirmTokens = new Map();

function signConfirmToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', `meta-confirm:${process.env.JWT_SECRET || ''}`).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyConfirmToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) throw Object.assign(new Error('Invalid confirmation token'), { statusCode: 400 });
  const expected = crypto.createHmac('sha256', `meta-confirm:${process.env.JWT_SECRET || ''}`).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw Object.assign(new Error('Invalid confirmation token'), { statusCode: 400 });
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (Date.now() > payload.exp) throw Object.assign(new Error('Confirmation expired — request a new preview'), { statusCode: 400 });
  return payload;
}

function pruneUsedTokens() {
  const now = Date.now();
  for (const [nonce, exp] of usedConfirmTokens) if (exp < now) usedConfirmTokens.delete(nonce);
}

// `metaOptions` ({ fetchImpl, sleep }) is passed to every Graph call so tests can
// stand in for the Meta API.
module.exports = function metaAdsRoutes(db, { onSyncFinished, metaOptions = {} } = {}) {
  const router = express.Router();
  const read = requireAccess('read');
  const write = requireAccess('write');

  function runSyncInBackground(connectionId, options) {
    meta.syncConnection(db, connectionId, { ...metaOptions, ...options })
      .then((result) => {
        console.log(`[meta_ads] ${options.trigger} sync connection=${connectionId}: ${result.status}${result.errors?.length ? ` (${result.errors.length} error(s))` : ''}`);
        if (onSyncFinished) onSyncFinished(result);
      })
      .catch((error) => console.error(`[meta_ads] sync connection=${connectionId} crashed: ${error.message}`));
  }

  // ─── Status / connections ───────────────────────────────────────────────────
  router.get('/status', read, async (req, res) => {
    try {
      const counts = await db.prepare(`
        SELECT (SELECT COUNT(*) FROM meta_connections) AS connections,
               (SELECT COUNT(*) FROM (${reports.VISIBLE_ACCOUNTS_SQL}) v) AS ad_accounts,
               (SELECT COUNT(*) FROM meta_campaigns
                  WHERE ad_account_id IN (${reports.VISIBLE_ACCOUNTS_SQL})) AS campaigns,
               (SELECT MAX(date) FROM meta_insights_daily) AS latest_insight_date,
               (SELECT MAX(last_sync_at) FROM meta_connections) AS last_sync_at
      `).get();
      res.json({
        oauth_configured: meta.oauthConfigured(),
        api_version: process.env.META_API_VERSION || 'v24.0',
        auto_sync: {
          enabled: process.env.META_SYNC_ENABLED === 'true',
          interval_minutes: Math.round(Math.max(5 * 60000, Number(process.env.META_SYNC_INTERVAL_MS || 15 * 60000)) / 60000),
        },
        connections: Number(counts?.connections || 0),
        ad_accounts: Number(counts?.ad_accounts || 0),
        campaigns: Number(counts?.campaigns || 0),
        latest_insight_date: counts?.latest_insight_date || null,
        last_sync_at: counts?.last_sync_at || null,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/connections', read, async (req, res) => {
    try {
      const rows = await db.prepare('SELECT * FROM meta_connections ORDER BY id').all();
      const accounts = await db.prepare('SELECT * FROM meta_ad_accounts ORDER BY name').all();
      res.json({
        connections: rows.map((row) => serializeConnection(row, accounts.filter((a) => Number(a.connection_id) === Number(row.id)))),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  async function saveConnection({ name, token, authType, actor }) {
    const info = await meta.inspectToken(token, metaOptions);
    const existing = await db.prepare('SELECT id FROM meta_connections WHERE meta_user_id = ?').get(info.meta_user_id);
    const encrypted = meta.encryptToken(token);
    const scopes = info.scopes.join(',');
    if (existing) {
      await db.prepare(`
        UPDATE meta_connections
        SET name = COALESCE(?, name), meta_user_name = ?, auth_type = ?, access_token_encrypted = ?, token_expires_at = ?,
            scopes = ?, status = 'connected', last_error = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(name || null, info.meta_user_name, authType, encrypted, info.token_expires_at, scopes, existing.id);
      return Number(existing.id);
    }
    const result = await db.prepare(`
      INSERT INTO meta_connections (name, meta_user_id, meta_user_name, auth_type, access_token_encrypted, token_expires_at, scopes, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?)
    `).run(name || info.meta_user_name || 'Meta account', info.meta_user_id, info.meta_user_name, authType, encrypted, info.token_expires_at, scopes, actor.user_id);
    return Number(result.lastInsertRowid);
  }

  router.post('/connections', write, async (req, res) => {
    const token = String(req.body?.access_token || '').trim();
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!token) return res.status(400).json({ error: 'access_token is required' });
    try {
      const id = await saveConnection({ name, token, authType: 'token', actor: actorOf(req) });
      runSyncInBackground(id, { trigger: 'connect' });
      const row = await db.prepare('SELECT * FROM meta_connections WHERE id = ?').get(id);
      res.status(201).json({ connection: serializeConnection(row), sync_started: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/connections/:id', write, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const row = await db.prepare('SELECT * FROM meta_connections WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Connection not found' });
      const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 120) : row.name;
      let status = row.status;
      if (req.body?.enabled === false) status = 'disabled';
      if (req.body?.enabled === true && row.status === 'disabled') status = 'connected';
      await db.prepare("UPDATE meta_connections SET name = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(name || row.name, status, id);
      res.json({ connection: serializeConnection(await db.prepare('SELECT * FROM meta_connections WHERE id = ?').get(id)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Removes the credentials. By default the synced history stays in the database
  // so past date ranges still report, and the ad accounts are detached so no
  // sync or action can use them — detached accounts are hidden from every
  // report (see connectedClause in metaAdsReports) instead of listing forever.
  // ?purge=1 additionally wipes the synced rows: irreversible, so the caller
  // has to ask for it.
  router.delete('/connections/:id', write, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const purge = req.query.purge === '1' || req.query.purge === 'true' || req.body?.purge === true;
      const accounts = (await db.prepare('SELECT meta_ad_account_id FROM meta_ad_accounts WHERE connection_id = ?').all(id))
        .map((row) => row.meta_ad_account_id);
      const purged = {};
      if (purge && accounts.length) {
        const holes = accounts.map(() => '?').join(', ');
        // Children first so a crash mid-purge leaves no row pointing at a
        // parent that is already gone.
        for (const table of ['meta_insights_daily', 'meta_ads', 'meta_adsets', 'meta_campaigns']) {
          const done = await db.prepare(`DELETE FROM ${table} WHERE ad_account_id IN (${holes})`).run(...accounts);
          purged[table] = Number(done.changes || 0);
        }
      }
      if (purge) {
        // This connection's own pages, plus any page an earlier detach left
        // behind that no surviving ad points at.
        const pages = await db.prepare(`
          DELETE FROM meta_pages
          WHERE connection_id = ?
             OR (connection_id IS NULL AND meta_page_id NOT IN (SELECT page_id FROM meta_ads WHERE page_id IS NOT NULL))
        `).run(id);
        purged.meta_pages = Number(pages.changes || 0);
        purged.meta_ad_accounts = Number((await db.prepare('DELETE FROM meta_ad_accounts WHERE connection_id = ?').run(id)).changes || 0);
        await db.prepare('DELETE FROM meta_sync_logs WHERE connection_id = ?').run(id);
      } else {
        // Detaching is enough to hide them and to stop every sync and action;
        // their enabled ticks are left alone so reconnecting the same Meta
        // account restores exactly what was showing before.
        await db.prepare('UPDATE meta_ad_accounts SET connection_id = NULL WHERE connection_id = ?').run(id);
        await db.prepare('UPDATE meta_pages SET connection_id = NULL WHERE connection_id = ?').run(id);
      }
      const result = await db.prepare('DELETE FROM meta_connections WHERE id = ?').run(id);
      if (!result.changes) return res.status(404).json({ error: 'Connection not found' });
      // meta_action_logs is the audit trail of who paused or rebudgeted what —
      // it is never purged.
      res.json({ deleted: true, id, purged: purge ? purged : null });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/ad-accounts/:id', write, async (req, res) => {
    try {
      const enabled = req.body?.enabled ? 1 : 0;
      const result = await db.prepare("UPDATE meta_ad_accounts SET enabled = ?, updated_at = datetime('now') WHERE meta_ad_account_id = ?").run(enabled, req.params.id);
      if (!result.changes) return res.status(404).json({ error: 'Ad account not found' });
      res.json({ id: req.params.id, enabled: enabled === 1 });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ─── OAuth ──────────────────────────────────────────────────────────────────
  router.get('/oauth/start', write, (req, res) => {
    if (!meta.oauthConfigured()) {
      return res.status(400).json({ error: 'Meta login is not configured. Set META_APP_ID, META_APP_SECRET and META_REDIRECT_URI, or paste an access token instead.' });
    }
    const actor = actorOf(req);
    const state = jwt.sign({ purpose: 'meta_oauth', uid: actor.user_id, name: String(req.query.name || '').slice(0, 120) }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res.json({ url: meta.buildOAuthUrl(state) });
  });

  // Mounted without authMiddleware: Meta redirects the browser here. The signed
  // state is what ties the callback back to the dashboard user who started it.
  const oauthCallback = express.Router();
  oauthCallback.get('/', async (req, res) => {
    const back = (params) => res.redirect(`/?${new URLSearchParams(params).toString()}`);
    try {
      if (req.query.error) return back({ meta_oauth: 'error', message: String(req.query.error_description || req.query.error).slice(0, 200) });
      const state = jwt.verify(String(req.query.state || ''), process.env.JWT_SECRET);
      if (state.purpose !== 'meta_oauth') throw new Error('Invalid state');
      const token = await meta.exchangeOAuthCode(String(req.query.code || ''), metaOptions);
      const id = await saveConnection({ name: state.name, token, authType: 'oauth', actor: { user_id: state.uid || null } });
      runSyncInBackground(id, { trigger: 'connect' });
      return back({ meta_oauth: 'success' });
    } catch (error) {
      return back({ meta_oauth: 'error', message: String(error.message).slice(0, 200) });
    }
  });
  router.oauthCallback = oauthCallback;

  // ─── Sync ───────────────────────────────────────────────────────────────────
  router.post('/sync', write, async (req, res) => {
    try {
      const days = req.body?.days ? Math.max(1, Math.min(1095, Number(req.body.days))) : null;
      const connectionIds = req.body?.connection_id
        ? [Number(req.body.connection_id)]
        : (await db.prepare("SELECT id FROM meta_connections WHERE status <> 'disabled' ORDER BY id").all()).map((r) => Number(r.id));
      if (!connectionIds.length) return res.status(400).json({ error: 'No Meta connections to sync' });
      const started = [];
      for (const id of connectionIds) {
        if (meta.isSyncRunning(id)) continue;
        runSyncInBackground(id, { trigger: 'manual', days, adAccountId: req.body?.ad_account_id || null });
        started.push(id);
      }
      res.status(202).json({ started, already_running: connectionIds.filter((id) => !started.includes(id)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/sync-logs', read, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
      const rows = await db.prepare(`
        SELECT l.*, c.name AS connection_name, a.name AS ad_account_name
        FROM meta_sync_logs l
        LEFT JOIN meta_connections c ON c.id = l.connection_id
        LEFT JOIN meta_ad_accounts a ON a.meta_ad_account_id = l.ad_account_id
        ORDER BY l.id DESC LIMIT ?
      `).all(limit);
      res.json({ logs: rows });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ─── Reports ────────────────────────────────────────────────────────────────
  router.get('/summary', read, async (req, res) => {
    try { res.json(await reports.summary(db, req.query)); } catch (error) { sendError(res, error); }
  });

  router.get('/trend', read, async (req, res) => {
    try { res.json(await reports.trend(db, req.query)); } catch (error) { sendError(res, error); }
  });

  for (const [path, level] of Object.entries(LEVEL_ROUTES)) {
    router.get(`/${path}`, read, async (req, res) => {
      try {
        if (req.query.format === 'csv') {
          const result = await reports.listLevel(db, level, { ...req.query, page: 1, per_page: 10000, max_per_page: 10000 });
          const csv = reports.toCsv(result.rows, [...CSV_COLUMNS[level], ...CSV_COLUMNS.common]);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="meta-${path}-${result.filters.from}_to_${result.filters.to}.csv"`);
          return res.send(`﻿${csv}`);
        }
        return res.json(await reports.listLevel(db, level, req.query));
      } catch (error) {
        return sendError(res, error);
      }
    });
  }

  router.get('/entity/:level/:id', read, async (req, res) => {
    try {
      const detail = await reports.entityDetail(db, req.params.level, req.params.id, req.query);
      if (!detail) return res.status(404).json({ error: 'Not found' });
      res.json(detail);
    } catch (error) {
      sendError(res, error);
    }
  });

  // ─── Billing ────────────────────────────────────────────────────────────────
  // Payment method, credit balance, spend cap and account standing, read live
  // from Meta per request — nothing is cached or stored. The spend figures come
  // from our own synced insights so they match the rest of the dashboard.
  router.get('/billing', read, async (req, res) => {
    try {
      const f = reports.parseFilters(req.query);
      const params = [];
      let sql = `SELECT * FROM meta_ad_accounts WHERE meta_ad_account_id IN (${reports.VISIBLE_ACCOUNTS_SQL})`;
      if (f.accounts.length) {
        sql += ` AND meta_ad_account_id IN (${f.accounts.map(() => '?').join(', ')})`;
        params.push(...f.accounts);
      }
      const accounts = await db.prepare(`${sql} ORDER BY name`).all(...params);

      const spendSince = async (id, from, to) => Number((await db.prepare(
        'SELECT COALESCE(SUM(spend), 0) AS spend FROM meta_insights_daily WHERE ad_account_id = ? AND date >= ? AND date <= ?',
      ).get(id, from, to))?.spend || 0);

      const rows = await Promise.all(accounts.map(async (account) => {
        const id = account.meta_ad_account_id;
        const today = meta.todayInZone(account.timezone_name);
        const [range, month, day] = await Promise.all([
          spendSince(id, f.from, f.to),
          spendSince(id, `${today.slice(0, 7)}-01`, today),
          spendSince(id, today, today),
        ]);
        const spend = { range, month_to_date: month, today: day, from: f.from, to: f.to };
        try {
          return { ...(await meta.accountBilling(db, id, metaOptions)), spend, error: null };
        } catch (error) {
          // One unreadable account must not blank the whole tab.
          return {
            ad_account_id: id, name: account.name, currency: account.currency, timezone_name: account.timezone_name,
            account_status: account.account_status, account_status_label: meta.ACCOUNT_STATUS[Number(account.account_status)] || 'Unknown',
            amount_spent: account.amount_spent, spend_cap: account.spend_cap, balance: null, is_prepay: null,
            daily_spend_limit: null, funding_source: null, funding_source_type: null,
            business_name: account.business_name, spend, error: error.message,
          };
        }
      }));

      // The charge history is one Graph call per account, so it is only fetched
      // when a single ad account is in scope.
      let charges = null;
      let chargesByMonth = null;
      let chargesNote = null;
      if (rows.length === 1) {
        const result = await meta.accountCharges(db, rows[0].ad_account_id, { ...metaOptions, limit: req.query.charge_limit });
        charges = result.charges;
        chargesByMonth = meta.chargesByMonth(result.charges);
        chargesNote = result.note;
      } else if (rows.length > 1) {
        chargesNote = 'Pick a single ad account above to see what the card was charged per month.';
      }

      const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))];
      res.json({
        filters: { from: f.from, to: f.to },
        accounts: rows,
        // Only meaningful when every account bills in the same currency.
        totals: currencies.length === 1 ? {
          currency: currencies[0],
          spend_range: rows.reduce((sum, r) => sum + Number(r.spend.range || 0), 0),
          spend_month_to_date: rows.reduce((sum, r) => sum + Number(r.spend.month_to_date || 0), 0),
          spend_today: rows.reduce((sum, r) => sum + Number(r.spend.today || 0), 0),
        } : null,
        charges,
        charges_by_month: chargesByMonth,
        charges_note: chargesNote,
        notes: [
          'Balance, payment method and spend cap are read from Meta at the moment you open this tab and are never stored here.',
          'Spend figures are the synced daily insights, so they match the other tabs; Meta can still revise the last few days.',
          'Lifetime spent is what Meta bills on the account and includes spend from before this dashboard was connected.',
          "Paid per month is grouped from Meta's own charge records, so it is what the card was actually charged — it will not match the spend figures exactly, because a month's last days are usually billed in the next month.",
        ],
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // The rendered ad — video included — as Meta itself draws it. Returns only a
  // signed URL on Meta's domain that the browser loads directly, so no creative
  // is ever stored here and no media streams through this server. The URL is
  // short-lived by design: fetch it per view, never cache it.
  router.get('/ads/:id/preview', read, async (req, res) => {
    try {
      res.json(await meta.adPreview(db, String(req.params.id), { ...metaOptions, format: req.query.format }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/profitability', read, async (req, res) => {
    try {
      const groupBy = LEVEL_ROUTES[`${req.query.group_by}s`] || (reports.LEVELS[req.query.group_by] ? req.query.group_by : 'page');
      const [totals, breakdown] = await Promise.all([
        reports.summary(db, req.query),
        reports.listLevel(db, groupBy, { sort: 'spend', ...req.query }),
      ]);
      res.json({
        group_by: groupBy,
        filters: totals.filters,
        totals: totals.totals,
        rows: breakdown.rows,
        total: breakdown.total,
        notes: [
          'POS figures count pos_orders whose Facebook ad_id matches a synced ad, by Manila order day; canceled/removed orders are excluded.',
          'Actual ROAS = Delivered COD / Meta spend. Meta ROAS = Meta purchase value / Meta spend. They are never blended.',
          'Product cost and shipping cost are not tracked per order yet, so Delivered COD - Spend is a contribution figure, not net profit.',
        ],
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ─── Targets ────────────────────────────────────────────────────────────────
  router.get('/targets', read, async (req, res) => {
    try {
      res.json({ targets: await db.prepare('SELECT * FROM meta_targets ORDER BY scope_type, scope_id').all() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/targets', write, async (req, res) => {
    try {
      const scopeType = String(req.body?.scope_type || 'organization');
      if (!['organization', 'ad_account', 'page', 'campaign'].includes(scopeType)) return res.status(400).json({ error: 'Invalid scope_type' });
      const scopeId = scopeType === 'organization' ? '' : String(req.body?.scope_id || '').trim();
      if (scopeType !== 'organization' && !scopeId) return res.status(400).json({ error: 'scope_id is required' });
      const values = reports.TARGET_FIELDS.map((field) => {
        const raw = req.body?.[field];
        if (raw === '' || raw === null || raw === undefined) return null;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error(`${field} must be a positive number`), { statusCode: 400 });
        return n;
      });
      await db.prepare(`
        INSERT INTO meta_targets (scope_type, scope_id, ${reports.TARGET_FIELDS.join(', ')}, updated_by, updated_at)
        VALUES (?, ?, ${reports.TARGET_FIELDS.map(() => '?').join(', ')}, ?, datetime('now'))
        ON CONFLICT (scope_type, scope_id) DO UPDATE SET
          ${reports.TARGET_FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')},
          updated_by = excluded.updated_by, updated_at = datetime('now')
      `).run(scopeType, scopeId, ...values, actorOf(req).user_id);
      res.json({ saved: true, target: await db.prepare('SELECT * FROM meta_targets WHERE scope_type = ? AND scope_id = ?').get(scopeType, scopeId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ─── Management actions ─────────────────────────────────────────────────────
  async function buildPreview(body) {
    const action = String(body?.action || '');
    const level = String(body?.level || '');
    const id = String(body?.id || '').trim();
    const spec = ENTITY[level];
    const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
    if (!['pause', 'activate', 'update_budget'].includes(action)) fail('action must be pause, activate or update_budget');
    if (!spec) fail('level must be campaign, adset or ad');
    if (action === 'update_budget' && level === 'ad') fail('Ads have no budget; update the ad set or campaign');

    // Only objects that came in through a synced connection can be touched.
    const entity = await db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.idCol} = ?`).get(id);
    if (!entity) fail(`${spec.label} not found in synced data`, 404);
    const account = await db.prepare('SELECT * FROM meta_ad_accounts WHERE meta_ad_account_id = ?').get(entity.ad_account_id);
    if (!account?.connection_id || Number(account.enabled) !== 1) fail('This ad account is not connected or is disabled', 403);
    const connection = await db.prepare('SELECT status FROM meta_connections WHERE id = ?').get(account.connection_id);
    if (!connection || connection.status === 'expired' || connection.status === 'disabled') fail('Meta authorization for this ad account expired. Reconnect the Meta account.', 409);

    const today = meta.todayInZone(account.timezone_name);
    const spendCol = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' }[level];
    const spent = await db.prepare(`SELECT COALESCE(SUM(spend), 0) AS spend FROM meta_insights_daily WHERE ${spendCol} = ? AND date = ?`).get(id, today);

    const preview = {
      action,
      level,
      id,
      name: entity.name,
      ad_account: account.name,
      currency: account.currency,
      current_status: entity.status,
      effective_status: entity.effective_status,
      current_daily_budget: entity.daily_budget === undefined ? null : entity.daily_budget,
      spend_today: Number(spent?.spend || 0),
      warnings: [],
    };
    let value;
    if (action === 'pause') {
      if (entity.status === 'PAUSED') fail(`${spec.label} is already paused`);
      value = 'PAUSED';
      preview.new_status = 'PAUSED';
      preview.title = `Pause ${spec.label}`;
    } else if (action === 'activate') {
      if (entity.status === 'ACTIVE') fail(`${spec.label} is already active`);
      value = 'ACTIVE';
      preview.new_status = 'ACTIVE';
      preview.title = `Activate ${spec.label}`;
      preview.warnings.push('Activating resumes spending immediately.');
      if (level !== 'campaign' && /PAUSED/.test(String(entity.effective_status)) && entity.effective_status !== 'PAUSED') {
        preview.warnings.push(`Its parent is paused (${entity.effective_status}), so it will not deliver until the parent is active.`);
      }
    } else {
      if (entity.daily_budget === null || entity.daily_budget === undefined) fail(`This ${spec.label.toLowerCase()} has no daily budget (lifetime budget or budget set at another level)`);
      const next = Number(body?.daily_budget);
      const cap = Number(process.env.META_MAX_DAILY_BUDGET || 1000000);
      if (!Number.isFinite(next) || next <= 0) fail('daily_budget must be a positive number');
      if (next > cap) fail(`daily_budget exceeds the configured maximum (${cap})`);
      value = Math.round(next * 100) / 100;
      preview.new_daily_budget = value;
      preview.title = `Change ${spec.label} daily budget`;
      const current = Number(entity.daily_budget);
      if (current > 0 && value / current >= 2) preview.warnings.push(`This is ${(value / current).toFixed(1)}× the current budget.`);
    }
    return { preview, value };
  }

  router.post('/actions/preview', write, async (req, res) => {
    try {
      const { preview, value } = await buildPreview(req.body);
      const exp = Date.now() + CONFIRM_TTL_MS;
      const confirmToken = signConfirmToken({
        a: preview.action, l: preview.level, id: preview.id, v: value, u: actorOf(req).key, exp, n: crypto.randomBytes(8).toString('hex'),
      });
      res.json({ preview, confirm_token: confirmToken, expires_at: new Date(exp).toISOString() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/actions/execute', write, async (req, res) => {
    const actor = actorOf(req);
    let payload;
    try {
      payload = verifyConfirmToken(req.body?.confirm_token);
      if (payload.u !== actor.key) throw Object.assign(new Error('This confirmation belongs to a different user'), { statusCode: 403 });
      pruneUsedTokens();
      if (usedConfirmTokens.has(payload.n)) throw Object.assign(new Error('This confirmation was already used'), { statusCode: 409 });
      usedConfirmTokens.set(payload.n, payload.exp);
    } catch (error) {
      return sendError(res, error);
    }

    const spec = ENTITY[payload.l];
    const entity = await db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.idCol} = ?`).get(payload.id);
    const account = entity ? await db.prepare('SELECT currency FROM meta_ad_accounts WHERE meta_ad_account_id = ?').get(entity.ad_account_id) : null;
    const isBudget = payload.a === 'update_budget';
    const oldValue = isBudget ? entity?.daily_budget : entity?.status;
    const log = (status, error) => db.prepare(`
      INSERT INTO meta_action_logs (user_id, username, source, action, entity_type, entity_id, entity_name, old_value, new_value, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(actor.user_id, actor.username, actor.source, payload.a, payload.l, payload.id, entity?.name || null,
      oldValue === null || oldValue === undefined ? null : String(oldValue), String(payload.v), status, error ? String(error).slice(0, 1000) : null);

    try {
      if (!entity) throw Object.assign(new Error('Entity no longer exists'), { statusCode: 404 });
      const fields = isBudget ? { daily_budget: meta.budgetToMinor(payload.v, account?.currency) } : { status: payload.v };
      const { fresh } = await meta.updateEntity(db, { level: payload.l, metaId: payload.id, fields }, metaOptions);
      const status = fresh?.status || (isBudget ? entity.status : payload.v);
      const effective = fresh?.effective_status || entity.effective_status;
      if (payload.l === 'ad') {
        await db.prepare(`UPDATE ${spec.table} SET status = ?, effective_status = ?, updated_at = datetime('now') WHERE ${spec.idCol} = ?`).run(status, effective, payload.id);
      } else {
        const budget = fresh?.daily_budget !== undefined ? meta.budgetFromMinor(fresh.daily_budget, account?.currency) : (isBudget ? payload.v : entity.daily_budget);
        await db.prepare(`UPDATE ${spec.table} SET status = ?, effective_status = ?, daily_budget = ?, updated_at = datetime('now') WHERE ${spec.idCol} = ?`).run(status, effective, budget, payload.id);
      }
      await log('success');
      res.json({ ok: true, action: payload.a, level: payload.l, id: payload.id, status, effective_status: effective, new_value: payload.v });
    } catch (error) {
      await log('failed', error.message).catch(() => {});
      sendError(res, error);
    }
  });

  router.get('/actions', read, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
      res.json({ actions: await db.prepare('SELECT * FROM meta_action_logs ORDER BY id DESC LIMIT ?').all(limit) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
};

module.exports.verifyConfirmToken = verifyConfirmToken;
module.exports.hasAccess = hasAccess;
