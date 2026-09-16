/* ═══════════════════════════════════════════════════════════
   ADS MANAGER — Meta Ads module (Sales & Marketing)
   Loaded before app.js; only declares functions, so nothing here runs until
   loadPage('ads-manager') calls renderAdsManager() / initAdsManager().
   Reads /api/meta/* (the synced database), never the Meta API directly.
   ═══════════════════════════════════════════════════════════ */

const AM_STORAGE_KEY = 'ynt_ads_manager';
const AM_LEVELS = {
  campaign: { label: 'Campaigns', path: '/campaigns', noun: 'Campaign', manageable: true },
  adset: { label: 'Ad Sets', path: '/adsets', noun: 'Ad Set', manageable: true },
  ad: { label: 'Ads', path: '/ads', noun: 'Ad', manageable: true },
  page: { label: 'Pages', path: '/pages', noun: 'Page', manageable: false },
  account: { label: 'Ad Accounts', path: '/accounts', noun: 'Ad Account', manageable: false },
  // Not a report level: its own loader and renderer, no columns, no CSV.
  billing: { label: 'Billing', path: '/billing', noun: 'Billing', manageable: false, custom: true },
};

// Column sets. `kind` picks the formatter; `tone` colors the cell against the
// resolved targets (good/bad) using the design-system soft fills.
const AM_COLUMN_SETS = {
  performance: {
    label: 'Performance',
    columns: [
      { key: 'daily_budget', label: 'Budget', kind: 'budget' },
      { key: 'spend', label: 'Amount Spent', kind: 'money' },
      { key: 'messages', label: 'Messages', kind: 'int', title: 'Messaging conversations started (Meta)' },
      { key: 'cost_per_message', label: 'Cost / Msg', kind: 'money' },
      { key: 'pos_orders', label: 'POS Orders', kind: 'int', title: 'YNTERP POS orders attributed to these ads' },
      { key: 'cost_per_order', label: 'Cost / Order', kind: 'money' },
      { key: 'delivered_cod', label: 'Delivered COD', kind: 'money' },
      { key: 'rts_rate', label: 'RTS %', kind: 'pct', tone: 'rts' },
      { key: 'actual_roas', label: 'Actual ROAS', kind: 'roas', tone: 'actual_roas' },
      { key: 'net_after_ads', label: 'COD − Spend', kind: 'money', tone: 'net', title: 'Delivered COD minus ad spend (product & shipping cost not included)' },
    ],
  },
  meta: {
    label: 'Meta Delivery',
    columns: [
      { key: 'spend', label: 'Amount Spent', kind: 'money' },
      { key: 'impressions', label: 'Impressions', kind: 'int' },
      { key: 'reach', label: 'Reach', kind: 'int', title: 'Sum of daily reach — not unique across days' },
      { key: 'clicks', label: 'Clicks', kind: 'int' },
      { key: 'ctr', label: 'CTR', kind: 'pct' },
      { key: 'cpc', label: 'CPC', kind: 'money' },
      { key: 'cpm', label: 'CPM', kind: 'money' },
      { key: 'frequency', label: 'Freq.', kind: 'ratio' },
      { key: 'purchases', label: 'Meta Purchases', kind: 'int' },
      { key: 'purchase_value', label: 'Meta Revenue', kind: 'money' },
      { key: 'roas', label: 'Meta ROAS', kind: 'roas' },
      { key: 'cpa', label: 'CPA', kind: 'money' },
    ],
  },
  profit: {
    label: 'Profitability',
    columns: [
      { key: 'spend', label: 'Ad Spend', kind: 'money' },
      { key: 'pos_orders', label: 'Orders', kind: 'int' },
      { key: 'gross_cod', label: 'Gross COD', kind: 'money' },
      { key: 'delivered', label: 'Delivered', kind: 'int' },
      { key: 'returned_total', label: 'Returned', kind: 'int', title: 'Returned + returning' },
      { key: 'delivered_cod', label: 'Delivered COD', kind: 'money' },
      { key: 'returned_cod', label: 'Returned COD', kind: 'money' },
      { key: 'rts_rate', label: 'RTS %', kind: 'pct', tone: 'rts' },
      { key: 'cost_per_delivered', label: 'Cost / Delivered', kind: 'money' },
      { key: 'roas', label: 'Meta ROAS', kind: 'roas' },
      { key: 'actual_roas', label: 'Actual ROAS', kind: 'roas', tone: 'actual_roas' },
      { key: 'net_after_ads', label: 'COD − Spend', kind: 'money', tone: 'net' },
    ],
  },
};

const AM_DATE_PRESETS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['custom', 'Custom'],
];

const amState = {
  level: 'campaign',
  columns: 'performance',
  preset: '7d',
  from: '',
  to: '',
  account: '',
  status: 'all',
  search: '',
  sort: 'spend',
  dir: 'desc',
  page: 1,
  perPage: 25,
  selected: { campaign: new Map(), adset: new Map() },
  rows: [],
  total: 0,
  connections: [],
  status_info: null,
  targets: null,
  loading: false,
  seq: 0,
  chart: null,
  detailChart: null,
  pollTimer: null,
  searchTimer: null,
};

// ─── Small helpers ────────────────────────────────────────────────────────────
function amEsc(value) {
  return typeof escapeHtml === 'function' ? escapeHtml(value) : String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function amManilaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

function amShiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function amPresetRange(preset) {
  const today = amManilaToday();
  const [y, m] = today.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  switch (preset) {
    case 'today': return [today, today];
    case 'yesterday': return [amShiftDate(today, -1), amShiftDate(today, -1)];
    case '30d': return [amShiftDate(today, -29), today];
    case 'this_month': return [`${y}-${pad(m)}-01`, today];
    case 'last_month': {
      const first = `${m === 1 ? y - 1 : y}-${pad(m === 1 ? 12 : m - 1)}-01`;
      return [first, amShiftDate(`${y}-${pad(m)}-01`, -1)];
    }
    default: return [amShiftDate(today, -6), today];
  }
}

function amFmt(value, kind) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '<span class="am-muted">—</span>';
  const n = Number(value);
  switch (kind) {
    case 'money':
    case 'budget':
      return `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'int': return Math.round(n).toLocaleString('en-PH');
    case 'pct': return `${n.toFixed(n >= 100 ? 0 : 2)}%`;
    case 'roas': return `${n.toFixed(2)}x`;
    case 'ratio': return n.toFixed(2);
    default: return amEsc(value);
  }
}

function amRelativeTime(iso) {
  if (!iso) return 'never';
  const then = new Date(String(iso).includes('T') || String(iso).endsWith('Z') ? iso : `${String(iso).replace(' ', 'T')}Z`);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (!Number.isFinite(mins)) return 'unknown';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return then.toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function amSaveState() {
  try {
    localStorage.setItem(AM_STORAGE_KEY, JSON.stringify({
      level: amState.level, columns: amState.columns, preset: amState.preset, from: amState.from, to: amState.to,
      account: amState.account, status: amState.status, perPage: amState.perPage,
    }));
  } catch {}
}

function amLoadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(AM_STORAGE_KEY) || '{}');
    if (AM_LEVELS[saved.level]) amState.level = saved.level;
    if (AM_COLUMN_SETS[saved.columns]) amState.columns = saved.columns;
    if (AM_DATE_PRESETS.some(([k]) => k === saved.preset)) amState.preset = saved.preset;
    if (saved.preset === 'custom' && saved.from && saved.to) { amState.from = saved.from; amState.to = saved.to; }
    if (typeof saved.account === 'string') amState.account = saved.account;
    if (typeof saved.status === 'string') amState.status = saved.status;
    if ([25, 50, 100].includes(saved.perPage)) amState.perPage = saved.perPage;
  } catch {}
  if (amState.preset !== 'custom' || !amState.from) [amState.from, amState.to] = amPresetRange(amState.preset);
}

function amFilterQuery(extra = {}) {
  const q = { from: amState.from, to: amState.to };
  if (amState.account) q.ad_account_id = amState.account;
  return { ...q, ...extra };
}

function amQs(params) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') usp.set(k, v); });
  return usp.toString();
}

async function amApi(path, options) {
  return authorizedJsonRequest(`/meta${path}`, options);
}

// ─── Render ───────────────────────────────────────────────────────────────────
const AM_ICONS = {
  campaign: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4.5a1 1 0 011-1h3.2l1.3 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4.5z"/></svg>',
  adset: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  ad: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 10.5h2.5l6.5 2.5V3L4.5 5.5H2v5z"/><path d="M4.5 5.5v5"/></svg>',
  page: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="2" width="11" height="12" rx="1.5"/><path d="M5 5.5h6M5 8h6M5 10.5h4"/></svg>',
  account: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.8-2.4 2.8-3.8 5-3.8s4.2 1.4 5 3.8"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#1877F2"/><path fill="#fff" d="M13.4 19v-6.1h2.1l.3-2.4h-2.4V9c0-.7.2-1.2 1.2-1.2h1.3V5.7c-.2 0-1-.1-1.9-.1-1.9 0-3.2 1.2-3.2 3.3v1.8H8.7v2.4h2.1V19h2.6z"/></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
  calendar: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>',
  sync: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 01-9.7 3.5M2.5 8a5.5 5.5 0 019.7-3.5"/><path d="M12.5 1.5v3h-3M3.5 14.5v-3h3"/></svg>',
  gear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>',
  download: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/></svg>',
  columns: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M6 3v10M10 3v10"/></svg>',
  bolt: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8l1-5.5z"/></svg>',
  billing: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M1.5 6.5h13M4 10h3"/></svg>',
};

function renderAdsManager() {
  amLoadState();
  return `
  <div class="am-root">
    <div class="am-freshness" id="am-freshness">Loading sync status…</div>
    <div id="am-alert"></div>

    <div class="am-header">
      <h1 class="am-title">Ads Manager</h1>
      <label class="am-account-select">
        <span class="am-fb">${AM_ICONS.facebook}</span>
        <select id="am-account" onchange="amSetAccount(this.value)" aria-label="Ad account">
          <option value="">All Ad Accounts</option>
        </select>
      </label>
      <label class="am-search">
        ${AM_ICONS.search}
        <input type="search" id="am-search" placeholder="Search here" oninput="amSearchInput(this.value)" autocomplete="off">
      </label>
      <div class="am-date">
        <select id="am-preset" class="am-date-preset" onchange="amSetPreset(this.value)" aria-label="Date range">
          ${AM_DATE_PRESETS.map(([key, label]) => `<option value="${key}" ${amState.preset === key ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <input type="date" id="am-from" value="${amState.from}" onchange="amSetCustomDate()">
        <span class="am-muted">–</span>
        <input type="date" id="am-to" value="${amState.to}" onchange="amSetCustomDate()">
        <span class="am-date-icon">${AM_ICONS.calendar}</span>
      </div>
    </div>

    <div class="am-kpis" id="am-kpis"></div>

    <div class="card am-chart-card">
      <div class="am-chart-head">
        <div>
          <div class="card-title">Spend vs Delivered COD</div>
          <div class="card-subtitle">Daily Meta spend against COD delivered from attributed POS orders.</div>
        </div>
        <div class="am-legend"><span class="am-dot am-dot-spend"></span>Spend <span class="am-dot am-dot-cod"></span>Delivered COD</div>
      </div>
      <div class="am-chart-wrap"><canvas id="am-trend-chart"></canvas></div>
    </div>

    <div class="am-tabs" id="am-tabs"></div>

    <div class="am-panel">
      <div class="am-toolbar">
        <div class="am-toolbar-left" id="am-scope-note"></div>
        <div class="am-toolbar-right">
          <label class="am-select" title="Delivery">
            ${AM_ICONS.bolt}
            <select id="am-status" onchange="amSetStatus(this.value)">
              <option value="all">Delivery: All</option>
              <option value="active">Delivery: Active</option>
              <option value="paused">Delivery: Paused</option>
              <option value="with_spend">Had spend</option>
            </select>
          </label>
          <label class="am-select" title="Columns">
            ${AM_ICONS.columns}
            <select id="am-columns" onchange="amSetColumns(this.value)">
              ${Object.entries(AM_COLUMN_SETS).map(([key, set]) => `<option value="${key}">Columns: ${set.label}</option>`).join('')}
            </select>
          </label>
          <button class="btn btn-secondary btn-sm" type="button" id="am-export-csv" onclick="amExportCsv()">${AM_ICONS.download} Export CSV</button>
          <button class="btn btn-secondary btn-sm" type="button" onclick="amOpenSettings()">${AM_ICONS.gear} Connections</button>
        </div>
      </div>
      <div class="am-table-wrap" id="am-table-wrap">
        <div class="empty-state"><p>Loading…</p></div>
      </div>
      <div class="table-pagination" id="am-pagination"></div>
    </div>
  </div>

  <div class="modal-overlay" id="am-confirm-modal">
    <div class="modal am-confirm">
      <div class="modal-header">
        <div class="modal-title" id="am-confirm-title">Action request</div>
        <button class="modal-close" type="button" onclick="amCloseConfirm(false)">×</button>
      </div>
      <div class="modal-body" id="am-confirm-body"></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" onclick="amCloseConfirm(false)">Cancel</button>
        <button class="btn btn-primary" type="button" id="am-confirm-btn" onclick="amExecuteConfirmed()">Confirm</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="am-detail-modal">
    <div class="modal am-detail">
      <div class="modal-header">
        <div class="modal-title" id="am-detail-title">Details</div>
        <button class="modal-close" type="button" onclick="closeModal('am-detail-modal')">×</button>
      </div>
      <div class="modal-body" id="am-detail-body"></div>
    </div>
  </div>

  <div class="modal-overlay" id="am-settings-modal">
    <div class="modal am-settings">
      <div class="modal-header">
        <div class="modal-title">Meta Connections</div>
        <button class="modal-close" type="button" onclick="amCloseSettings()">×</button>
      </div>
      <div class="modal-body" id="am-settings-body"></div>
    </div>
  </div>`;
}

function initAdsManager() {
  document.getElementById('am-status').value = amState.status;
  document.getElementById('am-columns').value = amState.columns;
  amToggleCustomDates();
  amRenderTabs();
  amRefreshMeta().then(() => amRefreshAll());
}

// Connections, status and targets: the slow-changing context around the table.
async function amRefreshMeta() {
  try {
    const [status, conns, targets] = await Promise.all([amApi('/status'), amApi('/connections'), amApi('/targets')]);
    amState.status_info = status;
    amState.connections = conns.connections || [];
    amState.targets = (targets.targets || []).find((t) => t.scope_type === 'organization') || null;
    amRenderAccountOptions();
    amRenderFreshness();
    amRenderAlert();
    amSchedulePoll();
  } catch (error) {
    const el = document.getElementById('am-freshness');
    if (el) el.textContent = `Could not load Meta status: ${error.message}`;
  }
}

function amRenderAccountOptions() {
  const select = document.getElementById('am-account');
  if (!select) return;
  const accounts = amState.connections.flatMap((c) => c.ad_accounts.filter((a) => a.enabled));
  if (amState.account && !accounts.some((a) => a.id === amState.account)) amState.account = '';
  select.innerHTML = `<option value="">All Ad Accounts</option>${accounts.map((a) => `<option value="${amEsc(a.id)}" ${a.id === amState.account ? 'selected' : ''}>${amEsc(a.name)}</option>`).join('')}`;
}

function amRenderFreshness() {
  const el = document.getElementById('am-freshness');
  if (!el) return;
  const s = amState.status_info || {};
  const syncing = amState.connections.some((c) => c.syncing);
  const cadence = s.auto_sync?.enabled ? `Data updates every ${s.auto_sync.interval_minutes} minutes.` : 'Auto-sync is off — use Sync now.';
  el.innerHTML = `${cadence} Last update was ${amRelativeTime(s.last_sync_at)}.
    ${amState.connections.length ? `<button type="button" class="am-link" onclick="amSyncNow()" ${syncing ? 'disabled' : ''}>${syncing ? 'Syncing…' : 'Sync now'}</button>` : ''}`;
}

function amRenderAlert() {
  const el = document.getElementById('am-alert');
  if (!el) return;
  const expired = amState.connections.filter((c) => c.status === 'expired');
  const errored = amState.connections.filter((c) => c.status === 'error');
  if (!amState.connections.length) {
    el.innerHTML = `
      <div class="am-banner am-banner-info">
        <div><strong>Connect a Meta account to start.</strong> Campaigns, ad sets, ads and daily insights sync into YNTERP; this page then reads them from the database.</div>
        <button class="btn btn-primary btn-sm" type="button" onclick="amOpenSettings()">+ Connect Meta Account</button>
      </div>`;
    return;
  }
  if (expired.length) {
    el.innerHTML = `
      <div class="am-banner am-banner-danger">
        <div><strong>Meta authorization expired.</strong> ${expired.map((c) => amEsc(c.name)).join(', ')} can no longer sync. Last successful sync: ${amRelativeTime(expired[0].last_success_at)}.</div>
        <button class="btn btn-primary btn-sm" type="button" onclick="amOpenSettings()">Reconnect Meta Account</button>
      </div>`;
    return;
  }
  if (errored.length) {
    el.innerHTML = `
      <div class="am-banner am-banner-warning">
        <div><strong>Meta connection temporarily unavailable.</strong> ${amEsc(errored[0].last_error || '')} Last successful sync: ${amRelativeTime(errored[0].last_success_at)}.</div>
        <button class="btn btn-secondary btn-sm" type="button" onclick="amSyncNow()">Retry</button>
      </div>`;
    return;
  }
  el.innerHTML = '';
}

// While a sync runs, re-read status every 5s; refresh the data when it ends.
function amSchedulePoll() {
  clearTimeout(amState.pollTimer);
  if (!amState.connections.some((c) => c.syncing)) return;
  amState.pollTimer = setTimeout(async () => {
    if (App.currentPage !== 'ads-manager') return;
    const wasSyncing = true;
    await amRefreshMeta();
    if (wasSyncing && !amState.connections.some((c) => c.syncing)) {
      amRefreshAll();
      if (document.getElementById('am-settings-modal')?.classList.contains('open')) amRenderSettings();
    }
  }, 5000);
}

function amRenderTabs() {
  const el = document.getElementById('am-tabs');
  if (!el) return;
  const chip = (level) => {
    const n = amState.selected[level]?.size || 0;
    return n ? `<span class="am-chip">${n} Selected <span class="am-chip-x" role="button" title="Clear selection" onclick="event.stopPropagation(); amClearSelection('${level}')">×</span></span>` : '';
  };
  el.innerHTML = Object.entries(AM_LEVELS).map(([key, def]) => `
    <button type="button" class="am-tab ${amState.level === key ? 'active' : ''} ${key === 'page' || key === 'billing' ? 'am-tab-gap' : ''}" onclick="amSetLevel('${key}')">
      <span class="am-tab-icon">${AM_ICONS[key]}</span>
      <span class="am-tab-label">${def.label}</span>
      ${chip(key)}
    </button>`).join('');
}

function amScopeQuery() {
  const q = {};
  const campaigns = [...amState.selected.campaign.keys()];
  const adsets = [...amState.selected.adset.keys()];
  if (amState.level === 'adset' && campaigns.length) q.campaign_id = campaigns.join(',');
  if (amState.level === 'ad') {
    if (adsets.length) q.adset_id = adsets.join(',');
    else if (campaigns.length) q.campaign_id = campaigns.join(',');
  }
  return q;
}

function amRenderScopeNote() {
  const el = document.getElementById('am-scope-note');
  if (!el) return;
  const scope = amScopeQuery();
  const names = (map) => [...map.values()].slice(0, 2).map(amEsc).join(', ') + (map.size > 2 ? ` +${map.size - 2}` : '');
  let note = '';
  if (scope.adset_id) note = `Showing ads in ${names(amState.selected.adset)}`;
  else if (scope.campaign_id) note = `Showing ${amState.level === 'ad' ? 'ads' : 'ad sets'} in ${names(amState.selected.campaign)}`;
  if (AM_LEVELS[amState.level].custom) {
    el.innerHTML = '<span class="am-muted">Read live from Meta — nothing on this tab is stored.</span>';
    return;
  }
  el.innerHTML = `<span class="am-muted">${amState.total.toLocaleString('en-PH')} ${AM_LEVELS[amState.level].label.toLowerCase()}</span>${note ? ` · <span>${note}</span>` : ''}`;
}

async function amRefreshAll() {
  amRenderScopeNote();
  await Promise.all([amLoadSummary(), amLoadTable()]);
}

async function amLoadSummary() {
  const kpis = document.getElementById('am-kpis');
  try {
    const query = amFilterQuery();
    const [summary, trend] = await Promise.all([
      amApi(`/summary?${amQs(query)}`),
      amApi(`/trend?${amQs(query)}`),
    ]);
    if (App.currentPage !== 'ads-manager') return;
    if (summary.last_sync_at && amState.status_info) { amState.status_info.last_sync_at = summary.last_sync_at; amRenderFreshness(); }
    const t = summary.totals;
    const tiles = [
      ['Amount Spent', amFmt(t.spend, 'money'), 'Meta'],
      ['Delivered COD', amFmt(t.delivered_cod, 'money'), `${Math.round(t.delivered).toLocaleString('en-PH')} delivered`],
      ['Actual ROAS', amFmt(t.actual_roas, 'roas'), 'Delivered COD ÷ spend'],
      ['Meta ROAS', amFmt(t.roas, 'roas'), `${Math.round(t.purchases)} Meta purchases`],
      ['POS Orders', amFmt(t.pos_orders, 'int'), `${amFmt(t.cost_per_order, 'money')} / order`],
      ['RTS', amFmt(t.rts_rate, 'pct'), `${Math.round(t.returned_total)} returned`],
      ['CPM', amFmt(t.cpm, 'money'), `CTR ${amFmt(t.ctr, 'pct')}`],
      ['Messages', amFmt(t.messages, 'int'), `${amFmt(t.cost_per_message, 'money')} / message`],
    ];
    kpis.innerHTML = tiles.map(([label, value, sub]) => `
      <div class="am-kpi"><div class="am-kpi-label">${label}</div><div class="am-kpi-value">${value}</div><div class="am-kpi-sub">${sub}</div></div>`).join('');
    amDrawTrend(trend.days || []);
  } catch (error) {
    if (kpis) kpis.innerHTML = `<div class="am-kpi am-kpi-error">Could not load totals: ${amEsc(error.message)}</div>`;
  }
}

function amChartColors() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return { spend: '#ef4444', cod: '#059669', grid: dark ? 'rgba(148,163,184,0.12)' : 'rgba(15,23,42,0.06)' };
}

function amDrawTrend(days) {
  const canvas = document.getElementById('am-trend-chart');
  if (!canvas || !window.Chart) return;
  if (amState.chart) amState.chart.destroy();
  const colors = amChartColors();
  const peso = (v) => `₱${Number(v).toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;
  amState.chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: days.map((d) => d.day.slice(5)),
      datasets: [
        { label: 'Spend', data: days.map((d) => d.spend), borderColor: colors.spend, backgroundColor: colors.spend, tension: 0.3, pointRadius: days.length > 31 ? 0 : 2, borderWidth: 2 },
        { label: 'Delivered COD', data: days.map((d) => d.delivered_cod), borderColor: colors.cod, backgroundColor: colors.cod, tension: 0.3, pointRadius: days.length > 31 ? 0 : 2, borderWidth: 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${peso(ctx.parsed.y)}`, afterBody: (items) => { const d = days[items[0].dataIndex]; return d.actual_roas !== null ? `Actual ROAS: ${d.actual_roas.toFixed(2)}x` : ''; } } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: colors.grid }, ticks: { callback: (v) => peso(v) } },
      },
    },
  });
}

// Delivery and Columns steer the report table only; Billing has neither.
function amToggleTableControls() {
  const custom = !!AM_LEVELS[amState.level].custom;
  for (const id of ['am-status', 'am-columns']) {
    const label = document.getElementById(id)?.closest('.am-select');
    if (label) label.hidden = custom;
  }
  const csv = document.getElementById('am-export-csv');
  if (csv) csv.hidden = custom;
}

async function amLoadTable() {
  const wrap = document.getElementById('am-table-wrap');
  if (!wrap) return;
  amToggleTableControls();
  if (AM_LEVELS[amState.level].custom) return amLoadBilling();
  const seq = ++amState.seq;
  wrap.classList.add('am-loading');
  try {
    const query = amFilterQuery({
      ...amScopeQuery(),
      status: AM_LEVELS[amState.level].manageable ? amState.status : (amState.status === 'with_spend' ? 'with_spend' : 'all'),
      search: amState.search,
      sort: amState.sort,
      dir: amState.dir,
      page: amState.page,
      per_page: amState.perPage,
    });
    const data = await amApi(`${AM_LEVELS[amState.level].path}?${amQs(query)}`);
    if (seq !== amState.seq || App.currentPage !== 'ads-manager') return;
    amState.rows = data.rows || [];
    amState.total = data.total || 0;
    amRenderTable();
    amRenderPagination();
    amRenderScopeNote();
  } catch (error) {
    if (seq !== amState.seq) return;
    wrap.innerHTML = `<div class="empty-state"><h3>Could not load ${AM_LEVELS[amState.level].label.toLowerCase()}</h3><p>${amEsc(error.message)}</p><button class="btn btn-secondary btn-sm" type="button" onclick="amLoadTable()">Retry</button></div>`;
  } finally {
    if (seq === amState.seq) wrap.classList.remove('am-loading');
  }
}

function amToneClass(col, row) {
  const t = amState.targets || {};
  const v = row[col.key];
  if (v === null || v === undefined || !(row.spend > 0)) return '';
  if (col.tone === 'net') return v >= 0 ? 'am-good' : 'am-bad';
  if (col.tone === 'actual_roas' && t.target_actual_roas !== null && t.target_actual_roas !== undefined) {
    const settled = row.delivered + row.returned + row.returning_count;
    if (!(row.pos_orders > 0 && settled >= row.pos_orders / 2)) return '';
    return v >= Number(t.target_actual_roas) ? 'am-good' : 'am-bad';
  }
  if (col.tone === 'rts' && t.max_rts !== null && t.max_rts !== undefined) return v > Number(t.max_rts) ? 'am-bad' : '';
  return '';
}

function amRenderTable() {
  const wrap = document.getElementById('am-table-wrap');
  const level = amState.level;
  const def = AM_LEVELS[level];
  if (!amState.connections.length && !amState.rows.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${AM_ICONS.facebook}</div>
        <h3>No Meta account connected</h3>
        <p>Connect a Meta account to sync campaigns, ad sets, ads and daily performance.</p>
        <button class="btn btn-primary btn-sm" type="button" onclick="amOpenSettings()">+ Connect Meta Account</button>
      </div>`;
    return;
  }
  if (!amState.rows.length) {
    wrap.innerHTML = `<div class="empty-state"><h3>No ${def.label.toLowerCase()} found</h3><p>Nothing matches these filters for ${amEsc(amState.from)} to ${amEsc(amState.to)}.</p></div>`;
    return;
  }

  const cols = AM_COLUMN_SETS[amState.columns].columns.filter((c) => !(c.kind === 'budget' && !def.manageable));
  const selectable = level === 'campaign' || level === 'adset';
  const sortIcon = (key) => (amState.sort === key ? (amState.dir === 'asc' ? '▲' : '▼') : '<span class="am-sort-idle">⇅</span>');
  const th = (key, label, extra = '', title = '') => `<th class="${extra}" ${title ? `title="${amEsc(title)}"` : ''}><button type="button" class="am-th" onclick="amSort('${key}')">${label} <span class="am-sort">${sortIcon(key)}</span></button></th>`;
  const allSelected = selectable && amState.rows.every((r) => amState.selected[level].has(r.id));

  const head = `<tr>
    ${selectable ? `<th class="am-col-check"><input type="checkbox" ${allSelected ? 'checked' : ''} onchange="amSelectAll(this.checked)" aria-label="Select all"></th>` : ''}
    ${def.manageable ? '<th class="am-col-toggle">On/Off</th>' : ''}
    ${th('name', `${def.noun} Name`, 'am-col-name')}
    ${def.manageable ? th('effective_status', 'Delivery') : ''}
    ${cols.map((c) => th(c.key, c.label, 'am-num', c.title)).join('')}
  </tr>`;

  const body = amState.rows.map((row) => {
    const id = amEsc(row.id);
    const isOn = row.status === 'ACTIVE';
    const context = level === 'adset' ? row.campaign_name : level === 'ad' ? [row.page_name, row.adset_name].filter(Boolean).join(' · ') : level === 'campaign' ? row.ad_account_name : level === 'account' ? [row.currency, row.business_name].filter(Boolean).join(' · ') : '';
    const flag = row.flag === 'winning'
      ? `<span class="badge badge-success am-flag" title="${amEsc((row.flag_reasons || []).join('; '))}">Winning</span>`
      : row.flag === 'attention' ? `<span class="badge badge-warning am-flag" title="${amEsc((row.flag_reasons || []).join('; '))}">Needs attention</span>` : '';
    const delivery = String(row.effective_status || '').replace(/_/g, ' ').toLowerCase();
    const deliveryDot = row.effective_status === 'ACTIVE' ? 'am-dot-on' : /PAUSED|OFF/.test(row.effective_status || '') ? 'am-dot-off' : 'am-dot-warn';
    return `<tr class="${selectable && amState.selected[level].has(row.id) ? 'am-row-selected' : ''}">
      ${selectable ? `<td class="am-col-check"><input type="checkbox" ${amState.selected[level].has(row.id) ? 'checked' : ''} onchange="amToggleSelect('${id}', this.checked)" aria-label="Select"></td>` : ''}
      ${def.manageable ? `<td class="am-col-toggle"><label class="switch am-switch"><input type="checkbox" ${isOn ? 'checked' : ''} onchange="amRequestToggle(this, '${level}', '${id}')"><span class="switch-slider"></span></label></td>` : ''}
      <td class="am-col-name">
        <button type="button" class="am-name" onclick="amOpenDetail('${level}', '${id}')">${amEsc(row.name || row.id)}</button>
        ${flag}
        ${context ? `<div class="am-sub">${amEsc(context)}</div>` : ''}
      </td>
      ${def.manageable ? `<td class="am-delivery"><span class="am-dot ${deliveryDot}"></span>${amEsc(delivery || '—')}</td>` : ''}
      ${cols.map((c) => `<td class="am-num ${amToneClass(c, row)}">${amFmt(row[c.key], c.kind)}${c.kind === 'budget' && row[c.key] !== null && row[c.key] !== undefined ? ' <span class="am-muted">(daily)</span>' : ''}</td>`).join('')}
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="am-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function amRenderPagination() {
  const el = document.getElementById('am-pagination');
  if (!el) return;
  const pages = Math.max(1, Math.ceil(amState.total / amState.perPage));
  const start = amState.total ? (amState.page - 1) * amState.perPage + 1 : 0;
  const end = Math.min(amState.total, amState.page * amState.perPage);
  el.innerHTML = `
    <span>${start.toLocaleString('en-PH')}–${end.toLocaleString('en-PH')} of ${amState.total.toLocaleString('en-PH')}</span>
    <div class="am-pager">
      <select class="am-per-page" onchange="amSetPerPage(this.value)" aria-label="Rows per page">
        ${[25, 50, 100].map((n) => `<option value="${n}" ${amState.perPage === n ? 'selected' : ''}>${n} / page</option>`).join('')}
      </select>
      <button class="btn btn-secondary btn-sm" type="button" ${amState.page <= 1 ? 'disabled' : ''} onclick="amGoPage(${amState.page - 1})">‹ Prev</button>
      <span>Page ${amState.page} of ${pages}</span>
      <button class="btn btn-secondary btn-sm" type="button" ${amState.page >= pages ? 'disabled' : ''} onclick="amGoPage(${amState.page + 1})">Next ›</button>
    </div>`;
}

// ─── Interactions ─────────────────────────────────────────────────────────────
function amSetLevel(level) {
  if (!AM_LEVELS[level] || level === amState.level) return;
  amState.level = level;
  amState.page = 1;
  if (!AM_LEVELS[level].manageable && amState.sort === 'effective_status') amState.sort = 'spend';
  amSaveState();
  amRenderTabs();
  amLoadTable();
}

function amSetAccount(value) {
  amState.account = value;
  amState.page = 1;
  amClearSelection('campaign', false);
  amClearSelection('adset', false);
  amSaveState();
  amRenderTabs();
  amRefreshAll();
}

function amSearchInput(value) {
  clearTimeout(amState.searchTimer);
  amState.searchTimer = setTimeout(() => {
    amState.search = value.trim();
    amState.page = 1;
    amLoadTable();
  }, 300);
}

function amToggleCustomDates() {
  const custom = amState.preset === 'custom';
  ['am-from', 'am-to'].forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = !custom; });
}

function amSetPreset(preset) {
  amState.preset = preset;
  if (preset !== 'custom') {
    [amState.from, amState.to] = amPresetRange(preset);
    document.getElementById('am-from').value = amState.from;
    document.getElementById('am-to').value = amState.to;
  }
  amToggleCustomDates();
  amState.page = 1;
  amSaveState();
  amRefreshAll();
}

function amSetCustomDate() {
  const from = document.getElementById('am-from').value;
  const to = document.getElementById('am-to').value;
  if (!from || !to) return;
  [amState.from, amState.to] = from <= to ? [from, to] : [to, from];
  amState.page = 1;
  amSaveState();
  amRefreshAll();
}

function amSetStatus(value) {
  amState.status = value;
  amState.page = 1;
  amSaveState();
  amLoadTable();
}

function amSetColumns(value) {
  amState.columns = value;
  amSaveState();
  amRenderTable();
}

function amSort(key) {
  if (amState.sort === key) amState.dir = amState.dir === 'asc' ? 'desc' : 'asc';
  else { amState.sort = key; amState.dir = key === 'name' ? 'asc' : 'desc'; }
  amState.page = 1;
  amLoadTable();
}

function amGoPage(page) {
  amState.page = Math.max(1, page);
  amLoadTable();
}

function amSetPerPage(value) {
  amState.perPage = Number(value) || 25;
  amState.page = 1;
  amSaveState();
  amLoadTable();
}

function amToggleSelect(id, checked) {
  const level = amState.level;
  const row = amState.rows.find((r) => r.id === id);
  if (checked) amState.selected[level].set(id, row?.name || id);
  else amState.selected[level].delete(id);
  if (level === 'campaign') amState.selected.adset.clear();
  amRenderTabs();
  amRenderTable();
}

function amSelectAll(checked) {
  amState.rows.forEach((row) => {
    if (checked) amState.selected[amState.level].set(row.id, row.name);
    else amState.selected[amState.level].delete(row.id);
  });
  if (amState.level === 'campaign') amState.selected.adset.clear();
  amRenderTabs();
  amRenderTable();
}

function amClearSelection(level, reload = true) {
  amState.selected[level]?.clear();
  if (level === 'campaign') amState.selected.adset.clear();
  if (!reload) return;
  amRenderTabs();
  if (amState.level === 'campaign' || amState.level === 'adset') amRenderTable();
  if (amState.level !== 'campaign') { amState.page = 1; amLoadTable(); }
}

function amDrillDown(level, id, name) {
  closeModal('am-detail-modal');
  if (level === 'campaign') {
    amState.selected.campaign = new Map([[id, name]]);
    amState.selected.adset.clear();
    amState.level = 'adset';
  } else if (level === 'adset') {
    amState.selected.adset = new Map([[id, name]]);
    amState.level = 'ad';
  }
  amState.page = 1;
  amRenderTabs();
  amLoadTable();
}

async function amExportCsv() {
  if (AM_LEVELS[amState.level].custom) { showToast('info', 'Export', 'Billing is read live from Meta and has no CSV. Export a report tab instead.'); return; }
  try {
    const query = amFilterQuery({ ...amScopeQuery(), status: amState.status, search: amState.search, sort: amState.sort, dir: amState.dir, format: 'csv' });
    const response = await fetch(`${getApiBase()}/meta${AM_LEVELS[amState.level].path}?${amQs(query)}`, { headers: { Authorization: `Bearer ${getAuthToken()}` } });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Export failed (${response.status})`);
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `meta-${AM_LEVELS[amState.level].path.slice(1)}-${amState.from}_to_${amState.to}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    showToast('error', 'Export failed', error.message);
  }
}

// ─── Management actions (preview → confirm → execute) ─────────────────────────
let amPendingAction = null;

async function amRequestAction({ action, level, id, dailyBudget = null, onDone, onCancel }) {
  try {
    const body = { action, level, id };
    if (dailyBudget !== null) body.daily_budget = dailyBudget;
    const { preview, confirm_token: token } = await amApi('/actions/preview', { method: 'POST', body: JSON.stringify(body) });
    amPendingAction = { token, onDone, onCancel };
    const money = (v) => (v === null || v === undefined ? '—' : amFmt(v, 'money'));
    document.getElementById('am-confirm-title').textContent = 'Action request';
    document.getElementById('am-confirm-body').innerHTML = `
      <div class="am-action-title">${amEsc(preview.title)}</div>
      <div class="am-action-name">"${amEsc(preview.name)}"</div>
      <dl class="am-action-grid">
        <dt>Ad account</dt><dd>${amEsc(preview.ad_account)}</dd>
        <dt>Current status</dt><dd>${amEsc(preview.current_status)} <span class="am-muted">(${amEsc(String(preview.effective_status || '').replace(/_/g, ' ').toLowerCase())})</span></dd>
        ${preview.new_status ? `<dt>New status</dt><dd><strong>${amEsc(preview.new_status)}</strong></dd>` : ''}
        <dt>Current daily budget</dt><dd>${money(preview.current_daily_budget)}</dd>
        ${preview.new_daily_budget !== undefined ? `<dt>New daily budget</dt><dd><strong>${money(preview.new_daily_budget)}</strong></dd>` : ''}
        <dt>Spend today</dt><dd>${money(preview.spend_today)}</dd>
      </dl>
      ${(preview.warnings || []).map((w) => `<div class="am-warning">⚠ ${amEsc(w)}</div>`).join('')}
      <p class="am-confirm-q">Are you sure? This change is sent to Meta immediately and logged under your name.</p>`;
    const btn = document.getElementById('am-confirm-btn');
    btn.disabled = false;
    btn.textContent = action === 'pause' ? 'Confirm pause' : action === 'activate' ? 'Confirm activate' : 'Confirm budget';
    btn.className = `btn ${action === 'pause' ? 'btn-danger' : 'btn-primary'}`;
    openModal('am-confirm-modal');
  } catch (error) {
    showToast('error', 'Action not allowed', error.message);
    if (onCancel) onCancel();
  }
}

function amCloseConfirm(executed) {
  closeModal('am-confirm-modal');
  if (!executed && amPendingAction?.onCancel) amPendingAction.onCancel();
  amPendingAction = null;
}

async function amExecuteConfirmed() {
  if (!amPendingAction) return;
  const btn = document.getElementById('am-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Sending to Meta…';
  const pending = amPendingAction;
  try {
    const result = await amApi('/actions/execute', { method: 'POST', body: JSON.stringify({ confirm_token: pending.token }) });
    amPendingAction = null;
    closeModal('am-confirm-modal');
    showToast('success', 'Done', `Meta now reports ${String(result.effective_status || result.status).replace(/_/g, ' ').toLowerCase()}.`);
    if (pending.onDone) pending.onDone(result);
    amLoadTable();
  } catch (error) {
    btn.disabled = false;
    btn.textContent = 'Retry';
    showToast('error', 'Meta rejected the change', error.message);
    if (/expired|already used/i.test(error.message)) amCloseConfirm(false);
  }
}

function amRequestToggle(input, level, id) {
  const turningOn = input.checked;
  input.checked = !turningOn; // stays as-is until Meta confirms
  amRequestAction({ action: turningOn ? 'activate' : 'pause', level, id });
}

function amRequestBudget(level, id, current) {
  const input = document.getElementById('am-budget-input');
  const value = Number(input?.value);
  if (!(value > 0)) { showToast('warning', 'Budget', 'Enter a daily budget above zero.'); return; }
  if (Number(current) === value) { showToast('info', 'Budget', 'That is already the current budget.'); return; }
  amRequestAction({ action: 'update_budget', level, id, dailyBudget: value, onDone: () => amOpenDetail(level, id) });
}

// The creative itself, on demand. Meta signs a short-lived URL on its own
// domain and the browser loads it directly, so nothing is stored here and no
// media crosses this server — which is also why the URL is never cached: it
// expires, so each view asks for a fresh one.
async function amLoadPreview(id) {
  const slot = document.getElementById('am-preview-slot');
  if (!slot) return;
  const format = document.getElementById('am-preview-format')?.value || 'mobile';
  slot.innerHTML = '<div class="am-sub">Asking Meta to render it…</div>';
  try {
    const { iframe_src: src } = await amApi(`/ads/${encodeURIComponent(id)}/preview?format=${encodeURIComponent(format)}`);
    slot.innerHTML = `<iframe class="am-preview-frame" src="${amEsc(src)}" title="Ad preview" allow="encrypted-media" referrerpolicy="no-referrer"></iframe>`;
  } catch (error) {
    slot.innerHTML = `<div class="am-warning">${amEsc(error.message)}</div>`;
  }
}

// ─── Billing ──────────────────────────────────────────────────────────────────
// Everything here is fetched from Meta on open and held only in this render —
// balance and payment method change on their side, so a stored copy would lie.
function amMoney(value, currency) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '<span class="am-muted">—</span>';
  const code = String(currency || 'PHP').toUpperCase();
  try {
    return Number(value).toLocaleString('en-PH', { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return `${amEsc(code)} ${Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

async function amLoadBilling() {
  const wrap = document.getElementById('am-table-wrap');
  if (!wrap) return;
  const seq = ++amState.seq;
  document.getElementById('am-pagination').innerHTML = '';
  wrap.innerHTML = '<div class="empty-state"><p>Asking Meta for the billing details…</p></div>';
  try {
    const data = await amApi(`/billing?${amQs(amFilterQuery())}`);
    if (seq !== amState.seq || App.currentPage !== 'ads-manager') return;
    amRenderBilling(data);
  } catch (error) {
    if (seq !== amState.seq) return;
    wrap.innerHTML = `<div class="empty-state"><h3>Could not read billing</h3><p>${amEsc(error.message)}</p><button class="btn btn-secondary btn-sm" type="button" onclick="amLoadBilling()">Retry</button></div>`;
  }
}

function amRenderBilling(data) {
  const wrap = document.getElementById('am-table-wrap');
  const accounts = data.accounts || [];
  if (!accounts.length) {
    wrap.innerHTML = '<div class="empty-state"><h3>No ad account to bill</h3><p>Connect a Meta account, or tick an ad account in Connections.</p></div>';
    return;
  }
  const statusTone = (row) => (row.account_status === 1 ? 'badge-success' : row.account_status === 9 || row.account_status === 3 ? 'badge-warning' : 'badge-danger');
  const fact = (label, value, title = '') => `<div class="am-bill-fact"${title ? ` title="${amEsc(title)}"` : ''}><div class="am-kpi-label">${label}</div><div class="am-bill-value">${value}</div></div>`;

  const cards = accounts.map((a) => `
    <div class="card am-bill-card">
      <div class="am-bill-head">
        <div>
          <div class="am-detail-name">${amEsc(a.name || a.ad_account_id)} <span class="badge ${statusTone(a)}">${amEsc(a.account_status_label)}</span></div>
          <div class="am-sub">${amEsc(a.ad_account_id)}${a.business_name ? ` · ${amEsc(a.business_name)}` : ''} · ${amEsc(a.currency || '')}${a.timezone_name ? ` · ${amEsc(a.timezone_name)}` : ''}</div>
        </div>
        ${a.is_prepay === true ? '<span class="badge badge-info">Prepaid</span>' : a.is_prepay === false ? '<span class="badge badge-gray">Postpaid</span>' : ''}
      </div>
      ${a.error ? `<div class="am-warning">Meta would not return the live billing details: ${amEsc(a.error)}. The spend below is from our own synced data.</div>` : ''}
      ${a.disable_reason ? `<div class="am-warning">Disable reason code from Meta: ${amEsc(String(a.disable_reason))}</div>` : ''}
      <div class="am-bill-grid">
        ${fact('Payment method', a.funding_source ? amEsc(a.funding_source) : '<span class="am-muted">—</span>')}
        ${fact(a.is_prepay ? 'Credit left' : 'Unbilled balance', amMoney(a.balance, a.currency), a.is_prepay ? 'Prepaid credit still available' : 'Run up since the last bill')}
        ${fact('Spend cap', amMoney(a.spend_cap, a.currency), 'Meta stops delivery once lifetime spend reaches this')}
        ${fact('Daily spend limit', amMoney(a.daily_spend_limit, a.currency), 'Set by Meta on the account, not by us')}
        ${fact('Spent today', amMoney(a.spend.today, a.currency), `Ad account day in ${amEsc(a.timezone_name || 'account timezone')}`)}
        ${fact('Month to date', amMoney(a.spend.month_to_date, a.currency))}
        ${fact(`Spend ${amEsc(a.spend.from)} – ${amEsc(a.spend.to)}`, amMoney(a.spend.range, a.currency))}
        ${fact('Lifetime spent', amMoney(a.amount_spent, a.currency), 'Billed by Meta on this account, including spend from before this dashboard was connected')}
      </div>
    </div>`).join('');

  const byMonth = (data.charges_by_month || []).filter((m) => m.count);
  const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const paidTotal = byMonth.reduce((sum, m) => sum + Number(m.net_paid || 0), 0);
  const monthly = byMonth.length ? `
    <div class="card am-bill-card">
      <div class="card-title">Paid per month</div>
      <div class="card-subtitle">What the card was actually charged, grouped from Meta's own charge records.</div>
      <div class="am-table-wrap">
        <table class="am-table">
          <thead><tr><th>Month</th><th class="am-num">Paid</th><th class="am-num">Refunds</th><th class="am-num">Net paid</th><th class="am-num">Pending</th><th class="am-num">Failed</th><th class="am-num">Charges</th></tr></thead>
          <tbody>
            ${byMonth.map((m) => `
              <tr>
                <td>${amEsc(monthName(m.month))}</td>
                <td class="am-num">${amMoney(m.paid, m.currency)}</td>
                <td class="am-num">${m.refunded ? amMoney(-m.refunded, m.currency) : '<span class="am-muted">—</span>'}</td>
                <td class="am-num"><strong>${amMoney(m.net_paid, m.currency)}</strong></td>
                <td class="am-num">${m.pending ? amMoney(m.pending, m.currency) : '<span class="am-muted">—</span>'}</td>
                <td class="am-num">${m.failed ? amMoney(m.failed, m.currency) : '<span class="am-muted">—</span>'}</td>
                <td class="am-num">${amFmt(m.count, 'int')}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr><th>Total paid</th><th class="am-num" colspan="2"></th><th class="am-num">${amMoney(paidTotal, byMonth[0].currency)}</th><th colspan="3"></th></tr></tfoot>
        </table>
      </div>
      <div class="am-sub am-bill-note">Covers only the charges Meta returned (newest ${amFmt(byMonth.reduce((n, m) => n + m.count, 0), 'int')}), so the oldest month shown may be partial.</div>
    </div>` : '';

  const charges = (data.charges || []).length ? `
    <div class="card am-bill-card">
      <div class="card-title">Billed charges</div>
      <div class="card-subtitle">Straight from Meta, newest first.</div>
      <div class="am-table-wrap">
        <table class="am-table">
          <thead><tr><th>Date</th><th>Type</th><th>Payment</th><th>Status</th><th class="am-num">Amount</th></tr></thead>
          <tbody>
            ${data.charges.map((c) => `
              <tr>
                <td>${c.time ? amEsc(new Date(c.time).toLocaleString('en-PH')) : '<span class="am-muted">—</span>'}</td>
                <td>${amEsc(String(c.charge_type || '—').replace(/_/g, ' '))}</td>
                <td>${amEsc(String(c.payment_option || '—').replace(/_/g, ' '))}</td>
                <td>${amEsc(String(c.status || '—').replace(/_/g, ' '))}</td>
                <td class="am-num">${amMoney(c.amount, c.currency)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : '';

  wrap.innerHTML = `
    <div class="am-bill">
      ${data.totals && accounts.length > 1 ? `
        <div class="card am-bill-card am-bill-totals">
          <div class="am-bill-grid">
            ${fact('Spend today (all accounts)', amMoney(data.totals.spend_today, data.totals.currency))}
            ${fact('Month to date', amMoney(data.totals.spend_month_to_date, data.totals.currency))}
            ${fact(`Spend ${amEsc(data.filters.from)} – ${amEsc(data.filters.to)}`, amMoney(data.totals.spend_range, data.totals.currency))}
          </div>
        </div>` : ''}
      ${cards}
      ${monthly}
      ${charges}
      ${data.charges_note ? `<div class="am-sub am-bill-note">${amEsc(data.charges_note)}</div>` : ''}
      ${(data.notes || []).map((n) => `<div class="am-sub am-bill-note">· ${amEsc(n)}</div>`).join('')}
    </div>`;
}

// ─── Detail ───────────────────────────────────────────────────────────────────
async function amOpenDetail(level, id) {
  const body = document.getElementById('am-detail-body');
  document.getElementById('am-detail-title').textContent = AM_LEVELS[level].noun;
  body.innerHTML = '<div class="empty-state"><p>Loading…</p></div>';
  openModal('am-detail-modal');
  try {
    const detail = await amApi(`/entity/${level}/${encodeURIComponent(id)}?${amQs({ from: amState.from, to: amState.to })}`);
    const r = detail.row;
    const rec = detail.record || {};
    const manageable = AM_LEVELS[level].manageable;
    const statusBadge = r.effective_status ? `<span class="badge ${r.effective_status === 'ACTIVE' ? 'badge-success' : 'badge-gray'}">${amEsc(String(r.effective_status).replace(/_/g, ' '))}</span>` : '';
    const facts = [
      ['Objective', rec.objective], ['Optimization', rec.optimization_goal], ['Campaign', r.campaign_name], ['Ad set', r.adset_name],
      ['Page', r.page_name], ['Ad account', r.ad_account_name], ['Meta ID', r.id], ['Creative ID', rec.creative_id],
    ].filter(([, v]) => v);
    const metric = (label, value) => `<div class="am-mini"><div class="am-kpi-label">${label}</div><div class="am-mini-value">${value}</div></div>`;
    const canBudget = (level === 'campaign' || level === 'adset') && r.daily_budget !== null && r.daily_budget !== undefined;
    body.innerHTML = `
      <div class="am-detail-head">
        ${rec.thumbnail_url ? `<img class="am-thumb" src="${amEsc(rec.thumbnail_url)}" alt="" referrerpolicy="no-referrer">` : ''}
        <div>
          <div class="am-detail-name">${amEsc(r.name)} ${statusBadge}</div>
          <div class="am-sub">${amEsc(amState.from)} to ${amEsc(amState.to)}${r.daily_budget ? ` · Budget ${amFmt(r.daily_budget, 'money')}/day` : ''}</div>
          ${r.flag ? `<div class="am-sub">${r.flag === 'winning' ? '🔥 Winning' : '⚠ Needs attention'}: ${amEsc((r.flag_reasons || []).join('; '))}</div>` : ''}
        </div>
      </div>
      ${level === 'ad' ? `
      <div class="am-preview-bar">
        <div class="am-select">
          <select id="am-preview-format">
            <option value="mobile">Mobile feed</option>
            <option value="desktop">Desktop feed</option>
            <option value="story">Mobile (basic)</option>
            <option value="reels">Facebook Reels</option>
            <option value="instagram">Instagram</option>
          </select>
        </div>
        <button class="btn btn-secondary btn-sm" type="button" onclick="amLoadPreview(${amEsc(JSON.stringify(String(id)))})">${AM_ICONS.play || '▶'} Play ad preview</button>
        <span class="am-muted">Rendered by Meta and streamed from Facebook — no video is stored or proxied here.</span>
      </div>
      <div id="am-preview-slot"></div>` : ''}
      <div class="am-mini-grid">
        ${metric('Spend', amFmt(r.spend, 'money'))}
        ${metric('Delivered COD', amFmt(r.delivered_cod, 'money'))}
        ${metric('Actual ROAS', amFmt(r.actual_roas, 'roas'))}
        ${metric('Meta ROAS', amFmt(r.roas, 'roas'))}
        ${metric('POS Orders', amFmt(r.pos_orders, 'int'))}
        ${metric('RTS', amFmt(r.rts_rate, 'pct'))}
        ${metric('Meta Purchases', amFmt(r.purchases, 'int'))}
        ${metric('CPA', amFmt(r.cpa, 'money'))}
        ${metric('CTR', amFmt(r.ctr, 'pct'))}
        ${metric('CPC', amFmt(r.cpc, 'money'))}
        ${metric('CPM', amFmt(r.cpm, 'money'))}
        ${metric('Impressions', amFmt(r.impressions, 'int'))}
      </div>
      <div class="am-chart-wrap am-chart-wrap-sm"><canvas id="am-detail-chart"></canvas></div>
      ${facts.length ? `<dl class="am-action-grid am-facts">${facts.map(([k, v]) => `<dt>${amEsc(k)}</dt><dd>${amEsc(v)}</dd>`).join('')}</dl>` : ''}
      <div class="am-detail-actions">
        ${level === 'campaign' ? `<button class="btn btn-secondary btn-sm" type="button" onclick="amDrillDown('campaign', '${amEsc(r.id)}', ${amEsc(JSON.stringify(r.name))})">View ad sets</button>` : ''}
        ${level === 'adset' ? `<button class="btn btn-secondary btn-sm" type="button" onclick="amDrillDown('adset', '${amEsc(r.id)}', ${amEsc(JSON.stringify(r.name))})">View ads</button>` : ''}
        ${manageable ? (r.status === 'ACTIVE'
    ? `<button class="btn btn-danger btn-sm" type="button" onclick="amRequestAction({ action: 'pause', level: '${level}', id: '${amEsc(r.id)}', onDone: () => amOpenDetail('${level}', '${amEsc(r.id)}') })">Pause ${AM_LEVELS[level].noun}</button>`
    : `<button class="btn btn-primary btn-sm" type="button" onclick="amRequestAction({ action: 'activate', level: '${level}', id: '${amEsc(r.id)}', onDone: () => amOpenDetail('${level}', '${amEsc(r.id)}') })">Activate ${AM_LEVELS[level].noun}</button>`) : ''}
        ${canBudget ? `<span class="am-budget-edit"><input type="number" min="1" step="1" class="form-control" id="am-budget-input" value="${Number(r.daily_budget)}" aria-label="Daily budget"><button class="btn btn-secondary btn-sm" type="button" onclick="amRequestBudget('${level}', '${amEsc(r.id)}', ${Number(r.daily_budget)})">Change budget</button></span>` : ''}
      </div>`;
    amDrawDetailChart(detail.trend || []);
  } catch (error) {
    body.innerHTML = `<div class="empty-state"><h3>Could not load details</h3><p>${amEsc(error.message)}</p></div>`;
  }
}

function amDrawDetailChart(days) {
  const canvas = document.getElementById('am-detail-chart');
  if (!canvas || !window.Chart) return;
  if (amState.detailChart) amState.detailChart.destroy();
  const colors = amChartColors();
  amState.detailChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: days.map((d) => d.day.slice(5)),
      datasets: [
        { label: 'Spend', data: days.map((d) => d.spend), backgroundColor: colors.spend, borderRadius: 3 },
        { label: 'Delivered COD', data: days.map((d) => d.delivered_cod), backgroundColor: colors.cod, borderRadius: 3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10 } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: colors.grid } } },
    },
  });
}

// ─── Connections / sync / targets ─────────────────────────────────────────────
function amOpenSettings() {
  amRenderSettings();
  openModal('am-settings-modal');
}

function amCloseSettings() {
  closeModal('am-settings-modal');
}

async function amRenderSettings() {
  const body = document.getElementById('am-settings-body');
  if (!body) return;
  const s = amState.status_info || {};
  const t = amState.targets || {};
  const statusBadge = (c) => {
    if (c.syncing) return '<span class="badge badge-info">Syncing…</span>';
    const map = { connected: 'badge-success', expired: 'badge-danger', error: 'badge-warning', disabled: 'badge-gray' };
    return `<span class="badge ${map[c.status] || 'badge-gray'}">${amEsc(c.status)}</span>`;
  };
  const connections = amState.connections.map((c) => `
    <div class="am-conn">
      <div class="am-conn-head">
        <div>
          <div class="am-conn-name">${amEsc(c.name)} ${statusBadge(c)}</div>
          <div class="am-sub">${amEsc(c.meta_user_name || '')} · ${c.auth_type === 'oauth' ? 'Facebook login' : 'Access token'}${c.token_expires_at ? ` · token expires ${new Date(c.token_expires_at).toLocaleDateString('en-PH')}` : ''} · last sync ${amRelativeTime(c.last_sync_at)}</div>
          ${c.last_error ? `<div class="am-conn-error">${amEsc(c.last_error)}</div>` : ''}
        </div>
        <div class="am-conn-actions">
          <button class="btn btn-secondary btn-sm" type="button" ${c.syncing ? 'disabled' : ''} onclick="amSyncNow(${c.id})">${AM_ICONS.sync} Sync now</button>
          <button class="btn btn-secondary btn-sm" type="button" onclick="amSetConnectionEnabled(${c.id}, ${c.status === 'disabled'})">${c.status === 'disabled' ? 'Unhide' : 'Hide'}</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="amRemoveConnection(${c.id}, ${amEsc(JSON.stringify(c.name))})">Remove</button>
        </div>
      </div>
      <div class="am-conn-accounts">
        ${c.ad_accounts.length ? `<div class="am-sub" style="margin-bottom:6px;">Untick an ad account to hide it from every tab and stop syncing it. Its history stays and comes back when you tick it again.</div>` : ''}
        ${c.ad_accounts.length ? c.ad_accounts.map((a) => `
          <label class="am-conn-account">
            <input type="checkbox" ${a.enabled ? 'checked' : ''} onchange="amToggleAccount('${amEsc(a.id)}', this.checked)">
            <span><strong>${amEsc(a.name)}</strong> <span class="am-muted">${amEsc(a.id)} · ${amEsc(a.currency || '')}${a.business_name ? ` · ${amEsc(a.business_name)}` : ''}${a.last_insights_date ? ` · data to ${amEsc(a.last_insights_date)}` : ''}</span></span>
          </label>`).join('') : '<div class="am-muted">No ad accounts yet — they appear after the first sync.</div>'}
      </div>
    </div>`).join('');

  body.innerHTML = `
    <div class="tabs">
      <button class="tab-btn active" type="button" onclick="switchTab(this,'am-set-connections')">Connections</button>
      <button class="tab-btn" type="button" onclick="switchTab(this,'am-set-sync'); amLoadSyncLogs();">Sync Center</button>
      <button class="tab-btn" type="button" onclick="switchTab(this,'am-set-targets')">Ads Targets</button>
      <button class="tab-btn" type="button" onclick="switchTab(this,'am-set-actions'); amLoadActionLogs();">Action Log</button>
    </div>

    <div id="am-set-connections" class="tab-content active">
      ${connections || '<div class="am-muted" style="margin-bottom:14px;">No Meta account connected yet.</div>'}
      <div class="am-connect-form">
        <div class="card-title">+ Connect Meta Account</div>
        ${s.oauth_configured ? `
          <button class="btn btn-primary" type="button" onclick="amStartOAuth()">${AM_ICONS.facebook} Continue with Facebook</button>
          <div class="am-or">or paste a token</div>` : ''}
        <div class="form-group">
          <label class="form-label" for="am-conn-name">Name</label>
          <input class="form-control" id="am-conn-name" placeholder="TAKARA Meta Account">
        </div>
        <div class="form-group">
          <label class="form-label" for="am-conn-token">Access token</label>
          <textarea class="form-control font-mono" id="am-conn-token" rows="3" placeholder="EAAB…" autocomplete="off" spellcheck="false"></textarea>
          <div class="field-help">A System User token from Business Settings (recommended) or a long-lived user token with <code>ads_read</code> (+ <code>ads_management</code> to pause/activate, <code>pages_show_list</code> for Page names). It is encrypted on the server and never sent back to the browser.</div>
        </div>
        <button class="btn btn-primary" type="button" id="am-connect-btn" onclick="amConnectToken()">Connect & sync</button>
      </div>
    </div>

    <div id="am-set-sync" class="tab-content">
      <div class="am-sync-head">
        <div class="am-muted">API ${amEsc(s.api_version || '')} · ${s.auto_sync?.enabled ? `auto-sync every ${s.auto_sync.interval_minutes} min` : 'auto-sync off (set META_SYNC_ENABLED=true)'} · latest data ${amEsc(s.latest_insight_date || '—')}</div>
        <div class="am-conn-actions">
          <button class="btn btn-secondary btn-sm" type="button" onclick="amSyncNow(null, 90)" title="Re-pull the last 90 days of insights">Reconcile 90 days</button>
          <button class="btn btn-primary btn-sm" type="button" onclick="amSyncNow()">${AM_ICONS.sync} Sync All</button>
        </div>
      </div>
      <div id="am-sync-logs" class="am-log-wrap"><div class="am-muted">Loading…</div></div>
    </div>

    <div id="am-set-targets" class="tab-content">
      <p class="am-muted" style="margin-bottom:14px;">Organization-wide thresholds for the Winning / Needs attention flags. Leave blank for no threshold.</p>
      <div class="form-grid-2">
        ${[
    ['target_actual_roas', 'Target Actual ROAS', 'x', 'Delivered COD ÷ spend'],
    ['target_roas', 'Target Meta ROAS', 'x', 'Meta purchase value ÷ spend'],
    ['max_cpa', 'Maximum cost per order', '₱', 'Spend ÷ POS orders'],
    ['max_cpm', 'Maximum CPM', '₱', ''],
    ['min_ctr', 'Minimum CTR', '%', ''],
    ['max_rts', 'Maximum RTS', '%', '(Returned + returning) ÷ settled'],
  ].map(([key, label, unit, help]) => `
          <div class="form-group">
            <label class="form-label" for="am-target-${key}">${label} <span class="am-muted">(${unit})</span></label>
            <input type="number" min="0" step="0.01" class="form-control" id="am-target-${key}" value="${t[key] ?? ''}">
            ${help ? `<div class="field-help">${help}</div>` : ''}
          </div>`).join('')}
      </div>
      <button class="btn btn-primary" type="button" onclick="amSaveTargets()">Save targets</button>
    </div>

    <div id="am-set-actions" class="tab-content">
      <div id="am-action-logs" class="am-log-wrap"><div class="am-muted">Loading…</div></div>
    </div>`;
}

async function amConnectToken() {
  const token = document.getElementById('am-conn-token').value.trim();
  const name = document.getElementById('am-conn-name').value.trim();
  if (!token) { showToast('warning', 'Access token', 'Paste a Meta access token first.'); return; }
  const btn = document.getElementById('am-connect-btn');
  btn.disabled = true;
  btn.textContent = 'Checking token…';
  try {
    await amApi('/connections', { method: 'POST', body: JSON.stringify({ name, access_token: token }) });
    showToast('success', 'Meta account connected', 'First sync started — it imports the last 30 days.');
    await amRefreshMeta();
    amRenderSettings();
  } catch (error) {
    showToast('error', 'Could not connect', error.message);
    btn.disabled = false;
    btn.textContent = 'Connect & sync';
  }
}

async function amStartOAuth() {
  try {
    const name = document.getElementById('am-conn-name')?.value.trim() || '';
    const { url } = await amApi(`/oauth/start?${amQs({ name })}`);
    window.location.href = url;
  } catch (error) {
    showToast('error', 'Facebook login unavailable', error.message);
  }
}

async function amSyncNow(connectionId = null, days = null) {
  try {
    const body = {};
    if (connectionId) body.connection_id = connectionId;
    if (days) body.days = days;
    const result = await amApi('/sync', { method: 'POST', body: JSON.stringify(body) });
    showToast('info', 'Sync started', result.started.length ? 'Data refreshes here when it finishes.' : 'A sync is already running.');
    await amRefreshMeta();
    if (document.getElementById('am-settings-modal')?.classList.contains('open')) amRenderSettings();
  } catch (error) {
    showToast('error', 'Sync failed to start', error.message);
  }
}

async function amRemoveConnection(id, name) {
  if (!confirm(`Remove "${name}"? Its token is deleted, its ad accounts stop syncing and their campaigns, ad sets and ads disappear from every tab.`)) return;
  // Second, opt-in step: the rows are kept by default so past date ranges still
  // report the spend, and reconnecting the same Meta account brings them back.
  const purge = confirm(`Also permanently delete the synced history for this connection?\n\nOK — delete its campaigns, ad sets, ads and daily insights. Past Meta spend and ROAS for these ad accounts are gone for good.\n\nCancel — keep the history in the database (hidden from the tabs, and it returns if you reconnect this account).`);
  try {
    const result = await amApi(`/connections/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
    await amRefreshMeta();
    amRenderSettings();
    amRefreshAll();
    const wiped = result?.purged ? Object.values(result.purged).reduce((a, b) => a + Number(b || 0), 0) : 0;
    showToast('success', 'Connection removed', purge ? `${wiped.toLocaleString('en-PH')} synced rows deleted.` : 'Synced history kept, hidden from the tabs.');
  } catch (error) {
    showToast('error', 'Could not remove', error.message);
  }
}

// Hiding a connection keeps the token and the synced history but takes its ad
// accounts out of every report and out of the automatic sync.
async function amSetConnectionEnabled(id, enabled) {
  try {
    await amApi(`/connections/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    await amRefreshMeta();
    amRenderSettings();
    amRefreshAll();
    showToast('success', enabled ? 'Connection unhidden' : 'Connection hidden', enabled ? 'Its ad accounts report and sync again.' : 'Its ad accounts are out of every tab until you unhide it.');
  } catch (error) {
    showToast('error', 'Could not update connection', error.message);
  }
}

async function amToggleAccount(id, enabled) {
  try {
    await amApi(`/ad-accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    await amRefreshMeta();
    amRefreshAll();
  } catch (error) {
    showToast('error', 'Could not update ad account', error.message);
  }
}

async function amLoadSyncLogs() {
  const el = document.getElementById('am-sync-logs');
  try {
    const { logs } = await amApi('/sync-logs?limit=40');
    if (!logs.length) { el.innerHTML = '<div class="am-muted">No syncs yet.</div>'; return; }
    const errors = logs.filter((l) => l.status === 'failed').length;
    el.innerHTML = `
      <div class="am-muted" style="margin-bottom:8px;">Errors in the last ${logs.length} steps: <strong>${errors}</strong></div>
      <table class="am-table am-log"><thead><tr><th>Started</th><th>Account</th><th>Step</th><th>Status</th><th class="am-num">Processed</th><th class="am-num">New</th><th class="am-num">Updated</th></tr></thead>
      <tbody>${logs.map((l) => `<tr>
        <td>${amEsc(new Date(l.started_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</td>
        <td>${amEsc(l.ad_account_name || l.connection_name || '—')}</td>
        <td>${amEsc(l.entity_type)}</td>
        <td><span class="badge ${l.status === 'success' ? 'badge-success' : l.status === 'failed' ? 'badge-danger' : 'badge-info'}">${amEsc(l.status)}</span>${l.error_message ? `<div class="am-conn-error">${amEsc(l.error_message)}</div>` : ''}</td>
        <td class="am-num">${Number(l.records_processed || 0).toLocaleString('en-PH')}</td>
        <td class="am-num">${Number(l.records_created || 0).toLocaleString('en-PH')}</td>
        <td class="am-num">${Number(l.records_updated || 0).toLocaleString('en-PH')}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch (error) {
    el.innerHTML = `<div class="am-conn-error">${amEsc(error.message)}</div>`;
  }
}

async function amLoadActionLogs() {
  const el = document.getElementById('am-action-logs');
  try {
    const { actions } = await amApi('/actions?limit=50');
    if (!actions.length) { el.innerHTML = '<div class="am-muted">No management actions yet.</div>'; return; }
    el.innerHTML = `<table class="am-table am-log"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Object</th><th>Before → After</th><th>Status</th></tr></thead>
      <tbody>${actions.map((a) => `<tr>
        <td>${amEsc(amRelativeTime(a.created_at))}</td>
        <td>${amEsc(a.username || '—')} <span class="am-muted">${amEsc(a.source || '')}</span></td>
        <td>${amEsc(String(a.action).replace('_', ' '))}</td>
        <td>${amEsc(a.entity_name || a.entity_id)} <span class="am-muted">${amEsc(a.entity_type)}</span></td>
        <td>${amEsc(a.old_value ?? '—')} → <strong>${amEsc(a.new_value ?? '—')}</strong></td>
        <td><span class="badge ${a.status === 'success' ? 'badge-success' : 'badge-danger'}">${amEsc(a.status)}</span>${a.error_message ? `<div class="am-conn-error">${amEsc(a.error_message)}</div>` : ''}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch (error) {
    el.innerHTML = `<div class="am-conn-error">${amEsc(error.message)}</div>`;
  }
}

async function amSaveTargets() {
  const body = { scope_type: 'organization' };
  ['target_actual_roas', 'target_roas', 'max_cpa', 'max_cpm', 'min_ctr', 'max_rts'].forEach((key) => {
    body[key] = document.getElementById(`am-target-${key}`).value;
  });
  try {
    const { target } = await amApi('/targets', { method: 'PUT', body: JSON.stringify(body) });
    amState.targets = target;
    showToast('success', 'Targets saved', 'Flags are recalculated on the table now.');
    amLoadTable();
  } catch (error) {
    showToast('error', 'Could not save targets', error.message);
  }
}

// Returning from Facebook login lands on /?meta_oauth=...; open the page and say
// how it went. 'load' fires after app.js has restored the session and shell.
window.addEventListener('load', () => {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('meta_oauth');
  if (!outcome) return;
  history.replaceState(null, '', window.location.pathname);
  setTimeout(() => {
    if (typeof App === 'undefined' || !App.user || typeof canAccessPage !== 'function' || !canAccessPage('ads-manager')) return;
    navigateTo('ads-manager');
    if (outcome === 'success') showToast('success', 'Meta account connected', 'First sync started — it imports the last 30 days.');
    else showToast('error', 'Meta login failed', params.get('message') || 'Facebook did not grant access.');
  }, 300);
});
