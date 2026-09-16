// Meta Ads module tests. Run: node --experimental-sqlite --test backend/tests/
// Uses an in-memory SQLite database with the real schema and a fake Graph API.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;
delete process.env.META_APP_SECRET;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const meta = require('../services/metaAds');
const reports = require('../services/metaAdsReports');
const metaRoutes = require('../routes/metaAds');
const { createServer } = require('../mcp/meta-ads-mcp');

const NOW = new Date('2026-09-15T04:00:00Z'); // 12:00 Manila
const noSleep = async () => {};

async function freshDb() {
  const db = new SqliteClient(':memory:');
  await initializeDatabaseAsync(db);
  return db;
}

// ─── Fake Graph API ───────────────────────────────────────────────────────────
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeGraph(overrides = {}) {
  const calls = [];
  const state = {
    spend: '100.50',
    insightFailuresLeft: overrides.insightFailures || 0,
    campaignsError: overrides.campaignsError || null,
    deadBillingField: overrides.deadBillingField || null,
    pagesError: overrides.pagesError || null,
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v[\d.]+\//, '');
    calls.push({ path, method: init.method || 'GET', params: Object.fromEntries(u.searchParams), body: init.body ? Object.fromEntries(init.body) : null });
    if (path === 'me' && !u.searchParams.get('fields')?.includes('status')) return jsonResponse(200, { id: 'U1', name: 'Takara Admin' });
    if (path === 'me/permissions') return jsonResponse(200, { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'granted' }] });
    if (path === 'me/adaccounts') {
      return jsonResponse(200, { data: [{ id: 'act_1', account_id: '1', name: 'TAKARA Main', currency: 'PHP', timezone_name: 'Asia/Manila', account_status: 1, amount_spent: '500000' }] });
    }
    if (path === 'me/accounts') {
      if (state.pagesError) return jsonResponse(400, { error: state.pagesError });
      return jsonResponse(200, { data: [{ id: 'P1', name: 'Ageless', category: 'Health' }] });
    }
    if (path === 'act_1/promote_pages') return jsonResponse(200, { data: [{ id: 'P2', name: 'Skin Expert PH' }] });
    if (path === 'act_1/campaigns') {
      if (state.campaignsError) return jsonResponse(400, { error: state.campaignsError });
      return jsonResponse(200, { data: [
        { id: 'C1', name: 'Campaign 1 - Search Terms', objective: 'OUTCOME_ENGAGEMENT', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '40000' },
        { id: 'C2', name: 'Campaign 2 - Retargeting', objective: 'OUTCOME_SALES', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '5000' },
      ] });
    }
    if (path === 'act_1/adsets') {
      return jsonResponse(200, { data: [
        { id: 'S1', name: 'Adset A', campaign_id: 'C1', status: 'ACTIVE', effective_status: 'ACTIVE', optimization_goal: 'CONVERSATIONS', targeting: { geo_locations: { countries: ['PH'] } } },
        { id: 'S2', name: 'Adset B', campaign_id: 'C2', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED', daily_budget: '1000' },
      ] });
    }
    if (path === 'act_1/ads') {
      return jsonResponse(200, { data: [
        { id: 'A1', name: 'Ad One', campaign_id: 'C1', adset_id: 'S1', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { id: 'CR1', actor_id: 'P1' } },
        { id: 'A2', name: 'Ad Two', campaign_id: 'C2', adset_id: 'S2', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED', creative: { id: 'CR2', effective_object_story_id: 'P2_999' } },
      ] });
    }
    if (path === 'act_1/insights') {
      if (state.insightFailuresLeft > 0) {
        state.insightFailuresLeft -= 1;
        return jsonResponse(400, { error: { code: 17, message: 'User request limit reached' } });
      }
      const range = JSON.parse(u.searchParams.get('time_range'));
      const rows = [];
      if (range.since <= '2026-09-14' && range.until >= '2026-09-14') {
        rows.push({
          date_start: '2026-09-14', account_id: '1', campaign_id: 'C1', adset_id: 'S1', ad_id: 'A1', spend: state.spend, impressions: '10000', reach: '8000', clicks: '300', inline_link_clicks: '250',
          actions: [{ action_type: 'omni_purchase', value: '4' }, { action_type: 'purchase', value: '4' }, { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '20' }],
          action_values: [{ action_type: 'omni_purchase', value: '1200' }, { action_type: 'purchase', value: '1200' }],
        });
      }
      if (range.since <= '2026-09-15' && range.until >= '2026-09-15') {
        rows.push({ date_start: '2026-09-15', account_id: '1', campaign_id: 'C2', adset_id: 'S2', ad_id: 'A2', spend: '50', impressions: '5000', reach: '4500', clicks: '50', inline_link_clicks: '40' });
      }
      // Split into two pages to exercise paging.next.
      if (rows.length === 2 && !u.searchParams.get('after')) {
        const next = new URL(url);
        next.searchParams.set('after', 'x');
        return jsonResponse(200, { data: [rows[0]], paging: { next: next.toString() } });
      }
      return jsonResponse(200, { data: u.searchParams.get('after') ? [rows[1]] : rows });
    }
    if (path === 'act_1' && (init.method || 'GET') === 'GET') {
      const asked = u.searchParams.get('fields') || '';
      if (state.deadBillingField && asked.includes(state.deadBillingField)) {
        return jsonResponse(400, { error: { code: 100, message: `(#100) Tried accessing nonexisting field (${state.deadBillingField}) on node type (AdAccount)` } });
      }
      return jsonResponse(200, {
        name: 'TAKARA Main', currency: 'PHP', account_status: 1, amount_spent: '50000000', spend_cap: '0',
        balance: '125075', is_prepay_account: false, adtrust_dsl: '2500000',
        funding_source_details: { id: 'FS1', type: 1, display_string: 'Mastercard *1234' },
        business: { id: 'B1', name: 'YNT' },
      });
    }
    if (path === 'act_1/transactions') {
      if (state.transactionsError) return jsonResponse(400, { error: { code: 200, message: 'Requires account admin' } });
      return jsonResponse(200, { data: [
        { id: 't1-t1b', time: '2026-09-10T02:00:00+0000', charge_type: 'ad_spend', status: 'Paid', payment_option: 'credit_card', tracking_id: 'GJTGA3NH24', vat_invoice_id: 'FBADS-582-106588313', billed_amount_details: { currency: 'PHP', total_amount: '450000', tax_amount: '48214' } },
        { id: 't2', time: '2026-09-02T02:00:00+0000', charge_type: 'ad_spend', status: 'Paid', payment_option: 'credit_card', billed_amount_details: { currency: 'PHP', total_amount: '300000' } },
        { id: 't3', time: '2026-09-04T02:00:00+0000', charge_type: 'ad_spend', status: 'Declined', payment_option: 'credit_card', billed_amount_details: { currency: 'PHP', total_amount: '100000' } },
        { id: 't4', time: '2026-09-06T02:00:00+0000', charge_type: 'refund', status: 'Refunded', payment_option: 'credit_card', billed_amount_details: { currency: 'PHP', total_amount: '50000' } },
        { id: 't5', time: '2026-08-15T02:00:00+0000', charge_type: 'ad_spend', status: 'Paid', payment_option: 'credit_card', billed_amount_details: { currency: 'PHP', total_amount: '900000' } },
        { id: 't6', time: '2026-09-05T02:00:00+0000', charge_type: 'ad_spend', status: 'Paid', payment_option: 'ad_credit', billed_amount_details: { currency: 'PHP', total_amount: '354' } },
      ] });
    }
    if (/^A\d\/previews$/.test(path)) {
      const format = u.searchParams.get('ad_format');
      return jsonResponse(200, { data: [{ body: `<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=AQ1&amp;f=${format}" width="476" height="592"></iframe>` }] });
    }
    if (/^(C|S|A)\d$/.test(path) && (init.method || 'GET') === 'POST') return jsonResponse(200, { success: true });
    if (/^(C|S|A)\d$/.test(path)) {
      const last = calls.filter((c) => c.path === path && c.method === 'POST').pop();
      return jsonResponse(200, { id: path, status: last?.body?.status || 'ACTIVE', effective_status: last?.body?.status || 'ACTIVE', daily_budget: last?.body?.daily_budget });
    }
    return jsonResponse(404, { error: { code: 803, message: `No fake for ${path}` } });
  };
  return { fetchImpl, calls, state };
}

async function addConnection(db) {
  const result = await db.prepare("INSERT INTO meta_connections (name, meta_user_id, access_token_encrypted, status) VALUES ('TAKARA', 'U1', ?, 'connected')")
    .run(meta.encryptToken('EAAB-test-token'));
  return Number(result.lastInsertRowid);
}

// ─── Unit ─────────────────────────────────────────────────────────────────────
test('token encryption round-trips and rejects tampering', () => {
  const sealed = meta.encryptToken('EAAB-secret');
  assert.notEqual(sealed, 'EAAB-secret');
  assert.ok(!sealed.includes('EAAB'));
  assert.equal(meta.decryptToken(sealed), 'EAAB-secret');
  const parts = sealed.split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => meta.decryptToken(parts.join(':')));
});

test('insight parsing does not double count purchase action types', () => {
  const row = meta.parseInsightRow({
    date_start: '2026-09-01', account_id: '9', ad_id: 'A', spend: '10',
    actions: [{ action_type: 'omni_purchase', value: '3' }, { action_type: 'purchase', value: '3' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' }, { action_type: 'lead', value: '2' }],
    action_values: [{ action_type: 'omni_purchase', value: '900' }, { action_type: 'purchase', value: '900' }],
  }, new Map([['A', 'P9']]));
  assert.equal(row.purchases, 3);
  assert.equal(row.purchase_value, 900);
  assert.equal(row.leads, 2);
  assert.equal(row.page_id, 'P9');
  assert.equal(row.ad_account_id, 'act_9');
});

test('budgets convert from minor units by currency', () => {
  assert.equal(meta.budgetFromMinor('40000', 'PHP'), 400);
  assert.equal(meta.budgetFromMinor('40000', 'JPY'), 40000);
  assert.equal(meta.budgetToMinor(1500.5, 'PHP'), 150050);
  assert.equal(meta.pageIdFromCreative({ effective_object_story_id: '123_456' }), '123');
});

test('insights window: backfill first, trailing refresh after, explicit days for reconciliation', () => {
  process.env.META_BACKFILL_DAYS = '30';
  process.env.META_REFRESH_DAYS = '3';
  const account = { timezone_name: 'Asia/Manila', last_insights_date: null };
  assert.deepEqual(meta.insightsWindow(account, { now: NOW }), { since: '2026-08-17', until: '2026-09-15' });
  assert.deepEqual(meta.insightsWindow({ ...account, last_insights_date: '2026-09-15' }, { now: NOW }), { since: '2026-09-13', until: '2026-09-15' });
  assert.deepEqual(meta.insightsWindow({ ...account, last_insights_date: '2026-09-01' }, { now: NOW }), { since: '2026-08-30', until: '2026-09-15' });
  assert.deepEqual(meta.insightsWindow({ ...account, last_insights_date: '2026-09-15' }, { now: NOW, days: 90 }), { since: '2026-06-18', until: '2026-09-15' });
  assert.equal(meta.chunkRange('2026-08-17', '2026-09-15').length, 5);
});

test('graph client retries rate limits, then surfaces a classified error', async () => {
  let attempts = 0;
  const flaky = async () => { attempts += 1; return jsonResponse(400, { error: { code: 17, message: 'limit' } }); };
  await assert.rejects(meta.graphRequest('t', 'me', { fetchImpl: flaky, sleep: noSleep, retries: 2 }), (e) => e.kind === 'rate_limit');
  assert.equal(attempts, 3);
  const expired = async () => jsonResponse(400, { error: { code: 190, message: 'Session has expired' } });
  await assert.rejects(meta.graphRequest('t', 'me', { fetchImpl: expired, sleep: noSleep }), (e) => e.kind === 'auth' && /Reconnect/.test(e.message));
  const denied = async () => jsonResponse(403, { error: { code: 200, message: 'Permissions error' } });
  await assert.rejects(meta.graphRequest('t', 'act_9/insights', { fetchImpl: denied, sleep: noSleep }), (e) => e.kind === 'permission');
  const down = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(meta.graphRequest('t', 'me', { fetchImpl: down, sleep: noSleep, retries: 1 }), (e) => e.kind === 'network');
});

// ─── Sync ─────────────────────────────────────────────────────────────────────
test('sync imports the hierarchy and insights; re-sync is idempotent', async () => {
  const db = await freshDb();
  const id = await addConnection(db);
  const graph = fakeGraph({ insightFailures: 1 });
  const opts = { fetchImpl: graph.fetchImpl, sleep: noSleep, now: NOW, trigger: 'test' };

  const first = await meta.syncConnection(db, id, opts);
  assert.equal(first.status, 'success', JSON.stringify(first.errors));
  const count = async (t) => Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n);
  assert.equal(await count('meta_ad_accounts'), 1);
  assert.equal(await count('meta_campaigns'), 2);
  assert.equal(await count('meta_adsets'), 2);
  assert.equal(await count('meta_ads'), 2);
  assert.equal(await count('meta_insights_daily'), 2);
  assert.equal(await count('meta_pages'), 2);

  const c1 = await db.prepare("SELECT * FROM meta_campaigns WHERE meta_campaign_id = 'C1'").get();
  assert.equal(c1.daily_budget, 400);
  const ins = await db.prepare("SELECT * FROM meta_insights_daily WHERE ad_id = 'A1'").get();
  assert.equal(ins.page_id, 'P1');
  assert.equal(ins.purchases, 4);
  assert.equal(ins.messages, 20);
  const a2 = await db.prepare("SELECT page_id FROM meta_ads WHERE meta_ad_id = 'A2'").get();
  assert.equal(a2.page_id, 'P2');

  const acct = await db.prepare('SELECT last_insights_date FROM meta_ad_accounts').get();
  assert.equal(acct.last_insights_date, '2026-09-15');
  const logs = await db.prepare("SELECT * FROM meta_sync_logs WHERE entity_type = 'campaigns'").all();
  assert.equal(logs[0].records_created, 2);

  // Duplicate sync: nothing duplicated, nothing rewritten.
  const second = await meta.syncConnection(db, id, opts);
  assert.equal(second.status, 'success');
  assert.equal(await count('meta_insights_daily'), 2);
  assert.equal(await count('meta_campaigns'), 2);
  const insightLog = await db.prepare("SELECT * FROM meta_sync_logs WHERE entity_type = 'insights' ORDER BY id DESC").get();
  assert.equal(insightLog.records_updated, 0);
  // The second sync only asked Meta for the trailing window.
  const lastInsightsCall = graph.calls.filter((c) => c.path === 'act_1/insights').pop();
  assert.equal(JSON.parse(lastInsightsCall.params.time_range).since, '2026-09-13');

  // Meta revises a day: the row is updated in place.
  graph.state.spend = '130';
  await meta.syncConnection(db, id, opts);
  assert.equal(await count('meta_insights_daily'), 2);
  assert.equal((await db.prepare("SELECT spend FROM meta_insights_daily WHERE ad_id = 'A1'").get()).spend, 130);

  const conn = await db.prepare('SELECT * FROM meta_connections WHERE id = ?').get(id);
  assert.equal(conn.status, 'connected');
  assert.ok(conn.last_success_at);
});

test('sync: expired token marks the connection expired; missing page permission is not fatal', async () => {
  const db = await freshDb();
  const id = await addConnection(db);
  const partial = fakeGraph({ pagesError: { code: 200, message: 'pages_show_list missing' } });
  const ok = await meta.syncConnection(db, id, { fetchImpl: partial.fetchImpl, sleep: noSleep, now: NOW });
  assert.equal(ok.status, 'success');
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM meta_ads').get()).n), 2);
  const pageLog = await db.prepare("SELECT status FROM meta_sync_logs WHERE entity_type = 'pages'").get();
  assert.equal(pageLog.status, 'failed');

  const expired = fakeGraph({ campaignsError: { code: 190, message: 'Error validating access token' } });
  const result = await meta.syncConnection(db, id, { fetchImpl: expired.fetchImpl, sleep: noSleep, now: NOW });
  assert.equal(result.status, 'failed');
  const conn = await db.prepare('SELECT status, last_error FROM meta_connections WHERE id = ?').get(id);
  assert.equal(conn.status, 'expired');
  assert.match(conn.last_error, /Reconnect/);
});

// ─── Reports ──────────────────────────────────────────────────────────────────
async function seededDb() {
  const db = await freshDb();
  const id = await addConnection(db);
  await meta.syncConnection(db, id, { fetchImpl: fakeGraph().fetchImpl, sleep: noSleep, now: NOW });
  const order = (ext, adId, status, cod, insertedAt, extra = {}) => db.prepare(`
    INSERT INTO pos_orders (external_id, shop_id, status_name, cod, ad_id, page_id, inserted_at_remote, customer_phone, raw_payload, partner_status, undeliverable_since)
    VALUES (?, 'S', ?, ?, ?, 'P1', ?, '0917', '{}', ?, ?)
  `).run(ext, status, cod, adId, insertedAt, extra.partner_status || null, extra.undeliverable_since || null);
  // A1 → campaign C1. Manila day 2026-09-14 = UTC 2026-09-13T16:00 .. 2026-09-14T16:00.
  await order('o1', 'A1', 'delivered', 1000, '2026-09-13T17:00:00');
  await order('o2', 'A1', 'delivered', 800, '2026-09-14T02:00:00');
  await order('o3', 'A1', 'returned', 900, '2026-09-14T03:00:00');
  await order('o4', 'A1', 'returning', 700, '2026-09-14T04:00:00');
  await order('o5', 'A1', 'shipped', 600, '2026-09-14T05:00:00');
  await order('o6', 'A1', 'canceled', 999, '2026-09-14T05:00:00');
  // 15:30 UTC on the 13th is still the 13th in Manila → outside a 14th-only range.
  await order('o7', 'A1', 'delivered', 5000, '2026-09-13T15:30:00');
  // Abandoned undeliverable counts as returned.
  await order('o8', 'A1', 'shipped', 400, '2026-09-14T06:00:00', { partner_status: 'undeliverable', undeliverable_since: '2026-01-01' });
  // Not attributed to any ad.
  await order('o9', null, 'delivered', 7777, '2026-09-14T06:00:00');
  return db;
}

test('campaign report joins Meta spend with POS actuals using the canonical RTS formula', async () => {
  const db = await seededDb();
  const result = await reports.listLevel(db, 'campaign', { from: '2026-09-14', to: '2026-09-14' }, { now: NOW });
  const c1 = result.rows.find((r) => r.id === 'C1');
  assert.equal(c1.spend, 100.5);
  assert.equal(c1.pos_orders, 6); // o1..o5 + o8; canceled, out-of-range and unattributed excluded
  assert.equal(c1.delivered, 2);
  assert.equal(c1.returned, 2); // o3 + abandoned o8
  assert.equal(c1.returning_count, 1);
  assert.equal(c1.delivered_cod, 1800);
  assert.equal(c1.returned_cod, 2000);
  assert.equal(c1.rts_rate, 60); // (2+1)/(2+2+1)
  assert.ok(Math.abs(c1.actual_roas - 1800 / 100.5) < 1e-9);
  assert.ok(Math.abs(c1.roas - 1200 / 100.5) < 1e-9);
  assert.equal(c1.ctr, 3);
  assert.equal(c1.net_after_ads, 1800 - 100.5);

  // SQL-derived metrics agree with the JS derive() used for totals.
  const js = reports.derive(c1);
  for (const key of ['roas', 'actual_roas', 'cpa', 'ctr', 'cpc', 'cpm', 'frequency', 'rts_rate', 'delivery_rate', 'cost_per_order', 'net_after_ads']) {
    assert.ok(Math.abs((js[key] ?? 0) - (c1[key] ?? 0)) < 1e-9, key);
  }

  const totals = await reports.summary(db, { from: '2026-09-14', to: '2026-09-14' }, { now: NOW });
  assert.equal(totals.totals.spend, 100.5);
  assert.equal(totals.totals.delivered_cod, 1800);
});

test('date range, filters, sorting and pagination', async () => {
  const db = await seededDb();
  const all = await reports.listLevel(db, 'campaign', { from: '2026-09-14', to: '2026-09-15', sort: 'spend', dir: 'asc' }, { now: NOW });
  assert.deepEqual(all.rows.map((r) => r.id), ['C2', 'C1']);
  assert.equal(all.total, 2);

  const paged = await reports.listLevel(db, 'campaign', { from: '2026-09-14', to: '2026-09-15', per_page: 1, page: 2 }, { now: NOW });
  assert.equal(paged.rows.length, 1);
  assert.equal(paged.total, 2);

  const active = await reports.listLevel(db, 'campaign', { from: '2026-09-14', to: '2026-09-15', status: 'active' }, { now: NOW });
  assert.deepEqual(active.rows.map((r) => r.id), ['C1']);

  const onlyOld = await reports.listLevel(db, 'ad', { from: '2026-09-01', to: '2026-09-10', status: 'with_spend' }, { now: NOW });
  assert.equal(onlyOld.total, 0);

  const byPage = await reports.listLevel(db, 'adset', { from: '2026-09-14', to: '2026-09-15', page_id: 'P2' }, { now: NOW });
  assert.deepEqual(byPage.rows.map((r) => r.id), ['S2']);

  const pages = await reports.listLevel(db, 'page', { from: '2026-09-14', to: '2026-09-15' }, { now: NOW });
  assert.deepEqual(pages.rows.map((r) => r.name).sort(), ['Ageless', 'Skin Expert PH']);

  const lowRoas = await reports.listLevel(db, 'campaign', { from: '2026-09-14', to: '2026-09-15', max_roas: 2 }, { now: NOW });
  assert.deepEqual(lowRoas.rows.map((r) => r.id), ['C2']); // C2 spent 50 with no delivered COD

  const trend = await reports.trend(db, { from: '2026-09-13', to: '2026-09-15' }, { now: NOW });
  assert.deepEqual(trend.days.map((d) => d.day), ['2026-09-13', '2026-09-14', '2026-09-15']);
  assert.equal(trend.days[1].spend, 100.5);
  assert.equal(trend.days[0].delivered_cod, 5000);
});

test('targets drive Winning / Needs attention flags', async () => {
  const db = await seededDb();
  await db.prepare("INSERT INTO meta_targets (scope_type, scope_id, target_actual_roas, max_cpa) VALUES ('organization', '', 3, 40)").run();
  const result = await reports.listLevel(db, 'campaign', { from: '2026-09-14', to: '2026-09-15' }, { now: NOW });
  const c1 = result.rows.find((r) => r.id === 'C1');
  const c2 = result.rows.find((r) => r.id === 'C2');
  assert.equal(c1.flag, 'winning');
  assert.equal(c2.flag, 'attention');
  assert.ok(c2.flag_reasons.includes('Spend with zero orders'));
  // A campaign-level override wins over the organization default.
  await db.prepare("INSERT INTO meta_targets (scope_type, scope_id, target_actual_roas) VALUES ('campaign', 'C1', 50)").run();
  const again = await reports.listLevel(db, 'campaign', { from: '2026-09-14', to: '2026-09-15' }, { now: NOW });
  assert.equal(again.rows.find((r) => r.id === 'C1').flag, 'attention');
});

// ─── Routes: access control + management actions ──────────────────────────────
async function startApp(db, graph) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const as = req.headers['x-test-user'] || 'marketing';
    const users = {
      marketing: { id: 7, username: 'mkt', role: 'Sales & Marketing' },
      other: { id: 8, username: 'tl', role: 'Sales and Marketing TL' },
      csr: { id: 9, username: 'csr', role: 'CSR' },
      readkey: { role: 'api_key', username: 'apikey:mcp', scopes: ['meta:read'], key_id: 1 },
      writekey: { role: 'api_key', username: 'apikey:mcp', scopes: ['meta:read', 'meta:write'], key_id: 2 },
    };
    req.user = users[as];
    next();
  });
  app.use('/api/meta', metaRoutes(db, { metaOptions: { fetchImpl: graph.fetchImpl, sleep: noSleep } }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/meta`;
  const call = async (method, path, { as, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(as ? { 'x-test-user': as } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { server, call, base };
}

test('routes enforce role and API-key scope access; tokens never leave the server', async () => {
  const db = await seededDb();
  const graph = fakeGraph();
  const { server, call } = await startApp(db, graph);
  try {
    assert.equal((await call('GET', '/campaigns', { as: 'csr' })).status, 403);
    assert.equal((await call('GET', '/campaigns', { as: 'readkey' })).status, 200);
    assert.equal((await call('POST', '/actions/preview', { as: 'readkey', body: { action: 'pause', level: 'campaign', id: 'C1' } })).status, 403);

    const conns = await call('GET', '/connections');
    assert.equal(conns.status, 200);
    assert.ok(!JSON.stringify(conns.data).includes('access_token'));
    assert.ok(!JSON.stringify(conns.data).includes('EAAB'));

    const csv = await call('GET', '/campaigns?from=2026-09-14&to=2026-09-14&format=csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.data, /Campaign 1 - Search Terms/);
  } finally {
    server.close();
  }
});

test('management actions require a same-user, single-use confirmation and are logged', async () => {
  const db = await seededDb();
  const graph = fakeGraph();
  const { server, call } = await startApp(db, graph);
  try {
    // Unknown objects and bad input are rejected before any Meta call.
    assert.equal((await call('POST', '/actions/preview', { body: { action: 'pause', level: 'campaign', id: 'NOPE' } })).status, 404);
    assert.equal((await call('POST', '/actions/preview', { body: { action: 'update_budget', level: 'campaign', id: 'C1', daily_budget: -5 } })).status, 400);
    assert.equal((await call('POST', '/actions/execute', { body: { confirm_token: 'forged.token' } })).status, 400);

    const preview = await call('POST', '/actions/preview', { body: { action: 'pause', level: 'campaign', id: 'C1' } });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.preview.name, 'Campaign 1 - Search Terms');
    assert.equal(preview.data.preview.current_daily_budget, 400);
    assert.equal(graph.calls.filter((c) => c.method === 'POST').length, 0, 'preview must not touch Meta');

    const token = preview.data.confirm_token;
    assert.equal((await call('POST', '/actions/execute', { as: 'other', body: { confirm_token: token } })).status, 403);

    const done = await call('POST', '/actions/execute', { body: { confirm_token: token } });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    const post = graph.calls.find((c) => c.method === 'POST' && c.path === 'C1');
    assert.equal(post.body.status, 'PAUSED');
    assert.equal((await db.prepare("SELECT status FROM meta_campaigns WHERE meta_campaign_id = 'C1'").get()).status, 'PAUSED');

    assert.equal((await call('POST', '/actions/execute', { body: { confirm_token: token } })).status, 409, 'replay rejected');

    const budget = await call('POST', '/actions/preview', { body: { action: 'update_budget', level: 'adset', id: 'S2', daily_budget: 25 } });
    assert.equal(budget.status, 200);
    assert.ok(budget.data.preview.warnings.some((w) => /2\.5×/.test(w)));
    const budgetDone = await call('POST', '/actions/execute', { body: { confirm_token: budget.data.confirm_token } });
    assert.equal(budgetDone.status, 200);
    assert.equal(graph.calls.find((c) => c.method === 'POST' && c.path === 'S2').body.daily_budget, '2500');

    const logs = await db.prepare('SELECT * FROM meta_action_logs ORDER BY id').all();
    assert.equal(logs.length, 2);
    assert.equal(logs[0].action, 'pause');
    assert.equal(logs[0].old_value, 'ACTIVE');
    assert.equal(logs[0].new_value, 'PAUSED');
    assert.equal(logs[0].username, 'mkt');
    assert.equal(logs[1].old_value, '10');
    assert.equal(logs[1].new_value, '25');
  } finally {
    server.close();
  }
});

// ─── MCP ──────────────────────────────────────────────────────────────────────
test('MCP server lists tools, reads through the API, and gates management tools', async () => {
  const db = await seededDb();
  const graph = fakeGraph();
  const { server, base } = await startApp(db, graph);
  try {
    const apiFetch = (url, init = {}) => {
      const key = init.headers?.['X-API-Key'];
      return fetch(url, { ...init, headers: { ...init.headers, 'x-test-user': key } });
    };
    const mcp = createServer({ apiUrl: base.replace(/\/meta$/, ''), apiKey: 'writekey', fetchImpl: apiFetch });
    const callTool = async (name, args) => (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;

    const init = await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.result.serverInfo.name, 'ynterp-meta-ads');
    assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

    const list = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['get_ad_accounts', 'get_pages', 'get_campaigns', 'get_campaign_insights', 'get_top_ads', 'get_low_roas_campaigns', 'get_profitability', 'pause_campaign', 'update_adset_budget']) {
      assert.ok(names.includes(n), n);
    }

    const accounts = JSON.parse((await callTool('get_ad_accounts', { date_from: '2026-09-14', date_to: '2026-09-15' })).content[0].text);
    assert.equal(accounts.rows[0].name, 'TAKARA Main');
    const pages = JSON.parse((await callTool('get_pages', { date_from: '2026-09-14', date_to: '2026-09-15' })).content[0].text);
    assert.equal(pages.rows.length, 2);
    const campaigns = JSON.parse((await callTool('get_campaigns', { date_from: '2026-09-14', date_to: '2026-09-14', status: 'active' })).content[0].text);
    assert.deepEqual(campaigns.rows.map((r) => r.id), ['C1']);
    const insights = JSON.parse((await callTool('get_campaign_insights', { campaign_id: 'C1', date_from: '2026-09-13', date_to: '2026-09-15' })).content[0].text);
    assert.equal(insights.daily.length, 3);
    const topAds = JSON.parse((await callTool('get_top_ads', { date_from: '2026-09-14', date_to: '2026-09-15' })).content[0].text);
    assert.equal(topAds.rows[0].id, 'A1');
    const low = JSON.parse((await callTool('get_low_roas_campaigns', { date_from: '2026-09-14', date_to: '2026-09-15' })).content[0].text);
    assert.deepEqual(low.rows.map((r) => r.id), ['C2']);

    // Management: first call only previews.
    const preview = await callTool('pause_campaign', { campaign_id: 'C1' });
    assert.match(preview.content[0].text, /ACTION REQUEST/);
    assert.match(preview.content[0].text, /Are you sure\?/);
    assert.equal(graph.calls.filter((c) => c.method === 'POST').length, 0);
    const token = JSON.parse(preview.content[0].text.split('\n\n').pop()).confirm_token;
    const executed = JSON.parse((await callTool('pause_campaign', { campaign_id: 'C1', confirm_token: token })).content[0].text);
    assert.equal(executed.executed, true);
    assert.equal((await db.prepare('SELECT source FROM meta_action_logs').get()).source, 'api_key');

    // A read-only key cannot even preview.
    const readOnly = createServer({ apiUrl: base.replace(/\/meta$/, ''), apiKey: 'readkey', fetchImpl: apiFetch });
    const denied = (await readOnly.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'activate_campaign', arguments: { campaign_id: 'C1' } } })).result;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /meta:write/);
  } finally {
    server.close();
  }
});

test('removing a connection hides its synced rows, and ?purge=1 deletes them', async () => {
  const db = await seededDb();
  const graph = fakeGraph();
  const { server, call } = await startApp(db, graph);
  const range = '?from=2026-09-14&to=2026-09-15';
  const count = async (table) => Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n);
  try {
    assert.equal((await call('GET', `/campaigns${range}`)).data.total, 2);

    const removed = await call('DELETE', '/connections/1');
    assert.equal(removed.status, 200);
    assert.equal(removed.data.purged, null);

    // Detached: nothing lists, no spend is reported, but the rows are still there.
    assert.equal((await call('GET', `/campaigns${range}`)).data.total, 0);
    assert.equal((await call('GET', `/ads${range}`)).data.total, 0);
    assert.equal((await call('GET', `/adsets${range}`)).data.total, 0);
    assert.equal((await call('GET', `/pages${range}`)).data.total, 0);
    assert.equal((await call('GET', `/accounts${range}`)).data.total, 0);
    assert.equal((await call('GET', `/summary${range}`)).data.totals.spend, 0);
    assert.equal((await call('GET', `/summary${range}`)).data.totals.pos_orders, 0);
    assert.equal((await call('GET', '/status')).data.campaigns, 0);
    assert.equal(await count('meta_campaigns'), 2);

    // Reporting on purpose still reaches the history.
    assert.equal((await call('GET', `/campaigns${range}&include_detached=1`)).data.total, 2);

    // Reconnecting the same Meta account re-attaches the accounts and the rows return.
    const again = await call('POST', '/connections', { body: { access_token: 'EAAB-token' } });
    assert.equal(again.status, 201);
    await new Promise((resolve) => setTimeout(resolve, 150)); // background sync re-links act_1
    assert.equal((await call('GET', `/campaigns${range}`)).data.total, 2);

    const purged = await call('DELETE', `/connections/${again.data.connection.id}?purge=1`);
    assert.equal(purged.status, 200);
    assert.ok(purged.data.purged.meta_campaigns >= 2);
    for (const table of ['meta_campaigns', 'meta_adsets', 'meta_ads', 'meta_insights_daily', 'meta_ad_accounts', 'meta_pages']) {
      assert.equal(await count(table), 0, table);
    }
    // The audit trail of management actions is never purged.
    assert.equal((await call('GET', `/campaigns${range}&include_detached=1`)).data.total, 0);
  } finally {
    server.close();
  }
});

test('hiding: unticking an ad account or disabling a connection takes it out of every report', async () => {
  const db = await seededDb();
  const graph = fakeGraph();
  const { server, call } = await startApp(db, graph);
  const range = '?from=2026-09-14&to=2026-09-15';
  try {
    assert.equal((await call('GET', `/campaigns${range}`)).data.total, 2);

    // Untick the ad account: hidden everywhere, history untouched.
    assert.equal((await call('PATCH', '/ad-accounts/act_1', { body: { enabled: false } })).status, 200);
    assert.equal((await call('GET', `/campaigns${range}`)).data.total, 0);
    assert.equal((await call('GET', `/accounts${range}`)).data.total, 0);
    assert.equal((await call('GET', `/summary${range}`)).data.totals.spend, 0);
    assert.equal((await call('GET', '/status')).data.campaigns, 0);
    assert.equal((await call('GET', '/status')).data.ad_accounts, 0);
    assert.equal((await call('GET', `/campaigns${range}&include_detached=1`)).data.total, 2);

    // Tick it back: everything returns without a re-sync.
    await call('PATCH', '/ad-accounts/act_1', { body: { enabled: true } });
    assert.equal((await call('GET', `/campaigns${range}`)).data.total, 2);

    // Same for the whole connection.
    assert.equal((await call('PATCH', '/connections/1', { body: { enabled: false } })).status, 200);
    assert.equal((await call('GET', `/campaigns${range}`)).data.total, 0);
    await call('PATCH', '/connections/1', { body: { enabled: true } });
    assert.equal((await call('GET', `/campaigns${range}`)).data.total, 2);
  } finally {
    server.close();
  }
});

test('ad preview returns a Meta-hosted URL and stores nothing', async () => {
  const db = await seededDb();
  const graph = fakeGraph();
  const { server, call } = await startApp(db, graph);
  try {
    const before = Number((await db.prepare('SELECT COUNT(*) AS n FROM meta_ads').get()).n);
    const preview = await call('GET', '/ads/A1/preview?format=reels');
    assert.equal(preview.status, 200);
    // A signed URL on Meta's own domain: the browser loads it, this server never
    // proxies the video, and no row or byte of creative is written.
    assert.match(preview.data.iframe_src, /^https:\/\/www\.facebook\.com\/ads\/api\/preview_iframe\.php\?/);
    assert.equal(preview.data.format, 'FACEBOOK_REELS_MOBILE');
    assert.ok(!preview.data.iframe_src.includes('&amp;'), 'entities decoded for the browser');
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM meta_ads').get()).n), before);

    // An unknown format falls back instead of failing.
    assert.equal((await call('GET', '/ads/A1/preview?format=nonsense')).data.format, 'MOBILE_FEED_STANDARD');

    assert.equal((await call('GET', '/ads/NOPE/preview')).status, 404);
    assert.equal((await call('GET', '/ads/A1/preview', { as: 'csr' })).status, 403);

    // The token is what renders it, so a detached ad account cannot be previewed.
    await call('DELETE', '/connections/1');
    assert.equal((await call('GET', '/ads/A1/preview')).status, 409);
  } finally {
    server.close();
  }
});

test('billing reads live from Meta, sums our own spend, and totals what the card paid per month', async () => {
  const db = await seededDb();
  const graph = fakeGraph();
  const { server, call } = await startApp(db, graph);
  try {
    const res = await call('GET', '/billing?from=2026-09-14&to=2026-09-15');
    assert.equal(res.status, 200);
    const [account] = res.data.accounts;
    // Minor units converted once, by the account's currency.
    assert.equal(account.balance, 1250.75);
    assert.equal(account.amount_spent, 500000);
    assert.equal(account.spend_cap, null, "Meta's 0 means no cap, not a zero cap");
    assert.equal(account.funding_source, 'Mastercard *1234');
    assert.equal(account.is_prepay, false);
    assert.equal(account.account_status_label, 'Active');
    // Spend comes from our synced insights, not from Meta's billing fields.
    assert.equal(account.spend.range, 150.5);

    // The payment log itself: newest first and tagged with the ad account it
    // was billed to, so several accounts can share one list.
    assert.equal(res.data.charges.length, 6);
    assert.equal(res.data.charges[0].id, 't1-t1b');
    assert.equal(res.data.charges.at(-1).id, 't5');
    assert.equal(res.data.charges[0].ad_account_name, 'TAKARA Main');
    assert.equal(res.data.charges[0].amount, 4500);
    // The billing columns Meta shows: invoice id, card reference, tax, method.
    assert.equal(res.data.charges[0].vat_invoice_id, 'FBADS-582-106588313');
    assert.equal(res.data.charges[0].tracking_id, 'GJTGA3NH24');
    assert.equal(res.data.charges[0].tax_amount, 482.14);
    assert.equal(res.data.charges[0].payment_method, 'Mastercard *1234');
    // Ad credit is a payment method, not a refund, and never a card charge.
    const credit = res.data.charges.find((c) => c.id === 't6');
    assert.equal(credit.is_ad_credit, true);
    assert.equal(credit.payment_method, 'Ad credit');

    // Paid per month: refunds netted off, declines and pending kept apart.
    const september = res.data.charges_by_month.find((m) => m.month === '2026-09');
    assert.equal(september.paid, 7500);
    assert.equal(september.refunded, 500);
    assert.equal(september.net_paid, 7000);
    assert.equal(september.failed, 1000);
    assert.equal(september.ad_credit, 3.54);
    assert.equal(september.count, 5);
    assert.equal(res.data.charges_by_month[0].month, '2026-09', 'newest month first');
    assert.equal(res.data.charges_by_month[1].net_paid, 9000);

    // Spend per month comes from our own insights — the monthly figure the tab
    // stands behind now that Meta removed its per-charge edge.
    assert.deepEqual(res.data.spend_by_month, [
      { month: '2026-09', spend: 150.5 },
    ]);

    // A field this API version dropped is pruned and the call retried, so the
    // rest of the billing details survive instead of falling back to a stub.
    graph.state.deadBillingField = 'disable_reason';
    const pruned = (await call('GET', '/billing')).data.accounts[0];
    assert.equal(pruned.balance, 1250.75);
    assert.equal(pruned.funding_source, 'Mastercard *1234', 'the card must survive a dropped field');
    assert.equal(pruned.error, null);
    graph.state.deadBillingField = null;

    // Meta gates or removes the charge edge depending on the account and API
    // version: a note and the monthly spend, never a broken tab.
    graph.state.transactionsError = true;
    const gated = await call('GET', '/billing');
    assert.equal(gated.status, 200);
    assert.deepEqual(gated.data.charges, []);
    assert.ok(gated.data.charges_note, 'the reason is reported');
    assert.ok(gated.data.spend_by_month.length, 'monthly spend still renders');
    graph.state.transactionsError = false;

    assert.equal((await call('GET', '/billing', { as: 'csr' })).status, 403);

    // Hidden ad accounts are not billed here either.
    await call('PATCH', '/ad-accounts/act_1', { body: { enabled: false } });
    assert.deepEqual((await call('GET', '/billing')).data.accounts, []);
  } finally {
    server.close();
  }
});
