// Read-side aggregation for the Meta Ads module. Everything is summed in SQL
// from meta_insights_daily (Meta-reported numbers) and pos_orders joined through
// meta_ads by Pancake's stored Facebook ad id (YNTERP actuals). The two sources
// are never blended: Meta ROAS uses Meta purchase value, Actual ROAS uses
// delivered COD. See docs/meta-ads-metrics.md for every definition.
const { effectivePosStatusSql, posManilaDaySql } = require('./pancakePosSync');

const LEVELS = {
  campaign: { insKey: 'campaign_id', adKey: 'campaign_id' },
  adset: { insKey: 'adset_id', adKey: 'adset_id' },
  ad: { insKey: 'ad_id', adKey: 'meta_ad_id' },
  page: { insKey: 'page_id', adKey: 'page_id' },
  account: { insKey: 'ad_account_id', adKey: 'ad_account_id' },
};

const SORTABLE = new Set([
  'name', 'effective_status', 'daily_budget', 'spend', 'impressions', 'reach', 'clicks', 'link_clicks', 'ctr', 'cpc', 'cpm',
  'frequency', 'purchases', 'purchase_value', 'roas', 'cpa', 'leads', 'messages', 'cost_per_message', 'pos_orders',
  'delivered', 'returned_total', 'gross_cod', 'delivered_cod', 'returned_cod', 'rts_rate', 'delivery_rate',
  'actual_roas', 'net_after_ads', 'cost_per_order', 'cost_per_delivered',
]);

function manilaToday(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function listParam(value) {
  if (value === undefined || value === null || value === '' || value === 'all') return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw.map((v) => String(v).trim()).filter(Boolean).slice(0, 200);
}

function numParam(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Normalizes query-string filters. Defaults to the last 7 Manila days.
function parseFilters(query = {}, now = new Date()) {
  const today = manilaToday(now);
  let to = isDate(query.to || query.date_to) ? String(query.to || query.date_to) : today;
  let from = isDate(query.from || query.date_from) ? String(query.from || query.date_from) : null;
  if (!from) {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 6);
    from = d.toISOString().slice(0, 10);
  }
  if (from > to) [from, to] = [to, from];
  return {
    from,
    to,
    accounts: listParam(query.ad_account_id),
    // `page` is the pagination number — the Facebook Page filter is page_id only.
    pages: listParam(query.page_id),
    campaigns: listParam(query.campaign_id),
    adsets: listParam(query.adset_id),
    ads: listParam(query.ad_id),
    status: String(query.status || 'all').trim(),
    search: String(query.search || '').trim().toLowerCase().slice(0, 100),
    minSpend: numParam(query.min_spend),
    maxRoas: numParam(query.max_roas),
    minRoas: numParam(query.min_roas),
    roasBasis: query.roas_basis === 'meta' ? 'meta' : 'actual',
    // Ad accounts whose connection was removed keep their synced rows so old
    // date ranges still report, but they are hidden everywhere by default —
    // otherwise a disconnected account's campaigns go on listing forever.
    includeDetached: query.include_detached === '1' || query.include_detached === 'true' || query.include_detached === true,
  };
}

// The ad accounts a report is allowed to show: still attached to a connection,
// that connection not switched off, and the account's own checkbox ticked.
// Unticking an ad account or disabling a connection is therefore the way to
// hide one without deleting its history; include_detached=1 reads past it.
// A subquery rather than a join so it can be dropped into any WHERE without
// touching the alias list or the bound parameters.
const VISIBLE_ACCOUNTS_SQL = `SELECT a.meta_ad_account_id FROM meta_ad_accounts a
    JOIN meta_connections c ON c.id = a.connection_id
    WHERE a.enabled = 1 AND c.status <> 'disabled'`;

function connectedClause(column, f) {
  if (f.includeDetached) return null;
  return `${column} IN (${VISIBLE_ACCOUNTS_SQL})`;
}

function inClause(column, values, params) {
  params.push(...values);
  return `${column} IN (${values.map(() => '?').join(', ')})`;
}

// WHERE fragments for the two fact sources. `alias` is the table alias of
// meta_insights_daily (i) or meta_ads (m).
function insightsWhere(f, params) {
  const parts = ['i.date >= ?', 'i.date <= ?'];
  params.push(f.from, f.to);
  if (f.accounts.length) parts.push(inClause('i.ad_account_id', f.accounts, params));
  if (f.pages.length) parts.push(inClause('i.page_id', f.pages, params));
  if (f.campaigns.length) parts.push(inClause('i.campaign_id', f.campaigns, params));
  if (f.adsets.length) parts.push(inClause('i.adset_id', f.adsets, params));
  if (f.ads.length) parts.push(inClause('i.ad_id', f.ads, params));
  const connected = connectedClause('i.ad_account_id', f); if (connected) parts.push(connected);
  return parts.join(' AND ');
}

function posWhere(db, f, params) {
  const day = posManilaDaySql(db.type, 'p.');
  const parts = [
    'p.ad_id IS NOT NULL',
    "p.status_name NOT IN ('canceled', 'removed')",
    `${day} >= ?`,
    `${day} <= ?`,
  ];
  params.push(f.from, f.to);
  if (f.accounts.length) parts.push(inClause('m.ad_account_id', f.accounts, params));
  if (f.pages.length) parts.push(inClause('m.page_id', f.pages, params));
  if (f.campaigns.length) parts.push(inClause('m.campaign_id', f.campaigns, params));
  if (f.adsets.length) parts.push(inClause('m.adset_id', f.adsets, params));
  if (f.ads.length) parts.push(inClause('m.meta_ad_id', f.ads, params));
  const connected = connectedClause('m.ad_account_id', f); if (connected) parts.push(connected);
  return parts.join(' AND ');
}

const INSIGHT_SUMS = `
  SUM(i.spend) AS spend, SUM(i.impressions) AS impressions, SUM(i.reach) AS reach,
  SUM(i.clicks) AS clicks, SUM(i.link_clicks) AS link_clicks, SUM(i.purchases) AS purchases,
  SUM(i.purchase_value) AS purchase_value, SUM(i.leads) AS leads, SUM(i.messages) AS messages`;

function posSums() {
  const st = effectivePosStatusSql(undefined, 'p.status_name');
  return `
  COUNT(*) AS pos_orders,
  SUM(CASE WHEN (${st}) = 'delivered' THEN 1 ELSE 0 END) AS delivered,
  SUM(CASE WHEN (${st}) = 'returned' THEN 1 ELSE 0 END) AS returned,
  SUM(CASE WHEN (${st}) = 'returning' THEN 1 ELSE 0 END) AS returning_count,
  COALESCE(SUM(p.cod), 0) AS gross_cod,
  COALESCE(SUM(CASE WHEN (${st}) = 'delivered' THEN p.cod ELSE 0 END), 0) AS delivered_cod,
  COALESCE(SUM(CASE WHEN (${st}) IN ('returned', 'returning') THEN p.cod ELSE 0 END), 0) AS returned_cod`;
}

// Base rows per level: the entity plus its display context.
function baseSelect(level, f, params) {
  const where = [];
  const statusClause = (col) => {
    const s = f.status.toLowerCase();
    if (s === 'active') return `${col} = 'ACTIVE'`;
    if (s === 'paused') return `${col} IN ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED')`;
    if (s && s !== 'all' && s !== 'with_spend' && /^[a-z_]+$/.test(s)) { params.push(s.toUpperCase()); return `${col} = ?`; }
    return null;
  };
  const search = (col) => { params.push(`%${f.search}%`); return `LOWER(COALESCE(${col}, '')) LIKE ?`; };

  if (level === 'campaign') {
    if (f.accounts.length) where.push(inClause('e.ad_account_id', f.accounts, params));
    if (f.campaigns.length) where.push(inClause('e.meta_campaign_id', f.campaigns, params));
    if (f.pages.length) where.push(`EXISTS (SELECT 1 FROM meta_ads x WHERE x.campaign_id = e.meta_campaign_id AND ${inClause('x.page_id', f.pages, params)})`);
    const sc = statusClause('e.effective_status'); if (sc) where.push(sc);
    if (f.search) where.push(search('e.name'));
    const connected = connectedClause('e.ad_account_id', f); if (connected) where.push(connected);
    return `SELECT e.meta_campaign_id AS id, e.name, e.ad_account_id, acc.name AS ad_account_name, acc.currency,
        e.status, e.effective_status, e.objective, e.daily_budget, e.lifetime_budget
      FROM meta_campaigns e LEFT JOIN meta_ad_accounts acc ON acc.meta_ad_account_id = e.ad_account_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  }
  if (level === 'adset') {
    if (f.accounts.length) where.push(inClause('e.ad_account_id', f.accounts, params));
    if (f.campaigns.length) where.push(inClause('e.campaign_id', f.campaigns, params));
    if (f.adsets.length) where.push(inClause('e.meta_adset_id', f.adsets, params));
    if (f.pages.length) where.push(`EXISTS (SELECT 1 FROM meta_ads x WHERE x.adset_id = e.meta_adset_id AND ${inClause('x.page_id', f.pages, params)})`);
    const sc = statusClause('e.effective_status'); if (sc) where.push(sc);
    if (f.search) where.push(search('e.name'));
    const connected = connectedClause('e.ad_account_id', f); if (connected) where.push(connected);
    return `SELECT e.meta_adset_id AS id, e.name, e.ad_account_id, acc.name AS ad_account_name, acc.currency,
        e.campaign_id, c.name AS campaign_name, e.status, e.effective_status, e.daily_budget, e.lifetime_budget,
        e.optimization_goal
      FROM meta_adsets e
      LEFT JOIN meta_ad_accounts acc ON acc.meta_ad_account_id = e.ad_account_id
      LEFT JOIN meta_campaigns c ON c.meta_campaign_id = e.campaign_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  }
  if (level === 'ad') {
    if (f.accounts.length) where.push(inClause('e.ad_account_id', f.accounts, params));
    if (f.campaigns.length) where.push(inClause('e.campaign_id', f.campaigns, params));
    if (f.adsets.length) where.push(inClause('e.adset_id', f.adsets, params));
    if (f.ads.length) where.push(inClause('e.meta_ad_id', f.ads, params));
    if (f.pages.length) where.push(inClause('e.page_id', f.pages, params));
    const sc = statusClause('e.effective_status'); if (sc) where.push(sc);
    if (f.search) where.push(search('e.name'));
    const connected = connectedClause('e.ad_account_id', f); if (connected) where.push(connected);
    return `SELECT e.meta_ad_id AS id, e.name, e.ad_account_id, acc.name AS ad_account_name, acc.currency,
        e.campaign_id, c.name AS campaign_name, e.adset_id, s.name AS adset_name, e.page_id, pg.name AS page_name,
        e.status, e.effective_status, e.creative_id, e.thumbnail_url, s.daily_budget AS daily_budget
      FROM meta_ads e
      LEFT JOIN meta_ad_accounts acc ON acc.meta_ad_account_id = e.ad_account_id
      LEFT JOIN meta_campaigns c ON c.meta_campaign_id = e.campaign_id
      LEFT JOIN meta_adsets s ON s.meta_adset_id = e.adset_id
      LEFT JOIN meta_pages pg ON pg.meta_page_id = e.page_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  }
  if (level === 'page') {
    const inner = ['x.page_id IS NOT NULL'];
    const connectedPages = connectedClause('x.ad_account_id', f); if (connectedPages) inner.push(connectedPages);
    if (f.accounts.length) inner.push(inClause('x.ad_account_id', f.accounts, params));
    if (f.pages.length) inner.push(inClause('x.page_id', f.pages, params));
    if (f.campaigns.length) inner.push(inClause('x.campaign_id', f.campaigns, params));
    if (f.search) where.push(search('COALESCE(pg.name, k.page_id)'));
    return `SELECT k.page_id AS id, COALESCE(pg.name, k.page_id) AS name, pg.category
      FROM (SELECT DISTINCT x.page_id FROM meta_ads x WHERE ${inner.join(' AND ')}) k
      LEFT JOIN meta_pages pg ON pg.meta_page_id = k.page_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  }
  // account
  if (f.accounts.length) where.push(inClause('e.meta_ad_account_id', f.accounts, params));
  if (f.search) where.push(search('e.name'));
  const visible = connectedClause('e.meta_ad_account_id', f); if (visible) where.push(visible);
  return `SELECT e.meta_ad_account_id AS id, e.name, e.currency, e.timezone_name, e.account_status, e.business_name,
      e.enabled, e.connection_id, e.last_sync_at, e.last_insights_date
    FROM meta_ad_accounts e
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
}

// The derived-metric formulas, once, in SQL. derive() below is the same set in
// JS for totals and trend rows; the test suite checks they agree.
const DERIVED_SQL = `
  CASE WHEN q.spend > 0 THEN q.purchase_value / q.spend END AS roas,
  CASE WHEN q.spend > 0 THEN q.delivered_cod / q.spend END AS actual_roas,
  CASE WHEN q.purchases > 0 THEN q.spend / q.purchases END AS cpa,
  CASE WHEN q.impressions > 0 THEN q.clicks * 100.0 / q.impressions END AS ctr,
  CASE WHEN q.clicks > 0 THEN q.spend / q.clicks END AS cpc,
  CASE WHEN q.impressions > 0 THEN q.spend * 1000.0 / q.impressions END AS cpm,
  CASE WHEN q.reach > 0 THEN q.impressions * 1.0 / q.reach END AS frequency,
  CASE WHEN q.messages > 0 THEN q.spend / q.messages END AS cost_per_message,
  CASE WHEN q.pos_orders > 0 THEN q.spend / q.pos_orders END AS cost_per_order,
  CASE WHEN q.delivered > 0 THEN q.spend / q.delivered END AS cost_per_delivered,
  CASE WHEN (q.delivered + q.returned + q.returning_count) > 0
       THEN (q.returned + q.returning_count) * 100.0 / (q.delivered + q.returned + q.returning_count) END AS rts_rate,
  CASE WHEN (q.delivered + q.returned + q.returning_count) > 0
       THEN q.delivered * 100.0 / (q.delivered + q.returned + q.returning_count) END AS delivery_rate,
  q.returned + q.returning_count AS returned_total,
  q.delivered_cod - q.spend AS net_after_ads`;

const NUMERIC_FIELDS = [
  'spend', 'impressions', 'reach', 'clicks', 'link_clicks', 'purchases', 'purchase_value', 'leads', 'messages',
  'pos_orders', 'delivered', 'returned', 'returning_count', 'gross_cod', 'delivered_cod', 'returned_cod',
];
const DERIVED_FIELDS = [
  'roas', 'actual_roas', 'cpa', 'ctr', 'cpc', 'cpm', 'frequency', 'cost_per_message', 'cost_per_order',
  'cost_per_delivered', 'rts_rate', 'delivery_rate', 'returned_total', 'net_after_ads',
];

function derive(row) {
  const r = { ...row };
  for (const k of NUMERIC_FIELDS) r[k] = Number(r[k] || 0);
  const div = (a, b) => (b > 0 ? a / b : null);
  const settled = r.delivered + r.returned + r.returning_count;
  r.roas = div(r.purchase_value, r.spend);
  r.actual_roas = div(r.delivered_cod, r.spend);
  r.cpa = div(r.spend, r.purchases);
  r.ctr = div(r.clicks * 100, r.impressions);
  r.cpc = div(r.spend, r.clicks);
  r.cpm = div(r.spend * 1000, r.impressions);
  r.frequency = div(r.impressions, r.reach);
  r.cost_per_message = div(r.spend, r.messages);
  r.cost_per_order = div(r.spend, r.pos_orders);
  r.cost_per_delivered = div(r.spend, r.delivered);
  r.rts_rate = div((r.returned + r.returning_count) * 100, settled);
  r.delivery_rate = div(r.delivered * 100, settled);
  r.returned_total = r.returned + r.returning_count;
  r.net_after_ads = r.delivered_cod - r.spend;
  return r;
}

function cleanRow(row) {
  const out = { ...row };
  for (const k of [...NUMERIC_FIELDS, 'daily_budget', 'lifetime_budget']) {
    if (out[k] !== undefined && out[k] !== null) out[k] = Number(out[k]);
  }
  for (const k of DERIVED_FIELDS) {
    out[k] = out[k] === null || out[k] === undefined ? null : Number(out[k]);
  }
  delete out.total_count;
  return out;
}

// ─── Targets & flags ──────────────────────────────────────────────────────────
const TARGET_FIELDS = ['target_roas', 'target_actual_roas', 'max_cpa', 'max_cpm', 'min_ctr', 'max_rts'];

async function loadTargets(db) {
  const rows = await db.prepare('SELECT * FROM meta_targets').all();
  const map = new Map(rows.map((r) => [`${r.scope_type}:${r.scope_id}`, r]));
  return map;
}

// Most specific scope wins per field: campaign → page → ad account → organization.
function resolveTargets(targetMap, row, level) {
  const chain = [];
  const campaignId = level === 'campaign' ? row.id : row.campaign_id;
  const pageId = level === 'page' ? row.id : row.page_id;
  const accountId = level === 'account' ? row.id : row.ad_account_id;
  if (campaignId) chain.push(targetMap.get(`campaign:${campaignId}`));
  if (pageId) chain.push(targetMap.get(`page:${pageId}`));
  if (accountId) chain.push(targetMap.get(`ad_account:${accountId}`));
  chain.push(targetMap.get('organization:'));
  const resolved = {};
  for (const field of TARGET_FIELDS) {
    const hit = chain.find((t) => t && t[field] !== null && t[field] !== undefined);
    resolved[field] = hit ? Number(hit[field]) : null;
  }
  return resolved;
}

// Winning / Needs attention. Actual ROAS and RTS only count once at least half
// of the attributed orders have a delivery verdict — a campaign whose orders are
// still in transit would otherwise always look like it is losing money.
function flagRow(row, t) {
  const reasons = [];
  if (!(row.spend > 0)) return { flag: null, reasons };
  const settled = row.delivered + row.returned + row.returning_count;
  const verdictReady = row.pos_orders > 0 && settled >= row.pos_orders / 2;

  if (t.target_actual_roas !== null && verdictReady && row.actual_roas !== null && row.actual_roas < t.target_actual_roas) {
    reasons.push(`Actual ROAS ${row.actual_roas.toFixed(2)} below ${t.target_actual_roas}`);
  }
  if (t.target_roas !== null && row.purchases > 0 && row.roas !== null && row.roas < t.target_roas) {
    reasons.push(`Meta ROAS ${row.roas.toFixed(2)} below ${t.target_roas}`);
  }
  if (t.max_cpa !== null && row.cost_per_order !== null && row.cost_per_order > t.max_cpa) {
    reasons.push(`Cost per order ${row.cost_per_order.toFixed(0)} above ${t.max_cpa}`);
  }
  if (t.max_cpa !== null && row.pos_orders === 0 && row.purchases === 0 && row.spend >= t.max_cpa) {
    reasons.push('Spend with zero orders');
  }
  if (t.max_cpm !== null && row.cpm !== null && row.cpm > t.max_cpm) reasons.push(`CPM ${row.cpm.toFixed(0)} above ${t.max_cpm}`);
  if (t.min_ctr !== null && row.impressions >= 1000 && row.ctr !== null && row.ctr < t.min_ctr) reasons.push(`CTR ${row.ctr.toFixed(2)}% below ${t.min_ctr}%`);
  if (t.max_rts !== null && verdictReady && row.rts_rate !== null && row.rts_rate > t.max_rts) reasons.push(`RTS ${row.rts_rate.toFixed(1)}% above ${t.max_rts}%`);
  if (reasons.length) return { flag: 'attention', reasons };

  const hasAnyTarget = t.target_actual_roas !== null || t.target_roas !== null;
  const actualWin = t.target_actual_roas !== null && verdictReady && row.actual_roas >= t.target_actual_roas;
  const metaWin = t.target_roas !== null && row.purchases > 0 && row.roas >= t.target_roas;
  if (hasAnyTarget && (actualWin || metaWin)) {
    return { flag: 'winning', reasons: [actualWin ? `Actual ROAS ${row.actual_roas.toFixed(2)}` : `Meta ROAS ${row.roas.toFixed(2)}`] };
  }
  return { flag: null, reasons };
}

// ─── Queries ──────────────────────────────────────────────────────────────────
async function listLevel(db, level, query = {}, { now } = {}) {
  if (!LEVELS[level]) throw new Error(`Unknown level: ${level}`);
  const f = parseFilters(query, now);
  const { insKey, adKey } = LEVELS[level];
  // Params are collected in the order their placeholders appear in the SQL
  // text: base subquery, insights join, POS join, outer filters, LIMIT/OFFSET.
  const params = [];
  const base = baseSelect(level, f, params);
  const insSql = `SELECT i.${insKey} AS k, ${INSIGHT_SUMS} FROM meta_insights_daily i WHERE ${insightsWhere(f, params)} GROUP BY i.${insKey}`;
  const posSql = `SELECT m.${adKey} AS k, ${posSums()} FROM pos_orders p JOIN meta_ads m ON m.meta_ad_id = p.ad_id WHERE ${posWhere(db, f, params)} GROUP BY m.${adKey}`;

  const outer = [];
  if (f.status === 'with_spend') outer.push('d.spend > 0');
  if (f.minSpend !== null) { outer.push('d.spend >= ?'); params.push(f.minSpend); }
  const roasCol = f.roasBasis === 'meta' ? 'd.roas' : 'd.actual_roas';
  if (f.maxRoas !== null) { outer.push(`d.spend > 0 AND COALESCE(${roasCol}, 0) < ?`); params.push(f.maxRoas); }
  if (f.minRoas !== null) { outer.push(`${roasCol} >= ?`); params.push(f.minRoas); }

  const sortKey = SORTABLE.has(String(query.sort)) ? String(query.sort) : 'spend';
  const dir = String(query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const perPage = Math.max(1, Math.min(Number(query.per_page || query.limit) || 50, Number(query.max_per_page) || 200));
  const page = Math.max(1, Number(query.page) || 1);
  params.push(perPage, (page - 1) * perPage);

  const sql = `
    SELECT d.*, COUNT(*) OVER () AS total_count FROM (
      SELECT q.*, ${DERIVED_SQL} FROM (
        SELECT b.*,
          COALESCE(ins.spend, 0) AS spend, COALESCE(ins.impressions, 0) AS impressions, COALESCE(ins.reach, 0) AS reach,
          COALESCE(ins.clicks, 0) AS clicks, COALESCE(ins.link_clicks, 0) AS link_clicks,
          COALESCE(ins.purchases, 0) AS purchases, COALESCE(ins.purchase_value, 0) AS purchase_value,
          COALESCE(ins.leads, 0) AS leads, COALESCE(ins.messages, 0) AS messages,
          COALESCE(pos.pos_orders, 0) AS pos_orders, COALESCE(pos.delivered, 0) AS delivered,
          COALESCE(pos.returned, 0) AS returned, COALESCE(pos.returning_count, 0) AS returning_count,
          COALESCE(pos.gross_cod, 0) AS gross_cod, COALESCE(pos.delivered_cod, 0) AS delivered_cod,
          COALESCE(pos.returned_cod, 0) AS returned_cod
        FROM (${base}) b
        LEFT JOIN (${insSql}) ins ON ins.k = b.id
        LEFT JOIN (${posSql}) pos ON pos.k = b.id
      ) q
    ) d
    ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
    ORDER BY d.${sortKey} ${dir} NULLS LAST, d.name ASC
    LIMIT ? OFFSET ?`;

  const rows = await db.prepare(sql).all(...params);
  const targets = await loadTargets(db);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    level,
    filters: { from: f.from, to: f.to },
    page,
    per_page: perPage,
    total,
    rows: rows.map((raw) => {
      const row = cleanRow(raw);
      const { flag, reasons } = flagRow(row, resolveTargets(targets, row, level));
      return { ...row, flag, flag_reasons: reasons };
    }),
  };
}

async function summary(db, query = {}, { now } = {}) {
  const f = parseFilters(query, now);
  const insParams = [];
  const posParams = [];
  const ins = await db.prepare(`SELECT ${INSIGHT_SUMS} FROM meta_insights_daily i WHERE ${insightsWhere(f, insParams)}`).get(...insParams);
  const pos = await db.prepare(`SELECT ${posSums()} FROM pos_orders p JOIN meta_ads m ON m.meta_ad_id = p.ad_id WHERE ${posWhere(db, f, posParams)}`).get(...posParams);
  const lastSync = await db.prepare('SELECT MAX(last_sync_at) AS last_sync_at FROM meta_connections').get();
  return {
    filters: { from: f.from, to: f.to },
    totals: derive({ ...(ins || {}), ...(pos || {}) }),
    last_sync_at: lastSync?.last_sync_at || null,
  };
}

async function trend(db, query = {}, { now } = {}) {
  const f = parseFilters(query, now);
  const insParams = [];
  const posParams = [];
  const insRows = await db.prepare(`SELECT i.date AS day, ${INSIGHT_SUMS} FROM meta_insights_daily i WHERE ${insightsWhere(f, insParams)} GROUP BY i.date`).all(...insParams);
  const day = posManilaDaySql(db.type, 'p.');
  const posRows = await db.prepare(`SELECT ${day} AS day, ${posSums()} FROM pos_orders p JOIN meta_ads m ON m.meta_ad_id = p.ad_id WHERE ${posWhere(db, f, posParams)} GROUP BY ${day}`).all(...posParams);
  const byDay = new Map();
  for (let d = f.from; d <= f.to;) {
    byDay.set(d, { day: d });
    const next = new Date(`${d}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    d = next.toISOString().slice(0, 10);
    if (byDay.size > 1100) break;
  }
  for (const r of insRows) Object.assign(byDay.get(r.day) || byDay.set(r.day, { day: r.day }).get(r.day), r);
  for (const r of posRows) Object.assign(byDay.get(r.day) || byDay.set(r.day, { day: r.day }).get(r.day), r);
  return {
    filters: { from: f.from, to: f.to },
    days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map(derive),
  };
}

const ENTITY_TABLES = {
  campaign: ['meta_campaigns', 'meta_campaign_id'],
  adset: ['meta_adsets', 'meta_adset_id'],
  ad: ['meta_ads', 'meta_ad_id'],
  page: ['meta_pages', 'meta_page_id'],
  account: ['meta_ad_accounts', 'meta_ad_account_id'],
};

async function entityDetail(db, level, id, query = {}, { now } = {}) {
  const table = ENTITY_TABLES[level];
  if (!table) throw new Error(`Unknown level: ${level}`);
  const scopeKey = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id', page: 'page_id', account: 'ad_account_id' }[level];
  const scoped = { from: query.from, to: query.to, [scopeKey]: id };
  const list = await listLevel(db, level, { ...scoped, per_page: 1 }, { now });
  const row = list.rows.find((r) => r.id === id) || null;
  if (!row) return null;
  const record = await db.prepare(`SELECT * FROM ${table[0]} WHERE ${table[1]} = ?`).get(id);
  if (record) delete record.access_token_encrypted;
  return { level, row, record, trend: (await trend(db, scoped, { now })).days };
}

function toCsv(rows, columns) {
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'number' ? String(Math.round(value * 10000) / 10000) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  return [header, ...rows.map((row) => columns.map((c) => escape(row[c.key])).join(','))].join('\r\n');
}

module.exports = {
  VISIBLE_ACCOUNTS_SQL,
  LEVELS,
  TARGET_FIELDS,
  parseFilters,
  listLevel,
  summary,
  trend,
  entityDetail,
  derive,
  flagRow,
  resolveTargets,
  loadTargets,
  toCsv,
  manilaToday,
};
