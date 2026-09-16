#!/usr/bin/env node
// YNTERP Meta Ads MCP server (stdio). Exposes the Meta Ads module to an AI
// client (Claude Code, Claude Desktop, ...) by calling the dashboard's own
// /api/meta endpoints with an API key — so it gets exactly the same
// authorization, filtering and action logging as the dashboard.
//
// Env:
//   YNT_API_URL   base API url, default http://localhost:3001/api
//   YNT_API_KEY   dashboard API key with meta:read (and meta:write for actions)
//
// No SDK dependency: MCP over stdio is newline-delimited JSON-RPC 2.0, and this
// server only needs initialize / tools/list / tools/call.

const SERVER_INFO = { name: 'ynterp-meta-ads', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

const FILTER_PROPS = {
  date_from: { type: 'string', description: 'Start date YYYY-MM-DD (default: 6 days before date_to)' },
  date_to: { type: 'string', description: 'End date YYYY-MM-DD (default: today, Asia/Manila)' },
  ad_account_id: { type: 'string', description: 'Meta ad account id, e.g. act_123 (comma-separate for several)' },
  page_id: { type: 'string', description: 'Facebook Page id (comma-separate for several)' },
  campaign_id: { type: 'string', description: 'Meta campaign id(s)' },
  adset_id: { type: 'string', description: 'Meta ad set id(s)' },
  ad_id: { type: 'string', description: 'Meta ad id(s)' },
  status: { type: 'string', description: 'all | active | paused | with_spend' },
  search: { type: 'string', description: 'Case-insensitive name contains' },
  sort: { type: 'string', description: 'spend | actual_roas | roas | pos_orders | delivered_cod | rts_rate | cpm | ctr | cost_per_order | net_after_ads | name ...' },
  dir: { type: 'string', description: 'asc | desc (default desc)' },
  limit: { type: 'number', description: 'Max rows (default 25, max 200)' },
};

const METRIC_NOTE = 'Rows carry Meta-reported metrics (spend, impressions, clicks, ctr, cpc, cpm, messages, purchases, purchase_value, roas = Meta ROAS) and YNTERP POS actuals attributed by Facebook ad id (pos_orders, delivered, returned_total, delivered_cod, rts_rate %, actual_roas = delivered COD / spend, net_after_ads = delivered COD - spend). Never mix Meta ROAS with Actual ROAS. Amounts are in the ad account currency (PHP).';

function filterSchema(extra = {}, required = []) {
  return { type: 'object', properties: { ...FILTER_PROPS, ...extra }, required };
}

function toQuery(args = {}, defaults = {}) {
  const q = { ...defaults };
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'date_from') q.from = value;
    else if (key === 'date_to') q.to = value;
    else if (key === 'limit') q.per_page = Math.max(1, Math.min(200, Number(value) || 25));
    else if (key === 'confirm_token' || key === 'daily_budget') continue;
    else q[key] = value;
  }
  if (!q.per_page) q.per_page = 25;
  return q;
}

// Keeps tool output compact: the fields an analyst needs, rounded.
function slimRow(row) {
  const keep = [
    'id', 'name', 'ad_account_name', 'campaign_name', 'adset_name', 'page_name', 'effective_status', 'daily_budget',
    'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'messages', 'cost_per_message', 'purchases', 'purchase_value',
    'roas', 'cpa', 'pos_orders', 'cost_per_order', 'delivered', 'returned_total', 'delivered_cod', 'rts_rate',
    'actual_roas', 'net_after_ads', 'flag', 'flag_reasons',
  ];
  const out = {};
  for (const key of keep) {
    if (row[key] === undefined || row[key] === null || (Array.isArray(row[key]) && !row[key].length)) continue;
    out[key] = typeof row[key] === 'number' ? Math.round(row[key] * 100) / 100 : row[key];
  }
  return out;
}

function listTool(name, description, path, defaults = {}, extra = {}) {
  return {
    name,
    description: `${description} ${METRIC_NOTE}`,
    inputSchema: filterSchema(extra),
    run: async (api, args) => {
      const data = await api.get(path, toQuery(args, defaults));
      return { date_range: data.filters, total_matching: data.total, rows: data.rows.map(slimRow) };
    },
  };
}

function insightsTool(name, level, idKey) {
  return {
    name,
    description: `Daily performance series for one ${level} (Meta metrics + POS actuals per day) plus range totals. ${METRIC_NOTE}`,
    inputSchema: filterSchema({}, [idKey]),
    run: async (api, args) => {
      const query = toQuery(args);
      const detail = await api.get(`/entity/${level}/${encodeURIComponent(args[idKey])}`, { from: query.from, to: query.to });
      return {
        [level]: slimRow(detail.row),
        daily: detail.trend.map((d) => ({
          day: d.day, spend: round(d.spend), impressions: d.impressions, clicks: d.clicks, messages: d.messages,
          purchases: d.purchases, roas: round(d.roas), pos_orders: d.pos_orders, delivered_cod: round(d.delivered_cod), actual_roas: round(d.actual_roas),
        })),
      };
    },
  };
}

function round(value) {
  return value === null || value === undefined ? null : Math.round(Number(value) * 100) / 100;
}

// Two-step management tools. Without confirm_token the tool only previews and
// returns a token; the client must show the preview to the user and call again
// with that token after the user explicitly confirms.
function actionTool(name, action, level, label) {
  const isBudget = action === 'update_budget';
  const idKey = `${level}_id`;
  const properties = {
    [idKey]: { type: 'string', description: `Meta ${label.toLowerCase()} id` },
    confirm_token: { type: 'string', description: 'Only pass the token returned by a previous preview call, and only after the user explicitly confirmed that exact action in the conversation.' },
  };
  if (isBudget) properties.daily_budget = { type: 'number', description: 'New daily budget in account currency units (e.g. 1500 = PHP 1,500)' };
  return {
    name,
    description: `${isBudget ? `Change a ${label.toLowerCase()}'s daily budget` : `${action === 'pause' ? 'Pause' : 'Activate'} a ${label.toLowerCase()}`}. FINANCIALLY SENSITIVE. `
      + 'Call first WITHOUT confirm_token to get an ACTION REQUEST preview. Show it to the user verbatim and ask them to confirm. '
      + 'Only if the user explicitly confirms, call again with the confirm_token. Never confirm on the user\'s behalf.',
    inputSchema: { type: 'object', properties, required: isBudget ? [idKey, 'daily_budget'] : [idKey] },
    run: async (api, args) => {
      if (args.confirm_token) {
        const result = await api.post('/actions/execute', { confirm_token: args.confirm_token });
        return { executed: true, ...result };
      }
      const body = { action, level, id: args[idKey] };
      if (isBudget) body.daily_budget = args.daily_budget;
      const { preview, confirm_token: token, expires_at: expiresAt } = await api.post('/actions/preview', body);
      const money = (v) => (v === null || v === undefined ? 'n/a' : `${preview.currency || ''} ${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`.trim());
      const lines = [
        'ACTION REQUEST — requires explicit user confirmation',
        '',
        `${preview.title}: "${preview.name}"`,
        `Ad account: ${preview.ad_account}`,
        `Current status: ${preview.current_status} (delivery: ${preview.effective_status})`,
        `Current daily budget: ${money(preview.current_daily_budget)}`,
        `Spend today: ${money(preview.spend_today)}`,
      ];
      if (preview.new_status) lines.push(`New status: ${preview.new_status}`);
      if (preview.new_daily_budget !== undefined) lines.push(`New daily budget: ${money(preview.new_daily_budget)}`);
      for (const w of preview.warnings || []) lines.push(`⚠ ${w}`);
      lines.push('', 'Ask the user: "Are you sure?" [Cancel] / [Confirm].',
        `If and only if they confirm, call ${name} again with confirm_token (expires ${expiresAt}).`);
      return { requires_confirmation: true, message: lines.join('\n'), confirm_token: token, expires_at: expiresAt };
    },
  };
}

const TOOLS = [
  {
    name: 'get_meta_connections',
    description: 'List connected Meta accounts, their ad accounts, status and last sync time.',
    inputSchema: { type: 'object', properties: {} },
    run: async (api) => (await api.get('/connections')).connections,
  },
  {
    name: 'get_sync_status',
    description: 'Data freshness: latest synced insight date, last sync time, and recent sync log entries (errors included).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    run: async (api, args) => {
      const [status, logs] = await Promise.all([api.get('/status'), api.get('/sync-logs', { limit: args.limit || 15 })]);
      return { ...status, recent_logs: logs.logs };
    },
  },
  listTool('get_ad_accounts', 'Ad accounts with performance totals for the date range.', '/accounts'),
  listTool('get_pages', 'Facebook Pages (from ads\' creatives) with performance totals for the date range.', '/pages'),
  listTool('get_campaigns', 'Campaigns with performance for the date range.', '/campaigns'),
  listTool('get_adsets', 'Ad sets with performance for the date range. Filter by campaign_id to drill down.', '/adsets'),
  listTool('get_ads', 'Ads with performance for the date range. Filter by campaign_id / adset_id to drill down.', '/ads'),
  insightsTool('get_campaign_insights', 'campaign', 'campaign_id'),
  insightsTool('get_adset_insights', 'adset', 'adset_id'),
  insightsTool('get_ad_insights', 'ad', 'ad_id'),
  listTool('get_page_performance', 'Compare Facebook Pages: spend, Meta ROAS, POS orders, delivered COD, RTS, Actual ROAS.', '/pages'),
  listTool('get_account_performance', 'Compare ad accounts.', '/accounts'),
  listTool('get_top_campaigns', 'Best campaigns, ranked by actual_roas by default (use sort to change). Only campaigns with spend.', '/campaigns', { sort: 'actual_roas', status: 'with_spend' }),
  listTool('get_top_ads', 'Best ads, ranked by actual_roas by default. Only ads with spend.', '/ads', { sort: 'actual_roas', status: 'with_spend' }),
  listTool('get_low_roas_campaigns', 'Campaigns with spend whose ROAS is below max_roas. roas_basis=actual (delivered COD, default) or meta.', '/campaigns',
    { sort: 'spend', max_roas: 2 },
    { max_roas: { type: 'number', description: 'ROAS threshold (default 2)' }, roas_basis: { type: 'string', description: 'actual | meta' }, min_spend: { type: 'number' } }),
  {
    name: 'get_profitability',
    description: `Real profitability: totals plus a breakdown (group_by page | account | campaign | adset | ad). ${METRIC_NOTE}`,
    inputSchema: filterSchema({ group_by: { type: 'string', description: 'page | account | campaign | adset | ad (default page)' } }),
    run: async (api, args) => {
      const data = await api.get('/profitability', toQuery(args));
      const t = data.totals;
      return {
        date_range: data.filters,
        totals: {
          ad_spend: round(t.spend), meta_purchases: t.purchases, meta_revenue: round(t.purchase_value), meta_roas: round(t.roas),
          pos_orders: t.pos_orders, gross_cod: round(t.gross_cod), delivered: t.delivered, delivered_cod: round(t.delivered_cod),
          returned_cod: round(t.returned_cod), rts_rate_pct: round(t.rts_rate), delivery_rate_pct: round(t.delivery_rate),
          cost_per_order: round(t.cost_per_order), cost_per_delivered_order: round(t.cost_per_delivered),
          actual_roas: round(t.actual_roas), delivered_cod_minus_spend: round(t.net_after_ads),
        },
        group_by: data.group_by,
        rows: data.rows.map(slimRow),
        notes: data.notes,
      };
    },
  },
  actionTool('pause_campaign', 'pause', 'campaign', 'Campaign'),
  actionTool('activate_campaign', 'activate', 'campaign', 'Campaign'),
  actionTool('pause_adset', 'pause', 'adset', 'Ad set'),
  actionTool('activate_adset', 'activate', 'adset', 'Ad set'),
  actionTool('pause_ad', 'pause', 'ad', 'Ad'),
  actionTool('activate_ad', 'activate', 'ad', 'Ad'),
  actionTool('update_campaign_budget', 'update_budget', 'campaign', 'Campaign'),
  actionTool('update_adset_budget', 'update_budget', 'adset', 'Ad set'),
];

function createApi({ apiUrl, apiKey, fetchImpl = globalThis.fetch }) {
  const base = String(apiUrl || 'http://localhost:3001/api').replace(/\/$/, '');
  async function call(method, path, { query, body } = {}) {
    if (!apiKey) throw new Error('YNT_API_KEY is not set. Create a key with the meta:read scope under Integrations → API Keys.');
    const url = new URL(`${base}/meta${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const response = await fetchImpl(url.toString(), {
      method,
      headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `YNTERP API ${response.status}`);
    return data;
  }
  return {
    get: (path, query) => call('GET', path, { query }),
    post: (path, body) => call('POST', path, { body }),
  };
}

function createServer(options = {}) {
  const api = createApi(options);
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  async function handle(message) {
    const { id, method, params } = message || {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
    if (id === undefined || id === null) return null; // notification

    switch (method) {
      case 'initialize':
        return reply({ protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
        try {
          const result = await tool.run(api, params?.arguments || {});
          const text = typeof result?.message === 'string' && result.requires_confirmation
            ? `${result.message}\n\n${JSON.stringify({ confirm_token: result.confirm_token, expires_at: result.expires_at })}`
            : JSON.stringify(result, null, 2);
          return reply({ content: [{ type: 'text', text }] });
        } catch (error) {
          return reply({ content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }
  return { handle, tools: TOOLS };
}

function runStdio() {
  const server = createServer({ apiUrl: process.env.YNT_API_URL, apiKey: process.env.YNT_API_KEY });
  let buffer = '';
  const inFlight = new Set();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
        continue;
      }
      const work = server.handle(message).then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
      inFlight.add(work);
      work.finally(() => inFlight.delete(work));
    }
  });
  // When the client closes stdin, answer every call already received and let the
  // process end on its own. An explicit process.exit() while fetch sockets are
  // still closing trips a libuv assertion on Windows.
  process.stdin.on('end', async () => {
    await Promise.allSettled([...inFlight]);
    process.exitCode = 0;
  });
}

if (require.main === module) runStdio();

module.exports = { createServer, TOOLS };
