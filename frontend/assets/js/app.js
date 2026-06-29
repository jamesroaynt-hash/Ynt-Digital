/* ═══════════════════════════════════════════════════════════
   YNT DIGITAL MARKETING — Shared App JavaScript
   ═══════════════════════════════════════════════════════════ */

// ─── STATE ─────────────────────────────────────────────────
const App = {
  user: JSON.parse(localStorage.getItem('ynt_user') || 'null'),
  currentPage: 'home',
};
const ROLE_OPTIONS = ['HR', 'Trainee', 'RMO', 'RMO TL', 'CSR', 'CSR TL', 'Logistics', 'Sales and Marketing', 'Sales and Marketing TL'];
const NAV_ACCESS = {
  Administrator: ['home', 'attendance', 'attendance-log', 'schedule', 'marketing-center', 'rmo-management', 'creatives', 'adspend-roas', 'csr', 'inventory', 'expenses', 'hr', 'training', 'daily-pickup', 'rts-scanning', 'rts-rate', 'scanning', 'data-report', 'view-records', 'manage-users', 'api-connections', 'profile'],
  HR: ['home', 'rts-rate', 'attendance', 'attendance-log', 'schedule', 'adspend-roas', 'rmo-management', 'hr', 'training', 'manage-users', 'expenses', 'data-report', 'view-records', 'profile'],
  Trainee: ['home', 'rts-rate', 'attendance', 'csr', 'data-report', 'view-records', 'profile'],
  CSR: ['home', 'rts-rate', 'attendance', 'csr', 'rmo-management', 'data-report', 'view-records', 'manage-users', 'profile'],
  'CSR TL': ['home', 'rts-rate', 'attendance', 'csr', 'rmo-management', 'data-report', 'view-records', 'manage-users', 'profile'],
  RMO: ['home', 'attendance', 'rmo-management', 'rts-rate', 'inventory', 'data-report', 'view-records', 'profile'],
  'RMO TL': ['home', 'attendance', 'rmo-management', 'rts-rate', 'inventory', 'data-report', 'view-records', 'profile'],
  Logistics: ['home', 'attendance', 'rmo-management', 'rts-rate', 'rts-scanning', 'daily-pickup', 'scanning', 'inventory', 'csr', 'adspend-roas', 'expenses', 'data-report', 'view-records', 'profile'],
  'Sales and Marketing': ['home', 'attendance', 'marketing-center', 'rmo-management', 'creatives', 'csr', 'adspend-roas', 'rts-rate', 'inventory', 'data-report', 'view-records', 'profile'],
  'Sales and Marketing TL': ['home', 'attendance', 'marketing-center', 'rmo-management', 'creatives', 'csr', 'adspend-roas', 'rts-rate', 'inventory', 'expenses', 'data-report', 'view-records', 'profile'],
};
let managedUsers = [];
let hrState = { users: [], summary: [], attendance: [], advances: [] };
let attendanceState = { today: null, date: '', advances: [], leaves: [], activeTab: 'clock' };
let posUsersState = { users: [], total: 0, page: 1, perPage: 50, search: '', loading: false };
const INTEGRATION_STORAGE_KEY = 'ynt_integrations';
const CSR_STORAGE_KEY = 'ynt_csr_daily_records';
// Flag set once any legacy localStorage CSR records have been pushed to the
// server, so the one-time migration never re-imports them.
const CSR_MIGRATED_KEY = 'ynt_csr_migrated';
const COURIER_STORAGE_KEY = 'ynt_courier_options';
const MARKETING_STORAGE_KEY = 'ynt_marketing_center';
const DAMAGE_REPORT_STORAGE_KEY = 'ynt_damage_reports';
const TRAINING_STORAGE_KEY = 'ynt_trainings';
const TRAINING_DEPARTMENTS = ['Logistics Staff', 'HR Assistant', 'Marketplace Associate', 'CSR Associate', 'Operations Assistant', 'Sales and Marketing Associate'];
const TRAINING_CATEGORIES = ['Safety', 'Onboarding', 'Compliance', 'Skills', 'Policy'];
const CSR_PAGE_OPTIONS = [
  'AGELESS',
  'GINSENG PH',
  'ORANIC SERUM',
  'BEAUTY LOVES',
  'DRAGON BLOOD',
  'SKIN EXPERT',
  'GLOW CART',
  'KOREAN FS',
  'HALLY LOTION',
  'LUZON BRANCH',
  'KRISTEL ANN',
  'GLOW HUB',
];
const CSR_SALES_TYPES = ['CONFIRM', 'REPEAT ORDERS', 'VIP + UPSELL', 'UPSELL', 'CANCELLED', 'BROADCAST', 'PENDING'];
const CSR_STATUS_OPTIONS = ['DELIVERED', 'INTRANSIT', 'RETURNED', 'FOR RETURN', 'DELIVERING', 'FOR MONITORING', 'DASHBOARD CANCELLED', 'CANCELLED'];
const DEFAULT_COURIER_OPTIONS = ['J&T Express', 'Ninja Van', 'LBC', '2GO', 'Flash Express', 'Shopee Xpress'];
let authMode = 'login';
let salesBarChart = null;
let salesDonutChart = null;
let homeDonutChart = null;

// Draws percentage labels in the middle of each arc segment for doughnut/pie charts.
// Skips slices < 4% so labels don't crowd tiny segments.
const doughnutPctPlugin = {
  id: 'doughnutPct',
  afterDraw(chart) {
    if (chart.config.type !== 'doughnut' && chart.config.type !== 'pie') return;
    const { ctx } = chart;
    const dataset = chart.data.datasets[0];
    const total = dataset.data.reduce((s, v) => s + Number(v || 0), 0);
    if (!total) return;
    chart.getDatasetMeta(0).data.forEach((arc, i) => {
      const value = Number(dataset.data[i] || 0);
      const pct = (value / total) * 100;
      if (pct < 4) return;
      const midAngle = arc.startAngle + (arc.endAngle - arc.startAngle) / 2;
      const r = (arc.outerRadius + arc.innerRadius) / 2;
      const x = arc.x + Math.cos(midAngle) * r;
      const y = arc.y + Math.sin(midAngle) * r;
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pct.toFixed(1) + '%', x, y);
      ctx.restore();
    });
  },
};
let homeRtsBarChart = null;
let dataReportPriceChart = null;
let integrationsBackendHydrated = false;
let ordersLoadPromise = null;

// ─── ROUTER / PAGE LOADER ──────────────────────────────────
function navigateTo(page) {
  if (!App.user && page !== 'login') {
    loadPage('login');
    return;
  }
  if (page !== 'login' && !canAccessPage(page)) {
    showToast('warning', 'Access denied', 'Your account cannot open this page.');
    loadPage('home');
    return;
  }
  loadPage(page);
}

function loadPage(page) {
  App.currentPage = page;
  const loginScreen = document.getElementById('login-screen');
  const shell = document.getElementById('app-shell');
  if (!loginScreen || !shell) return;

  // Update nav active state
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  // Update breadcrumb
  const crumb = document.getElementById('page-breadcrumb-current');
  if (crumb) crumb.textContent = pageNames[page] || page;

  const dateText = document.getElementById('topbar-date-text');
  if (dateText) dateText.textContent = new Date().toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Hide/show shell
  shell.style.display = (page === 'login') ? 'none' : 'flex';
  if (page === 'login') {
    loginScreen.innerHTML = renderLogin();
    return;
  }
  loginScreen.innerHTML = '';
  refreshSidebarAccess();

  // Render page content
  const renderFns = {
    home: renderHome,
    attendance: renderAttendance,
    'marketing-center': renderMarketingCenter,
    'rmo-management': renderRmoManagement,
    creatives: renderCreatives,
    'adspend-roas': renderAdspendRoas,
    csr: renderCSR,
    inventory: renderInventory,
    expenses: renderExpenses,
    hr: renderHR,
    'attendance-log': renderAttendanceLog,
    training: renderTraining,
    'daily-pickup': renderDailyPickup,
    'rts-scanning': renderRTSScanning,
    'rts-rate': renderRTSRate,
    'data-report': renderDataReport,
    scanning: renderScanning,
    'view-records': renderViewRecords,
    'manage-users': renderManageUsers,
    'api-connections': renderApiConnections,
    schedule: renderSchedulePage,
    profile: renderProfilePage,
  };

  const fn = renderFns[page];
  if (fn) {
    document.getElementById('main-page-content').innerHTML = fn();
    initPage(page);
  }
}

const pageNames = {
  home: 'Home',
  attendance: 'Time & Attendance',
  'marketing-center': 'Marketing',
  'rmo-management': 'RMO Management',
  creatives: 'Ad Creatives',
  'adspend-roas': 'ROAS Summary',
  csr: 'CSR Records',
  inventory: 'Stock',
  expenses: 'Expenses',
  hr: 'HR & Payroll',
  'attendance-log': 'Attendance Log',
  training: 'Training',
  'daily-pickup': 'Pickup',
  'rts-scanning': 'RTS Scan',
  'rts-rate': 'Sale Report',
  'data-report': 'Sales Dashboard',
  scanning: 'Scan Orders',
  'view-records': 'Records',
  'manage-users': 'Users',
  'api-connections': 'Integrations',
  schedule: 'Schedule',
  profile: 'My Profile',
};

// ─── AUTH ──────────────────────────────────────────────────
function getAuthApiBase() {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return `${location.origin}/api/auth`;
  }
  return '';
}

function getApiBase() {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return `${location.origin}/api`;
  }
  return '';
}

function getAuthToken() {
  return localStorage.getItem('ynt_token') || '';
}

function clearExpiredSession() {
  localStorage.removeItem('ynt_user');
  localStorage.removeItem('ynt_token');
  App.user = null;
}

async function authorizedJsonRequest(path, options = {}) {
  const apiBase = getApiBase();
  if (!apiBase) {
    throw new Error('Server required');
  }

  const token = getAuthToken();
  const headers = { ...(options.headers || {}) };
  if (!headers.Authorization && token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
  });

  let data = null;
  const responseType = response.headers.get('content-type') || '';
  if (responseType.includes('application/json')) {
    data = await response.json();
  } else {
    const text = await response.text();
    data = text ? { message: text } : null;
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearExpiredSession();
      showToast('warning', 'Session expired', 'Please sign in again to refresh dashboard data.');
      loadPage('login');
      throw new Error('Session expired. Please sign in again.');
    }
    throw new Error(data?.error || data?.message || 'Request failed');
  }

  return data;
}

function mapBackendOrder(row) {
  let posTags = [];
  if (row.pos_tags_json) {
    try {
      const parsed = typeof row.pos_tags_json === 'string' ? JSON.parse(row.pos_tags_json) : row.pos_tags_json;
      if (Array.isArray(parsed)) posTags = parsed.map((t) => (typeof t === 'string' ? t : (t?.name || t?.tag_name || t?.label || ''))).filter(Boolean);
    } catch { /* ignore */ }
  }
  return {
    id: row.order_ref || `ORD-${row.id}`,
    dbId: row.id,
    tracking: row.tracking_no || '',
    customer: row.customer || '',
    phone: row.phone || '',
    product: row.product || '',
    tags: row.tags || '',
    posTags,
    qty: Number(row.qty || 0),
    cod: Number(row.cod_amount || 0),
    status: row.status || 'Confirmed',
    courier: row.courier || '',
    date: normalizeDateString(row.order_date || row.created_at || new Date()),
    sourceSheet: row.source_sheet || '',
    confirmedBy: row.confirmed_by || '',
    attempts: Number(row.attempts || 1),
    confirmedBy: row.confirmed_by || row.confirmedBy || '',
    city: row.city || '',
    province: row.province || '',
    updated_at: row.updated_at || '',
  };
}

function mapBackendInventoryItem(row) {
  return {
    id: row.item_id || `INV-${row.id}`,
    dbId: row.id,
    name: row.name || '',
    type: row.type || 'Product',
    sku: row.sku || '',
    stock: Number(row.stock || 0),
    reorder: Number(row.reorder_pt || 0),
    totalOrders: Number(row.total_orders || 0),
    unit: row.unit || 'pcs',
    cost: Number(row.cost_price || 0),
    price: row.sell_price === null || row.sell_price === undefined ? null : Number(row.sell_price),
    active: row.active === 0 || row.active === false ? 0 : 1,
  };
}

let _ordersLoadedAt = 0;
let _ordersWatermark = '';   // max updated_at seen — drives incremental fetch
let _ordersTotal = 0;        // last known full count — drives deletion detection
const ORDERS_CACHE_TTL_MS = 60_000; // reuse in-memory data for 60s
const ORDERS_BASE_QUERY = '/orders?per_page=5000&page=1';

function recomputeOrderStats() {
  DB.orderStats = {
    total_orders: DB.orders.length,
    total_cod: DB.orders.reduce((sum, order) => sum + Number(order.cod || 0), 0),
    status_counts: Object.entries(DB.orders.reduce((counts, order) => {
      counts[order.status] = (counts[order.status] || 0) + 1;
      return counts;
    }, {})).map(([status, count]) => ({ status, count })),
  };
}

async function refreshOrdersFromBackend(force = false) {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;

  // Return immediately if cache is still fresh and data is loaded
  if (!force && DB.orders.length && (Date.now() - _ordersLoadedAt) < ORDERS_CACHE_TTL_MS) return true;

  // Incremental: once we have a baseline + watermark, pull only rows changed
  // since the watermark and upsert them — turns the recurring ~2.3MB full pull
  // into a few KB. Full reload only on first load or when rows were deleted.
  const canDelta = DB.orders.length > 0 && _ordersWatermark;
  let result = await authorizedJsonRequest(
    canDelta
      ? `${ORDERS_BASE_QUERY}&since=${encodeURIComponent(_ordersWatermark)}&_=${Date.now()}`
      : `${ORDERS_BASE_QUERY}&_=${Date.now()}`
  );
  if (!Array.isArray(result?.data)) return false;

  let fullReplace = !canDelta;
  if (canDelta && Number(result.total) < _ordersTotal) {
    // Deletion happened — a delta can't express removals, so resync fully.
    result = await authorizedJsonRequest(`${ORDERS_BASE_QUERY}&_=${Date.now()}`);
    if (!Array.isArray(result?.data)) return false;
    fullReplace = true;
  }

  const incoming = result.data.map(mapBackendOrder);
  if (fullReplace) {
    DB.orders = incoming;
  } else if (incoming.length) {
    // Upsert by id: replace changed rows in place, prepend genuinely new ones
    // (delta arrives newest-first, so prepending as a block preserves order).
    const indexById = new Map(DB.orders.map((order, i) => [order.id, i]));
    const fresh = [];
    for (const order of incoming) {
      if (indexById.has(order.id)) DB.orders[indexById.get(order.id)] = order;
      else fresh.push(order);
    }
    if (fresh.length) DB.orders = [...fresh, ...DB.orders];
  }

  _ordersWatermark = DB.orders.reduce(
    (mx, o) => (o.updated_at && o.updated_at > mx ? o.updated_at : mx),
    ''
  );
  _ordersTotal = Number(result.total) || DB.orders.length;
  recomputeOrderStats();
  _ordersLoadedAt = Date.now();
  return true;
}

async function ensureOrdersLoadedForPage(page) {
  if (DB.orders.length) {
    if (App.currentPage === page) renderPageOrderData(page);
    return true;
  }
  if (!ordersLoadPromise) {
    ordersLoadPromise = refreshOrdersFromBackend().finally(() => {
      ordersLoadPromise = null;
    });
  }

  const refreshed = await ordersLoadPromise;
  if (refreshed && App.currentPage === page) loadPage(page);
  return refreshed;
}

function renderPageOrderData(page) {
  if (page === 'rmo-management') renderPosOrdersTable();
  if (page === 'home') renderHomeOrderCharts();
  if (page === 'rts-rate') renderRTSRateDashboard();
  if (page === 'data-report') renderDataReportDashboard();
}

async function refreshOrderStatsFromBackend() {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;

  const stats = await authorizedJsonRequest(`/orders/stats?_=${Date.now()}`);
  DB.orderStats = {
    total_orders: Number(stats?.total_orders || 0),
    total_cod: Number(stats?.total_cod || 0),
    status_counts: Array.isArray(stats?.status_counts) ? stats.status_counts : [],
  };
  return true;
}

async function refreshInventoryFromBackend() {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;

  const result = await authorizedJsonRequest(`/inventory?_=${Date.now()}`);
  if (!Array.isArray(result)) return false;

  DB.inventory = result.map(mapBackendInventoryItem);
  return true;
}

// Normalize an item/product name for matching RTS scan totals to inventory rows:
// strip a leading pcs count ("2 Niacinamide"), collapse spaces, lowercase.
function normalizeProductKey(name) {
  return String(name || '').replace(/^\s*\d+\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Total pcs scanned in RTS, keyed by normalized product name. Populated from the
// /scans summary so the Inventory Products table can show scanned pcs per item.
async function refreshRtsPcsByProduct() {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;

  const result = await authorizedJsonRequest(`/scans?type=RTS&per_page=10&page=1&_=${Date.now()}`);
  const byProduct = result?.summary?.by_product;
  if (!Array.isArray(byProduct)) return false;

  const map = {};
  byProduct.forEach((row) => {
    const key = normalizeProductKey(row.product);
    if (key) map[key] = Number(row.pcs || 0);
  });
  DB.rtsPcsByProduct = map;

  // Per-page breakdown: powers the auto-added per-page tabs on the Inventory
  // page and the Add Item product-name picker.
  const byPageProduct = result?.summary?.by_page_product;
  const pageProductMap = {};
  const pageList = [];
  const nameSet = new Set();
  if (Array.isArray(byPageProduct)) {
    byPageProduct.forEach(({ page, products }) => {
      const pm = {};
      (Array.isArray(products) ? products : []).forEach((row) => {
        const key = normalizeProductKey(row.product || row.name);
        if (key) pm[key] = Number(row.pcs || 0);
        if (row.name) nameSet.add(String(row.name).trim());
      });
      pageProductMap[page] = pm;
      if (page) pageList.push(page);
    });
  }
  DB.rtsPcsByPageProduct = pageProductMap;
  DB.rtsScanPages = pageList.filter((p) => p && p !== 'Unknown').sort();
  DB.rtsProductNames = [...nameSet].filter(Boolean).sort((a, b) => a.localeCompare(b));

  await loadRtsPageSkuMap();
  return true;
}

// Page → SKU assignments for RTS Return. Once a page is mapped to a SKU, that
// page's RTS pcs flow into the inventory Product with the same SKU.
async function loadRtsPageSkuMap() {
  try {
    const rows = await authorizedJsonRequest(`/inventory/rts-sku-map?_=${Date.now()}`);
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (row && row.page_name) map[row.page_name] = String(row.sku || '');
    });
    DB.rtsPageSku = map;
    return true;
  } catch {
    DB.rtsPageSku = DB.rtsPageSku || {};
    return false;
  }
}

// Build RTS pcs lookups honoring the page→SKU mapping: a mapped page's total pcs
// go to its assigned SKU; unmapped pages fall back to per-product name matching.
function computeRtsPcsLookups() {
  const pageProduct = DB.rtsPcsByPageProduct || {}; // page -> { nameKey -> pcs }
  const pageSku = DB.rtsPageSku || {};              // page -> sku
  const skuPcs = {};
  const namePcs = {};
  Object.entries(pageProduct).forEach(([page, pm]) => {
    const sku = String(pageSku[page] || '').trim();
    if (sku) {
      const total = Object.values(pm).reduce((sum, v) => sum + Number(v || 0), 0);
      skuPcs[sku] = (skuPcs[sku] || 0) + total;
    } else {
      Object.entries(pm).forEach(([key, pcs]) => {
        namePcs[key] = (namePcs[key] || 0) + Number(pcs || 0);
      });
    }
  });
  return { skuPcs, namePcs };
}

// RTS pcs for one item, honoring the page→SKU mapping (SKU wins, name fallback).
function itemRtsPcs(item, lookups) {
  const { skuPcs, namePcs } = lookups || computeRtsPcsLookups();
  return (item.sku && skuPcs[item.sku] != null)
    ? Number(skuPcs[item.sku])
    : Number(namePcs[normalizeProductKey(item.name)] || 0);
}

// Effective stock = managed stock + RTS pcs (returned items back in the warehouse).
function inventoryEffectiveStock(item, lookups) {
  return Number(item.stock || 0) + itemRtsPcs(item, lookups);
}

// Active-products tab honors the search box (item name or SKU); other tabs unfiltered.
function inventoryProductsFiltered() {
  const q = (document.getElementById('inv-products-search')?.value || '').trim().toLowerCase();
  let items = DB.inventory.filter(i => i.type === 'Product' && i.active !== 0);
  if (q) {
    items = items.filter(i =>
      String(i.name || '').toLowerCase().includes(q) ||
      String(i.sku || '').toLowerCase().includes(q));
  }
  return items;
}

function filterInventoryProducts() {
  const container = document.querySelector('#tab-active .table-container');
  if (container) container.innerHTML = renderInventoryTable(inventoryProductsFiltered());
}

function rerenderInventoryTables() {
  const tabs = {
    'tab-active': inventoryProductsFiltered(),
    'tab-supplies': DB.inventory.filter(i => i.type === 'Supply'),
    'tab-inactive': DB.inventory.filter(i => i.type === 'Product' && i.active === 0),
  };
  Object.entries(tabs).forEach(([id, items]) => {
    const container = document.querySelector(`#${id} .table-container`);
    if (container) container.innerHTML = renderInventoryTable(items);
  });
}

// RTS Return tab: per-page ITEM NAME | RTS STOCKS, derived from RTS Scan Records.
// Pcs accumulate per page+item, so every new RTS scan bumps the right table.
function renderRtsReturnTab() {
  return `
  <div id="rts-return-pages">
    <div class="card"><div class="card-body" style="text-align:center;color:var(--text-muted);padding:24px;">Loading RTS Return stocks...</div></div>
  </div>`;
}

// Stock History tab: audit trail of every stock update from inventory_logs.
function renderStockHistoryTab() {
  return `
  <div id="stock-history-wrap">
    <div class="card"><div class="card-body" style="text-align:center;color:var(--text-muted);padding:24px;">Loading stock history...</div></div>
  </div>`;
}

async function loadStockHistory() {
  const wrap = document.getElementById('stock-history-wrap');
  if (!wrap) return;
  if (!getApiBase() || !getAuthToken()) {
    wrap.innerHTML = `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-muted);padding:24px;">Connect to a server to view stock history.</div></div>`;
    return;
  }
  try {
    const rows = await authorizedJsonRequest(`/inventory/logs?limit=300&_=${Date.now()}`);
    if (!Array.isArray(rows) || !rows.length) {
      wrap.innerHTML = `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-muted);padding:24px;">No stock updates recorded yet.</div></div>`;
      return;
    }
    const actionLabel = { add: 'Add', remove: 'Remove', set: 'Set', adjustment: 'Adjustment' };
    const bodyHtml = rows.map((r) => {
      const change = Number(r.qty_change || 0);
      const changeStr = change > 0 ? `+${change}` : `${change}`;
      const changeColor = change > 0 ? 'var(--success)' : (change < 0 ? 'var(--danger)' : 'var(--text-muted)');
      return `<tr>
        <td style="white-space:nowrap;">${escapeHtml(formatDateTime(r.created_at))}</td>
        <td style="font-weight:500;">${escapeHtml(r.item_name || r.item_id || '—')}</td>
        <td>${escapeHtml(actionLabel[r.action] || r.action || '—')}</td>
        <td style="text-align:right;">${Number(r.qty_before || 0).toLocaleString()}</td>
        <td style="text-align:right;font-weight:600;color:${changeColor};">${changeStr}</td>
        <td style="text-align:right;font-weight:600;">${Number(r.qty_after || 0).toLocaleString()}</td>
        <td>${escapeHtml(r.created_by_name || 'System')}</td>
        <td>${escapeHtml(r.notes || '')}</td>
      </tr>`;
    }).join('');
    wrap.innerHTML = `<div class="card">
      <div class="card-header"><div><div class="card-title">Stock Update History</div><div class="card-subtitle">Every stock change, newest first (last 300).</div></div></div>
      <div class="table-container">
        <table>
          <thead><tr><th>Date</th><th>Item</th><th>Action</th><th style="text-align:right;">Before</th><th style="text-align:right;">Change</th><th style="text-align:right;">After</th><th>By</th><th>Notes</th></tr></thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      </div>
    </div>`;
  } catch (error) {
    wrap.innerHTML = `<div class="card"><div class="card-body" style="text-align:center;color:var(--danger);padding:24px;">Failed to load: ${escapeHtml(error.message || 'error')}</div></div>`;
  }
}

async function loadRtsReturnRecords() {
  const wrap = document.getElementById('rts-return-pages');
  if (!wrap) return;
  if (!getApiBase() || !getAuthToken()) {
    wrap.innerHTML = `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-muted);padding:24px;">Connect to a server to view RTS Return stocks.</div></div>`;
    return;
  }
  try {
    const data = await authorizedJsonRequest(`/scans?type=RTS&per_page=1&page=1&_=${Date.now()}`);
    const byPage = Array.isArray(data?.summary?.by_page_product) ? data.summary.by_page_product : [];

    // Map normalized product name -> inventory SKU.
    const skuByKey = {};
    (DB.inventory || []).forEach((it) => {
      const k = normalizeProductKey(it.name);
      if (k) skuByKey[k] = it.sku || '';
    });

    // One row per page: total RTS pcs + the matched SKUs for that page.
    const pageAgg = new Map();
    byPage.forEach(({ page, products }) => {
      const pg = page || 'Unknown';
      const cur = pageAgg.get(pg) || { page: pg, skus: new Set(), pcs: 0 };
      (Array.isArray(products) ? products : []).forEach((pr) => {
        const sku = skuByKey[normalizeProductKey(pr.name || pr.product)];
        if (sku) cur.skus.add(sku);
        cur.pcs += Number(pr.pcs || 0);
      });
      pageAgg.set(pg, cur);
    });
    const rows = [...pageAgg.values()]
      .map((r) => ({ page: r.page, derivedSku: [...r.skus].join(', '), pcs: r.pcs }))
      .sort((a, b) => String(a.page).localeCompare(String(b.page)));

    if (!rows.length) {
      wrap.innerHTML = `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-muted);padding:24px;">No RTS scan records yet.</div></div>`;
      return;
    }

    // Saved page→SKU assignments drive which Product receives each page's RTS pcs.
    await loadRtsPageSkuMap();
    const pageSku = DB.rtsPageSku || {};
    const canEdit = canManageInventoryStock();
    const skuOptions = [...new Set((DB.inventory || []).map((it) => it.sku).filter(Boolean))].sort();
    const skuDatalist = `<datalist id="rts-sku-options">${skuOptions.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('')}</datalist>`;

    const dash = '<span class="text-xs text-muted">—</span>';
    const total = rows.reduce((s, r) => s + r.pcs, 0);
    const bodyHtml = rows.map((r) => {
      const assigned = pageSku[r.page] || '';
      const skuCell = canEdit
        ? `<input type="text" class="form-control" style="width:140px;padding:4px 8px;height:auto;font-size:12px" value="${escapeHtml(assigned)}" placeholder="${escapeHtml(r.derivedSku) || 'Assign SKU'}" list="rts-sku-options" title="Assign this page's RTS pcs to a product SKU" onchange="saveRtsPageSku('${encodeURIComponent(r.page)}', this.value)">`
        : `<span class="font-mono text-xs">${escapeHtml(assigned || r.derivedSku) || dash}</span>`;
      return `<tr>
      <td>${skuCell}</td>
      <td style="font-weight:500;">${escapeHtml(r.page)}</td>
      <td style="text-align:right;"><strong>${r.pcs.toLocaleString()}</strong></td>
    </tr>`;
    }).join('');
    wrap.innerHTML = `<div class="card">
      <div class="card-header"><div><div class="card-title">RTS Return Stocks</div><div class="card-subtitle">RTS total pcs per page, from scan records. Assign a SKU to route a page's pcs to a Product.</div></div></div>
      <div class="table-container">
        ${skuDatalist}
        <table>
          <thead><tr><th>SKU</th><th>PAGE NAME</th><th style="text-align:right;">RTS TOTAL PCS</th></tr></thead>
          <tbody>
            ${bodyHtml}
          </tbody>
          <tfoot><tr style="font-weight:700;border-top:1px solid var(--border);"><td colspan="2">Total</td><td style="text-align:right;">${total.toLocaleString()}</td></tr></tfoot>
        </table>
      </div>
    </div>`;
  } catch (error) {
    wrap.innerHTML = `<div class="card"><div class="card-body" style="text-align:center;color:var(--danger);padding:24px;">Failed to load: ${escapeHtml(error.message || 'error')}</div></div>`;
  }
}

// Save a page→SKU assignment from the RTS Return tab, then refresh the inventory
// tables so the Product with that SKU picks up the page's RTS pcs.
async function saveRtsPageSku(pageEnc, sku) {
  if (!canManageInventoryStock()) {
    showToast('warning', 'Not allowed', 'Only administrators and logistics staff can edit RTS SKUs.');
    return;
  }
  const pageName = decodeURIComponent(pageEnc);
  const clean = String(sku || '').trim();
  DB.rtsPageSku = DB.rtsPageSku || {};
  if (clean) DB.rtsPageSku[pageName] = clean; else delete DB.rtsPageSku[pageName];
  try {
    await authorizedJsonRequest('/inventory/rts-sku-map', {
      method: 'PUT',
      body: JSON.stringify({ page_name: pageName, sku: clean }),
    });
    rerenderInventoryTables();
    showToast('success', 'RTS SKU saved', `${pageName} → ${clean || '(cleared)'}`);
  } catch (error) {
    showToast('error', 'Save failed', error.message || 'Could not save RTS SKU.');
  }
}

async function loadPosOrdersDashboard() {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;
  const result = await authorizedJsonRequest(`/orders/pos-orders/dashboard?_=${Date.now()}`);
  DB.posOrders = Array.isArray(result?.data) ? result.data : [];
  if (result?.version !== undefined) posOrdersLastVersion = result.version;
  return true;
}

async function loadSheetRecordsStats() {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;
  try {
    const result = await authorizedJsonRequest(`/integrations/google-sheets/stats?_=${Date.now()}`);
    DB.sheetRecordsStats = {
      total: Number(result?.total || 0),
      delivered: Number(result?.delivered || 0),
      totalCOD: Number(result?.total_cod || 0),
    };
    return true;
  } catch {
    return false;
  }
}

let sheetRecordsLastVersion = null;
let sheetRecordsLastFetch = 0;
const SHEET_RECORDS_MIN_REFRESH_MS = 10 * 60 * 1000; // re-fetch at most every 10 min

async function fetchSheetRecordsVersion() {
  if (!App.user || !getAuthToken() || !getApiBase()) return null;
  try {
    const result = await authorizedJsonRequest(`/integrations/google-sheets/version?_=${Date.now()}`);
    return result?.version ?? null;
  } catch {
    return null;
  }
}

async function loadSheetRecordsForDataReport({ force = false } = {}) {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;

  // Single source of truth: pos_orders. Skip the full multi-page walk when
  // pos_orders is unchanged since the last load (biggest dashboard egress).
  const version = await fetchPosOrdersVersion();
  const hasData = Array.isArray(DB.sheetRecordsForReport) && DB.sheetRecordsForReport.length > 0;
  if (!force && hasData) {
    if (version !== null && version === sheetRecordsLastVersion) return true;
    if (Date.now() - sheetRecordsLastFetch < SHEET_RECORDS_MIN_REFRESH_MS) return true;
  }

  const all = [];
  const perPage = 1000;
  let page = 1;
  let totalPages = 1;
  do {
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage), _: String(Date.now()) });
    const result = await authorizedJsonRequest(`/orders/pos-orders/report?${params}`);
    const records = Array.isArray(result?.records) ? result.records : [];
    all.push(...records);
    totalPages = Number(result?.pages || 1);
    page += 1;
    if (page > 200) break;
  } while (page <= totalPages);
  // The endpoint already returns the dashboard record shape, so use as-is.
  DB.sheetRecordsForReport = all;
  sheetRecordsLastVersion = version;
  sheetRecordsLastFetch = Date.now();
  return true;
}

function mapGoogleSheetReportRecord(r = {}) {
  return {
    id: r.order_ref || String(r.id || ''),
    tracking: r.tracking_no || '',
    customer: r.customer || '',
    phone: r.phone || '',
    product: r.product || '',
    attempts: Number(r.attempts || 0),
    status: r.status,
    cod: Number(r.cod_amount || 0),
    province: r.province_city || '',
    assigning_seller_name: r.confirmed_by || '',
    confirmed_by: r.confirmed_by || '',
    tags: r.tag || '',
    date: (r.order_date || '').slice(0, 10),
    source_sheet: r.chat_page || '',
    sourceSheet: r.chat_page || '',
  };
}

async function fetchPosOrdersVersion() {
  if (!App.user || !getAuthToken() || !getApiBase()) return null;
  try {
    const result = await authorizedJsonRequest(`/orders/pos-orders/version?_=${Date.now()}`);
    return result?.version ?? null;
  } catch {
    return null;
  }
}

function formatPosOrdersDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Render POS API timestamps (stored UTC as "YYYY-MM-DD HH:MM:SS" or ISO) in
// Manila local time for date columns.
function formatPosTimestamp(value) {
  if (!value) return '';
  const raw = String(value);
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return raw.slice(0, 16);
  return date.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function getPosOrdersPeriodRange(period) {
  const today = new Date();
  if (period === 'today') {
    return { from: formatPosOrdersDate(today), to: formatPosOrdersDate(today) };
  }
  if (period === 'yesterday') {
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    return { from: formatPosOrdersDate(yesterday), to: formatPosOrdersDate(yesterday) };
  }
  if (period === 'month') {
    return { from: formatPosOrdersDate(new Date(today.getFullYear(), today.getMonth(), 1)), to: formatPosOrdersDate(today) };
  }
  if (period === 'year') {
    return { from: formatPosOrdersDate(new Date(today.getFullYear(), 0, 1)), to: formatPosOrdersDate(today) };
  }
  return null;
}

async function refreshPosRawOrdersFromBackend() {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;

  const query = new URLSearchParams({ page: String(posRawPage), per_page: '50', _: String(Date.now()) });
  if (posOrdersSearch) query.set('search', posOrdersSearch);
  if (posOrdersProductFilter !== 'all') query.set('product', posOrdersProductFilter);
  if (posOrdersPageFilter !== 'all') query.set('source', posOrdersPageFilter);
  if (posOrdersStatusFilter !== 'all') query.set('status', posOrdersStatusFilter);
  if (posOrdersTagFilter !== 'all') query.set('tags', posOrdersTagFilter);
  if (posOrdersAttemptFilter !== 'all') query.set('attempts', posOrdersAttemptFilter);
  if (rmoTab !== 'orders') {
    // Undeliverable / Returning / On Delivery tabs: scope to that status and
    // filter by the last status-update date instead of the order's inserted date.
    if (rmoTab === 'undeliverable') query.set('partner', 'undeliverable');
    else if (rmoTab === 'returning') query.set('status', 'Returning');
    else if (rmoTab === 'delivering') query.set('tags', 'On delivery');
    if (rmoUpdatePeriod !== 'all') query.set('update_period', rmoUpdatePeriod);
    // Reason filter is only offered on the Undeliverable / Returning tabs.
    if ((rmoTab === 'undeliverable' || rmoTab === 'returning') && posOrdersReasonFilter !== 'all') {
      query.set('reason', posOrdersReasonFilter);
    }
  } else {
    if (posOrdersPeriod !== 'all') query.set('period', posOrdersPeriod);
    if (posOrdersPeriod === 'custom') {
      if (posOrdersDateFrom) query.set('date_from', posOrdersDateFrom);
      if (posOrdersDateTo) query.set('date_to', posOrdersDateTo);
    } else {
      const range = getPosOrdersPeriodRange(posOrdersPeriod);
      if (range) {
        query.set('date_from', range.from);
        query.set('date_to', range.to);
      }
    }
  }

  const result = await authorizedJsonRequest(`/orders/pos-orders?${query.toString()}`);
  DB.posRawOrders = Array.isArray(result?.data) ? result.data : [];
  DB.posRawTotal = Number(result?.total || 0);
  DB.posRawStatusCounts = Array.isArray(result?.status_counts) ? result.status_counts : [];
  DB.posRawPartnerCounts = result?.partner_counts || { undeliverable: 0, problematic: 0 };
  DB.posRawFilterOptions = {
    products: Array.isArray(result?.filter_options?.products) ? result.filter_options.products : [],
    pages: Array.isArray(result?.filter_options?.pages) ? result.filter_options.pages : [],
    tags: Array.isArray(result?.filter_options?.tags) ? result.filter_options.tags : [],
    reasons: Array.isArray(result?.filter_options?.reasons) ? result.filter_options.reasons : [],
  };
  return true;
}

// Load the dashboard users that the RMO assignee dropdown offers. Cached for the
// session; only refetched if the list is still empty.
async function loadAssignableUsers({ force = false } = {}) {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;
  if (!force && DB.assignableUsers.length) return true;
  const result = await authorizedJsonRequest(`/orders/assignable-users?_=${Date.now()}`);
  DB.assignableUsers = Array.isArray(result?.users) ? result.users : [];
  return true;
}

// Persist the assignee chosen from a row's dropdown, then reflect it locally so
// it survives the next table repaint without waiting for a full reload.
async function assignPosOrder(externalId, userId, shopId = '') {
  const id = userId === '' ? null : Number(userId);
  try {
    const result = await authorizedJsonRequest(`/orders/pos-orders/${encodeURIComponent(externalId)}/assignee`, {
      method: 'POST',
      body: JSON.stringify({ user_id: id, shop_id: shopId || null }),
    });
    const order = DB.posRawOrders.find((o) =>
      String(o.external_id) === String(externalId) && (!shopId || String(o.shop_id || '') === String(shopId))
    );
    if (order) {
      order.assigned_to_user_id = result?.assigned_to_user_id ?? null;
      order.assigned_to_name = result?.assigned_to_name ?? null;
    }
    showToast('success', 'Assignee updated', result?.assigned_to_name ? `Assigned to ${result.assigned_to_name}` : 'Unassigned');
  } catch (error) {
    showToast('error', 'Assign failed', error.message || 'Request failed');
    renderPosOrdersTable();
  }
}

// ─── BOTCAKE SEND (RMO Management) ─────────────────────────
// Lets RMO staff fire a Botcake "broadcast" flow to a customer (or several) over
// Messenger. Recipients are resolved server-side from the order's stored PSID.
let botcakeSend = { recipients: [], shopId: null };

// Read the currently checked row checkboxes into recipient objects.
function getRmoSelectedRows() {
  return [...document.querySelectorAll('.rmo-row-check:checked')].map((cb) => ({
    external_id: cb.dataset.id,
    shop_id: cb.dataset.shop || '',
    name: cb.dataset.name || '',
  }));
}

function updateRmoBulkBar() {
  const bar = document.getElementById('rmo-bulk-bar');
  const count = document.getElementById('rmo-bulk-count');
  if (!bar) return;
  const n = document.querySelectorAll('.rmo-row-check:checked').length;
  bar.style.display = n ? 'flex' : 'none';
  if (count) count.textContent = `${n} selected`;
  const all = document.getElementById('rmo-select-all');
  const boxes = document.querySelectorAll('.rmo-row-check');
  if (all) all.checked = boxes.length > 0 && n === boxes.length;
}

function onRmoRowCheck() { updateRmoBulkBar(); }

function toggleRmoSelectAll(master) {
  document.querySelectorAll('.rmo-row-check').forEach((cb) => { cb.checked = master.checked; });
  updateRmoBulkBar();
}

function clearRmoSelection() {
  document.querySelectorAll('.rmo-row-check:checked').forEach((cb) => { cb.checked = false; });
  updateRmoBulkBar();
}

// Open the send modal for one order ('single') or the current selection ('selected').
// A Botcake flow id is page-specific, so a send is scoped to one shop/page; if a
// multi-select spans pages we stop and ask the user to narrow it down.
async function openBotcakeSendModal(mode, externalId, shopId) {
  let recipients = mode === 'single'
    ? [{ external_id: externalId, shop_id: shopId || '', name: '' }]
    : getRmoSelectedRows();
  recipients = recipients.filter((r) => r.external_id);
  if (!recipients.length) { showToast('error', 'No recipients', 'Select at least one messageable customer.'); return; }

  const shops = [...new Set(recipients.map((r) => r.shop_id || ''))];
  if (shops.length > 1) {
    showToast('error', 'One page at a time', 'Selected orders span multiple pages. Filter to a single page, then send.');
    return;
  }

  botcakeSend = { recipients, shopId: shops[0] || '' };
  const recapEl = document.getElementById('botcake-send-recipients');
  if (recapEl) {
    const names = recipients.map((r) => r.name).filter(Boolean);
    recapEl.textContent = recipients.length === 1
      ? `Recipient: ${names[0] || recipients[0].external_id}`
      : `${recipients.length} recipients on this page`;
  }
  const resultEl = document.getElementById('botcake-send-result');
  if (resultEl) resultEl.innerHTML = '';
  const confirmBtn = document.getElementById('botcake-send-confirm');
  if (confirmBtn) confirmBtn.disabled = false;

  openModal('botcake-send-modal');
  await loadBotcakeFlows(botcakeSend.shopId);
}

async function loadBotcakeFlows(shopId) {
  const select = document.getElementById('botcake-flow-select');
  if (!select) return;
  select.innerHTML = '<option value="">Loading…</option>';
  try {
    const data = await authorizedJsonRequest(`/orders/pos-orders/botcake/flows?shop_id=${encodeURIComponent(shopId || '')}`);
    const flows = Array.isArray(data?.flows) ? data.flows : [];
    if (!flows.length) {
      select.innerHTML = data?.folder_found
        ? '<option value="">"UPDATE" folder is empty — add broadcasts to it in Botcake</option>'
        : '<option value="">No "UPDATE" folder found on this page</option>';
      return;
    }
    select.innerHTML = flows.map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join('');
  } catch (error) {
    select.innerHTML = '<option value="">Failed to load broadcasts</option>';
    showToast('error', 'Could not load broadcasts', error.message || 'Request failed');
  }
}

async function confirmBotcakeSend() {
  const select = document.getElementById('botcake-flow-select');
  const flowId = select ? select.value : '';
  if (!flowId) { showToast('error', 'Pick a broadcast', 'Choose which broadcast to send.'); return; }
  const confirmBtn = document.getElementById('botcake-send-confirm');
  const resultEl = document.getElementById('botcake-send-result');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Sending…'; }
  try {
    const data = await authorizedJsonRequest('/orders/pos-orders/botcake/send', {
      method: 'POST',
      body: JSON.stringify({
        shop_id: botcakeSend.shopId,
        flow_id: flowId,
        orders: botcakeSend.recipients.map((r) => ({ external_id: r.external_id })),
      }),
    });
    const sent = Number(data?.sent || 0);
    const failed = Number(data?.failed || 0);
    if (sent && !failed) {
      showToast('success', 'Broadcast sent', `Delivered to ${sent} recipient${sent === 1 ? '' : 's'}.`);
      closeModal('botcake-send-modal');
      clearRmoSelection();
    } else {
      if (sent) showToast('warning', 'Partly sent', `${sent} sent, ${failed} failed.`);
      else showToast('error', 'Send failed', 'No messages were delivered.');
      if (resultEl) {
        const fails = (data?.results || []).filter((r) => !r.ok);
        resultEl.innerHTML = `<div class="field-help" style="color:var(--danger,#ef4444)">${escapeHtml(
          fails.slice(0, 5).map((r) => `${r.name || r.ref}: ${r.error || 'failed'}`).join('; ')
        )}</div>`;
      }
    }
  } catch (error) {
    showToast('error', 'Send failed', error.message || 'Request failed');
  } finally {
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Send'; }
  }
}

// ─── POS ORDER TAG EDITOR (RMO Management) ─────────────────
// Edit a Pancake POS order's tags from the dashboard and push the change back
// to Pancake. Available tags are fetched per shop and cached.
let tagEditor = { externalId: null, shopId: null };
const shopTagsCache = {};

async function openTagEditor(externalId, shopId) {
  tagEditor = { externalId, shopId };
  const order = DB.posRawOrders.find((o) =>
    String(o.external_id) === String(externalId) && String(o.shop_id || '') === String(shopId));
  const current = Array.isArray(order?.tags)
    ? order.tags.map((t) => Number(t && typeof t === 'object' ? t.id : t)).filter(Number.isInteger)
    : [];
  const recap = document.getElementById('pos-tags-recap');
  if (recap) recap.textContent = order?.customer_name ? `Order for ${order.customer_name}` : `Order ${externalId}`;
  const list = document.getElementById('pos-tags-list');
  if (list) list.innerHTML = 'Loading…';
  openModal('pos-tags-modal');
  try {
    let tags = shopTagsCache[shopId];
    if (!tags) {
      const data = await authorizedJsonRequest(`/orders/pos-orders/tags?shop_id=${encodeURIComponent(shopId || '')}`);
      tags = Array.isArray(data?.tags) ? data.tags : [];
      shopTagsCache[shopId] = tags;
    }
    if (!tags.length) { list.innerHTML = '<div class="field-help">No tags configured for this page.</div>'; return; }
    const cur = new Set(current);
    list.innerHTML = tags.map((t) =>
      `<label class="pos-tag-opt"><input type="checkbox" value="${escapeHtml(t.id)}" ${cur.has(Number(t.id)) ? 'checked' : ''}>
        <span>${escapeHtml(t.name)}</span>${t.group ? `<span class="pos-tag-group">${escapeHtml(t.group)}</span>` : ''}</label>`
    ).join('');
  } catch (error) {
    if (list) list.innerHTML = `<div class="field-help" style="color:var(--danger,#ef4444)">Failed to load tags: ${escapeHtml(error.message)}</div>`;
  }
}

async function saveOrderTags() {
  const ids = [...document.querySelectorAll('#pos-tags-list input:checked')].map((cb) => Number(cb.value)).filter(Number.isInteger);
  const btn = document.getElementById('pos-tags-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const data = await authorizedJsonRequest(`/orders/pos-orders/${encodeURIComponent(tagEditor.externalId)}/tags`, {
      method: 'POST',
      body: JSON.stringify({ shop_id: tagEditor.shopId, tags: ids }),
    });
    const order = DB.posRawOrders.find((o) =>
      String(o.external_id) === String(tagEditor.externalId) && String(o.shop_id || '') === String(tagEditor.shopId));
    if (order) order.tags = Array.isArray(data?.tags) ? data.tags : [];
    showToast('success', 'Tags updated', `Saved ${(data?.tags || []).length} tag(s) to Pancake.`);
    closeModal('pos-tags-modal');
    renderPosOrdersTable();
  } catch (error) {
    showToast('error', 'Tag update failed', error.message || 'Request failed');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save tags'; }
  }
}

// ─── Customer notes (per-phone, append-only history) ──────────
let customerNotesPhone = '';

async function openCustomerNotesModal(btn) {
  customerNotesPhone = btn?.dataset?.phone || '';
  const name = btn?.dataset?.name || '';
  if (!customerNotesPhone) { showToast('warning', 'No phone', 'This order has no customer phone to attach notes to.'); return; }
  const recap = document.getElementById('customer-notes-recap');
  if (recap) recap.innerHTML = `Notes for <strong>${escapeHtml(name || 'customer')}</strong> · ${escapeHtml(customerNotesPhone)}`;
  const err = document.getElementById('customer-notes-error');
  if (err) err.textContent = '';
  const input = document.getElementById('customer-note-input');
  if (input) input.value = '';
  openModal('customer-notes-modal');
  await loadCustomerNotes();
}

async function loadCustomerNotes() {
  const thread = document.getElementById('customer-notes-thread');
  if (thread) thread.innerHTML = 'Loading…';
  try {
    const data = await authorizedJsonRequest(`/orders/customer-notes?phone=${encodeURIComponent(customerNotesPhone)}&_=${Date.now()}`);
    renderCustomerNotesThread(Array.isArray(data?.notes) ? data.notes : []);
  } catch (error) {
    if (thread) thread.innerHTML = `<div style="color:var(--danger);font-size:13px;">Failed to load notes: ${escapeHtml(error.message || 'Request failed')}</div>`;
  }
}

function renderCustomerNotesThread(notes) {
  const thread = document.getElementById('customer-notes-thread');
  if (!thread) return;
  if (!notes.length) {
    thread.innerHTML = '<div class="field-help">No notes yet. Add the first one below.</div>';
    return;
  }
  thread.innerHTML = notes.map((n) => `
    <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px;background:var(--surface-1);">
      <div style="font-size:13px;white-space:pre-wrap;color:var(--text-primary);">${escapeHtml(n.note || '')}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${escapeHtml(n.author_name || 'Unknown')} · ${escapeHtml(formatPosTimestamp(n.created_at))}</div>
    </div>`).join('');
}

async function addCustomerNote() {
  const input = document.getElementById('customer-note-input');
  const err = document.getElementById('customer-notes-error');
  const btn = document.getElementById('customer-note-add');
  const note = (input?.value || '').trim();
  if (err) err.textContent = '';
  if (!note) { if (err) err.textContent = 'Please type a note first.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  try {
    await authorizedJsonRequest('/orders/customer-notes', {
      method: 'POST',
      body: JSON.stringify({ phone: customerNotesPhone, note }),
    });
    if (input) input.value = '';
    await loadCustomerNotes();
  } catch (error) {
    if (err) err.textContent = error.message || 'Failed to add note.';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Add note'; }
  }
}

let posOrdersAutoRefreshTimer = null;
let posOrdersLastVersion = null;
// RMO Management is a live order-monitoring dashboard, so it polls every 45s.
// Other live pages keep the slower 180s cadence to trim background egress; the
// visibilitychange handler triggers an immediate check when the user returns,
// so the slower cadence has no UX cost on active tabs. The poll itself only
// fetches a lightweight version number — a full reload happens only when it
// actually changed.
const POS_ORDERS_AUTO_REFRESH_MS = 180 * 1000;
const POS_ORDERS_RMO_REFRESH_MS = 45 * 1000;
const POS_ORDERS_LIVE_PAGES = ['data-report', 'rts-rate', 'rmo-management', 'marketing-center'];

function getPosOrdersRefreshInterval() {
  return App.currentPage === 'rmo-management' ? POS_ORDERS_RMO_REFRESH_MS : POS_ORDERS_AUTO_REFRESH_MS;
}

async function checkAndRefreshPosOrders() {
  if (!App.user || !getAuthToken()) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  if (!POS_ORDERS_LIVE_PAGES.includes(App.currentPage)) return;
  const version = await fetchPosOrdersVersion();
  if (version === null) return;
  if (version === posOrdersLastVersion) return;
  refreshOrderViewsFromBackend().catch(() => {});
}

function scheduleNextPosOrdersRefresh() {
  posOrdersAutoRefreshTimer = setTimeout(async () => {
    try { await checkAndRefreshPosOrders(); } catch { /* ignore */ }
    scheduleNextPosOrdersRefresh();
  }, getPosOrdersRefreshInterval());
}

function startPosOrdersAutoRefresh() {
  if (posOrdersAutoRefreshTimer) return;
  scheduleNextPosOrdersRefresh();
}

function stopPosOrdersAutoRefresh() {
  if (posOrdersAutoRefreshTimer) {
    clearTimeout(posOrdersAutoRefreshTimer);
    posOrdersAutoRefreshTimer = null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkAndRefreshPosOrders();
  });
}

async function refreshOrderViewsFromBackend() {
  try {
    // Only re-download full sheet records when the current page actually renders them.
    // Home and data-report use lightweight stat/summary endpoints instead.
    const SHEET_RECORD_PAGES = ['data-report', 'rts-rate', 'marketing-center', 'csr', 'view-records', 'adspend-roas'];
    const needsRecords = SHEET_RECORD_PAGES.includes(App.currentPage);
    await Promise.all([
      refreshOrdersFromBackend(true),
      loadPosOrdersDashboard(),
      loadSheetRecordsStats(),
      needsRecords ? loadSheetRecordsForDataReport() : Promise.resolve(),
    ]);

    if (App.currentPage === 'data-report') {
      renderRTSRateDashboard();
      loadDataReportSummary().then(() => renderDataReportDashboard()).catch(() => {});
    }
    if (App.currentPage === 'rmo-management') {
      loadPage('rmo-management');
    }
    if (App.currentPage === 'rts-rate') {
      renderRTSRateDashboard();
    }
    if (App.currentPage === 'home') {
      loadPage('home');
    }
    if (App.currentPage === 'marketing-center') {
      loadPage('marketing-center');
    }
  } catch (error) {
    if (!App.user && /session expired/i.test(error.message || '')) return;
    showToast('warning', 'Orders refresh failed', error.message || 'Could not load synced orders.');
  }
}

async function refreshInventoryViewFromBackend() {
  try {
    const refreshed = await refreshInventoryFromBackend();
    if (refreshed && App.currentPage === 'inventory') navigateTo('inventory');
  } catch (error) {
    showToast('warning', 'Inventory refresh failed', error.message || 'Could not load inventory.');
  }
}

function persistLoggedInUser(user, token = '') {
  App.user = user;
  localStorage.setItem('ynt_user', JSON.stringify(user));
  if (token) localStorage.setItem('ynt_token', token);
}

function refreshCurrentUserChip() {
  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role');
  const initialsEl = document.getElementById('sidebar-user-initials');

  if (nameEl) nameEl.textContent = App.user?.name || '';
  if (roleEl) roleEl.textContent = formatRoleLabel(App.user?.role);
  if (initialsEl) {
    initialsEl.textContent = (App.user?.name || '')
      .split(' ')
      .filter(Boolean)
      .map((name) => name[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }
  refreshSidebarAccess();
  initNavSectionStates();
}

async function handleAuthSubmit(e) {
  e && e.preventDefault();
  await handleLogin();
}

async function handleLogin(e) {
  e && e.preventDefault();
  const username = document.getElementById('username')?.value.trim();
  const password = document.getElementById('password')?.value || '';

  if (!username || !password) {
    showToast('error', 'Login failed', 'Enter your username and password.');
    return;
  }

  if (document.getElementById('login-remember')?.checked) {
    localStorage.setItem('ynt_remember_user', username);
  } else {
    localStorage.removeItem('ynt_remember_user');
  }

  const apiBase = getAuthApiBase();
  if (apiBase) {
    try {
      const response = await fetch(`${apiBase}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const responseType = response.headers.get('content-type') || '';
      const data = responseType.includes('application/json')
        ? await response.json()
        : { error: await response.text() };
      if (!response.ok) throw new Error(data?.error || 'Invalid username or password');

      persistLoggedInUser(data.user, data.token);
      showToast('success', 'Welcome back!', `Logged in as ${data.user.name}`);
      init();
      return;
    } catch (error) {
      showToast('error', 'Login failed', error.message || 'Could not sign in.');
      return;
    }
  }

  const users = [
    { id: 1, username: 'admin', password: 'admin123', name: 'Admin User', role: 'Administrator' },
    { id: 2, username: 'trainee', password: 'trainee123', name: 'Trainee User', role: 'Trainee' },
  ];
  const match = users.find((user) => user.username === username && user.password === password);
  if (!match) {
    showToast('error', 'Login failed', 'Invalid username or password');
    return;
  }

  persistLoggedInUser(match);
  showToast('success', 'Welcome back!', `Logged in as ${match.name}`);
  init();
}

function handleLogout() {
  stopPosOrdersAutoRefresh();
  localStorage.removeItem('ynt_user');
  localStorage.removeItem('ynt_token');
  App.user = null;
  location.reload();
}

// ─── DUMMY DATA ────────────────────────────────────────────
const DB = {
  orders: [],
  orderStats: null,
  posOrders: [],
  posRawOrders: [],
  posRawTotal: 0,
  posRawStatusCounts: [],
  posRawFilterOptions: { products: [], pages: [], tags: [] },
  assignableUsers: [],
  sheetRecordsForReport: [],
  sheetRecordsStats: { total: 0, delivered: 0, totalCOD: 0 },
  csrRecords: [],
  csrPosOrders: {},
  csrAgentNames: [],
  inventory: [],
  rtsPcsByProduct: {},
  expenses: [],
  dailyPickups: [],
  scanRecords: [],
  damageReports: loadDamageReports(),
  trainings: loadTrainings(),
  marketingEntries: [],
  customers: [],
};

function generateOrders(n) {
  const statuses = ['New', 'Confirmed', 'Waiting for pickup', 'Shipped', 'Delivered', 'Returning', 'Returned', 'Canceled'];
  const products = ['DRAGON BLOOD SERUM', 'DRAGON BLOOD CREAM', 'GINSENG SERUM', 'HALLY LOTIONS', 'WHITE CREAM', 'NIACINAMIDE'];
  const names = ['Maria Santos', 'Juan dela Cruz', 'Ana Reyes', 'Carlo Mendoza', 'Liza Tan', 'Ben Aquino', 'Rosa Cruz', 'Mark Lim', 'Joy Castro', 'Ryan Ong'];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - Math.floor(Math.random() * 90));
    return {
      id: `ORD-${String(i + 1001).padStart(5, '0')}`,
      tracking: `${randomStr(2)}${Math.floor(10000000 + Math.random() * 90000000)}PH`,
      customer: names[i % names.length],
      phone: `09${Math.floor(100000000 + Math.random() * 900000000)}`,
      product: products[i % products.length],
      qty: Math.floor(1 + Math.random() * 5),
      cod: Math.floor(200 + Math.random() * 1800),
      status: statuses[Math.floor(Math.random() * statuses.length)],
      date: d.toISOString().split('T')[0],
      courier: ['J&T Express', 'Ninja Van', 'LBC', '2GO'][Math.floor(Math.random() * 4)],
      attempts: Math.floor(1 + Math.random() * 3),
    };
  });
}

function generateInventory() {
  return [
    { id: 'P001', name: 'DRAGON BLOOD SERUM', type: 'Product', sku: 'SKU-001', stock: 156, reorder: 200, unit: 'pcs', cost: 120, price: 599 },
    { id: 'P002', name: 'DRAGON BLOOD CREAM', type: 'Product', sku: 'SKU-002', stock: 230, reorder: 200, unit: 'pcs', cost: 95, price: 450 },
    { id: 'P003', name: 'GINSENG SERUM', type: 'Product', sku: 'SKU-003', stock: 88, reorder: 200, unit: 'pcs', cost: 75, price: 399 },
    { id: 'P004', name: 'HALLY LOTIONS', type: 'Product', sku: 'SKU-004', stock: 312, reorder: 200, unit: 'pcs', cost: 140, price: 699 },
    { id: 'P005', name: 'WHITE CREAM', type: 'Product', sku: 'SKU-005', stock: 45, reorder: 200, unit: 'pcs', cost: 60, price: 299 },
    { id: 'P006', name: 'NIACINAMIDE', type: 'Product', sku: 'SKU-006', stock: 120, reorder: 200, unit: 'pcs', cost: 70, price: 399 },
    { id: 'S001', name: 'Bubble Wrap Roll', type: 'Supply', sku: 'SUP-001', stock: 8, reorder: 15, unit: 'roll', cost: 180, price: null },
    { id: 'S002', name: 'Packing Box (S)', type: 'Supply', sku: 'SUP-002', stock: 25, reorder: 15, unit: 'pcs', cost: 12, price: null },
    { id: 'S003', name: 'Packing Box (M)', type: 'Supply', sku: 'SUP-003', stock: 6, reorder: 15, unit: 'pcs', cost: 18, price: null },
    { id: 'S004', name: 'Plastic Pouch', type: 'Supply', sku: 'SUP-004', stock: 120, reorder: 15, unit: 'pcs', cost: 3, price: null },
    { id: 'S005', name: 'Tape Roll', type: 'Supply', sku: 'SUP-005', stock: 4, reorder: 15, unit: 'roll', cost: 55, price: null },
    { id: 'S006', name: 'Airsoft Bubble', type: 'Supply', sku: 'SUP-006', stock: 18, reorder: 15, unit: 'bag', cost: 95, price: null },
    { id: 'S007', name: 'Thank You Card', type: 'Supply', sku: 'SUP-007', stock: 200, reorder: 15, unit: 'pcs', cost: 2, price: null },
  ];
}

function generateExpenses(n) {
  const cats = ['Load', 'Utility', 'Product Supplies', 'Others'];
  const items = ['PLDT Wi-Fi Bill', 'Tape Supply', 'Facebook Ads Load', 'Electricity Bill', 'Office Supplies', 'Printer Ink', 'Shipping Vouchers', 'Packaging Materials'];
  const names = ['Maria Santos', 'Juan dela Cruz', 'Admin'];
  return Array.from({ length: n }, (_, i) => {
    const qty = Math.floor(1 + Math.random() * 10);
    const price = Math.floor(50 + Math.random() * 1000);
    const d = new Date(); d.setDate(d.getDate() - Math.floor(Math.random() * 60));
    return {
      id: `EXP-${String(i + 1).padStart(4, '0')}`,
      date: d.toISOString().split('T')[0],
      category: cats[Math.floor(Math.random() * cats.length)],
      item: items[i % items.length],
      qty, price,
      total: qty * price,
      noted: names[i % names.length],
    };
  });
}

function generatePickups(n) {
  const products = ['DRAGON BLOOD SERUM', 'DRAGON BLOOD CREAM', 'GINSENG SERUM', 'HALLY LOTIONS', 'WHITE CREAM', 'NIACINAMIDE'];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i);
    const orders = Math.floor(1 + Math.random() * 4);
    const pieces = orders * Math.floor(1 + Math.random() * 3);
    return {
      id: `PU-${String(i + 1).padStart(4, '0')}`,
      date: d.toISOString().split('T')[0],
      product: products[i % products.length],
      type: i % 3 === 0 ? 'Supplies' : 'Product',
      customerOrders: orders,
      totalPieces: pieces,
      notes: i % 4 === 0 ? 'Rush delivery' : '',
    };
  });
}

function generateScanRecords(n) {
  const statuses = ['For Delivery', 'Delivered', 'Return to Sender', 'Failed Attempt', 'In Transit', 'Out for Delivery'];
  const couriers = ['J&T Express', 'Ninja Van', 'LBC', '2GO'];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - Math.floor(Math.random() * 30));
    return {
      id: `SCN-${String(i + 1).padStart(4, '0')}`,
      tracking: `${randomStr(2)}${Math.floor(10000000 + Math.random() * 90000000)}PH`,
      customer: ['Maria Santos', 'Juan dela Cruz', 'Ana Reyes', 'Carlo Mendoza'][i % 4],
      phone: `09${Math.floor(100000000 + Math.random() * 900000000)}`,
      date: d.toISOString().split('T')[0],
      status: statuses[Math.floor(Math.random() * statuses.length)],
      courier: couriers[i % couriers.length],
      type: i % 5 === 0 ? 'RTS' : 'Standard',
    };
  });
}

function generateCustomers(n) {
  const names = ['Maria Santos', 'Juan dela Cruz', 'Ana Reyes', 'Carlo Mendoza', 'Liza Tan', 'Ben Aquino', 'Rosa Cruz', 'Mark Lim', 'Joy Castro', 'Ryan Ong'];
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: names[i % names.length],
    phone: `09${Math.floor(100000000 + Math.random() * 900000000)}`,
    orders: Math.floor(1 + Math.random() * 20),
    totalSpent: Math.floor(500 + Math.random() * 15000),
  }));
}

function randomStr(n) {
  return Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]).join('');
}

function getDefaultMarketingState() {
  return {
    targets: { sales: 7000000, spend: 85000, roas: 3.8, rts: 17 },
    pages: [
      { name: 'DRAGON BLOOD SERUM', product: 'DRAGON SERUM', owner: 'Mark' },
      { name: 'DRAGON BLOOD CREAM', product: 'DRAGON CREAM', owner: 'Mark' },
      { name: 'NIACINAMIDE', product: 'NIACINAMIDE', owner: 'Andrew' },
      { name: 'HALLY LOTION', product: 'HALLY', owner: 'Andrew' },
      { name: 'GINSENG PH', product: 'GINSENG', owner: 'Andrew' },
      { name: 'SM CITY ONLINE', product: 'MIXED', owner: 'Janjoy' },
    ],
    team: [
      { name: 'Katrina', role: 'Team Leader / Funnel', primary: 'System and strategy' },
      { name: 'Janjoy', role: 'Lead Advertiser / Testing', primary: 'Product and test pipeline' },
      { name: 'Mark', role: 'Ads + Creatives + Funnel', primary: 'Dragon pages' },
      { name: 'Andrew', role: 'Ads + Image + Broadcast', primary: 'Niacinamide / Hally / Ginseng' },
      { name: 'Jem', role: 'Video Creative', primary: '4 videos/day' },
    ],
    entries: [],
    creatives: [],
    standups: [],
    adAccounts: [
      { status: 'RUNNING', bm: 'JAMES SMITH', acc: '1078442237058998', page: 'KOREAN DRAGON', product: 'DRAGON', advertiser: 'JJ', payment: '.. 7005' },
      { status: 'RUNNING', bm: 'PERSONAL MARK', acc: 'PERSONAL MARK', page: 'SM', product: 'HALLY', advertiser: 'KAT', payment: '.. 7005' },
    ],
  };
}

function getMarketingState() {
  try {
    const saved = JSON.parse(localStorage.getItem(MARKETING_STORAGE_KEY) || '{}');
    const fallback = getDefaultMarketingState();
    return {
      ...fallback,
      ...saved,
      targets: { ...fallback.targets, ...(saved.targets || {}) },
      pages: Array.isArray(saved.pages) && saved.pages.length ? saved.pages : fallback.pages,
      team: Array.isArray(saved.team) && saved.team.length ? saved.team : fallback.team,
      entries: Array.isArray(DB.marketingEntries) ? DB.marketingEntries : [],
      creatives: Array.isArray(saved.creatives) ? saved.creatives : [],
      standups: Array.isArray(saved.standups) ? saved.standups : [],
      adAccounts: Array.isArray(saved.adAccounts) ? saved.adAccounts : fallback.adAccounts,
    };
  } catch {
    return getDefaultMarketingState();
  }
}

function saveMarketingState(state) {
  // Marketing entries are persisted to the backend via /api/marketing/entries.
  // Only the non-entries portion of the state lives in localStorage.
  const { entries, ...persistable } = state || {};
  localStorage.setItem(MARKETING_STORAGE_KEY, JSON.stringify(persistable));
}

async function loadMarketingEntries() {
  try {
    const result = await authorizedJsonRequest('/marketing/entries');
    DB.marketingEntries = Array.isArray(result?.entries) ? result.entries : [];
    DB.marketingEntriesLoaded = true;
  } catch (error) {
    console.error('[marketing] load entries failed:', error);
    DB.marketingEntries = DB.marketingEntries || [];
  }
}

async function migrateLocalMarketingEntriesIfNeeded() {
  const MIGRATED_FLAG = 'ynt_marketing_entries_migrated';
  if (localStorage.getItem(MIGRATED_FLAG) === '1') return;
  if (!canManageMarketing()) return; // Only managers can POST; defer migration until one logs in.
  let localState = {};
  try { localState = JSON.parse(localStorage.getItem(MARKETING_STORAGE_KEY) || '{}'); } catch {}
  const localEntries = Array.isArray(localState.entries) ? localState.entries : [];
  if (!localEntries.length) {
    localStorage.setItem(MIGRATED_FLAG, '1');
    return;
  }
  for (const entry of localEntries) {
    try {
      await authorizedJsonRequest('/marketing/entries', {
        method: 'POST',
        body: JSON.stringify({
          date: entry.date || '',
          page: entry.page || '',
          product: entry.product || '',
          owner: entry.owner || '',
          spend: Number(entry.spend || 0),
          sales: Number(entry.sales || 0),
          orders: Number(entry.orders || 0),
          rts: Number(entry.rts || 0),
        }),
      });
    } catch (error) {
      console.error('[marketing] migration failed for entry:', entry, error);
    }
  }
  delete localState.entries;
  localStorage.setItem(MARKETING_STORAGE_KEY, JSON.stringify(localState));
  localStorage.setItem(MIGRATED_FLAG, '1');
  await loadMarketingEntries();
}

function marketingMonth(date = new Date()) {
  return normalizeDateString(date).slice(0, 7);
}

function getMarketingMonthEntries(state) {
  const month = marketingMonth();
  return state.entries.filter((entry) => String(entry.date || '').startsWith(month));
}

function getMemberPages(member) {
  if (Array.isArray(member?.pages) && member.pages.length) return member.pages.filter(Boolean);
  if (member?.page) return [member.page];
  return [];
}

function memberPageMatchesSheet(memberPages, sourceSheet) {
  if (!memberPages.length) return false;
  const sheet = String(sourceSheet || '').toLowerCase();
  if (!sheet) return false;
  return memberPages.some((p) => {
    const pl = String(p || '').toLowerCase();
    if (!pl) return false;
    return sheet === pl || sheet.includes(pl) || pl.includes(sheet);
  });
}

function aggregateMarketing(entries) {
  const totals = entries.reduce((acc, entry) => {
    acc.orders += Number(entry.orders || 0);
    acc.sales += Number(entry.sales || 0);
    acc.spend += Number(entry.spend || 0);
    acc.rts += Number(entry.rts || 0);
    acc.days.add(entry.date);
    return acc;
  }, { orders: 0, sales: 0, spend: 0, rts: 0, days: new Set() });

  return {
    ...totals,
    days: totals.days.size,
    roas: totals.spend ? totals.sales / totals.spend : 0,
    cpp: totals.orders ? totals.spend / totals.orders : 0,
    rtsRate: totals.orders ? totals.rts / totals.orders : 0,
  };
}

function aggregateMarketingByPage(entries) {
  const map = {};
  entries.forEach((entry) => {
    if (!map[entry.page]) map[entry.page] = { page: entry.page, orders: 0, sales: 0, spend: 0, rts: 0 };
    map[entry.page].orders += Number(entry.orders || 0);
    map[entry.page].sales += Number(entry.sales || 0);
    map[entry.page].spend += Number(entry.spend || 0);
    map[entry.page].rts += Number(entry.rts || 0);
  });

  return Object.values(map).map((row) => ({
    ...row,
    roas: row.spend ? row.sales / row.spend : 0,
    cpp: row.orders ? row.spend / row.orders : 0,
    rtsRate: row.orders ? row.rts / row.orders : 0,
  }));
}

function marketingMoney(value) {
  return `PHP ${Math.round(Number(value || 0)).toLocaleString()}`;
}

function marketingRoas(value) {
  return Number(value || 0).toFixed(2) + 'x';
}

function marketingPct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function marketingRoasClass(value) {
  if (value >= 4) return 'badge-success';
  if (value >= 3) return 'badge-warning';
  return 'badge-danger';
}

function marketingRoasPillClass(value) {
  if (value >= 4) return 'green';
  if (value >= 3) return 'yellow';
  return 'red';
}

function getMarketingDailyTotals(entries) {
  const map = {};
  entries.forEach((entry) => {
    const date = entry.date || 'No date';
    if (!map[date]) map[date] = { date, orders: 0, sales: 0, spend: 0, rts: 0 };
    map[date].orders += Number(entry.orders || 0);
    map[date].sales += Number(entry.sales || 0);
    map[date].spend += Number(entry.spend || 0);
    map[date].rts += Number(entry.rts || 0);
  });
  return Object.values(map)
    .map((row) => ({
      ...row,
      roas: row.spend ? row.sales / row.spend : 0,
      cpp: row.orders ? row.spend / row.orders : 0,
      rtsRate: row.orders ? row.rts / row.orders : 0,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function getCurrentCsrName() {
  if (App.user?.name) return App.user.name;
  if (App.user?.username) return App.user.username;
  return 'CSR Member';
}

// Page Name options come from the live chat pages in Google Orders; fall back to
// the static list until the synced records have loaded.
function getCSRPageOptions() {
  const fromOrders = Array.from(new Set(
    (DB.sheetRecordsForReport || [])
      .map((record) => String(record.sourceSheet || record.source_sheet || '').trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));
  return fromOrders.length ? fromOrders : CSR_PAGE_OPTIONS;
}

function generateCsrRecords() {
  const customerNames = ['Aira Santos', 'Paolo Reyes', 'Mica Dela Cruz', 'Jessa Lim', 'Carlo Ramos', 'Nina Flores', 'Janine Ong', 'Rodel Cruz'];
  const csrNames = ['Admin User', 'Trainee User', 'Mark Lim', 'Joy Castro'];

  return Array.from({ length: 36 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (index % 18));

    const salesType = CSR_SALES_TYPES[index % CSR_SALES_TYPES.length];
    const status = CSR_STATUS_OPTIONS[index % CSR_STATUS_OPTIONS.length];
    const price = 299 + (index % 6) * 150;

    return {
      id: `CSR-${String(index + 1).padStart(4, '0')}`,
      date: date.toISOString().split('T')[0],
      csrName: csrNames[index % csrNames.length],
      pageName: CSR_PAGE_OPTIONS[index % CSR_PAGE_OPTIONS.length],
      customerName: customerNames[index % customerNames.length],
      cellphoneNumber: `09${Math.floor(100000000 + Math.random() * 900000000)}`,
      salesType,
      status,
      price,
      trackingNumber: `${randomStr(2)}${Math.floor(10000000 + Math.random() * 90000000)}PH`,
    };
  });
}

let csrRecordsLoaded = false;

// CSR daily records live on the server so every authorized user sees the same
// data. Pull them into DB.csrRecords; the per-role visibility (own vs all) is
// enforced server-side, and the page still filters/sorts client-side.
async function loadCsrRecordsFromBackend({ force = false } = {}) {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;
  if (csrRecordsLoaded && !force) return true;
  try {
    const result = await authorizedJsonRequest('/csr');
    DB.csrRecords = Array.isArray(result?.data) ? result.data : [];
    csrRecordsLoaded = true;
    await migrateLocalCsrRecords();
    await loadCsrLinkedPosOrders();
    return true;
  } catch {
    return false;
  }
}

// Fetch live status + tracking from pos_orders for all order IDs referenced by
// the loaded CSR records. Stored in DB.csrPosOrders keyed by external_id.
async function loadCsrLinkedPosOrders() {
  const ids = [...new Set(DB.csrRecords.map((r) => String(r.orderId || '').trim()).filter(Boolean))];
  if (!ids.length) return;
  try {
    const result = await authorizedJsonRequest(`/orders/pos-orders/by-ids?ids=${encodeURIComponent(ids.join(','))}`);
    const map = {};
    (Array.isArray(result?.data) ? result.data : []).forEach((o) => { map[String(o.id)] = o; });
    DB.csrPosOrders = map;
  } catch {
    // non-fatal — live status falls back to stored value
  }
}

async function loadCsrAgentNames() {
  try {
    const result = await authorizedJsonRequest('/csr/agents');
    DB.csrAgentNames = Array.isArray(result?.names) ? result.names : [];
  } catch {
    DB.csrAgentNames = [];
  }
}

// One-time push of any CSR records that were stranded in this browser's
// localStorage (from before records were stored server-side) up to the server.
async function migrateLocalCsrRecords() {
  if (localStorage.getItem(CSR_MIGRATED_KEY) === '1') return;
  let local = [];
  try { local = JSON.parse(localStorage.getItem(CSR_STORAGE_KEY) || '[]'); } catch {}
  if (!Array.isArray(local) || !local.length) {
    localStorage.setItem(CSR_MIGRATED_KEY, '1');
    return;
  }
  try {
    await authorizedJsonRequest('/csr/import', {
      method: 'POST',
      body: JSON.stringify({ rows: local }),
    });
    localStorage.setItem(CSR_MIGRATED_KEY, '1');
    localStorage.removeItem(CSR_STORAGE_KEY);
    const result = await authorizedJsonRequest('/csr');
    DB.csrRecords = Array.isArray(result?.data) ? result.data : DB.csrRecords;
  } catch {
    // Leave the flag unset so the migration retries on the next load.
  }
}

function loadDamageReports() {
  try {
    const saved = JSON.parse(localStorage.getItem(DAMAGE_REPORT_STORAGE_KEY) || '[]');
    if (Array.isArray(saved)) return saved;
  } catch {}
  return [];
}

function saveDamageReports() {
  localStorage.setItem(DAMAGE_REPORT_STORAGE_KEY, JSON.stringify(DB.damageReports));
}

function loadTrainings() {
  try {
    const saved = JSON.parse(localStorage.getItem(TRAINING_STORAGE_KEY) || '[]');
    if (Array.isArray(saved)) return saved;
  } catch {}
  return [];
}

function saveTrainings() {
  localStorage.setItem(TRAINING_STORAGE_KEY, JSON.stringify(DB.trainings));
}

// Placeholder Training page. The training feature is scaffolded (storage,
// departments, categories) but its UI isn't built yet; this stub exists so the
// `training: renderTraining` entry in loadPage's renderFns map resolves —
// otherwise the object literal throws and EVERY page renders blank.
function renderTraining() {
  const trainings = Array.isArray(DB.trainings) ? DB.trainings : [];
  return `
    <div class="page-header">
      <h1 class="page-title">Training</h1>
      <p class="page-subtitle">Employee training records</p>
    </div>
    <div class="card" style="padding:48px;text-align:center;color:var(--text-muted);">
      <h3 style="margin-bottom:8px;">Training module coming soon</h3>
      <p>${trainings.length ? `${trainings.length} saved record(s).` : 'No training records yet.'}</p>
    </div>`;
}

function getDefaultIntegrationState() {
  return {
    pancakePos: {
      enabled: false,
      syncMode: 'pull_only',
      baseUrl: 'https://pos.pages.fm/api/v1',
      apiKey: '',
      shopName: '',
      shopId: '',
      pageId: '',
      owner: '',
      pancakeToken: '',
      botcakeToken: '',
      connections: [],
      notes: '',
      lastSavedAt: null,
      lastCollectedAt: null,
      lastCollectionSummary: '',
    },
    googleSheets: {
      enabled: false,
      syncMode: 'source_of_data',
      spreadsheetId: '',
      sheetName: '',
      serviceAccountEmail: '',
      privateKey: '',
      syncIntervalMinutes: '5',
      notes: '',
      lastSavedAt: null,
      lastCollectedAt: null,
      lastCollectionSummary: '',
    },
  };
}

function getIntegrationState() {
  const fallback = getDefaultIntegrationState();
  try {
    const saved = JSON.parse(localStorage.getItem(INTEGRATION_STORAGE_KEY) || '{}');
    return {
      ...fallback,
      pancakePos: {
        ...fallback.pancakePos,
        ...(saved.pancakePos || {}),
      },
      googleSheets: {
        ...fallback.googleSheets,
        ...(saved.googleSheets || {}),
      },
    };
  } catch {
    return fallback;
  }
}

function saveIntegrationState(nextState) {
  localStorage.setItem(INTEGRATION_STORAGE_KEY, JSON.stringify(nextState));
}

function mapBackendPosStatusToState(status = {}, previous = {}) {
  const previousConnections = Array.isArray(previous.connections) ? previous.connections : [];
  const backendConnections = Array.isArray(status.connections) ? status.connections : [];
  const connections = backendConnections.map((connection, index) => {
    const saved = previousConnections.find((item) => (
      (item.id && item.id === connection.id)
      || ((item.shopId || item.shop_id) && (item.shopId || item.shop_id) === connection.shop_id)
    )) || {};
    return {
      id: connection.id || saved.id || `pos-${index + 1}`,
      name: connection.name || saved.name || `POS ${index + 1}`,
      enabled: connection.enabled ?? saved.enabled ?? true,
      syncMode: connection.sync_mode || saved.syncMode || saved.sync_mode || status.sync_mode || 'pull_only',
      baseUrl: connection.base_url || saved.baseUrl || saved.base_url || status.base_url || 'https://pos.pages.fm/api/v1',
      apiKey: saved.apiKey || saved.api_key || '',
      hasApiKey: Boolean(connection.has_api_key || saved.hasApiKey || saved.has_api_key),
      shopId: connection.shop_id || saved.shopId || saved.shop_id || '',
      messagingPageId: connection.messaging_page_id || saved.messagingPageId || saved.messaging_page_id || '',
      pageAccessToken: saved.pageAccessToken || saved.page_access_token || '',
      hasPageToken: Boolean(connection.has_page_token || saved.hasPageToken || saved.has_page_token),
      owner: connection.owner || saved.owner || '',
      botcakeToken: saved.botcakeToken || saved.botcake_token || '',
      hasBotcakeToken: Boolean(connection.has_botcake_token || saved.hasBotcakeToken || saved.has_botcake_token),
      lastSyncedAt: connection.last_synced_at || saved.lastSyncedAt || saved.last_synced_at || null,
      notes: connection.notes || saved.notes || '',
    };
  });
  return {
    ...previous,
    enabled: Boolean(status.enabled),
    syncMode: status.sync_mode || previous.syncMode || 'pull_only',
    baseUrl: status.base_url || previous.baseUrl || 'https://pos.pages.fm/api/v1',
    apiKey: previous.apiKey || '',
    hasApiKey: Boolean(connections[0]?.hasApiKey || previous.hasApiKey),
    shopName: connections.find((connection) => connection.id === 'primary')?.name || previous.shopName || '',
    shopId: status.shop_id || previous.shopId || '',
    pageId: connections[0]?.messagingPageId || previous.pageId || '',
    pancakeToken: previous.pancakeToken || '',
    hasPageToken: Boolean(connections[0]?.hasPageToken || previous.hasPageToken),
    botcakeToken: previous.botcakeToken || '',
    hasBotcakeToken: Boolean(connections[0]?.hasBotcakeToken || previous.hasBotcakeToken),
    connections: connections.length ? connections : previousConnections,
    notes: status.notes ?? previous.notes ?? '',
    updatedAt: status.updated_at || previous.updatedAt || null,
    orderCount: Number(status.local_counts?.orders || previous.orderCount || 0),
    userCount: Number(status.local_counts?.users || previous.userCount || 0),
  };
}

function mapBackendGoogleStatusToState(status = {}, previous = {}) {
  return {
    ...previous,
    enabled: Boolean(status.enabled),
    syncMode: status.sync_mode || previous.syncMode || 'manual',
    spreadsheetId: status.spreadsheet_id || previous.spreadsheetId || '',
    sheetName: status.sheet_name ?? previous.sheetName ?? '',
    syncIntervalMinutes: status.sync_interval_ms
      ? String(Math.max(1, Math.round(Number(status.sync_interval_ms) / 60000)))
      : previous.syncIntervalMinutes || '5',
    notes: status.notes ?? previous.notes ?? '',
    updatedAt: status.updated_at || previous.updatedAt || null,
  };
}

async function hydrateIntegrationStateFromBackend() {
  if (!canManageAccounts()) return;
  integrationsBackendHydrated = true;

  try {
    const [posStatus, googleStatus] = await Promise.all([
      authorizedJsonRequest('/integrations/pancake-pos/status'),
      authorizedJsonRequest('/integrations/google-sheets/status'),
    ]);
    const current = getIntegrationState();
    const next = {
      ...current,
      pancakePos: mapBackendPosStatusToState(posStatus, current.pancakePos),
      googleSheets: mapBackendGoogleStatusToState(googleStatus, current.googleSheets),
    };
    saveIntegrationState(next);
    if (App.currentPage === 'api-connections') {
      // Update stat cards in-place instead of re-rendering the whole page
      const posCollectedEl = document.querySelector('#api-tab-pos')?.closest?.('.page-content')?.querySelector?.('.stat-card.green .stat-value, .stat-card.amber .stat-value');
      const googleCollectedAt = next.googleSheets.lastCollectedAt ? new Date(next.googleSheets.lastCollectedAt).toLocaleString() : 'No sheet sync yet';
      const posCollectedAt = next.pancakePos.lastCollectedAt ? new Date(next.pancakePos.lastCollectedAt).toLocaleString() : 'No POS sync yet';
      document.querySelectorAll('.stat-card').forEach((card) => {
        const label = card.querySelector('.stat-label')?.textContent?.trim();
        const val = card.querySelector('.stat-value');
        const meta = card.querySelector('.stat-meta');
        if (label === 'POS Orders SQL Sync' && val) { val.textContent = posCollectedAt; if (meta) meta.textContent = next.pancakePos.lastCollectionSummary || ''; }
        if (label === 'Google Sheets Sync' && val) { val.textContent = googleCollectedAt; if (meta) meta.textContent = next.googleSheets.lastCollectionSummary || ''; }
      });
    }
  } catch (error) {
    console.warn('[integrations] Could not load saved backend settings:', error.message || error);
  }

  loadGoogleSheetsTabsStatus().catch(() => {});
}

async function loadGoogleSheetsTabsStatus() {
  const host = document.getElementById('google-sheets-tabs-status');
  if (!host) return;
  host.innerHTML = '<div class="loading-spinner" style="margin:24px auto;"></div>';
  try {
    const data = await authorizedJsonRequest('/integrations/google-sheets/tabs-status');
    const tabs = Array.isArray(data?.tabs) ? data.tabs : [];
    if (!tabs.length) {
      host.innerHTML = '<div class="empty-state" style="padding:24px 0;"><p>No tabs synced yet. Click <strong>Sync Now</strong> after saving config.</p></div>';
      return;
    }
    const now = Date.now();
    const STALE_MS = 24 * 60 * 60 * 1000;
    const fmt = (s) => {
      if (!s) return '—';
      try { return new Date(s).toLocaleString(); } catch { return s; }
    };
    const badge = (tab) => {
      if (tab.missing) return '<span class="badge badge-danger">missing</span>';
      if (!tab.last_updated_at) return '<span class="badge badge-gray">no data</span>';
      const ageMs = now - new Date(tab.last_updated_at).getTime();
      if (ageMs > STALE_MS) return '<span class="badge badge-warning">stale</span>';
      return '<span class="badge badge-success">synced</span>';
    };
    const configuredHint = data.auto_discover
      ? '<span class="badge badge-info" style="margin-left:8px;">auto-discover all tabs</span>'
      : `<span class="badge badge-info" style="margin-left:8px;">${data.configured.length} configured</span>`;
    host.innerHTML = `
      <div style="margin-bottom:10px;font-size:12px;color:var(--text-muted);">
        Mode: ${data.auto_discover ? 'Auto (every visible tab in the spreadsheet)' : 'Manual list'}
        ${configuredHint}
      </div>
      <table class="data-table">
        <thead><tr>
          <th>Status</th><th>Tab Name</th><th>Rows</th><th>Delivered</th><th>Last Synced</th><th>Latest Day</th><th>Configured?</th>
        </tr></thead>
        <tbody>
          ${tabs.map((tab) => `<tr>
            <td>${badge(tab)}</td>
            <td><strong>${escapeHtml(tab.name)}</strong></td>
            <td>${Number(tab.rows || 0).toLocaleString()}</td>
            <td>${Number(tab.delivered || 0).toLocaleString()}</td>
            <td>${escapeHtml(fmt(tab.last_updated_at))}</td>
            <td>${escapeHtml((tab.last_day || '').slice(0, 10) || '—')}</td>
            <td>${tab.configured ? '<span class="badge badge-success">yes</span>' : '<span class="badge badge-gray">auto-discovered</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (error) {
    host.innerHTML = `<div class="alert alert-danger">Failed to load tab status: ${escapeHtml(error.message || error)}</div>`;
  }
}

function getPancakePosPublicApiBase() {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return `${location.origin}/api/public/integrations/pancake-pos`;
  }
  return 'http://localhost:3001/api/public/integrations/pancake-pos';
}

function getGoogleSheetsPublicApiBase() {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return `${location.origin}/api/public/integrations/google-sheets`;
  }
  return 'http://localhost:3001/api/public/integrations/google-sheets';
}

function getExpectedDashboardUrl() {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return location.origin;
  }
  return 'http://localhost:3001';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadCourierOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(COURIER_STORAGE_KEY) || '[]');
    if (Array.isArray(saved) && saved.length) return saved.filter(Boolean);
  } catch {}
  return [...DEFAULT_COURIER_OPTIONS];
}

function saveCourierOptions(options) {
  const unique = [...new Set(options.map((item) => String(item || '').trim()).filter(Boolean))].sort();
  localStorage.setItem(COURIER_STORAGE_KEY, JSON.stringify(unique));
  return unique;
}

function getCourierOptions() {
  return saveCourierOptions([...loadCourierOptions(), ...DB.orders.map((order) => order.courier)]);
}

function getSourceSheetOptions() {
  return [...new Set(DB.orders.map((order) => order.sourceSheet || 'Manual').filter(Boolean))].sort();
}

function getOrderYearOptions() {
  return [...new Set(DB.orders.map((order) => (order.date || '').slice(0, 4)).filter(Boolean))].sort((a, b) => b.localeCompare(a));
}

function getOrderMonthOptions(year = '') {
  const formatter = new Intl.DateTimeFormat('en-US', { month: 'long' });
  return [...new Set(DB.orders
    .filter((order) => !year || (order.date || '').startsWith(year))
    .map((order) => (order.date || '').slice(5, 7))
    .filter(Boolean))]
    .sort()
    .map((value) => ({ value, label: formatter.format(new Date(2024, Number(value) - 1, 1)) }));
}

function getOrderById(orderId) {
  return DB.orders.find((order) => String(order.dbId || order.id) === String(orderId));
}

// ─── RENDER: LOGIN ─────────────────────────────────────────
function renderLogin() {
  const rememberedUser = localStorage.getItem('ynt_remember_user') || '';
  const year = new Date().getFullYear();
  return `
  <div class="login-page" id="login-page">
    <div class="login-main">
      <div class="login-shell">
        <!-- LEFT: sign-in -->
        <div class="login-left">
          <div class="login-brand">
            <span class="login-brand-badge">
              <svg viewBox="0 0 24 24" fill="none"><path d="M3 17l5-6 4 4 5-7 4 5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
            <span class="login-brand-text">
              <span class="login-brand-name">YNT ERP</span>
              <span class="login-brand-sub">DIGITAL MARKETING</span>
            </span>
          </div>

          <div class="login-box">
            <h1 class="login-title">Welcome back</h1>
            <p class="login-desc">Sign in to continue to your YNT ERP dashboard.</p>

            <form onsubmit="handleAuthSubmit(event)">
              <div class="login-group">
                <label class="login-label" for="username">Username</label>
                <div class="login-input-wrap">
                  <span class="login-input-icon">
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M3 6l7 5 7-5"/></svg>
                  </span>
                  <input type="text" id="username" placeholder="Enter your username" autocomplete="username" value="${escapeHtml(rememberedUser)}">
                </div>
              </div>

              <div class="login-group">
                <label class="login-label" for="password">Password</label>
                <div class="login-input-wrap">
                  <span class="login-input-icon">
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="9" width="12" height="8" rx="2"/><path d="M6.5 9V6.5a3.5 3.5 0 117 0V9"/></svg>
                  </span>
                  <input type="password" id="password" placeholder="Enter your password" autocomplete="current-password">
                  <button type="button" class="login-eye" onclick="toggleLoginPassword(this)" aria-label="Show password">
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path class="eye-open" d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10z"/><circle class="eye-open" cx="10" cy="10" r="2.5"/><path class="eye-off" d="M3 3l14 14M8 8a2.5 2.5 0 003.5 3.5M5 6.5C3 8 1.5 10 1.5 10S4.5 15.5 10 15.5c1.3 0 2.5-.3 3.5-.8M9 4.6a8 8 0 011 0c5.5 0 8.5 5.4 8.5 5.4s-.7 1.3-2 2.6" style="display:none"/></svg>
                  </button>
                </div>
              </div>

              <div class="login-row">
                <label class="login-remember">
                  <input type="checkbox" id="login-remember" ${rememberedUser ? 'checked' : ''}>
                  <span>Remember me</span>
                </label>
                <a href="#" class="login-forgot" onclick="loginForgotPassword(event)">Forgot password?</a>
              </div>

              <button type="submit" class="login-signin">
                Sign In
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h11M11 6l4 4-4 4"/></svg>
              </button>
            </form>
          </div>

          <div class="login-secure">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2l6 2.5V10c0 4-2.7 6.5-6 8-3.3-1.5-6-4-6-8V4.5L10 2z"/><path d="M7.5 10l1.8 1.8L13 8.5"/></svg>
            Secure access to your business dashboard
          </div>
        </div>

        <!-- RIGHT: showcase -->
        <div class="login-right">
          <div class="login-preview">
            <div class="lp-head">
              <span class="lp-dot"></span><span class="lp-dot"></span><span class="lp-dot"></span>
              <span class="lp-head-title">Dashboard</span>
              <span class="lp-online">System Online</span>
            </div>
            <div class="lp-stats">
              <div class="lp-stat"><span class="lp-stat-ico blue"></span><b>1,248</b><i>Total Orders</i></div>
              <div class="lp-stat"><span class="lp-stat-ico violet"></span><b>1,082</b><i>Delivered</i></div>
              <div class="lp-stat"><span class="lp-stat-ico amber"></span><b>₱8,94,320</b><i>COD Revenue</i></div>
              <div class="lp-stat"><span class="lp-stat-ico rose"></span><b>28</b><i>Low Stock</i></div>
            </div>
            <div class="lp-charts">
              <div class="lp-card lp-area">
                <span class="lp-card-title">Order Status Overview</span>
                <svg viewBox="0 0 240 90" preserveAspectRatio="none" class="lp-spark">
                  <defs><linearGradient id="lpFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b6cff" stop-opacity="0.45"/><stop offset="100%" stop-color="#3b6cff" stop-opacity="0"/></linearGradient></defs>
                  <path d="M0 70 L34 60 L68 64 L102 44 L136 50 L170 30 L204 36 L240 18" fill="none" stroke="#5b8bff" stroke-width="2.5"/>
                  <path d="M0 70 L34 60 L68 64 L102 44 L136 50 L170 30 L204 36 L240 18 L240 90 L0 90 Z" fill="url(#lpFill)"/>
                </svg>
              </div>
              <div class="lp-card lp-donut">
                <span class="lp-card-title">RTS Percentage</span>
                <svg viewBox="0 0 80 80" class="lp-donut-svg">
                  <circle cx="40" cy="40" r="30" fill="none" stroke="#1e2a45" stroke-width="10"/>
                  <circle cx="40" cy="40" r="30" fill="none" stroke="#3b6cff" stroke-width="10" stroke-dasharray="14 174" stroke-dashoffset="0" stroke-linecap="round" transform="rotate(-90 40 40)"/>
                  <text x="40" y="44" text-anchor="middle" fill="#fff" font-size="14" font-weight="700">7.69%</text>
                </svg>
              </div>
            </div>
          </div>

          <div class="login-pitch">
            <h2>Built for clarity. Designed for growth.</h2>
            <p>Track performance, manage operations, and grow your business with real-time insights — all in one place.</p>
            <div class="login-features">
              <div class="login-feature">
                <span class="lf-icon"><svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="1.7"><path d="M3 15l4-5 3 3 4-6 3 4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                <span class="lf-text"><b>Real-time</b>Analytics</span>
              </div>
              <div class="login-feature">
                <span class="lf-icon"><svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="1.7"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 12v2M10 8v6M13 10v4" stroke-linecap="round"/></svg></span>
                <span class="lf-text"><b>Smart</b>Reporting</span>
              </div>
              <div class="login-feature">
                <span class="lf-icon"><svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="1.7"><path d="M10 2l6 2.5V10c0 4-2.7 6.5-6 8-3.3-1.5-6-4-6-8V4.5L10 2z"/></svg></span>
                <span class="lf-text"><b>Secure</b>&amp; Reliable</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <footer class="login-footer">
      <span>© ${year} YNT Digital Marketing. All rights reserved.</span>
      <span class="login-footer-links"><a href="#" onclick="event.preventDefault()">Privacy Policy</a><a href="#" onclick="event.preventDefault()">Terms of Service</a></span>
    </footer>
  </div>`;
}

function toggleLoginPassword(btn) {
  const input = document.getElementById('password');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.classList.toggle('is-visible', show);
  const open = btn.querySelectorAll('.eye-open');
  const off = btn.querySelectorAll('.eye-off');
  open.forEach((el) => { el.style.display = show ? 'none' : ''; });
  off.forEach((el) => { el.style.display = show ? '' : 'none'; });
}

function loginForgotPassword(e) {
  e && e.preventDefault();
  showToast('info', 'Password reset', 'Contact your administrator to reset your password.');
}

function renderApiConnections() {
  if (!canManageAccounts()) {
    return `
    <div class="empty-state">
      <h3>Administrator access required</h3>
      <p>API Connections are available only on admin accounts.</p>
    </div>`;
  }

  const state = getIntegrationState();
  const posSettings = state.pancakePos;
  const googleSettings = state.googleSheets;
  const posStatusTone = posSettings.enabled ? 'success' : 'warning';
  const posStatusText = posSettings.enabled ? 'Ready' : 'Setup Needed';
  const googleStatusTone = googleSettings.enabled ? 'success' : 'warning';
  const googleStatusText = googleSettings.enabled ? 'Ready' : 'Setup Needed';
  const posCollectedAt = posSettings.lastCollectedAt ? new Date(posSettings.lastCollectedAt).toLocaleString() : 'No POS sync yet';
  const googleSavedAt = googleSettings.lastSavedAt ? new Date(googleSettings.lastSavedAt).toLocaleString() : 'Not saved yet';
  const googleCollectedAt = googleSettings.lastCollectedAt ? new Date(googleSettings.lastCollectedAt).toLocaleString() : 'No sheet sync yet';

  return `
  <div class="page-header">
    <div class="page-title">
      <h1>API Connections</h1>
      <p>Sync Pancake POS orders and automate Google Sheets imports into the dashboard database.</p>
    </div>
  </div>

  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab(this,'api-tab-pos')">Pancake POS</button>
    <button class="tab-btn" onclick="switchTab(this,'api-tab-pos-users'); loadPosUsers()">POS Users</button>
    <button class="tab-btn" onclick="switchTab(this,'api-tab-sheets')">Google Sheets</button>
    <button class="tab-btn" onclick="switchTab(this,'api-tab-apikeys'); loadApiKeys()">API Keys</button>
    <button class="tab-btn" onclick="switchTab(this,'api-tab-webhooks'); loadWebhooks()">Webhooks</button>
    <button class="tab-btn" onclick="switchTab(this,'api-tab-sms'); loadSmsSettings()">InfoTXT SMS</button>
  </div>

  <div id="api-tab-pos" class="tab-content active">
    <div class="pages-view">
      <div class="pages-head">
        <div>
          <h2 class="pages-title">Pages</h2>
          <p class="pages-sub">Manage your shop pages and their connected stores</p>
        </div>
        <div class="pages-head-actions">
          <button class="btn int-add-page" type="button" onclick="openPosPageModal()">+ Add New Page</button>
          <div class="pages-used" id="pos-pages-used">0/15 PAGES USED</div>
        </div>
      </div>

      <div class="pages-toolbar">
        <div class="pages-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3 3"/></svg>
          <input type="text" id="pos-pages-search" placeholder="Search page name..." oninput="setPosPagesSearch(this.value)">
        </div>
        <div class="pages-ops">
          <button class="btn btn-secondary btn-sm" type="button" onclick="collectPancakePosData()">Sync POS Orders</button>
          <button class="btn btn-secondary btn-sm" type="button" onclick="syncPancakePageUsers()">Sync Staff Users</button>
        </div>
      </div>

      <div class="pages-table-wrap">
        <table class="pages-table">
          <thead>
            <tr>
              <th onclick="setPosPagesSort('name')">Name <span class="pp-sort">⇅</span></th>
              <th onclick="setPosPagesSort('shop')">Shop <span class="pp-sort">⇅</span></th>
              <th onclick="setPosPagesSort('owner')">Owner <span class="pp-sort">⇅</span></th>
              <th onclick="setPosPagesSort('enabled')">Status <span class="pp-sort">⇅</span></th>
              <th onclick="setPosPagesSort('lastSync')">Last Sync <span class="pp-sort">⇅</span></th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="pos-pages-body"></tbody>
        </table>
      </div>

      <div class="pages-foot">
        <div class="pages-rows">
          <span>ROWS</span>
          <select id="pos-pages-perpage" onchange="setPosPagesPerPage(this.value)">
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
          </select>
        </div>
        <div class="pages-info" id="pos-pages-info"></div>
        <div class="pages-pager">
          <button class="page-btn" id="pos-pg-first" onclick="gotoPosPage('first')">«</button>
          <button class="page-btn" id="pos-pg-prev" onclick="gotoPosPage('prev')">‹ Prev</button>
          <button class="page-btn active" id="pos-pg-cur">1</button>
          <button class="page-btn" id="pos-pg-next" onclick="gotoPosPage('next')">Next ›</button>
          <button class="page-btn" id="pos-pg-last" onclick="gotoPosPage('last')">»</button>
        </div>
      </div>
    </div>

    <div class="modal-overlay" id="pos-page-modal">
      <div class="modal modal-lg">
        <div class="modal-header">
          <div class="modal-title" id="pos-page-modal-title">Add New Page</div>
          <button class="modal-close" onclick="closeModal('pos-page-modal')">×</button>
        </div>
        <div class="modal-body">
        <a class="int-tutorial" href="#" onclick="event.preventDefault();showToast('info','Setup tutorial','Fill Page ID, Shop ID, the POS token, then Get POS Shops and Save.');">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3.5h4.5A1.5 1.5 0 018 5v8a1.5 1.5 0 00-1.5-1.5H2zM14 3.5H9.5A1.5 1.5 0 008 5v8a1.5 1.5 0 011.5-1.5H14z"/></svg>
          Watch the setup tutorial
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h7v7M13 3L6.5 9.5M11 9.5V13H3V5h3.5"/></svg>
        </a>
        <div class="int-panel">
          <div class="int-section-label">Basic Info</div>
          <div class="form-grid two-col">
            <div class="form-group">
              <label class="form-label req">Page ID</label>
              <input type="text" class="form-control mono-input" id="pancake-pos-page-id" placeholder="e.g. 123456" value="${escapeHtml(posSettings.pageId || '')}">
            </div>
            <div class="form-group">
              <label class="form-label req">Shop ID</label>
              <input type="text" class="form-control mono-input" id="pancake-pos-shop-id" placeholder="e.g. 789" value="${escapeHtml(posSettings.shopId || '')}">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label req">Page Name</label>
            <input type="text" class="form-control" id="pancake-pos-shop-name" placeholder="e.g. My Store Page" autocomplete="off" value="${escapeHtml(posSettings.shopName || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Owner</label>
            <select class="form-control" id="pancake-pos-owner" data-selected="${escapeHtml(posSettings.owner || '')}">
              <option value="">Select owner…</option>
              ${posSettings.owner ? `<option value="${escapeHtml(posSettings.owner)}" selected>${escapeHtml(posSettings.owner)}</option>` : ''}
            </select>
          </div>
          <div class="int-status-box">
            <div>
              <div class="int-section-label" style="margin:0 0 3px;">Status</div>
              <div class="int-status-copy">Page is active and visible</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="pancake-pos-enabled" ${posSettings.enabled ? 'checked' : ''}>
              <span class="switch-slider"></span>
            </label>
          </div>
        </div>

        <div class="int-panel">
          <div class="int-section-label">Integration Tokens</div>
          <div class="form-group">
            <label class="form-label req">POS Token</label>
            <input type="text" class="form-control mono-input" id="pancake-pos-api-key" placeholder="${posSettings.hasApiKey ? 'Saved POS token - leave blank to keep it' : 'Enter POS token'}" value="${escapeHtml(posSettings.apiKey || '')}">
            <button class="btn int-validate" type="button" onclick="validatePosToken()">Validate</button>
          </div>
          <div class="form-group">
            <label class="form-label">Pancake Token</label>
            <input type="text" class="form-control mono-input" id="pancake-pos-pancake-token" placeholder="${posSettings.hasPageToken ? 'Saved Pancake token - leave blank to keep it' : 'Enter Pancake token'}" value="${escapeHtml(posSettings.pancakeToken || '')}">
            <button class="btn int-validate" type="button" onclick="validateIntegrationToken('pancake')">Validate</button>
          </div>
          <div class="form-group">
            <label class="form-label">Botcake Token</label>
            <input type="text" class="form-control mono-input" id="pancake-pos-botcake-token" placeholder="${posSettings.hasBotcakeToken ? 'Saved Botcake token - leave blank to keep it' : 'Enter Botcake token'}" value="${escapeHtml(posSettings.botcakeToken || '')}">
            <button class="btn int-validate" type="button" onclick="validateIntegrationToken('botcake')">Validate</button>
          </div>
        </div>

        <details class="int-advanced">
          <summary>Advanced settings</summary>
          <div class="int-panel" style="margin-top:14px;">
            <div class="form-grid two-col">
              <div class="form-group">
                <label class="form-label">POS Base URL</label>
                <input type="text" class="form-control mono-input" id="pancake-pos-base-url" placeholder="https://pos.pages.fm/api/v1" value="${escapeHtml(posSettings.baseUrl)}">
                <div class="field-help">Default: <code>https://pos.pages.fm/api/v1</code>.</div>
              </div>
              <div class="form-group">
                <label class="form-label">Sync Mode</label>
                <select class="form-control" id="pancake-pos-sync-mode">
                  <option value="pull_only" ${posSettings.syncMode === 'pull_only' ? 'selected' : ''}>Pull API to SQL</option>
                  <option value="automatic" ${posSettings.syncMode === 'automatic' ? 'selected' : ''}>Automatic every few minutes</option>
                  <option value="manual_backup" ${posSettings.syncMode === 'manual_backup' ? 'selected' : ''}>Manual backup only</option>
                </select>
                <div class="field-help">Automatic mode pulls POS orders into SQL and dashboard orders on the server interval.</div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Internal Notes</label>
              <textarea class="form-control" id="pancake-pos-notes" rows="3" placeholder="Example: Main Pancake POS shop.">${escapeHtml(posSettings.notes)}</textarea>
            </div>
          </div>
        </details>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" type="button" onclick="fetchShopsForModal()">Get POS Shops</button>
          <button class="btn btn-primary" type="button" onclick="savePosPageFromModal()">Save Page</button>
        </div>
      </div>
    </div>

  </div>

  <div id="api-tab-pos-users" class="tab-content">
    <section class="card integration-card">
      <div class="card-header">
        <div>
          <div class="card-title">POS Users</div>
          <div class="card-subtitle">Users collected from Pancake POS user, staff, or employee endpoints.</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="collectPancakePosUsers()">Sync Users</button>
      </div>
      <div class="card-body">
        <div class="table-toolbar">
          <div class="table-search">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
            <input type="text" id="pos-users-search" placeholder="Search POS users..." value="${escapeHtml(posUsersState.search)}" onkeydown="if(event.key==='Enter') searchPosUsers()">
          </div>
          <button class="btn btn-secondary btn-sm" onclick="searchPosUsers()">Search</button>
          <button class="btn btn-secondary btn-sm" onclick="loadPosUsers()">Refresh</button>
        </div>
        <div class="table-container">
          <table>
            <thead><tr>
              <th>Name</th><th>Username</th><th>Role</th><th>Shop ID</th><th>Email</th><th>Phone</th><th>Status</th>
            </tr></thead>
            <tbody id="pos-users-tbody">
              <tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted)">Loading POS users...</td></tr>
            </tbody>
          </table>
        </div>
        <div class="table-pagination" id="pos-users-pagination"></div>
      </div>
    </section>
  </div>

  <div id="api-tab-sheets" class="tab-content">
    <section class="card integration-card">
      <div class="card-header">
        <div>
          <div class="card-title">Google Sheets Auto Import</div>
          <div class="card-subtitle">Pull rows from an Orders sheet and upsert them into the dashboard SQL database.</div>
        </div>
      </div>
      <div class="card-body integration-body">
        <div class="integration-toggle">
          <div>
            <div class="integration-toggle-title">Enable Google Sheets sync</div>
            <div class="integration-toggle-copy">Turn this on after the service account has access to the spreadsheet.</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="google-sheets-enabled" ${googleSettings.enabled ? 'checked' : ''}>
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="form-grid two-col">
          <div class="form-group">
            <label class="form-label">Spreadsheet ID</label>
            <input type="text" class="form-control mono-input" id="google-sheets-spreadsheet-id" placeholder="Google Sheets spreadsheet ID" value="${escapeHtml(googleSettings.spreadsheetId)}">
            <div class="field-help">Use the ID from the sheet URL between <code>/d/</code> and <code>/edit</code>.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Sheet Name(s)</label>
            <input type="text" class="form-control mono-input" id="google-sheets-sheet-name" placeholder="* (auto-sync all tabs)  or  Orders, Team A, Team B" value="${escapeHtml(googleSettings.sheetName)}">
            <div class="field-help">Leave blank or enter <code>*</code> to auto-sync every visible tab. Otherwise list tab names separated by commas. New tabs appear automatically in auto mode.</div>
          </div>
        </div>

        <div class="form-grid two-col">
          <div class="form-group">
            <label class="form-label">Service Account Email</label>
            <input type="text" class="form-control mono-input" id="google-sheets-service-account-email" placeholder="service-account@project.iam.gserviceaccount.com" value="${escapeHtml(googleSettings.serviceAccountEmail)}">
            <div class="field-help">Share the spreadsheet with this email address.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Sync Mode</label>
            <select class="form-control" id="google-sheets-sync-mode">
              <option value="source_of_data" ${googleSettings.syncMode === 'source_of_data' ? 'selected' : ''}>Source of data</option>
              <option value="automatic" ${googleSettings.syncMode === 'automatic' ? 'selected' : ''}>Automatic every few minutes</option>
              <option value="manual" ${googleSettings.syncMode === 'manual' ? 'selected' : ''}>Manual only</option>
            </select>
            <div class="field-help">Source mode refreshes SQL from Google Sheets before dashboard order data loads.</div>
          </div>
        </div>

        <div class="form-grid two-col">
          <div class="form-group">
            <label class="form-label">Private Key</label>
            <textarea class="form-control mono-input" id="google-sheets-private-key" rows="6" placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----">${escapeHtml(googleSettings.privateKey)}</textarea>
            <div class="field-help">Paste the full private key from the Google service account JSON.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Sync Interval Minutes</label>
            <input type="number" min="1" class="form-control" id="google-sheets-sync-interval-minutes" value="${escapeHtml(googleSettings.syncIntervalMinutes)}">
            <div class="field-help">Backend auto-sync delay. Changes apply without code edits.</div>
            <label class="form-label" style="margin-top:18px;">Internal Notes</label>
            <textarea class="form-control" id="google-sheets-notes" rows="4" placeholder="Example: Orders tab owned by Sales Ops.">${escapeHtml(googleSettings.notes)}</textarea>
            <div class="field-help">Last saved: ${escapeHtml(googleSavedAt)}</div>
          </div>
        </div>

        <div class="integration-actions">
          <button class="btn btn-primary" type="button" onclick="saveGoogleSheetsConnection()">Save Google Sheets</button>
          <button class="btn btn-secondary" type="button" onclick="collectGoogleSheetsData()">Sync Now</button>
        </div>
      </div>
    </section>

    <section class="card integration-card" style="margin-top:16px;">
      <div class="card-header">
        <div>
          <div class="card-title">Connected Sheet Tabs</div>
          <div class="card-subtitle">One row per tab in <code>google_orders</code>. Every sync run iterates every configured tab — no partial / incremental — so adding a new tab does a full pass next sync.</div>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" onclick="loadGoogleSheetsTabsStatus()">Refresh</button>
      </div>
      <div class="card-body">
        <div id="google-sheets-tabs-status">
          <div class="loading-spinner" style="margin:24px auto;"></div>
        </div>
      </div>
    </section>
  </div>

  <div id="api-tab-apikeys" class="tab-content">
    <section class="card integration-card">
      <div class="card-header">
        <div>
          <div class="card-title">API Keys</div>
          <div class="card-subtitle">Create persistent API keys so external apps can connect without user credentials. Use <code>Authorization: ApiKey &lt;key&gt;</code> or <code>X-API-Key: &lt;key&gt;</code> header.</div>
        </div>
        <button class="btn btn-primary" onclick="showCreateApiKeyForm()">+ New API Key</button>
      </div>
      <div class="card-body">
        <div id="api-key-form" style="display:none; margin-bottom:20px; padding:16px; background:var(--bg-secondary); border-radius:8px;">
          <div style="margin-bottom:12px; font-weight:600;">Create New API Key</div>
          <div class="form-row">
            <div class="form-group" style="flex:2">
              <label class="form-label">Key Name</label>
              <input class="form-control" id="new-api-key-name" placeholder="e.g. Zapier Integration" />
            </div>
            <div class="form-group" style="flex:3">
              <label class="form-label">Scopes (select all that apply)</label>
              <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:4px;">
                ${['orders:read','orders:write','inventory:read','inventory:write','expenses:read','expenses:write','hr:read'].map(s => `<label style="display:flex;align-items:center;gap:4px;font-size:13px;"><input type="checkbox" class="api-key-scope" value="${s}" ${s === 'orders:read' ? 'checked' : ''}/>${s}</label>`).join('')}
              </div>
            </div>
          </div>
          <div style="display:flex; gap:8px; margin-top:12px;">
            <button class="btn btn-primary" onclick="createApiKey()">Generate Key</button>
            <button class="btn btn-secondary" onclick="document.getElementById('api-key-form').style.display='none'">Cancel</button>
          </div>
        </div>
        <div id="api-key-result" style="display:none; margin-bottom:20px; padding:16px; background:#1a3a1a; border:1px solid #2d6a2d; border-radius:8px;">
          <div style="font-weight:600; color:#4caf50; margin-bottom:8px;">API Key Created — copy it now, it won't be shown again</div>
          <code id="api-key-result-value" style="word-break:break-all; font-size:13px; color:#e8f5e9;"></code>
          <button class="btn btn-secondary" style="margin-top:10px;" onclick="copyApiKeyResult()">Copy Key</button>
        </div>
        <div id="api-keys-list"><div class="loading-spinner"></div></div>
      </div>
    </section>
    <section class="card" style="margin-top:16px;">
      <div class="card-header"><div><div class="card-title">Quick Reference</div></div></div>
      <div class="card-body">
        <div style="font-size:13px; line-height:1.8;">
          <div><strong>Authenticate with API key:</strong></div>
          <code style="display:block; background:var(--bg-secondary); padding:8px 12px; border-radius:6px; margin:6px 0;">curl https://your-domain.com/api/orders -H "Authorization: ApiKey yntk_..."</code>
          <div style="margin-top:10px;"><strong>Or with X-API-Key header:</strong></div>
          <code style="display:block; background:var(--bg-secondary); padding:8px 12px; border-radius:6px; margin:6px 0;">curl https://your-domain.com/api/orders -H "X-API-Key: yntk_..."</code>
          <div style="margin-top:10px;"><strong>API discovery:</strong></div>
          <code style="display:block; background:var(--bg-secondary); padding:8px 12px; border-radius:6px; margin:6px 0;">curl https://your-domain.com/api</code>
        </div>
      </div>
    </section>
  </div>

  <div id="api-tab-webhooks" class="tab-content">
    <section class="card integration-card">
      <div class="card-header">
        <div>
          <div class="card-title">Outbound Webhooks</div>
          <div class="card-subtitle">Push real-time events to your external apps when orders or inventory change. Payloads are signed with HMAC-SHA256 via the <code>X-YNT-Signature</code> header.</div>
        </div>
        <button class="btn btn-primary" onclick="showCreateWebhookForm()">+ New Webhook</button>
      </div>
      <div class="card-body">
        <div id="webhook-form" style="display:none; margin-bottom:20px; padding:16px; background:var(--bg-secondary); border-radius:8px;">
          <div style="margin-bottom:12px; font-weight:600;">Create New Webhook</div>
          <div class="form-row">
            <div class="form-group" style="flex:2">
              <label class="form-label">Name</label>
              <input class="form-control" id="new-webhook-name" placeholder="e.g. Zapier Order Hook" />
            </div>
            <div class="form-group" style="flex:3">
              <label class="form-label">URL</label>
              <input class="form-control" id="new-webhook-url" placeholder="https://hooks.zapier.com/..." />
            </div>
          </div>
          <div style="margin-top:12px;">
            <label class="form-label">Events (select all that apply)</label>
            <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:4px;">
              ${['order.created','order.updated','order.deleted','inventory.updated','*'].map(e => `<label style="display:flex;align-items:center;gap:4px;font-size:13px;"><input type="checkbox" class="webhook-event" value="${e}" ${e === 'order.created' ? 'checked' : ''}/>${e === '*' ? '* (all events)' : e}</label>`).join('')}
            </div>
          </div>
          <div style="display:flex; gap:8px; margin-top:12px;">
            <button class="btn btn-primary" onclick="createWebhook()">Create Webhook</button>
            <button class="btn btn-secondary" onclick="document.getElementById('webhook-form').style.display='none'">Cancel</button>
          </div>
        </div>
        <div id="webhook-secret-result" style="display:none; margin-bottom:20px; padding:16px; background:#1a2a3a; border:1px solid #2d5a8a; border-radius:8px;">
          <div style="font-weight:600; color:#64b5f6; margin-bottom:8px;">Webhook Created — save the signing secret now</div>
          <div style="font-size:13px; color:#bbdefb; margin-bottom:6px;">Use this secret to verify <code>X-YNT-Signature</code> on incoming payloads:</div>
          <code id="webhook-secret-value" style="word-break:break-all; font-size:13px; color:#e3f2fd;"></code>
          <button class="btn btn-secondary" style="margin-top:10px;" onclick="copyWebhookSecret()">Copy Secret</button>
        </div>
        <div id="webhooks-list"><div class="loading-spinner"></div></div>
      </div>
    </section>
    <section class="card" style="margin-top:16px;">
      <div class="card-header"><div><div class="card-title">Verifying Signatures</div></div></div>
      <div class="card-body">
        <div style="font-size:13px; line-height:1.8;">
          <div>Every request includes an <code>X-YNT-Signature</code> header. Verify it by computing <code>HMAC-SHA256(secret, raw_body)</code> and comparing with <code>sha256=&lt;hex&gt;</code>.</div>
          <code style="display:block; background:var(--bg-secondary); padding:8px 12px; border-radius:6px; margin:10px 0; white-space:pre-wrap;">// Node.js example
const crypto = require('crypto');
const sig = 'sha256=' + crypto
  .createHmac('sha256', YOUR_SECRET)
  .update(rawBody)
  .digest('hex');
if (sig !== req.headers['x-ynt-signature']) throw new Error('Invalid');</code>
        </div>
      </div>
    </section>
  </div>

  <div id="api-tab-sms" class="tab-content">
    <section class="card integration-card">
      <div class="card-header">
        <div>
          <div class="card-title">InfoTXT SMS</div>
          <div class="card-subtitle">Text the customer automatically when a POS order gains one of the tags below. Each tag has its own message and Active/Off switch.</div>
        </div>
        <span class="badge" id="sms-status-badge">—</span>
      </div>
      <div class="card-body">
        <div class="int-panel">
          <div class="int-section-label">Gateway connection</div>
          <div class="form-grid two-col">
            <div class="form-group">
              <label class="form-label req">UserID</label>
              <input type="text" class="form-control mono-input" id="sms-userid" placeholder="Your Infotxt Cloud UserID (e.g. 2)">
            </div>
            <div class="form-group">
              <label class="form-label">SIM slot (optional)</label>
              <input type="text" class="form-control mono-input" id="sms-sim" placeholder="Leave blank for default">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label req">API Key</label>
            <input type="text" class="form-control mono-input" id="sms-api-key" placeholder="Enter InfoTXT API Key">
          </div>
          <div class="form-group">
            <label class="form-label">Send-SMS Endpoint URL</label>
            <input type="text" class="form-control mono-input" id="sms-endpoint" placeholder="https://api.myinfotxt.com/v2/send.php">
            <div class="field-help">Default: <code>https://api.myinfotxt.com/v2/send.php</code> — leave as-is unless InfoTXT tells you otherwise.</div>
          </div>
          <div class="int-status-box">
            <div>
              <div class="int-section-label" style="margin:0 0 3px;">SMS Automation</div>
              <div class="int-status-copy">Master switch — when off, no texts are sent</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="sms-enabled">
              <span class="switch-slider"></span>
            </label>
          </div>
          <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
            <button class="btn btn-primary" type="button" onclick="saveSmsConfig()">Save Connection</button>
            <button class="btn btn-secondary" type="button" onclick="openSmsTest()">Send Test SMS</button>
          </div>
        </div>

        <div class="int-panel" style="margin-top:16px;">
          <div class="card-header" style="padding:0 0 12px;">
            <div>
              <div class="int-section-label" style="margin:0;">Tag → Message Rules</div>
              <div class="int-status-copy">Sent once per order per tag. Placeholders: {name} {phone} {order_ref} {cod} {product} {rider} {rider_number} {tag}</div>
            </div>
            <button class="btn int-add-page" type="button" onclick="openSmsRuleModal()">+ Add Tag Rule</button>
          </div>
          <div class="pages-table-wrap">
            <table class="pages-table">
              <thead>
                <tr><th>Tag</th><th>Message</th><th>Send</th><th>Action</th></tr>
              </thead>
              <tbody id="sms-rules-body"><tr><td colspan="4" class="pp-empty">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <div class="modal-overlay" id="sms-rule-modal">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title" id="sms-rule-modal-title">Add Tag Rule</div>
          <button class="modal-close" onclick="closeModal('sms-rule-modal')">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label req">Tag</label>
            <input type="text" class="form-control" id="sms-rule-tag" placeholder="e.g. Picked up">
            <div class="field-help">Matched against the order's tags (case-insensitive, substring).</div>
          </div>
          <div class="form-group">
            <label class="form-label req">Message</label>
            <textarea class="form-control" id="sms-rule-message" rows="4" placeholder="Hi {name}, your order {order_ref} has been picked up and is on the way!"></textarea>
          </div>
          <div class="int-status-box">
            <div><div class="int-status-copy">Active — send for this tag</div></div>
            <label class="switch">
              <input type="checkbox" id="sms-rule-enabled" checked>
              <span class="switch-slider"></span>
            </label>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" type="button" onclick="closeModal('sms-rule-modal')">Cancel</button>
          <button class="btn btn-primary" type="button" onclick="saveSmsRuleFromModal()">Save Rule</button>
        </div>
      </div>
    </div>

    <div class="modal-overlay" id="sms-test-modal">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">Send Test SMS</div>
          <button class="modal-close" onclick="closeModal('sms-test-modal')">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label req">Mobile Number</label>
            <input type="text" class="form-control mono-input" id="sms-test-number" placeholder="09171234567">
          </div>
          <div class="form-group">
            <label class="form-label">Message</label>
            <textarea class="form-control" id="sms-test-message" rows="3">InfoTXT test message from YNT Dashboard.</textarea>
          </div>
          <div id="sms-test-result" style="font-size:13px;"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" type="button" onclick="closeModal('sms-test-modal')">Close</button>
          <button class="btn btn-primary" type="button" onclick="sendSmsTest()">Send</button>
        </div>
      </div>
    </div>
  </div>

  `;
}

// Build an SVG path string for a sparkline from a series of numbers.
function buildSparklinePath(values, w = 80, h = 30) {
  const v = (values || []).map((n) => Number(n) || 0);
  if (v.length < 2) return '';
  const min = Math.min(...v);
  const max = Math.max(...v);
  const range = max - min || 1;
  const step = w / (v.length - 1);
  return v.map((n, i) => {
    const x = (i * step).toFixed(1);
    const y = (h - ((n - min) / range) * (h - 4) - 2).toFixed(1);
    return `${i ? 'L' : 'M'}${x} ${y}`;
  }).join(' ');
}

// Last-7-day daily series for the home KPI sparklines (from synced orders).
function getHomeKpiSeries() {
  const recs = DB.sheetRecordsForReport || [];
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push(normalizeDateString(d));
  }
  return {
    orders: days.map((d) => recs.filter((r) => r.date === d).length),
    delivered: days.map((d) => recs.filter((r) => r.date === d && r.status === 'Delivered').length),
    cod: days.map((d) => recs.filter((r) => r.date === d).reduce((s, r) => s + Number(r.cod || 0), 0)),
  };
}

// Percent change of the most recent half of a series vs the earlier half.
function seriesDelta(values) {
  const v = (values || []).map((n) => Number(n) || 0);
  if (v.length < 2) return null;
  const half = Math.floor(v.length / 2);
  const prev = v.slice(0, v.length - half).reduce((s, n) => s + n, 0);
  const recent = v.slice(v.length - half).reduce((s, n) => s + n, 0);
  if (prev <= 0) return recent > 0 ? 100 : 0;
  return ((recent - prev) / prev) * 100;
}

// Markup for a KPI delta line ("▲ 12.3% vs prev 7 days").
function kpiDelta(values) {
  const pct = seriesDelta(values);
  if (pct === null || !Number.isFinite(pct)) return '<div class="kpi-delta neutral">— vs prev 7 days</div>';
  const up = pct >= 0;
  return `<div class="kpi-delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}% <span>vs prev 7 days</span></div>`;
}

// Compact peso formatter for the product/inventory cards.
function formatPesoCompact(value) {
  const n = Number(value) || 0;
  if (n >= 1000000) return `₱${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `₱${(n / 1000).toFixed(1)}K`;
  return `₱${n.toLocaleString()}`;
}

// Top product lines by inventory value, for the Product & Inventory Overview.
function getHomeInventoryLines() {
  const items = (DB.inventory || []).map((i) => {
    const stock = Number(i.stock || 0);
    const unit = Number(i.cost_price || i.cost || i.sell_price || 0);
    return { name: i.name || i.item_id || 'Item', value: stock * unit, items: stock };
  }).filter((i) => i.value > 0);
  items.sort((a, b) => b.value - a.value);
  if (items.length) return items.slice(0, 4);
  // Fallback representative lines until inventory data has loaded.
  return [
    { name: 'Dragon Blood Serum', value: 2480000, items: 1248 },
    { name: 'Design Collection', value: 1860000, items: 932 },
    { name: 'Ginseng Serum', value: 1520000, items: 756 },
    { name: 'High Impact', value: 970000, items: 412 },
  ];
}

function initialsFromName(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'P';
}

// ─── RENDER: HOME ──────────────────────────────────────────
function renderHome() {
  const summaryStatusCount = (status) => Number(
    DB.orderStats?.status_counts?.find((row) => row.status === status)?.count || 0
  );
  // Read from the cheap server-side aggregate so the tiles are correct even
  // before the heavy /records walk finishes. Falls back to client array if the
  // stats call hasn't returned yet (e.g. first paint).
  const stats = DB.sheetRecordsStats || { total: 0, delivered: 0, totalCOD: 0 };
  const total = stats.total || DB.sheetRecordsForReport.length;
  const delivered = stats.delivered
    || DB.sheetRecordsForReport.filter(o => o.status === 'Delivered').length;
  const totalCOD = stats.totalCOD
    || DB.sheetRecordsForReport.reduce((s, o) => s + Number(o.cod || 0), 0);
  const sourceOptions = getPosSourceOptions();


  const productGalleryItems = [
    { title: 'DRAGON BLOOD SERUM', desc: 'YNT product line', icon: 'DB', tone: 'red' },
    { title: 'DRAGON BLOOD CREAM', desc: 'YNT product line', icon: 'DC', tone: 'rose' },
    { title: 'GINSENG SERUM', desc: 'YNT product line', icon: 'GS', tone: 'green' },
    { title: 'HALLY LOTIONS', desc: 'YNT product line', icon: 'HL', tone: 'blue' },
    { title: 'WHITE CREAM', desc: 'YNT product line', icon: 'WC', tone: 'slate' },
    { title: 'NIACINAMIDE', desc: 'YNT product line', icon: 'NA', tone: 'amber' },
  ];

  const kpiSeries = getHomeKpiSeries();
  const lowStock = DB.inventory.filter((i) => i.stock < (i.reorder ?? i.reorder_pt ?? 0)).length;

  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Welcome back, ${App.user?.name?.split(' ')[0] || 'User'} 👋</h1>
      <p>Here's what's happening at YNT Digital Marketing today.</p>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi-card kpi-violet">
      <div class="kpi-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="6" width="16" height="14" rx="2"/><path d="M9 3v4M15 3v4M4 11h16"/></svg>
      </div>
      <div class="kpi-main">
        <div class="kpi-value">${total.toLocaleString()}</div>
        <div class="kpi-label">Total Orders</div>
        ${kpiDelta(kpiSeries.orders)}
      </div>
      <svg class="kpi-spark" viewBox="0 0 80 30" preserveAspectRatio="none"><path d="${buildSparklinePath(kpiSeries.orders)}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div class="kpi-card kpi-blue">
      <div class="kpi-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7l9-4 9 4M3 7v10l9 4 9-4V7M3 7l9 4M21 7l-9 4M12 11v10"/></svg>
      </div>
      <div class="kpi-main">
        <div class="kpi-value">${delivered.toLocaleString()}</div>
        <div class="kpi-label">Delivered Orders</div>
        ${kpiDelta(kpiSeries.delivered)}
      </div>
      <svg class="kpi-spark" viewBox="0 0 80 30" preserveAspectRatio="none"><path d="${buildSparklinePath(kpiSeries.delivered)}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div class="kpi-card kpi-amber">
      <div class="kpi-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/><circle cx="8" cy="14" r="1.2"/></svg>
      </div>
      <div class="kpi-main">
        <div class="kpi-value">₱${totalCOD.toLocaleString()}</div>
        <div class="kpi-label">COD Revenue</div>
        ${kpiDelta(kpiSeries.cod)}
      </div>
      <svg class="kpi-spark" viewBox="0 0 80 30" preserveAspectRatio="none"><path d="${buildSparklinePath(kpiSeries.cod)}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div class="kpi-card kpi-rose">
      <div class="kpi-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7l3-3h12l3 3M3 7v12a2 2 0 002 2h14a2 2 0 002-2V7M3 7h18M9 11a3 3 0 006 0"/></svg>
      </div>
      <div class="kpi-main">
        <div class="kpi-value">${lowStock}</div>
        <div class="kpi-label">Low Stock Items</div>
        <div class="kpi-delta neutral">Items below reorder point</div>
      </div>
      <svg class="kpi-spark" viewBox="0 0 80 30" preserveAspectRatio="none"><path d="${buildSparklinePath([2, 3, 2, 4, 3, 5, lowStock || 4])}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
  </div>

  <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 28px;">
    <div class="card home-chart-card">
      <div class="card-header">
        <div><div class="card-title">Order Status Overview</div><div class="card-subtitle" id="home-status-subtitle">Filtered order data</div></div>
      </div>
      <div class="home-chart-filters">
        <div class="table-filters" id="home-order-filter-group">
          <button class="filter-pill ${homeOrderFilter === 'all' ? 'active' : ''}" onclick="setHomeOrderFilter('all',this)">All Time</button>
          <button class="filter-pill ${homeOrderFilter === 'today' ? 'active' : ''}" onclick="setHomeOrderFilter('today',this)">Today</button>
          <button class="filter-pill ${homeOrderFilter === 'weekly' ? 'active' : ''}" onclick="setHomeOrderFilter('weekly',this)">Weekly</button>
          <button class="filter-pill ${homeOrderFilter === 'monthly' ? 'active' : ''}" onclick="setHomeOrderFilter('monthly',this)">Monthly</button>
          <button class="filter-pill ${homeOrderFilter === 'custom' ? 'active' : ''}" onclick="setHomeOrderFilter('custom',this)">Custom</button>
        </div>
        <select class="form-control home-sheet-filter" id="home-source-filter" onchange="setHomeSourceFilter()">
          <option value="all">All Pages</option>
          ${sourceOptions.map((sheet) => `<option value="${escapeHtml(sheet)}" ${homeSourceFilter === sheet ? 'selected' : ''}>${escapeHtml(sheet)}</option>`).join('')}
        </select>
        <div class="home-custom-range ${homeOrderFilter === 'custom' ? '' : 'hidden'}" id="home-custom-range">
          <input type="date" class="form-control" id="home-date-from">
          <input type="date" class="form-control" id="home-date-to">
          <button class="btn btn-secondary btn-sm" onclick="applyHomeCustomRange()">Apply</button>
        </div>
      </div>
      <div class="card-body home-chart-body">
        <div class="empty-state hidden" id="home-donut-empty" style="padding:24px;"><h3>No matching orders</h3><p>Try another period or sheet filter.</p></div>
        <canvas id="home-donut-chart"></canvas>
      </div>
    </div>
    <div class="card home-chart-card">
      <div class="card-header"><div><div class="card-title">RTS Percentage</div><div class="card-subtitle">Delivered, returned, returning, and shipped</div></div></div>
      <div class="card-body home-chart-body">
        <div class="empty-state hidden" id="home-rts-empty" style="padding:24px;"><h3>No delivery status data</h3><p>Delivered, shipped, returning, or returned orders will appear here.</p></div>
        <canvas id="home-rts-bar-chart"></canvas>
      </div>
    </div>
    <div class="card home-announce-card">
      <div class="card-header">
        <div>
          <div class="card-title">📢 Announcements</div>
          <div class="card-subtitle">Latest from HR & management</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="loadHomeAnnouncements()">↻</button>
      </div>
      <div id="home-announcements" class="card-body home-announce-body">
        <div class="empty-state" style="padding:16px 0;color:var(--text-muted);font-size:13px;">Loading…</div>
      </div>
    </div>
  </div>

  <div class="card pi-overview">
    <div class="card-header">
      <div><div class="card-title">📦 Product &amp; Inventory Overview</div><div class="card-subtitle">Top product lines by inventory value</div></div>
      <button class="btn btn-ghost btn-sm" onclick="navigateTo('inventory')">View Inventory →</button>
    </div>
    <div class="card-body">
      <div class="pi-grid">
        ${getHomeInventoryLines().map((line, idx) => {
          const tones = ['pi-violet', 'pi-blue', 'pi-teal', 'pi-rose'];
          const spark = buildSparklinePath([line.value * 0.55, line.value * 0.7, line.value * 0.62, line.value * 0.82, line.value * 0.78, line.value * 0.95, line.value]);
          return `
          <div class="pi-card ${tones[idx % tones.length]}">
            <div class="pi-head">
              <span class="pi-badge">${initialsFromName(line.name)}</span>
              <div class="pi-value-wrap">
                <div class="pi-value">${formatPesoCompact(line.value)}</div>
                <div class="pi-vlabel">Inventory Value</div>
              </div>
            </div>
            <div class="pi-name">${escapeHtml(line.name)}</div>
            <div class="pi-foot">
              <span class="pi-items">${Number(line.items || 0).toLocaleString()} Items</span>
              <svg class="pi-spark" viewBox="0 0 80 26" preserveAspectRatio="none"><path d="${spark}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

async function loadHomeAnnouncements() {
  const wrap = document.getElementById('home-announcements');
  if (!wrap) return;
  try {
    const result = await authorizedJsonRequest('/announcements');
    const items = Array.isArray(result?.data) ? result.data : [];
    const today = normalizeDateString(new Date());
    const visible = items.filter((a) => !a.expires_at || a.expires_at >= today).slice(0, 5);
    if (!visible.length) {
      wrap.innerHTML = '<div class="empty-state" style="padding:20px 0;color:var(--text-muted);font-size:13px;">No announcements right now.</div>';
      return;
    }
    const tones = ['violet', 'blue', 'amber', 'teal', 'rose'];
    wrap.innerHTML = visible.map((a, idx) => {
      const when = a.posted_at ? new Date(a.posted_at.replace(' ', 'T')).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      const author = escapeHtml(a.posted_by_name || a.posted_by_username || 'Admin');
      return `<div class="ann-item ann-${tones[idx % tones.length]}">
        <span class="ann-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6.5h7l4-2.5v8L9 9.5H2z"/><path d="M4 9.5V13"/></svg></span>
        <div class="ann-body">
          <div class="ann-title">${escapeHtml(a.title || '')}</div>
          <div class="ann-text">${escapeHtml(a.body || '')}</div>
          <div class="ann-meta">${author}${when ? ` · ${escapeHtml(when)}` : ''}</div>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state" style="padding:16px 0;color:var(--text-muted);font-size:12px;">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadHRAnnouncements() {
  const wrap = document.getElementById('hr-announcement-list');
  if (!wrap) return;
  try {
    const result = await authorizedJsonRequest('/announcements');
    const items = Array.isArray(result?.data) ? result.data : [];
    if (!items.length) {
      wrap.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0;">No announcements posted yet.</div>';
      return;
    }
    wrap.innerHTML = items.map((a) => {
      const when = a.posted_at ? new Date(a.posted_at.replace(' ', 'T')).toLocaleString() : '';
      const exp = a.expires_at ? `· expires ${escapeHtml(a.expires_at)}` : '';
      return `<div style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:13px;color:var(--text-primary);">${escapeHtml(a.title)}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;white-space:pre-wrap;">${escapeHtml(a.body)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">${escapeHtml(a.posted_by_name || a.posted_by_username || 'Admin')} · ${escapeHtml(when)} ${exp}</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="deleteHRAnnouncement(${a.id})">Delete</button>
      </div>`;
    }).join('');
  } catch (err) {
    wrap.innerHTML = `<div style="color:var(--text-muted);font-size:12px;">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

async function submitHRAnnouncement() {
  const title = document.getElementById('hr-announce-title')?.value.trim() || '';
  const body = document.getElementById('hr-announce-body')?.value.trim() || '';
  const expires = document.getElementById('hr-announce-expires')?.value.trim() || '';
  if (!title || !body) {
    showToast('warning', 'Missing fields', 'Title and message are required.');
    return;
  }
  try {
    await authorizedJsonRequest('/announcements', {
      method: 'POST',
      body: JSON.stringify({ title, body, expires_at: expires || null }),
    });
    showToast('success', 'Announcement posted', title);
    clearHRAnnouncementForm();
    loadHRAnnouncements();
  } catch (err) {
    showToast('error', 'Post failed', err.message);
  }
}

async function deleteHRAnnouncement(id) {
  if (!confirm('Delete this announcement?')) return;
  try {
    await authorizedJsonRequest(`/announcements/${id}`, { method: 'DELETE' });
    showToast('success', 'Announcement removed', `#${id}`);
    loadHRAnnouncements();
  } catch (err) {
    showToast('error', 'Delete failed', err.message);
  }
}

function clearHRAnnouncementForm() {
  ['hr-announce-title', 'hr-announce-body', 'hr-announce-expires'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

function renderTimeClockCard() {
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Time Clock</div>
          <div class="card-subtitle">Today attendance with break countdown</div>
        </div>
        <div class="philippine-clock" id="philippine-clock-home">--:--:--</div>
      </div>
      <div class="card-body">
        <div id="time-clock-status" class="empty-state" style="padding:12px; margin-bottom:12px;">
          <h3>Loading clock</h3>
          <p>Checking today record.</p>
        </div>

        <div id="break-countdown-card" class="break-countdown hidden">
          <div class="break-countdown-label" id="break-countdown-label">On break</div>
          <div class="break-countdown-time" id="break-countdown-time">00:00</div>
          <div class="break-countdown-bar"><span id="break-countdown-fill"></span></div>
          <button class="btn btn-primary btn-sm" onclick="endBreakCountdown()" style="margin-top:8px;">End Break Now</button>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <button class="btn btn-primary btn-time-in" onclick="submitTimeClock('time_in')">Time In</button>
          <button class="btn btn-primary" onclick="submitTimeClock('time_out')">Time Out</button>
          <button class="btn btn-secondary btn-break" data-break="break" onclick="startBreakWithCountdown(60, 'break')">Break Out (1hr)</button>
          <button class="btn btn-secondary btn-break" data-break="break2" onclick="startBreakWithCountdown(15, 'break2')">15-min Break</button>
        </div>

        ${canAccessPage('hr') ? "<button class=\"btn btn-ghost btn-sm\" style=\"margin-top:12px;\" onclick=\"navigateTo('hr')\">Open HR records</button>" : ''}
      </div>
    </div>`;
}

function getUserRoleBadgeClass(role) {
  const normalizedRole = normalizeRoleName(role);
  if (normalizedRole === 'Administrator') return 'badge-purple';
  if (normalizedRole === 'HR') return 'badge-warning';
  if (normalizedRole.includes('CSR')) return 'badge-info';
  return 'badge-gray';
}

function formatRoleLabel(role) {
  return normalizeRoleName(role) === 'Administrator' ? 'Admin' : (role || '');
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderOwnAccountSection() {
  return `
  <div class="card" style="margin-bottom:20px;">
    <div class="card-header">
      <div>
        <div class="card-title">My Account Details</div>
        <div class="card-subtitle">These details belong to the signed-in account owner and can be updated here.</div>
      </div>
    </div>
    <div class="card-body">
      <form onsubmit="handleOwnAccountSave(event)">
        <div class="form-group">
          <label class="form-label">Full Name <span class="required">*</span></label>
          <input type="text" id="own-account-full-name" class="form-control" value="${escapeHtml(App.user?.name || '')}" placeholder="Enter full name">
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Username <span class="required">*</span></label>
            <input type="text" id="own-account-username" class="form-control" value="${escapeHtml(App.user?.username || '')}" placeholder="Enter username">
          </div>
          <div class="form-group">
            <label class="form-label">Position</label>
            <input type="text" class="form-control readonly-field" value="${escapeHtml(formatRoleLabel(App.user?.role))}" readonly>
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Birthday</label>
            <input type="date" id="own-account-birthday" class="form-control" value="${escapeHtml(App.user?.birthday || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Phone Number</label>
            <input type="text" id="own-account-phone-number" class="form-control" value="${escapeHtml(App.user?.phone_number || '')}" placeholder="09XXXXXXXXX">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Address</label>
          <textarea id="own-account-address" class="form-control" rows="2" placeholder="Enter address">${escapeHtml(App.user?.address || '')}</textarea>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Email Address</label>
            <input type="email" id="own-account-email-address" class="form-control" value="${escapeHtml(App.user?.email_address || '')}" placeholder="name@example.com">
          </div>
          <div class="form-group">
            <label class="form-label">FB Account Name</label>
            <input type="text" id="own-account-fb-account-name" class="form-control" value="${escapeHtml(App.user?.fb_account_name || '')}" placeholder="Facebook profile name">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">New Password</label>
          <input type="password" id="own-account-password" class="form-control" placeholder="Leave blank to keep current password">
          <div class="field-help">Only fill this in when you want to change your password.</div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:12px;">
          <button type="submit" class="btn btn-primary">Update My Account</button>
        </div>
      </form>
    </div>
  </div>`;
}

function renderHR() {
  const today = normalizeDateString(new Date());
  const monthStart = today.slice(0, 8) + '01';
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>HR / Payroll</h1>
      <p>Attendance, OT, holidays, cash advances, and printable payslips.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="loadHRDashboard()">Refresh</button>
      <button class="btn btn-primary btn-sm" onclick="openModal('cash-advance-modal')">+ Cash Advance</button>
      <button class="btn btn-secondary btn-sm" onclick="openScheduleModal()">+ Schedule</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px;">
    <div class="card-body">
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">From</label>
          <input type="date" id="hr-date-from" class="form-control" value="${monthStart}">
        </div>
        <div class="form-group">
          <label class="form-label">To</label>
          <input type="date" id="hr-date-to" class="form-control" value="${today}">
        </div>
        <div class="form-group">
          <label class="form-label">User</label>
          <select id="hr-user-filter" class="form-control">
            <option value="">All users</option>
          </select>
        </div>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;">
        <button class="btn btn-primary" onclick="loadHRDashboard()">Apply</button>
        <button class="btn btn-secondary" onclick="printSelectedPayslip()">Print Payslip</button>
      </div>
    </div>
  </div>

  <div id="hr-summary-wrap" class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom:20px;"></div>

  <div class="card" style="margin-bottom:20px;">
    <div class="card-header"><div><div class="card-title">User Payroll</div><div class="card-subtitle">Days worked, OT, holiday pay, cash advances, and net pay</div></div></div>
    <div class="card-body" id="hr-payroll-table-wrap">
      <div class="empty-state"><h3>Loading payroll</h3><p>Preparing HR records.</p></div>
    </div>
  </div>

  <!-- Cash Advance Modal -->
  <div class="modal-overlay" id="cash-advance-modal">
    <div class="modal" style="max-width:460px;">
      <div class="modal-header">
        <div class="modal-title">Cash Advance</div>
        <button class="modal-close" onclick="closeModal('cash-advance-modal')">×</button>
      </div>
      <div class="modal-body">
        <form onsubmit="createCashAdvance(event)">
          <div class="form-group">
            <label class="form-label">User</label>
            <select id="cash-advance-user" class="form-control"></select>
          </div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Date</label>
              <input type="date" id="cash-advance-date" class="form-control" value="${today}">
            </div>
            <div class="form-group">
              <label class="form-label">Amount</label>
              <input type="number" min="0" step="0.01" id="cash-advance-amount" class="form-control" placeholder="0.00">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Reason</label>
            <input type="text" id="cash-advance-reason" class="form-control" placeholder="Cash advance note">
          </div>
          <div style="display:flex;gap:8px;margin-top:4px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">Save Cash Advance</button>
            <button type="button" class="btn btn-secondary" onclick="closeModal('cash-advance-modal')">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <!-- Daily Schedule Modal -->
  <div class="modal-overlay" id="schedule-modal">
    <div class="modal" style="max-width:560px;">
      <div class="modal-header">
        <div class="modal-title">Daily Schedule</div>
        <button class="modal-close" onclick="closeModal('schedule-modal')">×</button>
      </div>
      <div class="modal-body">
        <form onsubmit="createUserSchedule(event)">
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">User</label>
              <select id="schedule-user" class="form-control" onchange="loadUserSchedules()"></select>
            </div>
            <div class="form-group">
              <label class="form-label">Date</label>
              <input type="date" id="schedule-date" class="form-control" value="${today}">
            </div>
            <div class="form-group">
              <label class="form-label">Shift Start</label>
              <input type="time" id="schedule-shift-start" class="form-control">
            </div>
            <div class="form-group">
              <label class="form-label">Shift End</label>
              <input type="time" id="schedule-shift-end" class="form-control">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Notes</label>
            <input type="text" id="schedule-notes" class="form-control" placeholder="e.g. Morning shift, WFH, Rest day">
          </div>
          <div style="margin-bottom:10px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:500;margin-bottom:8px;">
              <input type="checkbox" id="schedule-is-holiday" onchange="toggleScheduleHoliday()" style="width:16px;height:16px;cursor:pointer;">
              Holiday
            </label>
            <div id="schedule-holiday-options" style="display:none;">
              <div class="form-grid-2" style="gap:8px;margin-bottom:8px;">
                <div class="form-group" style="margin:0;">
                  <label class="form-label" style="font-size:11px;">Holiday Type</label>
                  <select id="schedule-holiday-type" class="form-control" style="height:34px;font-size:13px;">
                    <option value="Special Holiday">Special Holiday</option>
                    <option value="Regular Holiday">Regular Holiday</option>
                  </select>
                </div>
                <div class="form-group" style="margin:0;">
                  <label class="form-label" style="font-size:11px;">Holiday Pay %</label>
                  <div style="display:flex;gap:4px;">
                    <button type="button" class="btn btn-secondary btn-sm" id="sched-pct-30" onclick="selectSchedulePct(30)" style="flex:1;">30%</button>
                    <button type="button" class="btn btn-secondary btn-sm" id="sched-pct-50" onclick="selectSchedulePct(50)" style="flex:1;">50%</button>
                    <button type="button" class="btn btn-secondary btn-sm" id="sched-pct-100" onclick="selectSchedulePct(100)" style="flex:1;">100%</button>
                  </div>
                  <input type="hidden" id="schedule-holiday-percentage" value="30">
                </div>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:4px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">Add Schedule</button>
            <button type="button" class="btn btn-secondary" onclick="closeModal('schedule-modal')">Close</button>
          </div>
        </form>
        <div id="schedule-list" style="margin-top:16px;"></div>
      </div>
    </div>
  </div>

  <!-- Edit Daily Rate Modal -->
  <div class="modal-overlay" id="payroll-edit-modal">
    <div class="modal" style="max-width:400px;">
      <div class="modal-header">
        <div>
          <div class="modal-title" id="payroll-modal-title">Edit Daily Rate</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;" id="payroll-modal-role"></div>
        </div>
        <button class="modal-close" onclick="closeModal('payroll-edit-modal')">×</button>
      </div>
      <div class="modal-body">
        <input type="hidden" id="payroll-modal-user-id">
        <div class="form-group">
          <label class="form-label">Daily Rate (PHP)</label>
          <input type="number" min="0" step="0.01" id="payroll-modal-rate" class="form-control" placeholder="0.00">
        </div>
        <div style="display:flex;gap:8px;margin-top:4px;">
          <button class="btn btn-primary" style="flex:1;" onclick="savePayrollRate()">Save Rate</button>
          <button class="btn btn-secondary" onclick="printPayslipFromModal()">Print Payslip</button>
          <button class="btn btn-secondary" onclick="closeModal('payroll-edit-modal')">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
}

function renderAttendance() {
  const today = normalizeDateString(new Date());
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Attendance</h1>
      <p>Clock in, record breaks, request cash advance, and file leave requests.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="loadAttendanceDashboard()">Refresh</button>
    </div>
  </div>

  <div class="tabs" style="margin-bottom:16px;">
    <button class="tab-btn active" onclick="switchTab(this,'attendance-tab-clock')">Time Clock</button>
    <button class="tab-btn" onclick="switchTab(this,'attendance-tab-cash')">Cash Advance</button>
    <button class="tab-btn" onclick="switchTab(this,'attendance-tab-leave')">Request Leave</button>
    <button class="tab-btn" onclick="switchTab(this,'attendance-tab-ot'); loadMyOTRequests();">Overtime</button>
    <button class="tab-btn" onclick="switchTab(this,'attendance-tab-hours'); loadMyWorkHours();">Work Hours</button>
  </div>

  <div id="attendance-tab-clock" class="tab-content active">
    <div style="display:grid; grid-template-columns:${canManageHR() ? 'minmax(0, .9fr) minmax(320px, 1.1fr)' : 'minmax(0, 1fr)'}; gap:16px;">
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">Today Status</div><div class="card-subtitle">Use the buttons to clock in/out and record breaks.</div></div>
          <div class="philippine-clock" id="philippine-clock">--:--:--</div>
        </div>
        <div class="card-body">
          <div id="attendance-clock-status" class="empty-state"><h3>Loading attendance</h3><p>Checking today time record.</p></div>

          <div id="attendance-break-countdown" class="break-countdown hidden" style="margin-top:14px;">
            <div class="break-countdown-label" id="attendance-break-countdown-label">On break</div>
            <div class="break-countdown-time" id="attendance-break-countdown-time">00:00</div>
            <div class="break-countdown-bar"><span id="attendance-break-countdown-fill"></span></div>
            <button class="btn btn-primary btn-sm" onclick="endBreakCountdown()" style="margin-top:8px;">End Break Now</button>
          </div>

          <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; margin-top:16px;">
            <button class="btn btn-primary btn-time-in" onclick="submitTimeClock('time_in')">Time In</button>
            <button class="btn btn-primary" onclick="submitTimeClock('time_out')">Time Out</button>
            <button class="btn btn-secondary btn-break" data-break="break" onclick="startBreakWithCountdown(60, 'break')">Break Out (1hr)</button>
            <button class="btn btn-secondary btn-break" data-break="break2" onclick="startBreakWithCountdown(15, 'break2')">15-min Break</button>
          </div>
        </div>
      </div>

      ${canManageHR() ? `<div class="card">
        <div class="card-header"><div><div class="card-title">Time Inputs</div><div class="card-subtitle">Adjust the current day record when needed.</div></div></div>
        <div class="card-body">
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Time In</label>
              <input type="time" id="attendance-time-in" class="form-control">
            </div>
            <div class="form-group">
              <label class="form-label">Time Out</label>
              <input type="time" id="attendance-time-out" class="form-control">
            </div>
            <div class="form-group">
              <label class="form-label">Break Out</label>
              <input type="time" id="attendance-break-out" class="form-control">
            </div>
            <div class="form-group">
              <label class="form-label">Break In</label>
              <input type="time" id="attendance-break-in" class="form-control">
            </div>
            <div class="form-group">
              <label class="form-label">15-min Out</label>
              <input type="time" id="attendance-break2-out" class="form-control">
            </div>
            <div class="form-group">
              <label class="form-label">15-min In</label>
              <input type="time" id="attendance-break2-in" class="form-control">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Notes</label>
            <textarea id="attendance-notes" class="form-control" rows="3" placeholder="Optional attendance note"></textarea>
          </div>
          <button class="btn btn-primary" onclick="saveAttendanceTimes()">Save Time Record</button>
        </div>
      </div>` : ''}
    </div>
  </div>

  <div id="attendance-tab-cash" class="tab-content">
    <div style="display:grid; grid-template-columns:minmax(320px, .75fr) minmax(0, 1.25fr); gap:16px;">
      <div class="card">
        <div class="card-header"><div><div class="card-title">Cash Advance Request</div><div class="card-subtitle">Requests are saved under your account for HR review.</div></div></div>
        <div class="card-body">
          <form onsubmit="requestCashAdvance(event)">
            <div class="form-group">
              <label class="form-label">Amount</label>
              <input type="number" min="0" step="0.01" id="attendance-cash-amount" class="form-control" placeholder="0.00">
            </div>
            <div class="form-group">
              <label class="form-label">Reason</label>
              <textarea id="attendance-cash-reason" class="form-control" rows="4" placeholder="Reason for cash advance"></textarea>
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;">Submit Cash Advance</button>
          </form>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div><div class="card-title">Cash Advance Records</div><div class="card-subtitle">Recent requests and deductions</div></div></div>
        <div class="card-body" id="attendance-cash-list"><div class="empty-state"><h3>Loading records</h3><p>Checking cash advance list.</p></div></div>
      </div>
    </div>
  </div>

  <div id="attendance-tab-leave" class="tab-content">
    <div style="display:grid; grid-template-columns:minmax(320px, .75fr) minmax(0, 1.25fr); gap:16px;">
      <div class="card">
        <div class="card-header"><div><div class="card-title">Leave Request</div><div class="card-subtitle">Submit the dates and reason for HR approval.</div></div></div>
        <div class="card-body">
          <form onsubmit="requestLeave(event)">
            <div class="form-group">
              <label class="form-label">Leave Type</label>
              <select id="attendance-leave-type" class="form-control">
                <option>Personal</option>
                <option>Sick Leave</option>
                <option>Emergency Leave</option>
                <option>Vacation Leave</option>
                <option>Unpaid Leave</option>
              </select>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">From</label>
                <input type="date" id="attendance-leave-from" class="form-control" value="${today}">
              </div>
              <div class="form-group">
                <label class="form-label">To</label>
                <input type="date" id="attendance-leave-to" class="form-control" value="${today}">
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Reason</label>
              <textarea id="attendance-leave-reason" class="form-control" rows="4" placeholder="Reason for leave"></textarea>
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;">Submit Leave Request</button>
          </form>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div><div class="card-title">Leave Records</div><div class="card-subtitle">Pending and reviewed requests</div></div></div>
        <div class="card-body" id="attendance-leave-list"><div class="empty-state"><h3>Loading leave</h3><p>Checking request list.</p></div></div>
      </div>
    </div>
  </div>

  <div id="attendance-tab-ot" class="tab-content">
    <div style="display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1.2fr); gap:16px;">
      <div class="card">
        <div class="card-header"><div><div class="card-title">Request Overtime</div><div class="card-subtitle">OT hours are paid only if HR approves.</div></div></div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">Work Date</label>
            <input type="date" id="ot-work-date" class="form-control" value="${today}">
          </div>
          <div class="form-group">
            <label class="form-label">Overtime Hours</label>
            <input type="number" id="ot-hours" class="form-control" min="0" step="0.25" placeholder="e.g. 2">
            <div class="field-help">In hours (0.25 = 15 min). Saved as minutes.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Reason</label>
            <textarea id="ot-reason" class="form-control" rows="3" placeholder="What did you work on?"></textarea>
          </div>
          <button class="btn btn-primary" onclick="submitOTRequest()">Submit Request</button>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div><div class="card-title">My OT Requests</div><div class="card-subtitle">Latest 25 requests</div></div>
          <button class="btn btn-ghost btn-sm" onclick="loadMyOTRequests()">↻</button>
        </div>
        <div class="card-body" id="ot-request-list"><div class="empty-state"><h3>Loading</h3><p>Pulling your overtime requests.</p></div></div>
      </div>
    </div>
  </div>

  <div id="attendance-tab-hours" class="tab-content">
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Work Hours</div><div class="card-subtitle">Your attendance history — read only.</div></div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <input type="date" id="wh-date-from" class="form-control" style="width:auto;" value="${today.slice(0,8)}01">
          <span style="color:var(--text-muted);font-size:13px;">to</span>
          <input type="date" id="wh-date-to" class="form-control" style="width:auto;" value="${today}">
          <button class="btn btn-secondary btn-sm" onclick="loadMyWorkHours()">Apply</button>
        </div>
      </div>
      <div class="card-body" style="padding:0;">
        <div id="attendance-hours-wrap">
          <div class="empty-state"><h3>Loading</h3><p>Fetching your work hour records.</p></div>
        </div>
      </div>
    </div>
  </div>`;
}

function renderProfilePage() {
  return `
    <div class="page-header">
      <div class="page-title">
        <h1>My Profile</h1>
        <p>Update your own account details and password.</p>
      </div>
    </div>
    ${renderOwnAccountSection()}`;
}

function renderManageUsers() {
  if (!isAdminUser()) {
    // Non-admin landed here via a stale link/bookmark — send them to the dedicated profile page.
    setTimeout(() => navigateTo('profile'), 0);
    return '';
  }
  const ownAccountSection = renderOwnAccountSection();

  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Account</h1>
      <p>Edit usernames, names, roles, and deactivate accounts. Delete keeps history by disabling login access.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-primary btn-sm" onclick="openManageUserCreator()">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>
        Create Account
      </button>
      <button class="btn btn-secondary btn-sm" onclick="loadManagedUsers()">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 8A5 5 0 1 1 8 3"/><path d="M13 3v5H8"/></svg>
        Refresh
      </button>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px;">
    <div class="card-body" style="padding:16px 20px;">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap;">
        <div>
          <div class="card-title" style="margin-bottom:4px;">Account controls</div>
          <div class="card-subtitle">Administrator and HR accounts can edit or deactivate user accounts from this screen.</div>
        </div>
        <div class="badge badge-warning">Delete = deactivate account</div>
      </div>
    </div>
  </div>

  ${ownAccountSection}

  <div class="table-container">
    <div class="table-toolbar">
      <div>
        <div class="card-title">User Accounts</div>
        <div class="card-subtitle">Active users and owner account details in the shared dashboard</div>
      </div>
    </div>
    <div id="manage-users-table-wrap">
      <div class="empty-state">
        <h3>Loading accounts</h3>
        <p>Pulling the latest user list from the server.</p>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="manage-user-modal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Edit Account</div>
        <button class="modal-close" onclick="closeModal('manage-user-modal')">×</button>
      </div>
      <form onsubmit="handleManageUserSave(event)">
        <div class="modal-body">
          <input type="hidden" id="manage-user-id">
          <div class="field-help" id="manage-user-mode-copy" style="margin-bottom:12px;">Update an existing account profile and role.</div>
          <div class="form-group">
            <label class="form-label">Full Name <span class="required">*</span></label>
            <input type="text" id="manage-user-full-name" class="form-control" placeholder="Enter full name">
          </div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Username <span class="required">*</span></label>
              <input type="text" id="manage-user-username" class="form-control" placeholder="Enter username">
            </div>
            <div class="form-group">
              <label class="form-label">Role <span class="required">*</span></label>
              <select id="manage-user-role" class="form-control">
                <option value="Administrator">Admin</option>
                ${ROLE_OPTIONS.map((role) => `<option value="${role}">${role}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Birthday</label>
              <input type="date" id="manage-user-birthday" class="form-control">
            </div>
            <div class="form-group">
              <label class="form-label">Phone Number</label>
              <input type="text" id="manage-user-phone-number" class="form-control" placeholder="09XXXXXXXXX">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Address</label>
            <textarea id="manage-user-address" class="form-control" rows="2" placeholder="Enter address"></textarea>
          </div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Email Address</label>
              <input type="email" id="manage-user-email-address" class="form-control" placeholder="name@example.com">
            </div>
            <div class="form-group">
              <label class="form-label">FB Account Name</label>
              <input type="text" id="manage-user-fb-account-name" class="form-control" placeholder="Facebook profile name">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label"><span id="manage-user-password-label">New Password</span></label>
            <input type="password" id="manage-user-password" class="form-control" placeholder="Leave blank to keep current password">
            <div class="field-help" id="manage-user-password-help">Only fill this in when the password needs to change.</div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" onclick="closeModal('manage-user-modal')">Cancel</button>
          <button type="submit" class="btn btn-primary" id="manage-user-submit-btn">Save Changes</button>
        </div>
      </form>
    </div>
  </div>`;
}

// ─── RENDER: SALES DASHBOARD ───────────────────────────────
function renderSales() {
  const records = DB.sheetRecordsForReport;
  const newOrders = records.filter((o) => o.status === 'New').length;
  const confirmed = records.filter((o) => o.status === 'Confirmed').length;
  const waiting = records.filter((o) => o.status === 'Waiting for pickup').length;
  const shipped = records.filter((o) => o.status === 'Shipped').length;
  const delivered = records.filter((o) => o.status === 'Delivered').length;
  const returned = records.filter((o) => o.status === 'Returned').length;
  const returning = records.filter((o) => o.status === 'Returning').length;
  const canceled = records.filter((o) => o.status === 'Canceled').length;
  const totalCOD = records.reduce((sum, o) => sum + Number(o.cod || 0), 0);
  const sourceOptions = getPosSourceOptions();
  const yearOptions = getPosYearOptions();
  const monthOptions = getPosMonthOptions(salesYearFilter === 'all' ? '' : salesYearFilter);
  const salesMonths = getDataReportMonths();
  if (salesFilter === 'monthly' && !salesMonth) {
    salesMonth = salesMonths[0] || normalizeDateString(new Date()).slice(0, 7);
  }
  return `
  <div class="page-header">
    <div class="page-title"><h1>Sales Dashboard</h1><p>Track orders, deliveries, and revenue metrics.</p></div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="startCsvImport('orders')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 14V6M5 9l3-3 3 3M2 3h12"/></svg>
        Import CSV
      </button>
      <button class="btn btn-secondary btn-sm" onclick="exportTableCSV('sales-table', 'sales-records')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8M5 7l3 3 3-3M2 12h12"/></svg>
        Export CSV
      </button>
    </div>
  </div>

  <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr);" id="sales-summary-cards">
    <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">New</div><div class="stat-value">${newOrders}</div><div class="stat-meta">Newly received</div></div>
    <div class="stat-card gray"><div class="stat-card-accent"></div><div class="stat-label">Confirmed</div><div class="stat-value">${confirmed}</div><div class="stat-meta">Ready to process</div></div>
    <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">Waiting Pickup</div><div class="stat-value">${waiting}</div><div class="stat-meta">Packaging or pickup</div></div>
    <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">Shipped</div><div class="stat-value">${shipped}</div><div class="stat-meta">Awaiting delivery</div></div>
    <div class="stat-card green"><div class="stat-card-accent"></div><div class="stat-label">Delivered</div><div class="stat-value">${delivered}</div><div class="stat-meta"><span class="stat-badge up">✓ Completed</span></div></div>
    <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">Returning</div><div class="stat-value">${returning}</div><div class="stat-meta">In transit back</div></div>
    <div class="stat-card red"><div class="stat-card-accent"></div><div class="stat-label">Returned</div><div class="stat-value">${returned}</div><div class="stat-meta">Received back</div></div>
    <div class="stat-card red"><div class="stat-card-accent"></div><div class="stat-label">Canceled</div><div class="stat-value">${canceled}</div><div class="stat-meta">Canceled orders</div></div>
    <div class="stat-card purple"><div class="stat-card-accent"></div><div class="stat-label">COD Amount</div><div class="stat-value" style="font-size:20px;">₱${(totalCOD/1000).toFixed(1)}K</div><div class="stat-meta">Total collected</div></div>
  </div>

  <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px;">
    <div class="card">
      <div class="card-header"><div class="card-title">Monthly Trend</div></div>
      <div class="card-body" style="padding:16px;"><canvas id="sales-bar-chart" height="220"></canvas></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Status Breakdown</div></div>
      <div class="card-body" style="padding:16px;"><canvas id="sales-donut-chart" height="220"></canvas></div>
    </div>
  </div>

  <div class="table-container">
    <div class="table-toolbar">
      <div class="table-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
        <input type="text" placeholder="Search orders, customers..." id="sales-search" oninput="filterSalesTable()" />
      </div>
      <div class="table-filters" id="sales-filter-group">
        <button class="filter-pill ${salesFilter === 'all' ? 'active' : ''}" onclick="setSalesFilter('all',this)">All</button>
        <button class="filter-pill ${salesFilter === 'daily' ? 'active' : ''}" onclick="setSalesFilter('daily',this)">Daily</button>
        <button class="filter-pill ${salesFilter === 'weekly' ? 'active' : ''}" onclick="setSalesFilter('weekly',this)">Weekly</button>
        <button class="filter-pill ${salesFilter === 'monthly' ? 'active' : ''}" onclick="setSalesFilter('monthly',this)">Month</button>
        <button class="filter-pill ${salesFilter === 'yearly' ? 'active' : ''}" onclick="setSalesFilter('yearly',this)">Year</button>
        <button class="filter-pill ${salesFilter === 'custom' ? 'active' : ''}" onclick="setSalesFilter('custom',this)">Custom</button>
      </div>
      <div id="sales-month-picker" class="${salesFilter === 'monthly' ? '' : 'hidden'}" style="align-items:center;gap:6px;display:flex;">
        <select class="form-control" id="sales-month-dropdown" onchange="setSalesMonthDropdown()" style="min-width:160px;height:34px;font-size:13px;padding:6px 10px;">
          ${salesMonths.length
            ? salesMonths.map((m) => `<option value="${m}"${salesMonth === m ? ' selected' : ''}>${escapeHtml(monthLabel(m))}</option>`).join('')
            : `<option value="${escapeHtml(salesMonth)}">${escapeHtml(monthLabel(salesMonth))}</option>`}
        </select>
      </div>
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <select class="form-control" style="width:150px; padding:6px 10px; font-size:13px;" id="sales-source-filter" onchange="setSalesSourceFilter()">
          <option value="all">All Pages</option>
          ${sourceOptions.map((sheet) => `<option value="${escapeHtml(sheet)}" ${salesSourceFilter === sheet ? 'selected' : ''}>${escapeHtml(sheet)}</option>`).join('')}
        </select>
        <select class="form-control" style="width:105px; padding:6px 10px; font-size:13px;" id="sales-year-filter" onchange="setSalesYearFilter()">
          <option value="all">All Years</option>
          ${yearOptions.map((year) => `<option value="${year}" ${salesYearFilter === year ? 'selected' : ''}>${year}</option>`).join('')}
        </select>
        <select class="form-control" style="width:125px; padding:6px 10px; font-size:13px;" id="sales-month-filter" onchange="setSalesMonthFilter()">
          <option value="all">All Months</option>
          ${monthOptions.map((month) => `<option value="${month.value}" ${salesMonthFilter === month.value ? 'selected' : ''}>${month.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-grid-2 ${salesFilter === 'custom' ? '' : 'hidden'}" id="sales-custom-range" style="max-width:340px;">
        <input type="date" class="form-control" id="sales-date-from">
        <div style="display:flex; gap:8px;">
          <input type="date" class="form-control" id="sales-date-to">
          <button class="btn btn-secondary btn-sm" onclick="applySalesCustomRange()">Apply</button>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:13px; color:var(--text-muted)">Per page:</span>
        <select class="form-control" style="width:70px; padding:6px 10px; font-size:13px;" id="sales-per-page" onchange="renderSalesTable()">
          <option>10</option><option>25</option><option>50</option>
        </select>
      </div>
    </div>
    <div id="sales-table-wrapper">
      <table id="sales-table">
        <thead><tr>
          <th>Order ID</th><th>Tracking No.</th><th>Page</th><th>Date</th><th>Customer</th><th>Product</th><th>Attempts</th><th>COD</th><th>Assigned</th><th>Status</th>
        </tr></thead>
        <tbody id="sales-tbody"></tbody>
      </table>
    </div>
    <div class="table-pagination" id="sales-pagination"></div>
  </div>`;
}

function renderRTSRate() {
  const sourceOptions = getPosSourceOptions();
  const months = getDataReportMonths();
  const today = normalizeDateString(new Date());
  if (rtsRateFilter === 'monthly' && !rtsRateMonth) {
    rtsRateMonth = months[0] || today.slice(0, 7);
  }
  return `
  <div class="rts-rate-page">
    <div class="page-header">
      <div class="page-title"><h1>Sale Report</h1><p>Delivery, return-to-sender, and COD performance based on Google Sheets records.</p></div>
    </div>

    <div class="rts-filter-bar">
      <div class="rts-filter-group">
        <div class="rts-filter-label">Time Filter</div>
        <div class="table-filters" id="rts-rate-filter-group">
          <button class="filter-pill ${rtsRateFilter === 'all' ? 'active' : ''}" onclick="setRTSRateFilter('all',this)">All Time</button>
          <button class="filter-pill ${rtsRateFilter === 'weekly' ? 'active' : ''}" onclick="setRTSRateFilter('weekly',this)">Weekly</button>
          <button class="filter-pill ${rtsRateFilter === 'monthly' ? 'active' : ''}" onclick="setRTSRateFilter('monthly',this)">Monthly</button>
          <button class="filter-pill ${rtsRateFilter === 'custom' ? 'active' : ''}" onclick="setRTSRateFilter('custom',this)">Custom Date Range</button>
        </div>
      </div>
      <div class="rts-filter-group ${rtsRateFilter === 'monthly' ? '' : 'hidden'}" id="rts-rate-month-group">
        <div class="rts-filter-label">Month</div>
        <select class="form-control" id="rts-rate-month" onchange="setRTSRateMonth()" style="min-width:160px;height:34px;font-size:13px;">
          ${months.length
            ? months.map((m) => `<option value="${m}"${rtsRateMonth === m ? ' selected' : ''}>${escapeHtml(monthLabel(m))}</option>`).join('')
            : `<option value="${escapeHtml(rtsRateMonth || today.slice(0,7))}">${escapeHtml(monthLabel(rtsRateMonth || today.slice(0,7)))}</option>`}
        </select>
      </div>
      <div class="rts-filter-group rts-sheet-filter">
        <label class="rts-filter-label" for="rts-rate-source-filter">Page Filter</label>
        <select class="form-control" id="rts-rate-source-filter" onchange="setRTSRateSourceFilter()">
          <option value="all">All Pages</option>
          ${sourceOptions.map((sheet) => `<option value="${escapeHtml(sheet)}" ${rtsRateSourceFilter === sheet ? 'selected' : ''}>${escapeHtml(sheet)}</option>`).join('')}
        </select>
      </div>
      <div class="rts-custom-range ${rtsRateFilter === 'custom' ? '' : 'hidden'}" id="rts-rate-custom-range">
        <input type="date" class="form-control" id="rts-rate-date-from">
        <input type="date" class="form-control" id="rts-rate-date-to">
        <button class="btn btn-secondary btn-sm" onclick="applyRTSRateCustomRange()">Apply</button>
      </div>
    </div>

    <div id="rts-rate-dashboard"></div>
  </div>`;
}

function getOrderStatusKey(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['delivered', 'completed'].includes(value)) return 'delivered';
  if (['returned', 'return to sender', 'rts'].includes(value)) return 'returned';
  if (['returning', 'for return', 'return in transit'].includes(value)) return 'returning';
  if (['shipped', 'in transit', 'out for delivery'].includes(value)) return 'shipped';
  if (['canceled', 'cancelled', 'void'].includes(value)) return 'canceled';
  return value;
}

function getFilteredRTSRateOrders() {
  let data = [...DB.sheetRecordsForReport];
  const today = normalizeDateString(new Date());

  if (rtsRateFilter === 'weekly') {
    const week = getDateDaysAgo(6);
    data = data.filter((order) => new Date(order.date) >= week);
  } else if (rtsRateFilter === 'monthly') {
    const month = rtsRateMonth || today.slice(0, 7);
    data = data.filter((order) => String(order.date || '').startsWith(month));
  } else if (rtsRateFilter === 'custom') {
    if (rtsRateDateFrom) data = data.filter((order) => order.date >= rtsRateDateFrom);
    if (rtsRateDateTo) data = data.filter((order) => order.date <= rtsRateDateTo);
  }

  if (rtsRateSourceFilter !== 'all') {
    data = data.filter((order) => (order.sourceSheet || 'Sheets') === rtsRateSourceFilter);
  }

  return data;
}

function getRTSRateMetrics() {
  const orders = getFilteredRTSRateOrders();
  const counts = { delivered: 0, returned: 0, returning: 0, shipped: 0 };
  const cod = { total: 0, delivered: 0, lost: 0, shipped: 0 };

  orders.forEach((order) => {
    const key = getOrderStatusKey(order.status);
    const amount = Number(order.cod || 0);
    cod.total += amount;

    if (counts[key] !== undefined) counts[key] += 1;
    if (key === 'delivered') cod.delivered += amount;
    if (key === 'returned' || key === 'returning') cod.lost += amount;
    if (key === 'shipped') cod.shipped += amount;
  });

  const deliveryBase = counts.delivered + counts.returned + counts.returning;
  const rtsRate = deliveryBase ? ((counts.returned + counts.returning) / deliveryBase) * 100 : 0;
  return { orders, counts, cod, deliveryBase, rtsRate };
}

function formatPercent(value) {
  return `${Number.isFinite(value) ? value.toFixed(1) : '0.0'}%`;
}

function formatPeso(value) {
  return `PHP ${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderRTSMetricCard(label, value, color, total) {
  const rate = total ? (value / total) * 100 : 0;
  return `
    <div class="rts-metric-card ${color}">
      <div class="stat-label">${label}</div>
      <div class="rts-metric-value">${Number(value || 0).toLocaleString()}</div>
      <div class="stat-meta">Delivery Rate: ${formatPercent(rate)}</div>
    </div>`;
}

function renderRTSCodCard(label, value, color, subtitle) {
  return `
    <div class="rts-cod-card ${color}">
      <div class="stat-label">${label}</div>
      <div class="rts-cod-value">${formatPeso(value)}</div>
      <div class="stat-meta">${subtitle}</div>
    </div>`;
}

function renderRTSRateDashboard() {
  const wrapper = document.getElementById('rts-rate-dashboard');
  if (!wrapper) return;

  const { orders, counts, cod, deliveryBase, rtsRate } = getRTSRateMetrics();
  const progress = Math.min(100, Math.max(0, rtsRate));

  wrapper.innerHTML = `
    <div class="rts-overview-grid">
      ${renderRTSMetricCard('Delivered Orders', counts.delivered, 'green', orders.length)}
      ${renderRTSMetricCard('Returned', counts.returned, 'red', orders.length)}
      ${renderRTSMetricCard('Returning', counts.returning, 'amber', orders.length)}
      ${renderRTSMetricCard('Shipped', counts.shipped, 'blue', orders.length)}
      <div class="rts-metric-card yellow">
        <div class="stat-label">RTS Rate</div>
        <div class="rts-metric-value">${formatPercent(rtsRate)}</div>
        <div class="stat-meta">(Returned + Returning) / (Delivered + Returned + Returning)</div>
        <div class="rts-progress"><span style="width:${progress}%"></span></div>
      </div>
    </div>

    <section class="card" style="margin-top:20px;">
      <div class="card-header">
        <div>
          <div class="card-title">Order Status Breakdown</div>
          <div class="card-subtitle">Count of orders by status (from Sheet Records)</div>
        </div>
      </div>
      <div style="padding:16px 20px 20px;">
        <canvas id="sale-report-bar-chart" style="max-height:320px;"></canvas>
      </div>
    </section>

    <div class="rts-formula-card">
      <div>
        <div class="card-title">RTS Rate Formula</div>
        <div class="card-subtitle">Based on ${deliveryBase.toLocaleString()} delivered, returned, and returning orders.</div>
      </div>
      <div class="rts-formula">
        <span>RTS Rate =</span>
        <strong>(Returned + Returning) / (Delivered + Returned + Returning) x 100</strong>
      </div>
    </div>

    <div class="rts-section-title">Additional COD Metrics</div>
    <div class="rts-cod-grid">
      ${renderRTSCodCard('Total COD', cod.total, 'purple', 'All filtered orders')}
      ${renderRTSCodCard('Total Delivered COD', cod.delivered, 'green', 'Successfully collected')}
      ${renderRTSCodCard('Lost COD', cod.lost, 'red', 'Returned + Returning')}
      ${renderRTSCodCard('Shipped COD', cod.shipped, 'blue', 'In transit')}
    </div>`;

  renderSaleReportBarChart(orders);
}

let saleReportBarChart = null;
function renderSaleReportBarChart(orders) {
  const canvas = document.getElementById('sale-report-bar-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const statusCounts = orders.reduce((acc, o) => {
    const k = o.status || 'Unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const labels = ['New', 'Confirmed', 'Shipped', 'Delivered', 'Returning', 'Returned', 'Canceled'];
  const data = labels.map((l) => statusCounts[l] || 0);
  const colors = {
    'New': '#60a5fa', 'Confirmed': '#3b82f6',
    'Shipped': '#a78bfa', 'Delivered': '#10b981',
    'Returning': '#f97316', 'Returned': '#ef4444', 'Canceled': '#9ca3af',
  };
  if (saleReportBarChart && (saleReportBarChart.canvas !== canvas || !canvas.isConnected)) {
    try { saleReportBarChart.destroy(); } catch {}
    saleReportBarChart = null;
  }
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Orders',
        data,
        backgroundColor: labels.map((l) => colors[l] || '#94a3b8'),
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  };
  if (saleReportBarChart) {
    saleReportBarChart.data = config.data;
    saleReportBarChart.update();
  } else {
    saleReportBarChart = new Chart(canvas, config);
  }
}

let dataReportTab = 'sales';
let dataReportAnalyticsSubTab = 'price';
let dataReportStocksLoaded = false;
let dataReportStocksLoading = false;
let dataReportPreset = 'monthly';
let dataReportDateFrom = '';
let dataReportDateTo = '';
let dataReportPageFilter = 'all';
let dataReportMonth = ''; // YYYY-MM selected in the Monthly dropdown

// The Data Report is computed server-side (/google-sheets/report-summary) so the
// page no longer walks every order row into the browser. These hold the last
// fetched summary plus the dropdown domains (months/pages) the endpoint returns.
let dataReportSummary = null;
let dataReportSummaryLoading = false;
let dataReportMonths = [];
let dataReportPages = [];

// Translate the active preset/page filter into report-summary query params.
function getDataReportParams() {
  const params = new URLSearchParams();
  const today = normalizeDateString(new Date());
  if (dataReportPreset === 'today') {
    params.set('date_from', today);
    params.set('date_to', today);
  } else if (dataReportPreset === 'yesterday') {
    const y = normalizeDateString(getDateDaysAgo(1));
    params.set('date_from', y);
    params.set('date_to', y);
  } else if (dataReportPreset === 'monthly') {
    params.set('month', dataReportMonth || today.slice(0, 7));
  } else if (dataReportPreset === 'custom') {
    if (dataReportDateFrom) params.set('date_from', dataReportDateFrom);
    if (dataReportDateTo) params.set('date_to', dataReportDateTo);
  }
  if (dataReportPageFilter !== 'all') params.set('page', dataReportPageFilter);
  return params;
}

async function loadDataReportSummary() {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;
  dataReportSummaryLoading = true;
  try {
    const params = getDataReportParams();
    params.set('_', String(Date.now()));
    const result = await authorizedJsonRequest(`/integrations/google-sheets/report-summary?${params}`);
    dataReportSummary = result;
    if (Array.isArray(result.months)) dataReportMonths = result.months;
    if (Array.isArray(result.pages)) dataReportPages = result.pages;
    return true;
  } finally {
    dataReportSummaryLoading = false;
  }
}

async function refreshDataReport() {
  try {
    await loadDataReportSummary();
  } catch (error) {
    showToast('warning', 'Data report refresh failed', error.message || 'Could not refresh report.');
  }
  if (App.currentPage === 'data-report') renderDataReportDashboard();
}

// Month dropdown domain — from the summary endpoint, falling back to whatever
// rows happen to be in memory before the first fetch resolves.
function getDataReportMonths() {
  if (dataReportMonths.length) return dataReportMonths;
  const set = new Set();
  (DB.sheetRecordsForReport || []).forEach((o) => {
    const m = String(o.date || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(m)) set.add(m);
  });
  return [...set].sort((a, b) => b.localeCompare(a));
}

function monthLabel(ym) {
  const [y, m] = String(ym || '').split('-');
  if (!y || !m) return ym;
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
}

function setDataReportTab(tab) {
  dataReportTab = tab;
  document.querySelectorAll('.dr-tab-btn').forEach((btn) => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    // The underline/color are inline styles set at render time, so update them
    // here too — toggling the class alone leaves the indicator on the old tab.
    btn.style.color = isActive ? 'var(--primary)' : 'var(--text-muted)';
    btn.style.borderBottom = `2px solid ${isActive ? 'var(--primary)' : 'transparent'}`;
  });
  document.querySelectorAll('.dr-tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.tab !== tab);
  });
  if (tab === 'analytics') renderDataReportDashboard();
  if (tab === 'roas') renderRoasSummaryDashboard();
  if (tab === 'sales') renderRTSRateDashboard();
}

function setDataReportAnalyticsSubTab(tab) {
  dataReportAnalyticsSubTab = tab;
  renderDataReportDashboard();
}

function setDataReportPreset(preset) {
  dataReportPreset = preset;
  if (preset !== 'custom') { dataReportDateFrom = ''; dataReportDateTo = ''; }
  dataReportTab = 'analytics';
  navigateTo('data-report');
}

function applyDataReportCustomRange() {
  dataReportDateFrom = document.getElementById('data-report-date-from')?.value || '';
  dataReportDateTo = document.getElementById('data-report-date-to')?.value || '';
  dataReportPreset = 'custom';
  navigateTo('data-report');
}

function setDataReportPageFilter() {
  dataReportPageFilter = document.getElementById('data-report-page-filter')?.value || 'all';
  dataReportTab = 'analytics';
  navigateTo('data-report');
}

function setDataReportMonth() {
  dataReportMonth = document.getElementById('data-report-month')?.value || '';
  dataReportPreset = 'monthly';
  dataReportTab = 'analytics';
  navigateTo('data-report');
}

function renderDataReportTable(rows, firstColumn, emptyText, { showCod = false } = {}) {
  if (!rows.length) {
    return `<div class="empty-state data-report-empty"><h3>${emptyText}</h3><p>Sync Google Sheets to populate this report.</p></div>`;
  }

  return `
    <table class="data-report-table">
      <thead><tr>
        <th>${firstColumn}</th><th>Total Orders</th><th>Delivered</th><th>Returned</th><th>RTS Rate</th>${showCod ? '<th>Sales Total (COD)</th><th>Avg COD/Order</th>' : ''}
      </tr></thead>
      <tbody>
        ${rows.slice(0, 12).map((row) => {
          const codTotal = Number(row.cod || 0);
          const avgCod = row.total ? Math.round(codTotal / row.total) : 0;
          return `<tr>
            <td>${escapeHtml(row.label)}</td>
            <td>${row.total.toLocaleString()}</td>
            <td class="text-success">${row.delivered.toLocaleString()}</td>
            <td class="text-danger">${(row.returned + row.returning).toLocaleString()}</td>
            <td><span class="data-report-rate ${row.rtsRate >= 30 ? 'bad' : row.rtsRate >= 15 ? 'warn' : 'ok'}">${formatPercent(row.rtsRate)}</span></td>
            ${showCod ? `<td style="font-weight:600;">₱${codTotal.toLocaleString()}</td><td style="color:var(--text-muted);">₱${avgCod.toLocaleString()}</td>` : ''}
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function renderDataReport() {
  const records = DB.sheetRecordsForReport;
  const newOrders = records.filter((o) => o.status === 'New').length;
  const confirmed = records.filter((o) => o.status === 'Confirmed').length;
  const waiting = records.filter((o) => o.status === 'Waiting for pickup').length;
  const shipped = records.filter((o) => o.status === 'Shipped').length;
  const delivered = records.filter((o) => o.status === 'Delivered').length;
  const returned = records.filter((o) => o.status === 'Returned').length;
  const returning = records.filter((o) => o.status === 'Returning').length;
  const canceled = records.filter((o) => o.status === 'Canceled').length;
  const totalCOD = records.reduce((sum, o) => sum + Number(o.cod || 0), 0);
  const sourceOptions = getPosSourceOptions();
  const yearOptions = getPosYearOptions();
  const monthOptions = getPosMonthOptions(salesYearFilter === 'all' ? '' : salesYearFilter);
  const salesMonths = getDataReportMonths();
  if (salesFilter === 'monthly' && !salesMonth) {
    salesMonth = salesMonths[0] || normalizeDateString(new Date()).slice(0, 7);
  }

  const today = normalizeDateString(new Date());
  const rtsMonths = getDataReportMonths();
  if (rtsRateFilter === 'monthly' && !rtsRateMonth) {
    rtsRateMonth = rtsMonths[0] || today.slice(0, 7);
  }

  const pageOptions = dataReportPages.length ? dataReportPages : getPosSourceOptions();
  const presets = [['today', 'Today'], ['yesterday', 'Yesterday'], ['monthly', 'Monthly'], ['custom', 'Custom']];
  const analyticsMonths = getDataReportMonths();
  if (dataReportPreset === 'monthly' && !dataReportMonth) {
    dataReportMonth = analyticsMonths[0] || normalizeDateString(new Date()).slice(0, 7);
  }

  return `
  <div class="page-header">
    <div class="page-title"><h1>Sales Dashboard</h1><p>Track orders, deliveries, and revenue metrics.</p></div>
  </div>

  <div style="display:flex;gap:4px;margin-bottom:20px;border-bottom:2px solid var(--border-color);">
    <button class="dr-tab-btn ${dataReportTab === 'sales' ? 'active' : ''}" data-tab="sales" onclick="setDataReportTab('sales')" style="padding:10px 20px;font-size:13px;font-weight:600;border:none;background:none;cursor:pointer;color:${dataReportTab === 'sales' ? 'var(--primary)' : 'var(--text-muted)'};border-bottom:2px solid ${dataReportTab === 'sales' ? 'var(--primary)' : 'transparent'};margin-bottom:-2px;transition:color .15s;">Sales Dashboard</button>
    <button class="dr-tab-btn ${dataReportTab === 'analytics' ? 'active' : ''}" data-tab="analytics" onclick="setDataReportTab('analytics')" style="padding:10px 20px;font-size:13px;font-weight:600;border:none;background:none;cursor:pointer;color:${dataReportTab === 'analytics' ? 'var(--primary)' : 'var(--text-muted)'};border-bottom:2px solid ${dataReportTab === 'analytics' ? 'var(--primary)' : 'transparent'};margin-bottom:-2px;transition:color .15s;">Analytics</button>
    <button class="dr-tab-btn ${dataReportTab === 'roas' ? 'active' : ''}" data-tab="roas" onclick="setDataReportTab('roas')" style="padding:10px 20px;font-size:13px;font-weight:600;border:none;background:none;cursor:pointer;color:${dataReportTab === 'roas' ? 'var(--primary)' : 'var(--text-muted)'};border-bottom:2px solid ${dataReportTab === 'roas' ? 'var(--primary)' : 'transparent'};margin-bottom:-2px;transition:color .15s;">ROAS Summary</button>
  </div>

  <div class="dr-tab-panel ${dataReportTab !== 'sales' ? 'hidden' : ''}" data-tab="sales">
    <div class="card" style="margin-bottom:16px;padding:14px 18px;">
      <div style="margin-bottom:4px;font-size:14px;font-weight:700;color:var(--text-primary);">Sale Report</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;">Delivery, return-to-sender, and COD performance based on Google Sheets records.</div>
      <div class="rts-filter-bar">
        <div class="rts-filter-group">
          <div class="rts-filter-label">Time Filter</div>
          <div class="table-filters" id="rts-rate-filter-group">
            <button class="filter-pill ${rtsRateFilter === 'all' ? 'active' : ''}" onclick="setRTSRateFilter('all',this)">All Time</button>
            <button class="filter-pill ${rtsRateFilter === 'weekly' ? 'active' : ''}" onclick="setRTSRateFilter('weekly',this)">Weekly</button>
            <button class="filter-pill ${rtsRateFilter === 'monthly' ? 'active' : ''}" onclick="setRTSRateFilter('monthly',this)">Monthly</button>
            <button class="filter-pill ${rtsRateFilter === 'custom' ? 'active' : ''}" onclick="setRTSRateFilter('custom',this)">Custom Date Range</button>
          </div>
        </div>
        <div class="rts-filter-group ${rtsRateFilter === 'monthly' ? '' : 'hidden'}" id="rts-rate-month-group">
          <div class="rts-filter-label">Month</div>
          <select class="form-control" id="rts-rate-month" onchange="setRTSRateMonth()" style="min-width:160px;height:34px;font-size:13px;">
            ${rtsMonths.length
              ? rtsMonths.map((m) => `<option value="${m}"${rtsRateMonth === m ? ' selected' : ''}>${escapeHtml(monthLabel(m))}</option>`).join('')
              : `<option value="${escapeHtml(rtsRateMonth || today.slice(0,7))}">${escapeHtml(monthLabel(rtsRateMonth || today.slice(0,7)))}</option>`}
          </select>
        </div>
        <div class="rts-filter-group rts-sheet-filter">
          <label class="rts-filter-label" for="rts-rate-source-filter">Page Filter</label>
          <select class="form-control" id="rts-rate-source-filter" onchange="setRTSRateSourceFilter()">
            <option value="all">All Pages</option>
            ${sourceOptions.map((sheet) => `<option value="${escapeHtml(sheet)}" ${rtsRateSourceFilter === sheet ? 'selected' : ''}>${escapeHtml(sheet)}</option>`).join('')}
          </select>
        </div>
        <div class="rts-custom-range ${rtsRateFilter === 'custom' ? '' : 'hidden'}" id="rts-rate-custom-range">
          <input type="date" class="form-control" id="rts-rate-date-from">
          <input type="date" class="form-control" id="rts-rate-date-to">
          <button class="btn btn-secondary btn-sm" onclick="applyRTSRateCustomRange()">Apply</button>
        </div>
      </div>
    </div>
    <div id="rts-rate-dashboard" style="margin-bottom:20px;"></div>
  </div>

  <div class="dr-tab-panel ${dataReportTab !== 'analytics' ? 'hidden' : ''}" data-tab="analytics">
    <div class="card" style="margin-bottom:16px;padding:14px 18px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--text-primary);">Analytics</div>
          <div style="font-size:12px;color:var(--text-muted);">RTS analytics from synced POS records.</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="refreshDataReport()">Refresh</button>
      </div>
      <div class="rts-filter-bar">
        <div class="rts-filter-group">
          <div class="rts-filter-label">Time Filter</div>
          <div class="table-filters">
            ${presets.map(([v, l]) => `<button class="filter-pill ${dataReportPreset === v ? 'active' : ''}" onclick="setDataReportPreset('${v}')">${l}</button>`).join('')}
          </div>
        </div>
        <div class="rts-filter-group ${dataReportPreset === 'monthly' ? '' : 'hidden'}" id="data-report-month-group">
          <div class="rts-filter-label">Month</div>
          <select class="form-control" id="data-report-month" onchange="setDataReportMonth()" style="min-width:160px;height:34px;font-size:13px;">
            ${analyticsMonths.length
              ? analyticsMonths.map((m) => `<option value="${m}"${dataReportMonth === m ? ' selected' : ''}>${escapeHtml(monthLabel(m))}</option>`).join('')
              : `<option value="${escapeHtml(dataReportMonth)}">${escapeHtml(monthLabel(dataReportMonth))}</option>`}
          </select>
        </div>
        <div class="rts-filter-group rts-sheet-filter">
          <label class="rts-filter-label" for="data-report-page-filter">Page Filter</label>
          <select class="form-control" id="data-report-page-filter" onchange="setDataReportPageFilter()">
            <option value="all">All Pages</option>
            ${pageOptions.map((p) => `<option value="${escapeHtml(p)}"${dataReportPageFilter === p ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}
          </select>
        </div>
        <div class="rts-custom-range ${dataReportPreset === 'custom' ? '' : 'hidden'}" id="data-report-custom-range">
          <input type="date" class="form-control" id="data-report-date-from" value="${dataReportDateFrom}">
          <input type="date" class="form-control" id="data-report-date-to" value="${dataReportDateTo}">
          <button class="btn btn-secondary btn-sm" onclick="applyDataReportCustomRange()">Apply</button>
        </div>
      </div>
    </div>
    <div id="data-report-dashboard" style="margin-bottom:20px;"></div>
  </div>

  <div class="dr-tab-panel ${dataReportTab !== 'roas' ? 'hidden' : ''}" data-tab="roas">
    <div class="card" style="margin-bottom:16px;padding:14px 18px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--text-primary);">ROAS Summary</div>
          <div style="font-size:12px;color:var(--text-muted);">Ad-level performance from synced POS records. Uses the same time and page filters as the Analytics tab.</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="refreshDataReport()">Refresh</button>
      </div>
    </div>
    <div id="roas-summary-dashboard" style="margin-bottom:20px;"></div>
  </div>`;
}

function renderDataReportDashboard() {
  renderRoasSummaryDashboard();

  const wrapper = document.getElementById('data-report-dashboard');
  if (!wrapper) return;

  if (dataReportSummaryLoading || !dataReportSummary) {
    wrapper.innerHTML = '<div class="loading-spinner" style="margin:48px auto;"></div>';
    return;
  }

  const { rtsRate, byPrice, byConfirmed, byProvince } = dataReportSummary;
  const byPage = dataReportSummary.byPage || [];

  const subTabs = [
    ['price', 'By Price'],
    ['staff', 'By Assigned Staff'],
    ['province', 'By Province/City'],
    ['page', 'Page Report'],
    ['stocks', 'Stocks'],
  ];
  if (!subTabs.some(([v]) => v === dataReportAnalyticsSubTab)) dataReportAnalyticsSubTab = 'price';
  const active = dataReportAnalyticsSubTab;

  let cardHtml = '';
  if (active === 'price') {
    cardHtml = `
    <section class="data-report-section">
      <div class="card-header">
        <div><div class="card-title">By Price (Final Amount)</div><div class="card-subtitle">RTS rate by order price range</div></div>
      </div>
      <div class="data-report-chart-wrap"><canvas id="data-report-price-chart"></canvas></div>
    </section>`;
  } else if (active === 'staff') {
    cardHtml = `
    <section class="data-report-section">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div class="card-title">By Assigned Staff</div>
          <div class="card-subtitle">Orders and RTS rate per assigned staff member</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="openStaffMergeModal()">Merge staff…</button>
      </div>
      ${renderDataReportTable(byConfirmed, 'Assigned Staff', 'No staff data yet', { showCod: true })}
    </section>`;
  } else if (active === 'province') {
    cardHtml = `
    <section class="data-report-section">
      <div class="card-header">
        <div><div class="card-title">By Province/City</div><div class="card-subtitle">RTS rate grouped by province/city</div></div>
      </div>
      ${renderDataReportTable(byProvince, 'Province/City', 'No province data yet')}
    </section>`;
  } else if (active === 'page') {
    cardHtml = `
    <section class="data-report-section">
      <div class="card-header">
        <div><div class="card-title">Page Report</div><div class="card-subtitle">Total orders, delivered, returned and RTS rate per page</div></div>
      </div>
      ${renderDataReportTable(byPage, 'Page', 'No page data yet')}
    </section>`;
  } else if (active === 'stocks') {
    cardHtml = renderStockAnalyticsCard();
  }

  wrapper.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;">
      ${subTabs.map(([v, l]) => `<button class="filter-pill ${active === v ? 'active' : ''}" onclick="setDataReportAnalyticsSubTab('${v}')">${l}</button>`).join('')}
    </div>
    ${cardHtml}
`;

  if (active === 'price') renderDataReportPriceChart(byPrice);
}

function renderRoasSummaryDashboard() {
  const wrapper = document.getElementById('roas-summary-dashboard');
  if (!wrapper) return;

  if (dataReportSummaryLoading || !dataReportSummary) {
    wrapper.innerHTML = '<div class="loading-spinner" style="margin:48px auto;"></div>';
    return;
  }

  const byAdId = dataReportSummary.byAdId || [];
  wrapper.innerHTML = `
    <section class="data-report-section">
      <div class="card-header">
        <div><div class="card-title">By Ads ID</div><div class="card-subtitle">Orders and RTS rate grouped by ad id</div></div>
      </div>
      ${renderDataReportTable(byAdId, 'Ads ID', 'No ads ID data yet')}
    </section>
`;
}

// Stocks sub-tab data comes from the Inventory endpoints, not the POS summary:
// item list (name/stock/price) + RTS pcs derived via the page→SKU map.
async function loadStockAnalyticsData() {
  if (dataReportStocksLoading) return;
  dataReportStocksLoading = true;
  try {
    await Promise.all([
      refreshInventoryFromBackend().catch(() => {}),
      refreshRtsPcsByProduct().catch(() => {}),
    ]);
    dataReportStocksLoaded = true;
  } finally {
    dataReportStocksLoading = false;
    if (App.currentPage === 'data-report' && dataReportTab === 'analytics' && dataReportAnalyticsSubTab === 'stocks') {
      renderDataReportDashboard();
    }
  }
}

function renderStockAnalyticsCard() {
  if (!dataReportStocksLoaded) {
    if (!dataReportStocksLoading) loadStockAnalyticsData();
    return `<section class="data-report-section"><div class="loading-spinner" style="margin:48px auto;"></div></section>`;
  }

  const { skuPcs, namePcs } = computeRtsPcsLookups();
  const getRtsPcs = (item) => (item.sku && skuPcs[item.sku] != null)
    ? Number(skuPcs[item.sku])
    : Number(namePcs[normalizeProductKey(item.name)] || 0);

  const rows = (DB.inventory || []).slice()
    .sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0) || String(a.name).localeCompare(String(b.name)));

  let body;
  if (!rows.length) {
    body = `<div class="empty-state data-report-empty"><h3>No stock data yet</h3><p>Add items on the Inventory page to populate this report.</p></div>`;
  } else {
    body = `
    <table class="data-report-table">
      <thead><tr>
        <th>Product/Supplies</th><th style="text-align:right">Total Stocks</th><th style="text-align:right">RTS</th><th style="text-align:right">Cost (Total)</th>
      </tr></thead>
      <tbody>
        ${rows.map((item) => {
          const rtsPcs = getRtsPcs(item);
          const unitCost = Number(item.cost || 0);
          const totalCost = unitCost * Number(item.stock || 0);
          return `<tr>
            <td>${escapeHtml(item.name || '—')}<span style="color:var(--text-muted);font-size:11px;"> · ${escapeHtml(item.type || 'Product')}</span></td>
            <td style="text-align:right;">${Number(item.stock || 0).toLocaleString()}</td>
            <td style="text-align:right;" class="${rtsPcs ? 'text-danger' : ''}">${rtsPcs ? rtsPcs.toLocaleString() : '—'}</td>
            <td style="text-align:right;">${totalCost ? `₱${totalCost.toLocaleString()}` : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  }

  return `
    <section class="data-report-section">
      <div class="card-header">
        <div><div class="card-title">Stocks</div><div class="card-subtitle">Total stocks, RTS pcs and total cost (cost price × stock) per product/supply</div></div>
      </div>
      ${body}
    </section>`;
}

// Persistent staff alias merge (Data Report "By Assigned Staff" only). Maps an
// assigning_seller_name to another name so their rows combine in the report.
async function openStaffMergeModal() {
  let overlay = document.getElementById('staff-merge-modal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'staff-merge-modal';
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('open'); };
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="modal" style="max-width:560px;">
      <div class="modal-header">
        <div class="modal-title">Merge Assigned Staff</div>
        <button class="modal-close" onclick="document.getElementById('staff-merge-modal').classList.remove('open')">×</button>
      </div>
      <div class="modal-body" id="staff-merge-body">
        <div class="loading-spinner" style="margin:32px auto;"></div>
      </div>
    </div>`;
  overlay.classList.add('open');
  await renderStaffMergeBody();
}

async function renderStaffMergeBody() {
  const body = document.getElementById('staff-merge-body');
  if (!body) return;
  try {
    const data = await authorizedJsonRequest(`/integrations/google-sheets/staff-merge-map?_=${Date.now()}`);
    const names = Array.isArray(data.names) ? data.names : [];
    const map = {};
    (Array.isArray(data.map) ? data.map : []).forEach((m) => { if (m.alias) map[m.alias] = m.canonical || ''; });
    if (!names.length) {
      body.innerHTML = `<div class="empty-state" style="padding:24px 0;"><p>No assigned staff names found yet.</p></div>`;
      return;
    }
    const datalist = `<datalist id="staff-merge-options">${names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>`;
    const rows = names.map((n) => {
      const canonical = map[n] || '';
      return `<tr>
        <td style="text-align:center;"><input type="checkbox" class="staff-merge-check" value="${escapeHtml(n)}"></td>
        <td style="font-weight:500;">${escapeHtml(n)}</td>
        <td><input type="text" class="form-control" style="width:180px;padding:4px 8px;height:auto;font-size:12px;" list="staff-merge-options" value="${escapeHtml(canonical)}" placeholder="Keep separate" onchange="saveStaffMerge('${encodeURIComponent(n)}', this.value)"></td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Tick multiple staff and merge them into one target at once, or set a single row's "Merge into" target. Merged staff have their orders summed. Applies to the By Assigned Staff card only.</p>
      ${datalist}
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
        <input type="text" id="staff-merge-target" class="form-control" list="staff-merge-options" placeholder="Merge selected into…" style="width:220px;padding:6px 10px;height:auto;font-size:13px;">
        <button class="btn btn-primary btn-sm" onclick="saveStaffMergeBulk()">Merge selected</button>
      </div>
      <table class="data-report-table">
        <thead><tr><th style="text-align:center;width:32px;"><input type="checkbox" onchange="document.querySelectorAll('.staff-merge-check').forEach(c=>c.checked=this.checked)"></th><th>Staff Name</th><th>Merge into</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } catch (err) {
    body.innerHTML = `<div class="empty-state" style="padding:24px 0;"><p>Failed to load: ${escapeHtml(err.message || 'error')}</p></div>`;
  }
}

async function saveStaffMerge(aliasEnc, canonical) {
  const alias = decodeURIComponent(aliasEnc);
  try {
    await authorizedJsonRequest('/integrations/google-sheets/staff-merge-map', {
      method: 'PUT',
      body: JSON.stringify({ alias, canonical: String(canonical || '').trim() }),
    });
    showToast('success', 'Saved', `${alias} → ${String(canonical || '').trim() || '(separate)'}`);
    await refreshDataReport();
  } catch (err) {
    showToast('error', 'Save failed', err.message || 'Could not save merge.');
  }
}

// Merge every checked staff name into one target in a single action.
async function saveStaffMergeBulk() {
  const target = String(document.getElementById('staff-merge-target')?.value || '').trim();
  if (!target) {
    showToast('warning', 'Pick a target', 'Type the name to merge the selected staff into.');
    return;
  }
  const aliases = [...document.querySelectorAll('.staff-merge-check:checked')]
    .map((c) => c.value)
    .filter((v) => v && v !== target);
  if (!aliases.length) {
    showToast('warning', 'Select staff', 'Tick at least one staff name (other than the target) to merge.');
    return;
  }
  try {
    for (const alias of aliases) {
      await authorizedJsonRequest('/integrations/google-sheets/staff-merge-map', {
        method: 'PUT',
        body: JSON.stringify({ alias, canonical: target }),
      });
    }
    showToast('success', 'Merged', `${aliases.length} staff → ${target}`);
    await renderStaffMergeBody();
    await refreshDataReport();
  } catch (err) {
    showToast('error', 'Merge failed', err.message || 'Could not save merges.');
  }
}

async function loadConfirmedByStats() {
  const wrap = document.getElementById('confirmed-by-table-wrap');
  if (!wrap) return;

  const source = document.getElementById('cb-source-filter')?.value || 'all';
  const from = document.getElementById('cb-from')?.value || '';
  const to = document.getElementById('cb-to')?.value || '';

  wrap.innerHTML = '<div class="loading-spinner" style="margin:24px auto;"></div>';

  try {
    const params = new URLSearchParams();
    if (source && source !== 'all') params.set('source', source);
    if (from) params.set('from', from);
    if (to) params.set('to', to);

    const data = await authorizedJsonRequest(`/integrations/pancake-pos/staff-stats?${params}`);

    // Populate source dropdown
    const sel = document.getElementById('cb-source-filter');
    if (sel && Array.isArray(data.sources)) {
      const current = sel.value;
      sel.innerHTML = '<option value="all">All Pages</option>'
        + data.sources.map((s) => `<option value="${escapeHtml(s)}" ${s === current ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
    }

    wrap.innerHTML = renderConfirmedByStatsTable(data.stats || []);
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state" style="padding:24px 0;"><p>Failed to load: ${escapeHtml(err.message)}</p></div>`;
  }
}

function renderConfirmedByStatsTable(stats) {
  if (!stats.length) {
    return `<div class="empty-state" style="padding:24px 0;"><h3>No staff yet</h3><p>Click "Sync Staff Users" on the Pancake POS integration page to populate this list.</p></div>`;
  }
  return `
    <table class="data-report-table">
      <thead><tr>
        <th>Staff (Assigned)</th>
        <th style="text-align:right">Total</th>
        <th style="text-align:right">Delivered</th>
        <th style="text-align:right">Returned</th>
        <th style="text-align:right">Active</th>
        <th style="text-align:right">RTS Rate</th>
      </tr></thead>
      <tbody>
        ${stats.map((row) => {
          const rts = Number(row.rts_rate || 0);
          return `<tr>
            <td>${escapeHtml(row.staff_name || '—')}</td>
            <td style="text-align:right">${Number(row.total || 0).toLocaleString()}</td>
            <td style="text-align:right" class="text-success">${Number(row.delivered || 0).toLocaleString()}</td>
            <td style="text-align:right" class="text-danger">${Number(row.returned || 0).toLocaleString()}</td>
            <td style="text-align:right">${Number(row.active || 0).toLocaleString()}</td>
            <td style="text-align:right"><span class="data-report-rate ${rts >= 30 ? 'bad' : rts >= 15 ? 'warn' : 'ok'}">${rts.toFixed(1)}%</span></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function upsertChart(existing, canvas, hasData, config) {
  if (!canvas || typeof Chart === 'undefined') return existing || null;
  // Discard stale instance if the canvas was replaced by a page re-render
  if (existing && (existing.canvas !== canvas || !canvas.isConnected)) {
    try { existing.destroy(); } catch {}
    existing = null;
  }
  if (!hasData) {
    if (existing) existing.destroy();
    return null;
  }
  if (!existing) return new Chart(canvas, config);
  existing.data = config.data;
  if (config.options) existing.options = config.options;
  existing.update();
  return existing;
}

function renderDataReportPriceChart(rows) {
  const canvas = document.getElementById('data-report-price-chart');
  dataReportPriceChart = upsertChart(dataReportPriceChart, canvas, rows.length > 0, {
    type: 'line',
    data: {
      labels: rows.map((row) => row.label),
      datasets: [{
        label: 'RTS Rate',
        data: rows.map((row) => Number(row.rtsRate.toFixed(2))),
        borderColor: '#e66a63',
        backgroundColor: 'rgba(230, 106, 99, 0.1)',
        pointBackgroundColor: '#e66a63',
        pointRadius: 4,
        pointHoverRadius: 6,
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, max: 100, ticks: { callback: (value) => `${value}%` }, grid: { color: '#eef2f7' } },
        x: { grid: { display: false }, ticks: { maxRotation: 38, minRotation: 38 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (context) => `${context.parsed.y}% RTS` } },
      },
    },
  });
}

function renderConfirmedByTable(rows) {
  if (!rows.length) {
    return `<div class="empty-state data-report-empty"><h3>No confirming data yet</h3><p>Sync Pancake POS orders to populate this report.</p></div>`;
  }
  return `
    <table class="data-report-table">
      <thead><tr>
        <th>Staff</th>
        <th style="text-align:right">Total</th>
        <th style="text-align:right">Delivered</th>
        <th style="text-align:right">Returned</th>
        <th style="text-align:right">Canceled</th>
        <th style="text-align:right">Active</th>
        <th style="text-align:right">RTS Rate</th>
      </tr></thead>
      <tbody>
        ${rows.map((row) => `<tr>
          <td>${escapeHtml(row.label)}</td>
          <td style="text-align:right">${row.total.toLocaleString()}</td>
          <td style="text-align:right" class="text-success">${row.delivered.toLocaleString()}</td>
          <td style="text-align:right" class="text-danger">${(row.returned + row.returning).toLocaleString()}</td>
          <td style="text-align:right">${row.canceled.toLocaleString()}</td>
          <td style="text-align:right">${row.active.toLocaleString()}</td>
          <td style="text-align:right"><span class="data-report-rate ${row.rtsRate >= 30 ? 'bad' : row.rtsRate >= 15 ? 'warn' : 'ok'}">${formatPercent(row.rtsRate)}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}


function computePresetRange(preset) {
  const today = new Date();
  const fmt = (d) => normalizeDateString(d);
  if (preset === 'all') return { from: '2020-01-01', to: fmt(today) };
  if (preset === 'weekly') return { from: fmt(getDateDaysAgo(6)), to: fmt(today) };
  if (preset === 'monthly') {
    return {
      from: fmt(new Date(today.getFullYear(), today.getMonth(), 1)),
      to: fmt(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
    };
  }
  return null;
}

function setMarketingPreset(preset) {
  const currentPage = window.mktFilter?.page || '';
  if (preset === 'custom') {
    window.mktFilter = { ...(window.mktFilter || {}), preset, page: currentPage };
  } else {
    const range = computePresetRange(preset);
    window.mktFilter = { preset, from: range.from, to: range.to, page: currentPage };
  }
  navigateTo('marketing-center');
}

function applyMarketingFilter() {
  const from = document.getElementById('mkt-filter-from')?.value || '';
  const to = document.getElementById('mkt-filter-to')?.value || '';
  const page = document.getElementById('mkt-filter-page')?.value || '';
  if (from) {
    window.mktFilter = { ...(window.mktFilter || {}), preset: 'custom', from, to: to || from, page };
  } else {
    window.mktFilter = { ...(window.mktFilter || {}), page };
  }
  navigateTo('marketing-center');
}

function autoFillMarketingSalesFromOrders() {
  const pageName = document.getElementById('mkt-page')?.value || '';
  const date = document.getElementById('mkt-date')?.value || '';
  if (!pageName || !date) {
    showToast('warning', 'Select page and date first', 'Both page and date are required to auto-fill.');
    return;
  }
  const delivered = (DB.orders || []).filter((o) => {
    if (o.status !== 'Delivered') return false;
    if (o.date !== date) return false;
    const sheet = String(o.sourceSheet || '').toLowerCase();
    const page = pageName.toLowerCase();
    return sheet === page || sheet.includes(page) || page.includes(sheet);
  });
  const total = delivered.reduce((s, o) => s + Number(o.cod || 0), 0);
  const count = delivered.length;
  const salesInput = document.getElementById('mkt-sales');
  const ordersInput = document.getElementById('mkt-orders');
  if (salesInput) salesInput.value = total;
  if (ordersInput) ordersInput.value = count;
  showToast('success', 'Auto-filled from delivered orders', `${count} orders — PHP ${total.toLocaleString()}`);
}

// ─── AD SPEND ROAS SUMMARY ─────────────────────────────────
let adspendDateFrom = '';
let adspendDateTo = '';
let adspendDatePreset = 'weekly';
let adspendMonth = ''; // 'YYYY-MM' for the Monthly preset month dropdown
let adspendPageFilter = 'all';
let adspendStatusFilters = new Set();
let adspendAdsRequestKey = '';
let adspendAdsLoading = false;
let adspendAdsData = null;
let adspendAdsShopFilter = 'all';
let adspendAdsStatusFilter = 'all';
let adspendAdsSearch = '';
let adspendAdsView = 'adsets';
let adspendIndividualAdsData = null;
let adspendIndividualAdsLoading = false;
let adspendRoasPage = 1;
let adspendRoasPerPage = 20;
let adspendActiveTab = 'summary';
let adspendAllPagesIndex = 0;

function setAdspendTab(tab) {
  adspendActiveTab = tab;
  const summary = document.getElementById('adspend-tab-summary');
  const allpages = document.getElementById('adspend-tab-allpages');
  const adsets = document.getElementById('adspend-tab-adsets');
  if (summary) summary.style.display = tab === 'summary' ? 'block' : 'none';
  if (allpages) allpages.style.display = tab === 'allpages' ? 'block' : 'none';
  if (adsets) adsets.style.display = tab === 'adsets' ? 'block' : 'none';
  document.querySelectorAll('.adspend-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
}

// Slide the All Pages tab one chat page at a time.
function slideAdspendPage(dir) {
  adspendAllPagesIndex += dir;
  navigateTo('adspend-roas');
}

function setAdspendAllPagesIndex(idx) {
  adspendAllPagesIndex = Number(idx) || 0;
  navigateTo('adspend-roas');
}

const ADSPEND_STATUS_MAP = [
  ['Confirmed',          'adspend-cb-confirmed', 'View Confirmed'],
  ['Waiting for pickup', 'adspend-cb-waiting',   'View Waiting for pickup'],
  ['Shipped',            'adspend-cb-shipped',   'View Shipped'],
  ['Delivered',          'adspend-cb-delivered', 'View Delivered'],
  ['Returning',          'adspend-cb-returning', 'View Returning'],
  ['Returned',           'adspend-cb-returned',  'View Returned'],
];

const ADSPEND_ALLOWED_STATUSES = new Set(['Confirmed', 'Waiting for pickup', 'Shipped', 'Delivered', 'Returning', 'Returned']);

// Date range (from/to) for a 'YYYY-MM' month string.
function adspendMonthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const last = new Date(y, m, 0).getDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

function setAdspendPreset(preset) {
  adspendDatePreset = preset;
  if (preset === 'monthly') {
    if (!adspendMonth) adspendMonth = normalizeDateString(new Date()).slice(0, 7);
    const r = adspendMonthRange(adspendMonth);
    adspendDateFrom = r.from; adspendDateTo = r.to;
  } else if (preset !== 'custom') {
    const range = computePresetRange(preset);
    if (range) { adspendDateFrom = range.from; adspendDateTo = range.to; }
  }
  adspendRoasPage = 1;
  navigateTo('adspend-roas');
}

function setAdspendMonth(ym) {
  adspendMonth = ym;
  adspendDatePreset = 'monthly';
  const r = adspendMonthRange(ym);
  adspendDateFrom = r.from; adspendDateTo = r.to;
  adspendRoasPage = 1;
  navigateTo('adspend-roas');
}

function applyAdspendFilter(suffix) {
  suffix = suffix || '';
  const from = document.getElementById('adspend-from' + suffix)?.value || '';
  const to = document.getElementById('adspend-to' + suffix)?.value || '';
  if (from) {
    adspendDateFrom = from;
    adspendDateTo = to || from;
    adspendDatePreset = 'custom';
  }
  // Page dropdown only exists on the Summary tab; the All Pages tab iterates
  // every page so it leaves the page filter untouched.
  const pageEl = document.getElementById('adspend-page' + suffix);
  if (pageEl) adspendPageFilter = pageEl.value || 'all';
  adspendStatusFilters.clear();
  ADSPEND_STATUS_MAP.forEach(([status, id]) => {
    if (document.getElementById(id + suffix)?.checked) adspendStatusFilters.add(status);
  });
  adspendRoasPage = 1;
  navigateTo('adspend-roas');
}

function changeAdspendRoasPage(page) {
  adspendRoasPage = Math.max(1, page);
  navigateTo('adspend-roas');
}

function setAdspendRoasPerPage(val) {
  adspendRoasPerPage = Number(val) || 20;
  adspendRoasPage = 1;
  navigateTo('adspend-roas');
}

function adspendApiMoney(value) {
  return `PHP ${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function adspendMetricMoney(value) {
  const parsed = Number(value || 0);
  return parsed ? `PHP ${parsed.toLocaleString('en-PH', { maximumFractionDigits: 2 })}` : '-';
}

function getAdspendCampaignId(item) {
  const directId = String(item?.campaign_id || item?.campaignId || '').trim();
  if (directId) return directId;
  const text = String(item?.campaign_name || '').trim();
  return text.match(/\b\d{8,}\b/)?.[0] || '-';
}

function getAdspendAdsRequestKey() {
  return 'ad-sets-v2';
}

function renderAdspendAdsCardShell(totalAmount) {
  return `
    <div class="card adspend-ads-card" id="adspend-ads-card" data-orders-amount="${Number(totalAmount || 0)}" style="margin-top:16px;">
      <div class="adspend-ads-head">
        <div>
          <div class="adspend-ads-kicker">Pancake Ads Manager</div>
          <h3>Live Ad Sets</h3>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="refreshAdspendAds()">Refresh Ads</button>
      </div>
      <div id="adspend-ads-card-body" class="adspend-ads-loading">Loading Pancake ads...</div>
    </div>`;
}

function getFilteredAdspendAdsItems(data) {
  const rawItems = Array.isArray(data?.items) ? data.items : [];
  const search = normalizeText(adspendAdsSearch);
  return rawItems.filter((item) => {
    if (adspendAdsShopFilter !== 'all' && String(item.shop_id || item.shop_name || '') !== adspendAdsShopFilter) return false;
    if (adspendAdsStatusFilter !== 'all' && String(item.status || '-').toLowerCase() !== adspendAdsStatusFilter.toLowerCase()) return false;
    if (search) {
      const haystack = normalizeText(`${getAdspendCampaignId(item)} ${item.campaign_name || ''} ${item.name || ''} ${item.shop_name || ''} ${item.status || ''} ${item.id || ''}`);
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function renderAdspendAdsFilters(data) {
  const rawItems = Array.isArray(data?.items) ? data.items : [];
  const shopOptions = [...new Map(rawItems.map((item) => [
    String(item.shop_id || item.shop_name || ''),
    item.shop_name || item.shop_id || 'Unknown shop',
  ]).filter(([id]) => id)).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const statusOptions = [...new Set(rawItems.map((item) => String(item.status || '-')).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  return `
    <div class="adspend-ads-filters">
      <div class="adspend-ads-search">
        <input type="text" class="form-control" id="adspend-ads-search" value="${escapeHtml(adspendAdsSearch)}" placeholder="Search campaign, ad set, shop, status" oninput="applyAdspendAdsFilters()">
      </div>
      <select class="form-control" id="adspend-ads-shop" onchange="applyAdspendAdsFilters()">
        <option value="all"${adspendAdsShopFilter === 'all' ? ' selected' : ''}>All Shops</option>
        ${shopOptions.map(([id, label]) => `<option value="${escapeHtml(id)}"${adspendAdsShopFilter === id ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
      </select>
      <select class="form-control" id="adspend-ads-status" onchange="applyAdspendAdsFilters()">
        <option value="all"${adspendAdsStatusFilter === 'all' ? ' selected' : ''}>All Statuses</option>
        ${statusOptions.map((status) => `<option value="${escapeHtml(status)}"${adspendAdsStatusFilter === status ? ' selected' : ''}>${escapeHtml(status)}</option>`).join('')}
      </select>
    </div>`;
}

function applyAdspendAdsFilters() {
  adspendAdsSearch = document.getElementById('adspend-ads-search')?.value || '';
  adspendAdsShopFilter = document.getElementById('adspend-ads-shop')?.value || 'all';
  adspendAdsStatusFilter = document.getElementById('adspend-ads-status')?.value || 'all';
  const body = document.getElementById('adspend-ads-card-body');
  const card = document.getElementById('adspend-ads-card');
  if (body && card) {
    body.innerHTML = renderAdspendAdsCardBody(adspendAdsData, Number(card.dataset.ordersAmount || 0));
  }
}

function setAdspendAdsView(view) {
  adspendAdsView = view;
  const body = document.getElementById('adspend-ads-card-body');
  const card = document.getElementById('adspend-ads-card');
  if (body && card) {
    body.innerHTML = renderAdspendAdsCardBody(adspendAdsData, Number(card.dataset.ordersAmount || 0));
  }
}

// Aggregate ad-set rows into one row per campaign id. Sums additive counters
// and derives ratio metrics (CPC/CPM/CTR/CPP/ROAS) from the summed totals so
// they stay accurate rather than averaging per-ad-set ratios.
function aggregateAdspendCampaigns(items) {
  const map = new Map();
  items.forEach((item) => {
    const id = getAdspendCampaignId(item);
    if (!map.has(id)) {
      map.set(id, {
        campaign_id: id,
        campaign_name: item.campaign_name || '',
        adSets: 0,
        shops: new Set(),
        statuses: new Set(),
        budget: 0, spend: 0, reach: 0, impressions: 0, clicks: 0,
        results: 0, revenue: 0,
      });
    }
    const row = map.get(id);
    if (!row.campaign_name && item.campaign_name) row.campaign_name = item.campaign_name;
    row.adSets += 1;
    if (item.shop_name || item.shop_id) row.shops.add(item.shop_name || item.shop_id);
    if (item.status) row.statuses.add(item.status);
    row.budget += Number(item.budget || 0);
    row.spend += Number(item.spend || 0);
    row.reach += Number(item.reach || 0);
    row.impressions += Number(item.impressions || 0);
    row.clicks += Number(item.clicks || 0);
    // Derive purchase count and revenue from per-ad-set ratios so the campaign
    // totals can recompute weighted CPP / ROAS.
    const cpp = Number(item.cpp || 0);
    if (cpp > 0) row.results += Number(item.spend || 0) / cpp;
    row.revenue += Number(item.result_roas || 0) * Number(item.spend || 0);
  });
  return [...map.values()].map((row) => ({
    ...row,
    cpc: row.clicks > 0 ? row.spend / row.clicks : 0,
    cpm: row.impressions > 0 ? (row.spend / row.impressions) * 1000 : 0,
    ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
    cpp: row.results > 0 ? row.spend / row.results : 0,
    roas: row.spend > 0 ? row.revenue / row.spend : 0,
    frequency: row.reach > 0 ? row.impressions / row.reach : 0,
  }));
}

function renderAdspendAdsSubtabs(view) {
  const tab = (key, label) => `<button type="button" class="filter-pill${view === key ? ' active' : ''}" onclick="setAdspendAdsView('${key}')">${label}</button>`;
  return `
    <div class="adspend-ads-subtabs" style="display:flex;gap:8px;margin-bottom:14px;">
      ${tab('adsets', 'Ad Sets')}${tab('campaigns', 'Campaigns')}
    </div>`;
}

function renderAdspendAdsCardBody(data, totalAmount) {
  const view = adspendAdsView;
  const subtabs = renderAdspendAdsSubtabs(view);

  // The Ads view pulls from a separately-fetched, lazily-loaded dataset; the
  // other two views reuse the ad-set payload passed in as `data`.
  const sourceData = view === 'ads' ? adspendIndividualAdsData : data;
  if (view === 'ads' && !sourceData) {
    if (!adspendIndividualAdsLoading) loadAdspendIndividualAds().catch(() => {});
    return `${subtabs}<div class="adspend-ads-loading">Loading individual ads...</div>`;
  }
  if (!sourceData) return `${subtabs}<div class="adspend-ads-loading">Loading Pancake ads...</div>`;
  if (sourceData.error) return `${subtabs}<div class="adspend-ads-empty">Ads API unavailable: ${escapeHtml(sourceData.error)}</div>`;

  const rawItems = Array.isArray(sourceData.items) ? sourceData.items : [];
  const items = getFilteredAdspendAdsItems(sourceData);
  const spend = items.reduce((sum, item) => sum + Number(item.spend || 0), 0);
  const impressions = items.reduce((sum, item) => sum + Number(item.impressions || 0), 0);
  const clicks = items.reduce((sum, item) => sum + Number(item.clicks || 0), 0);
  const reach = items.reduce((sum, item) => sum + Number(item.reach || 0), 0);
  // ROAS from the Ads API itself (revenue = result_roas x spend), not Google Sheets.
  const apiRevenue = items.reduce((sum, item) => sum + Number(item.result_roas || 0) * Number(item.spend || 0), 0);
  const roas = spend > 0 ? apiRevenue / spend : 0;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const tableItems = [...items].sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));
  const failed = Array.isArray(sourceData.failed_shops) ? sourceData.failed_shops : [];
  const failedHtml = failed.length ? `
    <div class="adspend-ads-failures">
      ${failed.map((shop) => `<div><strong>${escapeHtml(shop.name || shop.shop_id || 'Shop')}</strong>: ${escapeHtml(shop.error || 'Ads API failed')}</div>`).join('')}
    </div>` : '';
  const campaigns = view === 'campaigns' ? aggregateAdspendCampaigns(items).sort((a, b) => b.spend - a.spend) : [];
  const unit = view === 'campaigns' ? 'campaigns' : view === 'ads' ? 'ads' : 'ad sets';
  const unitLabel = view === 'campaigns' ? 'Campaigns' : view === 'ads' ? 'Ads' : 'Ad Sets';
  const unitCount = view === 'campaigns' ? campaigns.length : items.length;
  const emptyMessage = rawItems.length
    ? `No ${unit} match these filters.`
    : `Pancake Ads Manager returned 0 ${unit} for the connected shops.`;

  const adSetsTable = `
    <div class="adspend-ads-table-wrap">
      <table class="adspend-ads-table">
        <thead><tr><th>Campaign ID</th><th>Ad Set</th><th>Shop</th><th>Status</th><th>Budget</th><th>Spend</th><th>Reach</th><th>Impressions</th><th>Clicks</th><th>CPC</th><th>CPP</th><th>CPM</th><th>CTR</th><th>ROAS</th><th>Frequency</th></tr></thead>
        <tbody>
          ${tableItems.length ? tableItems.map((item) => `<tr>
            <td>${escapeHtml(getAdspendCampaignId(item))}</td>
            <td>${escapeHtml(item.name || 'Untitled ad set')}</td>
            <td>${escapeHtml(item.shop_name || item.shop_id || '-')}</td>
            <td>${escapeHtml(item.status || '-')}</td>
            <td>${Number(item.budget || 0) ? adspendApiMoney(item.budget) : '-'}</td>
            <td>${adspendApiMoney(item.spend)}</td>
            <td>${Number(item.reach || 0).toLocaleString()}</td>
            <td>${Number(item.impressions || 0).toLocaleString()}</td>
            <td>${Number(item.clicks || 0).toLocaleString()}</td>
            <td>${adspendMetricMoney(item.cpc)}</td>
            <td>${adspendMetricMoney(item.cpp)}</td>
            <td>${adspendMetricMoney(item.cpm)}</td>
            <td>${Number(item.ctr || 0) ? Number(item.ctr || 0).toFixed(2) : '-'}</td>
            <td>${Number(item.result_roas || 0) ? Number(item.result_roas || 0).toFixed(2) : '-'}</td>
            <td>${Number(item.frequency || 0) ? Number(item.frequency || 0).toFixed(2) : '-'}</td>
          </tr>`).join('') : `<tr><td colspan="15">${escapeHtml(emptyMessage)}</td></tr>`}
        </tbody>
      </table>
    </div>`;

  const campaignsTable = `
    <div class="adspend-ads-table-wrap">
      <table class="adspend-ads-table">
        <thead><tr><th>Campaign ID</th><th>Campaign</th><th>Ad Sets</th><th>Shop</th><th>Status</th><th>Budget</th><th>Spend</th><th>Reach</th><th>Impressions</th><th>Clicks</th><th>CPC</th><th>CPP</th><th>CPM</th><th>CTR</th><th>ROAS</th><th>Frequency</th></tr></thead>
        <tbody>
          ${campaigns.length ? campaigns.map((c) => `<tr>
            <td>${escapeHtml(c.campaign_id)}</td>
            <td>${escapeHtml(c.campaign_name || 'Untitled campaign')}</td>
            <td>${c.adSets.toLocaleString()}</td>
            <td>${escapeHtml([...c.shops].join(', ') || '-')}</td>
            <td>${escapeHtml([...c.statuses].join(', ') || '-')}</td>
            <td>${c.budget ? adspendApiMoney(c.budget) : '-'}</td>
            <td>${adspendApiMoney(c.spend)}</td>
            <td>${c.reach.toLocaleString()}</td>
            <td>${c.impressions.toLocaleString()}</td>
            <td>${c.clicks.toLocaleString()}</td>
            <td>${adspendMetricMoney(c.cpc)}</td>
            <td>${adspendMetricMoney(c.cpp)}</td>
            <td>${adspendMetricMoney(c.cpm)}</td>
            <td>${c.ctr ? c.ctr.toFixed(2) : '-'}</td>
            <td>${c.roas ? c.roas.toFixed(2) : '-'}</td>
            <td>${c.frequency ? c.frequency.toFixed(2) : '-'}</td>
          </tr>`).join('') : `<tr><td colspan="16">${escapeHtml(emptyMessage)}</td></tr>`}
        </tbody>
      </table>
    </div>`;

  const adsTable = `
    <div class="adspend-ads-table-wrap">
      <table class="adspend-ads-table">
        <thead><tr><th>Ad</th><th>Ad Set</th><th>Campaign ID</th><th>Shop</th><th>Status</th><th>Budget</th><th>Spend</th><th>Reach</th><th>Impressions</th><th>Clicks</th><th>CPC</th><th>CPP</th><th>CPM</th><th>CTR</th><th>ROAS</th><th>Frequency</th></tr></thead>
        <tbody>
          ${tableItems.length ? tableItems.map((item) => `<tr>
            <td>${escapeHtml(item.name || 'Untitled ad')}</td>
            <td>${escapeHtml(item.ad_set_name || '-')}</td>
            <td>${escapeHtml(getAdspendCampaignId(item))}</td>
            <td>${escapeHtml(item.shop_name || item.shop_id || '-')}</td>
            <td>${escapeHtml(item.status || '-')}</td>
            <td>${Number(item.budget || 0) ? adspendApiMoney(item.budget) : '-'}</td>
            <td>${adspendApiMoney(item.spend)}</td>
            <td>${Number(item.reach || 0).toLocaleString()}</td>
            <td>${Number(item.impressions || 0).toLocaleString()}</td>
            <td>${Number(item.clicks || 0).toLocaleString()}</td>
            <td>${adspendMetricMoney(item.cpc)}</td>
            <td>${adspendMetricMoney(item.cpp)}</td>
            <td>${adspendMetricMoney(item.cpm)}</td>
            <td>${Number(item.ctr || 0) ? Number(item.ctr || 0).toFixed(2) : '-'}</td>
            <td>${Number(item.result_roas || 0) ? Number(item.result_roas || 0).toFixed(2) : '-'}</td>
            <td>${Number(item.frequency || 0) ? Number(item.frequency || 0).toFixed(2) : '-'}</td>
          </tr>`).join('') : `<tr><td colspan="16">${escapeHtml(emptyMessage)}</td></tr>`}
        </tbody>
      </table>
    </div>`;

  const activeTable = view === 'campaigns' ? campaignsTable : view === 'ads' ? adsTable : adSetsTable;

  return `
    ${subtabs}
    ${renderAdspendAdsFilters(sourceData)}
    <div class="adspend-ads-grid">
      <div class="adspend-ads-metric"><span>API Ad Spend</span><strong>${adspendApiMoney(spend)}</strong></div>
      <div class="adspend-ads-metric"><span>${unitLabel}</span><strong>${unitCount.toLocaleString()} <small>/ ${rawItems.length.toLocaleString()}</small></strong></div>
      <div class="adspend-ads-metric"><span>Clicks</span><strong>${clicks.toLocaleString()}</strong></div>
      <div class="adspend-ads-metric"><span>Impressions</span><strong>${impressions.toLocaleString()}</strong></div>
      <div class="adspend-ads-metric"><span>CTR</span><strong>${ctr ? ctr.toFixed(2) + '%' : '-'}</strong></div>
      <div class="adspend-ads-metric"><span>ROAS</span><strong>${spend ? roas.toFixed(2) : '-'}</strong></div>
    </div>
    <div class="adspend-ads-subline">
      Reach ${reach.toLocaleString()} across ${(Array.isArray(sourceData.shops) ? sourceData.shops.length : 0).toLocaleString()} connected shop(s).
      ${failed.length ? `${failed.length} shop(s) failed.` : ''}
    </div>
    ${failedHtml}
    ${activeTable}`;
}

function refreshAdspendAds() {
  if (adspendAdsView === 'ads') {
    loadAdspendIndividualAds({ force: true }).catch(() => {});
  } else {
    loadAdspendAdsSummary({ force: true }).catch(() => {});
  }
}

async function loadAdspendIndividualAds({ force = false } = {}) {
  if (adspendIndividualAdsLoading) return;
  if (!force && adspendIndividualAdsData) return;
  adspendIndividualAdsLoading = true;
  const body = document.getElementById('adspend-ads-card-body');
  const card = document.getElementById('adspend-ads-card');
  if (body && adspendAdsView === 'ads') body.innerHTML = '<div class="adspend-ads-loading">Loading individual ads...</div>';
  try {
    const params = new URLSearchParams({
      page: '1',
      page_size: '100',
      max_pages: '10',
      select_fields: 'ad_performance_session,spend,reach,impressions,clicks,frequency,cpp,cpm,cpc,ctr,cost_per_result,result_roas',
      _: String(Date.now()),
    });
    adspendIndividualAdsData = await authorizedJsonRequest(`/integrations/pancake-pos/ads/ads?${params}`);
  } catch (error) {
    adspendIndividualAdsData = { error: error.message || 'Request failed' };
  } finally {
    adspendIndividualAdsLoading = false;
    const card2 = document.getElementById('adspend-ads-card');
    const body2 = document.getElementById('adspend-ads-card-body');
    if (body2 && card2 && adspendAdsView === 'ads') {
      body2.innerHTML = renderAdspendAdsCardBody(adspendAdsData, Number(card2.dataset.ordersAmount || 0));
    }
  }
}

async function loadAdspendAdsSummary({ force = false } = {}) {
  const body = document.getElementById('adspend-ads-card-body');
  const card = document.getElementById('adspend-ads-card');
  if (!body || !card) return;
  const key = getAdspendAdsRequestKey();
  const totalAmount = Number(card.dataset.ordersAmount || 0);
  if (!force && adspendAdsData && adspendAdsRequestKey === key) {
    body.innerHTML = renderAdspendAdsCardBody(adspendAdsData, totalAmount);
    return;
  }
  if (adspendAdsLoading) return;
  adspendAdsLoading = true;
  body.innerHTML = '<div class="adspend-ads-loading">Loading Pancake ads...</div>';
  try {
    const params = new URLSearchParams({
      page: '1',
      page_size: '100',
      max_pages: '10',
      select_fields: 'ad_performance_session,spend,reach,impressions,clicks,frequency,cpp,cpm,cpc,ctr,cost_per_result,result_roas',
      _: String(Date.now()),
    });
    const data = await authorizedJsonRequest(`/integrations/pancake-pos/ads/ad-sets?${params}`);
    adspendAdsData = data;
    adspendAdsRequestKey = key;
    body.innerHTML = renderAdspendAdsCardBody(data, totalAmount);
  } catch (error) {
    adspendAdsData = { error: error.message || 'Request failed' };
    adspendAdsRequestKey = key;
    body.innerHTML = renderAdspendAdsCardBody(adspendAdsData, totalAmount);
  } finally {
    adspendAdsLoading = false;
  }
}

function renderAdspendRoas() {
  const today = normalizeDateString(new Date());
  if (!adspendDateFrom) adspendDateFrom = normalizeDateString(getDateDaysAgo(6));
  if (!adspendDateTo) adspendDateTo = today;

  const mktState = getMarketingState();

  if (!DB.sheetRecordsForReport.length) {
    loadSheetRecordsForDataReport().then(() => { if (App.currentPage === 'adspend-roas') navigateTo('adspend-roas'); }).catch(() => {});
    return `<div class="page-header"><div class="page-title"><h1>Ad Spend ROAS Summary</h1></div></div>
      <div class="card" style="text-align:center;padding:48px;color:var(--text-muted);">Loading sheet records...</div>`;
  }

  // Pages: only chat pages that actually have sheet records (chat_page from google_orders).
  const allPages = [...new Set(DB.sheetRecordsForReport.map((o) => o.sourceSheet).filter(Boolean))].sort();

  // Months available for the Monthly preset dropdown (newest first), derived
  // from order + ad spend dates with the current month always included.
  const monthSet = new Set();
  DB.sheetRecordsForReport.forEach((o) => { if (o.date) monthSet.add(o.date.slice(0, 7)); });
  (mktState.entries || []).forEach((e) => { if (e.date) monthSet.add(e.date.slice(0, 7)); });
  monthSet.add(today.slice(0, 7));
  const monthOptions = [...monthSet].filter(Boolean).sort().reverse();
  const monthLabel = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long' }) + ' ' + y;
  };

  // Build every date in range (local time — avoid toISOString UTC shift)
  const dates = [];
  const cursor = new Date(adspendDateFrom + 'T00:00:00');
  const endDate = new Date(adspendDateTo + 'T00:00:00');
  const pad = (n) => String(n).padStart(2, '0');
  const fmtLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  while (cursor <= endDate) {
    dates.push(fmtLocal(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  // Orders filtered by date + page + status (from google_orders / Sheet Records)
  // Baseline: only count orders with one of the 5 allowed statuses
  const statusActive = adspendStatusFilters.size > 0;

  function roasCellStyle(roas) {
    if (roas >= 5) return 'background:rgba(16,185,129,0.16);color:#34d399;font-weight:700;';
    if (roas >= 4) return 'background:rgba(245,158,11,0.14);color:#fbbf24;font-weight:700;';
    if (roas >= 3) return 'background:rgba(245,158,11,0.10);color:#f59e0b;font-weight:700;';
    if (roas > 0) return 'background:rgba(239,68,68,0.12);color:#f87171;font-weight:700;';
    return 'color:var(--text-muted);';
  }

  // Build daily ROAS rows + totals for one page ('all' = every page combined).
  function buildRoasData(pageName) {
    const fOrders = DB.sheetRecordsForReport.filter((o) => {
      if (!ADSPEND_ALLOWED_STATUSES.has(o.status)) return false;
      if (o.date < adspendDateFrom || o.date > adspendDateTo) return false;
      if (pageName !== 'all' && (o.sourceSheet || 'Manual') !== pageName) return false;
      if (statusActive && !adspendStatusFilters.has(o.status)) return false;
      return true;
    });
    const obd = {};
    fOrders.forEach((o) => {
      if (!obd[o.date]) obd[o.date] = { orders: 0, delivered: 0, returned: 0, returning: 0, amount: 0 };
      obd[o.date].orders++;
      obd[o.date].amount += Number(o.cod || 0);
      const key = getOrderStatusKey(o.status);
      if (key === 'delivered') obd[o.date].delivered++;
      else if (key === 'returned') obd[o.date].returned++;
      else if (key === 'returning') obd[o.date].returning++;
    });
    const sbd = {};
    (mktState.entries || []).forEach((entry) => {
      if (!entry.date || entry.date < adspendDateFrom || entry.date > adspendDateTo) return;
      if (pageName !== 'all' && entry.page !== pageName) return;
      sbd[entry.date] = (sbd[entry.date] || 0) + Number(entry.spend || 0);
    });
    const rws = dates.map((date) => {
      const o = obd[date] || { orders: 0, delivered: 0, returned: 0, returning: 0, amount: 0 };
      const spend = sbd[date] || 0;
      const roas = spend > 0 ? o.amount / spend : 0;
      const cpp = spend > 0 ? o.orders / spend : 0;
      const rtsBase = o.delivered + o.returned + o.returning;
      const rtsRate = rtsBase > 0 ? ((o.returned + o.returning) / rtsBase) * 100 : 0;
      return { date, orders: o.orders, delivered: o.delivered, returned: o.returned, returning: o.returning, amount: o.amount, spend, roas, cpp, rtsRate };
    });
    const tot = {
      orders: rws.reduce((s, r) => s + r.orders, 0),
      delivered: rws.reduce((s, r) => s + r.delivered, 0),
      returned: rws.reduce((s, r) => s + r.returned, 0),
      returning: rws.reduce((s, r) => s + r.returning, 0),
      amount: rws.reduce((s, r) => s + r.amount, 0),
      spend: rws.reduce((s, r) => s + r.spend, 0),
    };
    tot.roas = tot.spend > 0 ? tot.amount / tot.spend : 0;
    tot.cpp = tot.spend > 0 ? tot.orders / tot.spend : 0;
    tot.rtsBase = tot.delivered + tot.returned + tot.returning;
    tot.rtsRate = tot.rtsBase > 0 ? ((tot.returned + tot.returning) / tot.rtsBase) * 100 : 0;
    return { rows: rws, totals: tot };
  }

  const summaryData = buildRoasData(adspendPageFilter);
  const rows = summaryData.rows;
  const t = summaryData.totals;
  const totalOrders = t.orders;
  const totalDelivered = t.delivered;
  const totalReturned = t.returned;
  const totalReturning = t.returning;
  const totalAmount = t.amount;
  const totalSpend = t.spend;
  const totalRoas = t.roas;
  const totalCpp = t.cpp;
  const totalRtsBase = t.rtsBase;
  const totalRtsRate = t.rtsRate;
  const n = rows.length || 1;

  const totalRoasPages = Math.max(1, Math.ceil(rows.length / adspendRoasPerPage));
  if (adspendRoasPage > totalRoasPages) adspendRoasPage = totalRoasPages;
  const roasPageStart = (adspendRoasPage - 1) * adspendRoasPerPage;
  const pagedRows = rows.slice(roasPageStart, roasPageStart + adspendRoasPerPage);
  const roasPageEnd = Math.min(roasPageStart + adspendRoasPerPage, rows.length);

  const fmt = (v) => Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Renders the daily ROAS table (header + body rows + totals/average footer).
  // Shared by the ROAS Summary tab and the per-page All Pages tab.
  function roasTableHtml(displayRows, tot, rowCount) {
    return `
    <div class="table-container" style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;min-width:920px;">
        <thead>
          <tr style="background:var(--primary,#3b82f6);color:#fff;">
            <th colspan="9" style="text-align:center;padding:10px 14px;font-size:12px;letter-spacing:1px;font-weight:700;">ROAS SUMMARY</th>
          </tr>
          <tr style="background:var(--primary,#3b82f6);color:#fff;">
            <th style="padding:10px 14px;text-align:left;font-size:12px;font-weight:700;letter-spacing:.5px;">DATE</th>
            <th style="padding:10px 14px;text-align:right;font-size:12px;font-weight:700;letter-spacing:.5px;">ORDERS</th>
            <th style="padding:10px 14px;text-align:right;font-size:12px;font-weight:700;letter-spacing:.5px;">DELIVERED</th>
            <th style="padding:10px 14px;text-align:right;font-size:12px;font-weight:700;letter-spacing:.5px;">RETURNED</th>
            <th style="padding:10px 14px;text-align:right;font-size:12px;font-weight:700;letter-spacing:.5px;">ORDERS AMOUNT</th>
            <th style="padding:10px 14px;text-align:right;font-size:12px;font-weight:700;letter-spacing:.5px;">AD SPENT</th>
            <th style="padding:10px 14px;text-align:right;font-size:12px;font-weight:700;letter-spacing:.5px;">CPP</th>
            <th style="padding:10px 14px;text-align:right;font-size:12px;font-weight:700;letter-spacing:.5px;">RTS RATE</th>
            <th style="padding:10px 14px;text-align:right;font-size:12px;font-weight:700;letter-spacing:.5px;">ROAS</th>
          </tr>
        </thead>
        <tbody>
          ${displayRows.map((row, i) => `<tr style="background:${i % 2 === 0 ? 'var(--surface-1,#fff)' : 'var(--surface-2,#f9fafb)'};">
            <td style="padding:10px 14px;font-weight:500;font-size:13px;">${row.date}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${row.orders.toLocaleString()}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;color:#059669;font-weight:600;">${row.delivered.toLocaleString()}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;color:#dc2626;font-weight:600;">${row.returned.toLocaleString()}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${fmt(row.amount)}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${fmt(row.spend)}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${row.orders > 0 && row.spend > 0 ? fmt(row.cpp) : '—'}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;${row.rtsRate >= 30 ? 'color:#dc2626;font-weight:700;' : row.rtsRate >= 15 ? 'color:#d97706;font-weight:600;' : 'color:#059669;'}">${row.delivered + row.returned + row.returning > 0 ? row.rtsRate.toFixed(1) + '%' : '—'}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;${roasCellStyle(row.roas)}">${row.spend > 0 ? row.roas.toFixed(2) : '—'}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr style="background:rgba(245,158,11,0.12);color:var(--text-primary);font-weight:700;border-top:1px solid rgba(245,158,11,0.35);">
            <td style="padding:10px 14px;font-size:13px;letter-spacing:.5px;">TOTAL AMOUNT</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${tot.orders.toLocaleString()}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${tot.delivered.toLocaleString()}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${tot.returned.toLocaleString()}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${fmt(tot.amount)}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${fmt(tot.spend)}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${tot.orders > 0 && tot.spend > 0 ? fmt(tot.cpp) : '—'}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${tot.rtsBase > 0 ? tot.rtsRate.toFixed(1) + '%' : '—'}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${tot.spend > 0 ? tot.roas.toFixed(2) : '—'}</td>
          </tr>
          <tr style="background:rgba(16,185,129,0.12);color:var(--text-primary);font-weight:700;border-top:1px solid rgba(16,185,129,0.28);">
            <td style="padding:10px 14px;font-size:13px;letter-spacing:.5px;">AVERAGE</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${(tot.orders / rowCount).toFixed(2)}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${(tot.delivered / rowCount).toFixed(2)}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${(tot.returned / rowCount).toFixed(2)}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${fmt(tot.amount / rowCount)}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;">${fmt(tot.spend / rowCount)}</td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;"></td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;"></td>
            <td style="padding:10px 14px;text-align:right;font-size:13px;"></td>
          </tr>
        </tfoot>
      </table>
    </div>`;
  }

  // Time + page + status filter bar. `suffix` keeps element ids unique across
  // the Summary and All Pages tabs (both live in the DOM at once); `includePage`
  // toggles the page dropdown (omitted on the All Pages tab).
  function filterBarHtml(suffix, includePage) {
    suffix = suffix || '';
    const applyArg = `'${suffix}'`;
    return `
    <div style="padding:16px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08));">
      <div style="display:flex;flex-wrap:wrap;gap:32px;align-items:flex-start;">
        <div>
          <div style="font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:600;margin-bottom:8px;">TIME FILTER</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${[['all','All Time'],['weekly','Weekly'],['monthly','Monthly'],['custom','Custom Date Range']]
              .map(([key,label]) => `<button type="button" class="filter-pill${adspendDatePreset===key?' active':''}" onclick="setAdspendPreset('${key}')">${label}</button>`)
              .join('')}
          </div>
          ${adspendDatePreset === 'custom' ? `<div style="display:flex;gap:8px;margin-top:10px;align-items:center;">
            <input type="date" class="form-control" id="adspend-from${suffix}" value="${adspendDateFrom}" style="width:148px;height:34px;">
            <span style="color:var(--text-muted);">–</span>
            <input type="date" class="form-control" id="adspend-to${suffix}" value="${adspendDateTo}" style="width:148px;height:34px;">
            <button class="btn btn-primary btn-sm" onclick="applyAdspendFilter(${applyArg})">Apply</button>
          </div>` : adspendDatePreset === 'monthly' ? '' : `<div style="font-size:12px;color:var(--text-muted);margin-top:8px;">${adspendDateFrom} — ${adspendDateTo}</div>`}
        </div>
        ${adspendDatePreset === 'monthly' ? `<div>
          <div style="font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:600;margin-bottom:8px;">MONTH</div>
          <select class="form-control" onchange="setAdspendMonth(this.value)" style="height:38px;font-size:13px;min-width:160px;">
            ${monthOptions.map((ym) => `<option value="${ym}"${adspendMonth === ym ? ' selected' : ''} style="background:#0f172a;color:#fff;">${monthLabel(ym)}</option>`).join('')}
          </select>
        </div>` : ''}
        ${includePage ? `<div>
          <div style="font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:600;margin-bottom:8px;">PAGE FILTER</div>
          <select class="form-control" id="adspend-page${suffix}" style="height:38px;font-size:13px;min-width:220px;" onchange="applyAdspendFilter(${applyArg})">
            <option value="all"${adspendPageFilter === 'all' ? ' selected' : ''}>All Pages</option>
            ${allPages.map((name) => `<option value="${escapeHtml(name)}"${adspendPageFilter === name ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}
          </select>
        </div>` : ''}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:20px;margin-top:14px;">
        ${ADSPEND_STATUS_MAP.map(([status, id, label]) => `
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;color:var(--text-secondary);">
            <input type="checkbox" id="${id}${suffix}" ${adspendStatusFilters.has(status) ? 'checked' : ''} onchange="applyAdspendFilter(${applyArg})" style="width:14px;height:14px;accent-color:var(--primary);">
            ${label}
          </label>`).join('')}
      </div>
    </div>`;
  }

  // ALL PAGES tab: one ROAS table per chat page, slideable one page at a time.
  // Respects the active time + status filters but ignores the page dropdown.
  const apCount = allPages.length;
  if (adspendAllPagesIndex >= apCount) adspendAllPagesIndex = apCount - 1;
  if (adspendAllPagesIndex < 0) adspendAllPagesIndex = 0;
  let allPagesHtml;
  if (!apCount) {
    allPagesHtml = `<div class="card" style="padding:0;overflow:hidden;">${filterBarHtml('-ap', false)}<div style="text-align:center;padding:48px;color:var(--text-muted);">No pages found for the selected filters.</div></div>`;
  } else {
    const apPage = allPages[adspendAllPagesIndex];
    const apData = buildRoasData(apPage);
    allPagesHtml = `
    <div class="card" style="padding:0;overflow:hidden;">
      ${filterBarHtml('-ap', false)}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08));">
        <button class="page-btn" onclick="slideAdspendPage(-1)" ${adspendAllPagesIndex <= 0 ? 'disabled' : ''}>‹ Prev</button>
        <div style="text-align:center;">
          <div style="font-size:15px;font-weight:700;color:var(--text-primary);">${escapeHtml(apPage)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">Page ${adspendAllPagesIndex + 1} of ${apCount} · ${adspendDateFrom} — ${adspendDateTo}</div>
        </div>
        <button class="page-btn" onclick="slideAdspendPage(1)" ${adspendAllPagesIndex >= apCount - 1 ? 'disabled' : ''}>Next ›</button>
      </div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08));">
        ${allPages.map((name, idx) => `<button type="button" class="filter-pill${idx === adspendAllPagesIndex ? ' active' : ''}" onclick="setAdspendAllPagesIndex(${idx})" title="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join('')}
      </div>
      ${roasTableHtml(apData.rows, apData.totals, apData.rows.length || 1)}
    </div>`;
  }

  const monthlyTarget = Number(mktState.targets?.sales || 0);
  const dailyTarget = monthlyTarget / 31;
  const dailySpendTarget = Number(mktState.targets?.spend || 0);
  const monthlySpendTarget = dailySpendTarget * 31;
  const goalPct = monthlyTarget > 0 ? Math.min(100, (totalAmount / monthlyTarget) * 100) : 0;
  const goalRemaining = Math.max(0, monthlyTarget - totalAmount);

  return `
  <div class="page-header">
    <div class="page-title"><h1>Ad Spend ROAS Summary</h1><p>Daily orders and ad spend performance across pages.</p></div>
  </div>

  <div class="card" style="margin-bottom:16px;padding:16px 20px;">
    <div class="adspend-target-grid">
      <div class="adspend-target-card adspend-target-monthly">
        <div class="adspend-target-icon">🎯</div>
        <div>
          <div class="adspend-target-label">Monthly Sales Target</div>
          <div class="adspend-target-value">${fmt(monthlyTarget)}</div>
          <div class="adspend-target-sub">Set by Marketing TL</div>
        </div>
      </div>
      <div class="adspend-target-card adspend-target-daily">
        <div class="adspend-target-icon">📅</div>
        <div>
          <div class="adspend-target-label">Daily Sales Target</div>
          <div class="adspend-target-value">${fmt(dailyTarget)}</div>
          <div class="adspend-target-sub">Monthly ÷ 31</div>
        </div>
      </div>
      <div class="adspend-target-card adspend-target-spend">
        <div class="adspend-target-icon">💸</div>
        <div>
          <div class="adspend-target-label">Daily Spend Target</div>
          <div class="adspend-target-value">${fmt(dailySpendTarget)}</div>
          <div class="adspend-target-sub">${fmt(monthlySpendTarget)} monthly cap</div>
        </div>
      </div>
      <div class="adspend-target-card adspend-target-goal">
        <div class="adspend-target-icon">📈</div>
        <div style="flex:1;">
          <div class="adspend-target-label">Total Sales vs Goal</div>
          <div class="adspend-target-value">${fmt(totalAmount)} <span class="adspend-target-mute">/ ${fmt(monthlyTarget)}</span></div>
          <div class="adspend-target-bar"><span style="width:${goalPct.toFixed(1)}%;"></span></div>
          <div class="adspend-target-sub">${goalPct.toFixed(1)}% achieved · ${fmt(goalRemaining)} to go</div>
        </div>
      </div>
    </div>
  </div>

  <div class="adspend-tabs" style="display:flex;gap:8px;margin-bottom:16px;">
    <button type="button" class="filter-pill adspend-tab-btn${adspendActiveTab==='summary'?' active':''}" data-tab="summary" onclick="setAdspendTab('summary')">ROAS Summary</button>
    <button type="button" class="filter-pill adspend-tab-btn${adspendActiveTab==='allpages'?' active':''}" data-tab="allpages" onclick="setAdspendTab('allpages')">All Pages</button>
    <button type="button" class="filter-pill adspend-tab-btn${adspendActiveTab==='adsets'?' active':''}" data-tab="adsets" onclick="setAdspendTab('adsets')">Live Ad Sets</button>
  </div>

  <div id="adspend-tab-summary" style="display:${adspendActiveTab==='summary'?'block':'none'};">
  <div class="card" style="padding:0;overflow:hidden;">
    ${filterBarHtml('', true)}
    ${roasTableHtml(pagedRows, t, n)}
    <div class="table-pagination">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:13px;color:var(--text-muted);">Rows:</span>
        <select onchange="setAdspendRoasPerPage(this.value)" style="height:30px;font-size:13px;padding:0 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface-1);color:var(--text-primary);cursor:pointer;">
          ${[10,20,50].map((v) => `<option value="${v}"${adspendRoasPerPage===v?' selected':''}>${v}</option>`).join('')}
        </select>
        <span>${rows.length ? roasPageStart + 1 : 0}–${roasPageEnd} of ${rows.length} rows</span>
      </div>
      <div class="pagination-buttons">
        <button class="page-btn" onclick="changeAdspendRoasPage(${adspendRoasPage - 1})" ${adspendRoasPage <= 1 ? 'disabled' : ''}>‹</button>
        ${renderPaginationButtons(adspendRoasPage, totalRoasPages, 'changeAdspendRoasPage')}
        <button class="page-btn" onclick="changeAdspendRoasPage(${adspendRoasPage + 1})" ${adspendRoasPage >= totalRoasPages ? 'disabled' : ''}>›</button>
      </div>
    </div>
  </div>
  </div>

  <div id="adspend-tab-allpages" style="display:${adspendActiveTab==='allpages'?'block':'none'};">
    ${allPagesHtml}
  </div>

  <div id="adspend-tab-adsets" style="display:${adspendActiveTab==='adsets'?'block':'none'};">
    ${renderAdspendAdsCardShell(totalAmount)}
  </div>`;
}

// ─── AD CREATIVES MONITOR ──────────────────────────────────
let creativesDateFrom = '';
let creativesDateTo = '';
let creativesDatePreset = 'monthly';
let creativesPlatformFilter = 'all';

const CREATIVE_PLATFORMS = ['Meta', 'TikTok', 'Google', 'YouTube', 'Other'];
const CREATIVE_STATUSES = ['active', 'paused', 'disabled'];
const CREATIVE_STATUS_BADGE = {
  active: 'badge-success',
  paused: 'badge-warning',
  disabled: 'badge-gray',
};

function normalizeCreative(item, index) {
  const legacyStatusMap = { Live: 'active', Killed: 'disabled', Scaled: 'active' };
  let status = item?.status || 'active';
  if (legacyStatusMap[status]) status = legacyStatusMap[status];
  if (!CREATIVE_STATUSES.includes(status)) status = 'active';
  return {
    _index: index,
    date: item?.date || '',
    name: item?.name || item?.hook || '(untitled)',
    platform: item?.platform || 'Meta',
    spend: Number(item?.spend || 0),
    revenue: Number(item?.revenue || 0),
    conversions: Number(item?.conversions || 0),
    ctr: Number(item?.ctr || 0),
    status,
    page: item?.page || '',
    notes: item?.notes || '',
  };
}

function setCreativesPreset(preset) {
  creativesDatePreset = preset;
  if (preset !== 'custom') {
    const range = computePresetRange(preset);
    if (range) { creativesDateFrom = range.from; creativesDateTo = range.to; }
  }
  navigateTo('creatives');
}

function applyCreativesFilter() {
  const from = document.getElementById('creatives-from')?.value || '';
  const to = document.getElementById('creatives-to')?.value || '';
  const platform = document.getElementById('creatives-platform')?.value || 'all';
  if (from) {
    creativesDateFrom = from;
    creativesDateTo = to || from;
    creativesDatePreset = 'custom';
  }
  creativesPlatformFilter = platform;
  navigateTo('creatives');
}

function openCreativeModal() {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can manage creatives.');
    return;
  }
  ['creative-name', 'creative-spend', 'creative-revenue', 'creative-conversions', 'creative-ctr', 'creative-page', 'creative-notes']
    .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  const dateEl = document.getElementById('creative-date'); if (dateEl) dateEl.value = normalizeDateString(new Date());
  const platformEl = document.getElementById('creative-platform'); if (platformEl) platformEl.value = 'Meta';
  const statusEl = document.getElementById('creative-status'); if (statusEl) statusEl.value = 'active';
  const idx = document.getElementById('creative-edit-index'); if (idx) idx.value = '';
  const titleEl = document.getElementById('creative-modal-title'); if (titleEl) titleEl.textContent = 'Add Creative';
  openModal('creative-modal');
  document.getElementById('creative-name')?.focus();
}

function closeCreativeModal() {
  closeModal('creative-modal');
}

function saveCreative() {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can manage creatives.');
    return;
  }
  const name = document.getElementById('creative-name')?.value.trim() || '';
  if (!name) { showToast('error', 'Name required', 'Please enter a creative name.'); return; }
  const date = document.getElementById('creative-date')?.value || normalizeDateString(new Date());
  const platform = document.getElementById('creative-platform')?.value || 'Meta';
  const status = document.getElementById('creative-status')?.value || 'active';
  const spend = Math.max(0, Number(document.getElementById('creative-spend')?.value || 0));
  const revenue = Math.max(0, Number(document.getElementById('creative-revenue')?.value || 0));
  const conversions = Math.max(0, Number(document.getElementById('creative-conversions')?.value || 0));
  const ctr = Math.max(0, Number(document.getElementById('creative-ctr')?.value || 0));
  const page = document.getElementById('creative-page')?.value.trim() || '';
  const notes = document.getElementById('creative-notes')?.value.trim() || '';
  const payload = { name, date, platform, status, spend, revenue, conversions, ctr, page, notes };

  const state = getMarketingState();
  const editVal = document.getElementById('creative-edit-index')?.value;
  const editIndex = editVal === '' ? -1 : Number(editVal);
  if (editIndex >= 0 && editIndex < (state.creatives || []).length) {
    state.creatives[editIndex] = payload;
  } else {
    state.creatives = state.creatives || [];
    state.creatives.push(payload);
  }
  saveMarketingState(state);
  showToast('success', editIndex >= 0 ? 'Creative updated' : 'Creative added', name);
  closeModal('creative-modal');
  navigateTo('creatives');
}

function editCreative(index) {
  if (!canManageMarketing()) return;
  const state = getMarketingState();
  const item = (state.creatives || [])[index];
  if (!item) return;
  const norm = normalizeCreative(item, index);
  const fields = {
    'creative-name': norm.name,
    'creative-date': norm.date,
    'creative-platform': norm.platform,
    'creative-status': norm.status,
    'creative-spend': String(norm.spend),
    'creative-revenue': String(norm.revenue),
    'creative-conversions': String(norm.conversions),
    'creative-ctr': String(norm.ctr),
    'creative-page': norm.page,
    'creative-notes': norm.notes,
    'creative-edit-index': String(index),
  };
  Object.entries(fields).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = val; });
  const titleEl = document.getElementById('creative-modal-title'); if (titleEl) titleEl.textContent = 'Edit Creative';
  openModal('creative-modal');
}

function deleteCreativeAt(index) {
  if (!canManageMarketing()) return;
  const state = getMarketingState();
  if (!state.creatives || index < 0 || index >= state.creatives.length) return;
  const name = normalizeCreative(state.creatives[index], index).name;
  state.creatives.splice(index, 1);
  saveMarketingState(state);
  showToast('success', 'Creative removed', name);
  navigateTo('creatives');
}

function updateCreativeStatus(index, newStatus) {
  if (!canManageMarketing()) return;
  if (!CREATIVE_STATUSES.includes(newStatus)) return;
  const state = getMarketingState();
  if (!state.creatives || index < 0 || index >= state.creatives.length) return;
  state.creatives[index] = { ...state.creatives[index], status: newStatus };
  saveMarketingState(state);
  // Light update — no full re-render needed; toast confirms
  showToast('success', 'Status updated', `${normalizeCreative(state.creatives[index], index).name} → ${newStatus}`);
}

function renderCreatives() {
  if (!creativesDateFrom) {
    const r = computePresetRange('monthly');
    creativesDateFrom = r.from;
    creativesDateTo = r.to;
  }
  const state = getMarketingState();
  const marketingManager = canManageMarketing();
  const all = (state.creatives || []).map(normalizeCreative);
  const platformOptions = Array.from(new Set([...CREATIVE_PLATFORMS, ...all.map((c) => c.platform)])).filter(Boolean);
  const filtered = all.filter((c) => {
    if (c.date && (c.date < creativesDateFrom || c.date > creativesDateTo)) return false;
    if (creativesPlatformFilter !== 'all' && c.platform !== creativesPlatformFilter) return false;
    return true;
  });

  const totals = filtered.reduce((acc, c) => {
    acc.spend += c.spend;
    acc.revenue += c.revenue;
    acc.conversions += c.conversions;
    acc.ctrSum += c.ctr;
    return acc;
  }, { spend: 0, revenue: 0, conversions: 0, ctrSum: 0 });
  const avgRoas = totals.spend ? totals.revenue / totals.spend : 0;
  const avgCtr = filtered.length ? totals.ctrSum / filtered.length : 0;
  const peso = (v) => `₱${Number(v || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;
  const num = (v) => Number(v || 0).toLocaleString('en-PH');
  const sorted = filtered.slice().sort((a, b) => b.spend - a.spend);

  return `
  <div class="page-header">
    <div class="page-title"><h1>Ad Creatives Monitor</h1><p>Per-creative spend, revenue, ROAS, conversions, and status across all ad platforms.</p></div>
  </div>

  ${marketingManager ? `<div class="modal-overlay" id="creative-modal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title" id="creative-modal-title">Add Creative</div>
        <button class="modal-close" onclick="closeCreativeModal()">×</button>
      </div>
      <div class="modal-body">
        <input type="hidden" id="creative-edit-index" value="">
        <div class="form-grid-2">
          <div class="form-group" style="grid-column:1 / -1;"><label class="form-label">Creative Name</label><input type="text" class="form-control" id="creative-name" placeholder="e.g. Summer sale — carousel"></div>
          <div class="form-group"><label class="form-label">Date</label><input type="date" class="form-control" id="creative-date" value="${normalizeDateString(new Date())}"></div>
          <div class="form-group"><label class="form-label">Platform</label>
            <select class="form-control" id="creative-platform">
              ${CREATIVE_PLATFORMS.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label class="form-label">Spend (₱)</label><input type="number" min="0" step="0.01" class="form-control" id="creative-spend" placeholder="0"></div>
          <div class="form-group"><label class="form-label">Revenue (₱)</label><input type="number" min="0" step="0.01" class="form-control" id="creative-revenue" placeholder="0"></div>
          <div class="form-group"><label class="form-label">Conversions</label><input type="number" min="0" step="1" class="form-control" id="creative-conversions" placeholder="0"></div>
          <div class="form-group"><label class="form-label">CTR (%)</label><input type="number" min="0" step="0.01" class="form-control" id="creative-ctr" placeholder="0.00"></div>
          <div class="form-group"><label class="form-label">Page (optional)</label><input type="text" class="form-control" id="creative-page" placeholder="Associated page"></div>
          <div class="form-group"><label class="form-label">Status</label>
            <select class="form-control" id="creative-status">
              ${CREATIVE_STATUSES.map((s) => `<option value="${s}">${s}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="grid-column:1 / -1;"><label class="form-label">Notes</label><input type="text" class="form-control" id="creative-notes" placeholder="Hook angle, learnings, etc."></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeCreativeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveCreative()">Save Creative</button>
      </div>
    </div>
  </div>` : ''}

  <div class="card" style="margin-bottom:16px;padding:16px 20px;">
    <div style="display:flex;flex-wrap:wrap;gap:32px;align-items:flex-start;">
      <div>
        <div style="font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:600;margin-bottom:8px;">TIME FILTER</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${[['all','All Time'],['weekly','Weekly'],['monthly','Monthly'],['custom','Custom Date Range']]
            .map(([key,label]) => `<button type="button" class="filter-pill${creativesDatePreset===key?' active':''}" onclick="setCreativesPreset('${key}')">${label}</button>`)
            .join('')}
        </div>
        ${creativesDatePreset === 'custom' ? `<div style="display:flex;gap:8px;margin-top:10px;align-items:center;">
          <input type="date" class="form-control" id="creatives-from" value="${creativesDateFrom}" style="width:148px;height:34px;">
          <span style="color:var(--text-muted);">–</span>
          <input type="date" class="form-control" id="creatives-to" value="${creativesDateTo}" style="width:148px;height:34px;">
          <button class="btn btn-primary btn-sm" onclick="applyCreativesFilter()">Apply</button>
        </div>` : `<div style="font-size:12px;color:var(--text-muted);margin-top:8px;">${creativesDateFrom} — ${creativesDateTo}</div>`}
      </div>
      <div>
        <div style="font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:600;margin-bottom:8px;">PLATFORM FILTER</div>
        <select class="form-control" id="creatives-platform" style="height:38px;font-size:13px;min-width:220px;" onchange="applyCreativesFilter()">
          <option value="all"${creativesPlatformFilter === 'all' ? ' selected' : ''}>All Platforms</option>
          ${platformOptions.map((p) => `<option value="${escapeHtml(p)}"${creativesPlatformFilter === p ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}
        </select>
      </div>
    </div>
  </div>

  <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:16px;">
    <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">Total Spend</div><div class="stat-value">${peso(totals.spend)}</div></div>
    <div class="stat-card green"><div class="stat-card-accent"></div><div class="stat-label">Total Revenue</div><div class="stat-value">${peso(totals.revenue)}</div></div>
    <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">Avg ROAS</div><div class="stat-value">${avgRoas.toFixed(2)}x</div></div>
    <div class="stat-card"><div class="stat-card-accent"></div><div class="stat-label">Conversions</div><div class="stat-value">${num(totals.conversions)}</div></div>
    <div class="stat-card"><div class="stat-card-accent"></div><div class="stat-label">Avg CTR</div><div class="stat-value">${avgCtr.toFixed(2)}%</div></div>
  </div>

  <div class="card erp-card">
    <div class="card-header">
      <div><div class="card-title">Creatives</div><div class="card-subtitle">${filtered.length} of ${all.length} creatives in range. ROAS and CPP are computed from spend/revenue/conversions.</div></div>
      ${marketingManager ? '<button class="btn btn-primary btn-sm" onclick="openCreativeModal()">+ Add Creative</button>' : ''}
    </div>
    <div class="table-container">
      <table>
        <thead><tr style="background:var(--surface-2);">
          <th style="text-transform:uppercase;font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--border);">Creative</th>
          <th style="text-transform:uppercase;font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--border);">Page</th>
          <th style="text-transform:uppercase;font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--border);">Platform</th>
          <th style="text-transform:uppercase;font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--border);text-align:right;">Spend</th>
          <th style="text-transform:uppercase;font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--border);text-align:right;">Revenue</th>
          <th style="text-transform:uppercase;font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--border);text-align:right;">ROAS</th>
          <th style="text-transform:uppercase;font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--border);text-align:right;">CPP</th>
          <th style="text-transform:uppercase;font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--border);text-align:right;">Conv.</th>
          <th style="text-transform:uppercase;font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--border);">Status</th>
          ${marketingManager ? '<th style="border-bottom:1px solid var(--border);"></th>' : ''}
        </tr></thead>
        <tbody>
          ${sorted.length ? sorted.map((c) => {
            const roas = c.spend ? c.revenue / c.spend : 0;
            const cpp = c.conversions ? c.spend / c.conversions : 0;
            return `<tr>
              <td><strong>${escapeHtml(c.name)}</strong>${c.notes ? `<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(c.notes)}</div>` : ''}${c.date ? `<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(c.date)}</div>` : ''}</td>
              <td>${c.page ? escapeHtml(c.page) : '<span style="color:var(--text-muted);">—</span>'}</td>
              <td>${escapeHtml(c.platform)}</td>
              <td style="text-align:right;">${peso(c.spend)}</td>
              <td style="text-align:right;">${peso(c.revenue)}</td>
              <td style="text-align:right;font-weight:600;${roas >= 2 ? 'color:var(--success);' : roas >= 1 ? '' : 'color:var(--danger);'}">${roas.toFixed(2)}x</td>
              <td style="text-align:right;">${cpp ? peso(cpp) : '—'}</td>
              <td style="text-align:right;">${num(c.conversions)}</td>
              <td>${marketingManager ? `<select class="form-control" style="height:30px;font-size:12px;padding:0 8px;width:110px;" onchange="updateCreativeStatus(${c._index}, this.value)">
                ${CREATIVE_STATUSES.map((s) => `<option value="${s}"${s === c.status ? ' selected' : ''}>${s}</option>`).join('')}
              </select>` : `<span class="badge ${CREATIVE_STATUS_BADGE[c.status]}">${c.status}</span>`}</td>
              ${marketingManager ? `<td><button class="btn btn-ghost btn-sm" onclick="editCreative(${c._index})">Edit</button><button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="deleteCreativeAt(${c._index})">×</button></td>` : ''}
            </tr>`;
          }).join('') : `<tr><td colspan="${marketingManager ? 10 : 9}" style="text-align:center;padding:32px;color:var(--text-muted);">No creatives in range.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderMarketingCenter() {
  const now = new Date();
  if (!window.mktFilter) {
    const range = computePresetRange('monthly');
    window.mktFilter = { preset: 'monthly', from: range.from, to: range.to, page: '' };
  }
  if (!window.mktFilter.preset) window.mktFilter.preset = 'custom';
  const filterPreset = window.mktFilter.preset;
  const filterFrom = window.mktFilter.from;
  const filterTo = window.mktFilter.to;
  const filterPage = window.mktFilter.page || '';

  const state = getMarketingState();
  const entries = state.entries.filter((e) => {
    const d = e.date || '';
    if (d < filterFrom || d > filterTo) return false;
    if (filterPage && e.page !== filterPage) return false;
    return true;
  });
  const totals = aggregateMarketing(entries);
  // Gross sales (delivered) and RTS rate from Sheet Records (google_orders) in date range
  const sheetOrdersInRange = (DB.sheetRecordsForReport || []).filter((o) => {
    const d = o.date || '';
    if (d < filterFrom || d > filterTo) return false;
    if (filterPage) {
      const sheet = String(o.sourceSheet || '').toLowerCase();
      const pg = filterPage.toLowerCase();
      if (sheet !== pg && !sheet.includes(pg) && !pg.includes(sheet)) return false;
    }
    return true;
  });
  let deliveredSales = 0;
  const posCounts = { delivered: 0, returned: 0, returning: 0 };
  sheetOrdersInRange.forEach((o) => {
    const key = getOrderStatusKey(o.status);
    if (key === 'delivered') {
      posCounts.delivered += 1;
      deliveredSales += Number(o.cod || 0);
    } else if (key === 'returned') posCounts.returned += 1;
    else if (key === 'returning') posCounts.returning += 1;
  });
  const posRtsBase = posCounts.delivered + posCounts.returned + posCounts.returning;
  const posRtsRate = posRtsBase ? (posCounts.returned + posCounts.returning) / posRtsBase : 0;
  const byPage = aggregateMarketingByPage(entries).sort((a, b) => b.sales - a.sales);
  const byDay = getMarketingDailyTotals(entries);
  const targetPct = state.targets.sales ? deliveredSales / state.targets.sales : 0;
  const monthSpendTarget = Number(state.targets.spend || 0) * 31;
  const creativeMonth = state.creatives.filter((item) => String(item.date || '').startsWith(marketingMonth()));
  const survived = creativeMonth.filter((item) => Number(item.spend || 0) >= 5000).length;
  const survivalRate = creativeMonth.length ? survived / creativeMonth.length : 0;
  const marketingManager = canManageMarketing();
  const ownerTotals = state.team.map((member) => {
    const memberPages = getMemberPages(member);
    const memberRows = entries.filter((entry) => {
      if (entry.owner === member.name) return true;
      if (memberPages.length && entry.page && memberPages.includes(entry.page)) return true;
      return false;
    });
    const agg = aggregateMarketing(memberRows);
    // When a team member has assigned pages, attribute delivered sales/orders
    // from sheet records (not the manual entries' sales fields) so spend logged
    // for a page rolls up against actual page revenue.
    if (memberPages.length) {
      let memberSales = 0;
      let memberOrders = 0;
      sheetOrdersInRange.forEach((o) => {
        if (getOrderStatusKey(o.status) !== 'delivered') return;
        if (!memberPageMatchesSheet(memberPages, o.sourceSheet)) return;
        memberSales += Number(o.cod || 0);
        memberOrders += 1;
      });
      agg.sales = memberSales;
      agg.orders = memberOrders;
      agg.roas = agg.spend ? memberSales / agg.spend : 0;
      agg.cpp = memberOrders ? agg.spend / memberOrders : 0;
    }
    return { ...member, pages: memberPages, ...agg };
  });
  const latestStandups = (state.standups || []).slice().reverse().slice(0, 8);

  return `
  <div class="erp-command-center">
  <div class="page-header erp-header">
    <div class="page-title"><h1>Sales & Marketing Command Center</h1><p>Track page ROAS, ad spend, creative output, and team pacing.</p></div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="exportMarketingEntries()">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8M5 7l3 3 3-3M2 12h12"/></svg>
        Export CSV
      </button>
      ${marketingManager ? '<button class="btn btn-primary btn-sm" onclick="openMarketingTargetsModal()">Targets</button>' : ''}
    </div>
  </div>

  <div class="mkt-filter-bar card" style="margin-bottom:16px;padding:16px 20px;">
    <div style="display:flex;flex-wrap:wrap;gap:32px;align-items:flex-start;">
      <div>
        <div style="font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:600;margin-bottom:8px;">TIME FILTER</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${[['all','All Time'],['weekly','Weekly'],['monthly','Monthly'],['custom','Custom Date Range']]
            .map(([key,label]) => `<button type="button" class="filter-pill${filterPreset===key?' active':''}" onclick="setMarketingPreset('${key}')">${label}</button>`)
            .join('')}
        </div>
        ${filterPreset === 'custom' ? `<div style="display:flex;gap:8px;margin-top:10px;align-items:center;">
          <input type="date" id="mkt-filter-from" class="form-control" style="width:148px;height:34px;font-size:13px;" value="${filterFrom}">
          <span style="color:var(--text-muted);font-size:13px;">to</span>
          <input type="date" id="mkt-filter-to" class="form-control" style="width:148px;height:34px;font-size:13px;" value="${filterTo}">
          <button class="btn btn-primary btn-sm" onclick="applyMarketingFilter()">Apply</button>
        </div>` : `<div style="font-size:12px;color:var(--text-muted);margin-top:8px;">${filterFrom} — ${filterTo}</div>`}
      </div>
      <div>
        <div style="font-size:11px;letter-spacing:0.06em;color:var(--text-muted);font-weight:600;margin-bottom:8px;">PAGE FILTER</div>
        <select id="mkt-filter-page" class="form-control" style="height:38px;font-size:13px;min-width:220px;" onchange="applyMarketingFilter()">
          <option value="">All Pages</option>
          ${getPosSourceOptions().map((p) => `<option value="${escapeHtml(p)}"${filterPage === p ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}
        </select>
      </div>
    </div>
  </div>

  <div class="erp-kpi-grid">
    <div class="erp-kpi"><div class="erp-kpi-label">Gross Sales (Delivered)</div><div class="erp-kpi-value" style="font-size:clamp(16px,2.5vw,26px);overflow-wrap:break-word;">${marketingMoney(deliveredSales)}</div><div class="erp-kpi-target">${Math.round(targetPct * 100)}% of monthly target</div></div>
    <div class="erp-kpi warn"><div class="erp-kpi-label">Ad Spend (Manual)</div><div class="erp-kpi-value" style="font-size:clamp(16px,2.5vw,26px);overflow-wrap:break-word;">${marketingMoney(totals.spend)}</div><div class="erp-kpi-target">${marketingMoney(monthSpendTarget)} monthly cap</div></div>
    <div class="erp-kpi ok"><div class="erp-kpi-label">ROAS</div><div class="erp-kpi-value" style="font-size:clamp(16px,2.5vw,26px);overflow-wrap:break-word;">${marketingRoas(totals.spend ? deliveredSales / totals.spend : 0)}</div><div class="erp-kpi-target">Target ${marketingRoas(state.targets.roas)}</div></div>
    <div class="erp-kpi bad"><div class="erp-kpi-label">RTS Rate</div><div class="erp-kpi-value" style="font-size:clamp(16px,2.5vw,26px);overflow-wrap:break-word;">${marketingPct(posRtsRate)}</div><div class="erp-kpi-target">Max ${state.targets.rts}%</div></div>
  </div>

  ${(() => {
    const mktTabs = [
      ['mkt-entries', 'Daily Entry', true],
      ['mkt-team', 'Team', true],
      ['mkt-standup', 'Daily Standup', true],
      ['mkt-adaccounts', 'Ad Accounts', true],
    ];
    const validIds = mktTabs.filter(([, , show]) => show).map(([id]) => id);
    if (!validIds.includes(lastMarketingTab)) lastMarketingTab = 'mkt-entries';
    return `<div class="tabs erp-tabs">${mktTabs.map(([id, label, show]) =>
      show ? `<button class="tab-btn${lastMarketingTab === id ? ' active' : ''}" onclick="switchTab(this,'${id}')">${label}</button>` : ''
    ).join('')}</div>`;
  })()}

  <div id="mkt-entries" class="tab-content${lastMarketingTab === 'mkt-entries' ? ' active' : ''}">
    ${marketingManager ? `<div class="modal-overlay" id="mkt-entry-modal">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title" id="mkt-entry-modal-title">Log Daily Entry</div>
          <button class="modal-close" onclick="closeMarketingEntryModal()">×</button>
        </div>
        <div class="modal-body">
          <input type="hidden" id="mkt-entry-edit-index" value="">
          <div class="form-group" style="max-width:240px;">
            <label class="form-label">Date</label>
            <input type="date" class="form-control" id="mkt-date" value="${normalizeDateString(new Date())}">
          </div>

          <div style="margin-top:8px;">
            <label class="form-label" style="display:block;margin-bottom:6px;">Products</label>
            <div id="mkt-product-rows" style="display:flex;flex-direction:column;gap:8px;">
              ${marketingProductRowHtml(state)}
            </div>
            <button type="button" class="btn btn-secondary btn-sm" onclick="addMarketingProductRow()" style="margin-top:10px;">
              + Add Product
            </button>
          </div>

          <div class="mkt-total-card" style="margin-top:14px;padding:12px 14px;background:linear-gradient(135deg,#eff6ff,#dbeafe);border-radius:8px;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:12px;font-weight:700;letter-spacing:.6px;color:#1e3a8a;text-transform:uppercase;">Total Adspend</span>
            <span id="mkt-total-adspend" style="font-size:20px;font-weight:700;color:#1e3a8a;">0.00</span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeMarketingEntryModal()">Cancel</button>
          <button class="btn btn-primary" onclick="submitMarketingEntries()">Save Entry</button>
        </div>
      </div>
    </div>` : ''}

    <div class="card">
      <div class="card-header" style="flex-wrap:wrap;gap:10px;">
        <div><div class="card-title">Recent Entries</div><div class="card-subtitle">Latest ad spend logs by product.${marketingManager ? '' : ' Only Sales & Marketing TL can add or edit entries.'}</div></div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          ${(() => {
            const products = [...new Set(state.entries.map((e) => e.page).filter(Boolean))].sort();
            const cur = window.mktRecentFilter?.product || '';
            return `<select id="mkt-recent-product" onchange="applyMarketingRecentFilter()" style="height:30px;font-size:12px;padding:0 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface-1);color:var(--text-primary);cursor:pointer;max-width:180px;">
              <option value=""${cur ? '' : ' selected'} style="background:#0f172a;color:#fff;">All products</option>
              ${products.map((p) => `<option value="${escapeHtml(p)}"${cur === p ? ' selected' : ''} style="background:#0f172a;color:#fff;">${escapeHtml(p)}</option>`).join('')}
            </select>`;
          })()}
          <input type="date" class="form-control" id="mkt-recent-from" value="${window.mktRecentFilter?.from || ''}" onchange="applyMarketingRecentFilter()" style="height:30px;font-size:12px;width:140px;">
          <span style="font-size:12px;color:var(--text-muted);">—</span>
          <input type="date" class="form-control" id="mkt-recent-to" value="${window.mktRecentFilter?.to || ''}" onchange="applyMarketingRecentFilter()" style="height:30px;font-size:12px;width:140px;">
          <button class="btn btn-secondary btn-sm" onclick="clearMarketingRecentFilter()" style="height:30px;font-size:12px;padding:0 10px;">All</button>
          <span style="font-size:12px;color:var(--text-muted);">Rows:</span>
          <select onchange="setMarketingRecentLimit(this.value)" style="height:30px;font-size:12px;padding:0 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface-1);color:var(--text-primary);cursor:pointer;">
            ${[10,20,40,50,100].map((v) => `<option value="${v}"${(window.mktRecentLimit || 10) === v ? ' selected' : ''} style="background:#0f172a;color:#fff;">${v}</option>`).join('')}
          </select>
          ${marketingManager ? '<button class="btn btn-primary btn-sm" onclick="openMarketingEntryModal()" style="height:30px;font-size:12px;padding:0 14px;">+ Log Entry</button>' : ''}
        </div>
      </div>
        <div class="table-container">
          <table>
            <thead><tr><th>Date</th><th>Product</th><th>Owner</th><th style="text-align:right;">Ad Spend</th><th></th></tr></thead>
            <tbody>
              ${(() => {
                const rf = window.mktRecentFilter || {};
                let filtered = state.entries.slice();
                if (rf.product) filtered = filtered.filter((e) => (e.page || '') === rf.product);
                if (rf.from) filtered = filtered.filter((e) => (e.date || '') >= rf.from);
                if (rf.to) filtered = filtered.filter((e) => (e.date || '') <= rf.to);
                return filtered.reverse().slice(0, window.mktRecentLimit || 10);
              })().map((entry) => {
                const id = Number(entry.id || 0);
                return `<tr>
                  <td>${escapeHtml(entry.date)}</td>
                  <td><strong>${escapeHtml(entry.page)}</strong>${entry.product ? `<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(entry.product)}</div>` : ''}</td>
                  <td>${escapeHtml(entry.owner || '—')}</td>
                  <td style="text-align:right;"><span style="font-weight:600;">${marketingMoney(entry.spend)}</span></td>
                  <td>
                    ${marketingManager ? `<div class="flex gap-2"><button class="btn btn-ghost btn-sm" onclick="editMarketingEntry(${id})">Edit</button><button class="btn btn-ghost btn-sm" onclick="deleteMarketingEntry(${id})">×</button></div>` : '<span class="text-xs text-muted">—</span>'}
                  </td>
                </tr>`;
              }).join('') || '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted)">No entries yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
  </div>

  <div id="mkt-team" class="tab-content${lastMarketingTab === 'mkt-team' ? ' active' : ''}">
    <div style="display:grid; grid-template-columns:${marketingManager ? 'minmax(280px,.7fr) minmax(400px,1.3fr)' : '1fr'}; gap:20px; align-items:start;">
      ${marketingManager ? `<div class="card">
        <div class="card-header"><div><div class="card-title">Add Team Member</div><div class="card-subtitle">TL access required.</div></div></div>
        <div class="card-body">
          <input type="hidden" id="mkt-team-edit-index" value="">
          <div class="form-group"><label class="form-label">Name</label><input type="text" class="form-control" id="mkt-team-name" placeholder="e.g. Mark"></div>
          <div class="form-group"><label class="form-label">Role</label><input type="text" class="form-control" id="mkt-team-role" placeholder="e.g. Ads + Creatives"></div>
          <div class="form-group">
            <label class="form-label">Pages (assigned)</label>
            <div id="mkt-team-pages" style="display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--surface);">
              ${getPosSourceOptions().map((p) => `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                <input type="checkbox" class="mkt-team-page-cb" value="${escapeHtml(p)}" style="margin:0;">
                <span>${escapeHtml(p)}</span>
              </label>`).join('') || '<span style="font-size:12px;color:var(--text-muted);">No pages available yet. Sync POS first.</span>'}
            </div>
            <div class="field-help">Pumili ng isa o higit pang pages na hawak ng team member. Ad spend at sales doon ila-lump sa kanya.</div>
          </div>
          <div class="form-group"><label class="form-label">Primary Focus</label><input type="text" class="form-control" id="mkt-team-primary" placeholder="e.g. Dragon pages"></div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary" onclick="saveMarketingTeamMember()">Save Member</button>
            <button class="btn btn-secondary" onclick="cancelMarketingTeamEdit()">Cancel</button>
          </div>
        </div>
      </div>` : ''}
      <div class="card erp-card">
        <div class="card-header"><div><div class="card-title">Team Performance</div><div class="card-subtitle">Date-range totals by owner.</div></div></div>
        <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:12px;">
          ${ownerTotals.map((member, index) => `<div class="erp-member-card" style="position:relative;">
            ${marketingManager ? `<div style="position:absolute;top:8px;right:8px;display:flex;gap:4px;">
              <button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:11px;" onclick="editMarketingTeamMember(${index})">Edit</button>
              <button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:11px;color:var(--danger);" onclick="deleteMarketingTeamMember(${index})">×</button>
            </div>` : ''}
            <div class="stat-label" style="padding-right:${marketingManager ? '64px' : '0'}">${escapeHtml(member.role)}</div>
            <div class="stat-value" style="font-size:18px;overflow-wrap:break-word;">${escapeHtml(member.name)}</div>
            ${member.pages && member.pages.length ? `<div style="font-size:11px;color:var(--accent);font-weight:600;margin:4px 0;overflow-wrap:break-word;">📍 ${member.pages.map(p => escapeHtml(p)).join(', ')}</div>` : ''}
            <div class="stat-meta" style="overflow-wrap:break-word;">${escapeHtml(member.primary)}</div>
            <div style="margin-top:12px; display:grid; gap:4px; font-size:12px;">
              <div style="display:flex;justify-content:space-between;"><span>Sales</span><strong>${marketingMoney(member.sales)}</strong></div>
              <div style="display:flex;justify-content:space-between;"><span>Spend</span><strong>${marketingMoney(member.spend)}</strong></div>
              <div style="display:flex;justify-content:space-between;"><span>ROAS</span><strong>${marketingRoas(member.roas)}</strong></div>
              <div style="display:flex;justify-content:space-between;"><span>Orders</span><strong>${member.orders}</strong></div>
            </div>
          </div>`).join('')}
        </div>
      </div>
    </div>
  </div>

  <div id="mkt-standup" class="tab-content${lastMarketingTab === 'mkt-standup' ? ' active' : ''}">
    <div style="display:grid; grid-template-columns:minmax(320px,.8fr) minmax(420px,1.2fr); gap:20px; align-items:start;">
      <div class="card erp-card">
        <div class="card-header"><div><div class="card-title">Daily Standup Log</div><div class="card-subtitle">Yesterday score, today priority, blockers.</div></div></div>
        <div class="card-body">
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Date</label><input type="date" class="form-control" id="mkt-standup-date" value="${normalizeDateString(new Date())}"></div>
            <div class="form-group"><label class="form-label">Owner</label><select class="form-control" id="mkt-standup-owner">${state.team.map((member) => `<option value="${escapeHtml(member.name)}">${escapeHtml(member.name)}</option>`).join('')}</select></div>
          </div>
          <div class="form-group"><label class="form-label">Yesterday Score</label><input type="text" class="form-control" id="mkt-standup-yesterday" placeholder="Wins / numbers / learning"></div>
          <div class="form-group"><label class="form-label">Today Priority</label><input type="text" class="form-control" id="mkt-standup-today" placeholder="Top priority"></div>
          <div class="form-group"><label class="form-label">Blockers</label><input type="text" class="form-control" id="mkt-standup-blockers" placeholder="None"></div>
          <button class="btn btn-primary" onclick="addMarketingStandup()">Log Standup</button>
        </div>
      </div>
      <div class="card erp-card">
        <div class="card-header"><div><div class="card-title">Standup Records</div><div class="card-subtitle">Latest team check-ins.</div></div></div>
        <div class="card-body">
          <div class="erp-mini-list">
            ${latestStandups.length ? latestStandups.map((item, reverseIndex) => {
              const index = (state.standups || []).length - 1 - reverseIndex;
              return `<div>
                <span><strong>${escapeHtml(item.date)}</strong> - ${escapeHtml(item.owner)}</span>
                <button class="btn btn-ghost btn-sm" onclick="deleteMarketingStandup(${index})">Delete</button>
                <small>${escapeHtml(item.today || '')}${item.blockers ? ` | Blocker: ${escapeHtml(item.blockers)}` : ''}</small>
              </div>`;
            }).join('') : '<div><span>No standups yet.</span><strong>Ready</strong></div>'}
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="mkt-adaccounts" class="tab-content${lastMarketingTab === 'mkt-adaccounts' ? ' active' : ''}">
    ${marketingManager ? `<div class="modal-overlay" id="mkt-adaccount-modal">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title" id="mkt-adaccount-modal-title">Add Ad Account</div>
          <button class="modal-close" onclick="closeMarketingAdAccountModal()">×</button>
        </div>
        <div class="modal-body">
          <input type="hidden" id="mkt-adaccount-edit-index" value="">
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Status</label>
              <select class="form-control" id="mkt-adaccount-status">
                <option value="RUNNING">RUNNING</option>
                <option value="ACTIVE">ACTIVE</option>
                <option value="PAUSED">PAUSED</option>
                <option value="DISABLED">DISABLED</option>
                <option value="REVIEW">REVIEW</option>
              </select>
            </div>
            <div class="form-group"><label class="form-label">BM</label><input type="text" class="form-control" id="mkt-adaccount-bm" placeholder="e.g. BM01"></div>
            <div class="form-group"><label class="form-label">Account</label><input type="text" class="form-control" id="mkt-adaccount-acc" placeholder="Account ID or name"></div>
            <div class="form-group">
              <label class="form-label">Page</label>
              <select class="form-control" id="mkt-adaccount-page">
                <option value="">— Select page —</option>
                ${state.pages.map((page) => `<option value="${escapeHtml(page.name)}">${escapeHtml(page.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label class="form-label">Product</label><input type="text" class="form-control" id="mkt-adaccount-product" placeholder="Product being advertised"></div>
            <div class="form-group"><label class="form-label">Advertiser</label><input type="text" class="form-control" id="mkt-adaccount-advertiser" placeholder="Person responsible"></div>
            <div class="form-group" style="grid-column:1 / -1;"><label class="form-label">Payment Reference</label><input type="text" class="form-control" id="mkt-adaccount-payment" placeholder="Card / billing ref"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeMarketingAdAccountModal()">Cancel</button>
          <button class="btn btn-primary" onclick="saveMarketingAdAccount()">Save Account</button>
        </div>
      </div>
    </div>` : ''}
    <div class="card erp-card">
      <div class="card-header">
        <div><div class="card-title">Ad Accounts Registry</div><div class="card-subtitle">Status, BM, account, page, product, advertiser, and payment reference.</div></div>
        ${marketingManager ? '<button class="btn btn-primary btn-sm" onclick="openMarketingAdAccountModal()">+ Add Account</button>' : ''}
      </div>
      <div class="table-container">
        <table>
          <thead><tr><th>Status</th><th>BM</th><th>Account</th><th>Page</th><th>Product</th><th>Advertiser</th><th>Payment</th><th></th></tr></thead>
          <tbody>
            ${(state.adAccounts || []).map((account, index) => `<tr>
              <td><span class="badge ${['RUNNING','ACTIVE'].includes(String(account.status).toUpperCase()) ? 'badge-success' : 'badge-warning'}">${escapeHtml(account.status)}</span></td>
              <td>${escapeHtml(account.bm)}</td>
              <td>${escapeHtml(account.acc)}</td>
              <td>${escapeHtml(account.page)}</td>
              <td>${escapeHtml(account.product)}</td>
              <td>${escapeHtml(account.advertiser)}</td>
              <td>${escapeHtml(account.payment)}</td>
              <td>${marketingManager ? `<button class="btn btn-ghost btn-sm" onclick="editMarketingAdAccount(${index})">Edit</button>
                <button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="deleteMarketingAdAccount(${index})">Delete</button>` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-muted)">No accounts.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  ${marketingManager ? `<div class="modal-overlay" id="mkt-targets-modal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Marketing Targets</div>
        <button class="modal-close" onclick="closeModal('mkt-targets-modal')">×</button>
      </div>
      <div class="modal-body">
        <div class="card-subtitle" style="margin-bottom:14px;">Used for pacing and dashboard status indicators.</div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Monthly Gross Sales</label><input type="number" class="form-control" id="mkt-target-sales" value="${state.targets.sales}"></div>
          <div class="form-group"><label class="form-label">Daily Ad Spend Target</label><input type="number" class="form-control" id="mkt-target-spend" value="${state.targets.spend}"></div>
          <div class="form-group"><label class="form-label">ROAS Target</label><input type="number" class="form-control" id="mkt-target-roas" value="${state.targets.roas}" step="0.1"></div>
          <div class="form-group"><label class="form-label">Max RTS Rate %</label><input type="number" class="form-control" id="mkt-target-rts" value="${state.targets.rts}" step="0.1"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('mkt-targets-modal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveMarketingTargets()">Save Targets</button>
      </div>
    </div>
  </div>` : ''}

  </div>`;
}

// ─── RENDER: INVENTORY ──────────────────────────────────────
function renderCSR() {
  const today = new Date().toISOString().split('T')[0];
  // Admins and view-only roles (Logistics, Sales & Marketing) see the records
  // dashboard without the Daily Record input form.
  const adminDashboardOnly = isAdminUser() || isCSRViewOnlyUser();
  const pageOptions = getCSRPageOptions();
  const inputPanel = adminDashboardOnly ? '' : `
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Daily Record Input</div><div class="card-subtitle">Pick a page, enter the Order ID, then the details auto-fill from Google Orders.</div></div>
      </div>
      <div class="card-body">
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Record Date <span class="required">*</span></label>
            <input type="date" class="form-control" id="csr-date" value="${today}">
          </div>
          <div class="form-group">
            <label class="form-label">Name CSR</label>
            <input type="text" class="form-control readonly-field" id="csr-name" value="${escapeHtml(getCurrentCsrName())}" readonly>
            <div class="field-help">Auto-filled from the logged-in member.</div>
          </div>
        </div>

        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Page Name <span class="required">*</span></label>
            <select class="form-control" id="csr-page-name">
              <option value="">Select page...</option>
              ${pageOptions.map((page) => `<option value="${escapeHtml(page)}">${escapeHtml(page)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Type of Sales <span class="required">*</span></label>
            <select class="form-control" id="csr-sales-type">
              <option value="">Select sales type...</option>
              ${CSR_SALES_TYPES.map((type) => `<option value="${type}">${type}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Order ID <span class="required">*</span></label>
          <div class="input-group">
            <input type="text" class="form-control font-mono" id="csr-order-id" placeholder="Enter Order ID" onkeydown="if(event.key==='Enter'){event.preventDefault();lookupCSROrder();}">
            <button class="btn btn-primary" type="button" onclick="lookupCSROrder()">Search</button>
          </div>
          <div class="field-help" id="csr-lookup-help">Search the chat page by Order ID to auto-fill the details below.</div>
        </div>

        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Customer Name</label>
            <input type="text" class="form-control readonly-field" id="csr-customer-name" placeholder="Auto-filled" readonly>
          </div>
          <div class="form-group">
            <label class="form-label">Cellphone Number</label>
            <input type="text" class="form-control readonly-field font-mono" id="csr-cellphone-number" placeholder="Auto-filled" readonly>
          </div>
        </div>

        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Price</label>
            <div class="input-group">
              <span class="input-addon">₱</span>
              <input type="number" class="form-control readonly-field" id="csr-price" placeholder="0.00" readonly>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Tracking Number</label>
            <input type="text" class="form-control readonly-field font-mono" id="csr-tracking-number" placeholder="Auto-filled if available" readonly>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Status</label>
          <input type="text" class="form-control readonly-field" id="csr-status" placeholder="Auto-filled from latest order status" readonly>
          <div class="field-help">Reflects the latest status from the linked order record.</div>
        </div>

        <div class="flex gap-3">
          <button class="btn btn-primary" id="csr-save-btn" onclick="saveCSRRecord()">${getCSRPrimaryButtonLabel()}</button>
          <button class="btn btn-secondary" id="csr-reset-btn" onclick="resetCSRForm()">Reset</button>
        </div>
      </div>
    </div>`;

  return `
  <div class="page-header">
    <div class="page-title"><h1>CSR Daily Records</h1><p>Admins and CSR TL can view all CSR entries. CSR users only see and edit their own sales records.</p></div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="exportTableCSV('csr-records-table', 'csr-daily-records')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8M5 7l3 3 3-3M2 12h12"/></svg>
        Export CSV
      </button>
    </div>
  </div>

  <div class="${adminDashboardOnly ? '' : 'split-layout'}" style="margin-bottom:20px;">
    ${inputPanel}

    <div class="summary-stack">
      <div id="csr-summary"></div>
    </div>
  </div>

  <div class="table-container">
    <div class="table-toolbar">
      <div class="table-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
        <input type="text" placeholder="Search CSR, customer, page, tracking..." id="csr-search" oninput="filterCSRTable()">
      </div>
      <div class="table-filters" id="csr-filter-group">
        <button class="filter-pill active" data-csr-filter="daily" onclick="setCSRFilter('daily', this)">Daily</button>
        <button class="filter-pill" data-csr-filter="weekly" onclick="setCSRFilter('weekly', this)">Week</button>
        <button class="filter-pill" data-csr-filter="monthly" onclick="setCSRFilter('monthly', this)">Month</button>
        <button class="filter-pill" data-csr-filter="custom" onclick="setCSRFilter('custom', this)">Custom</button>
      </div>
      <div class="custom-range hidden" id="csr-custom-range">
        <input type="date" class="form-control" id="csr-date-from">
        <input type="date" class="form-control" id="csr-date-to">
        <button class="btn btn-secondary btn-sm" onclick="applyCSRCustomRange()">Apply</button>
      </div>
      ${canViewAllCSRRecords() ? `<select class="form-control" id="csr-name-filter" onchange="setCSRNameFilter()" style="min-width:160px;height:34px;font-size:13px;padding:6px 10px;">
        <option value="">All CSR Names</option>
        ${[...new Set([...DB.csrAgentNames, ...DB.csrRecords.map((r) => r.csrName)].filter(Boolean))].sort().map((n) => `<option value="${escapeHtml(n)}"${csrNameFilter === n ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')}
      </select>` : ''}
    </div>
    <div style="overflow-x:auto;">
      <table id="csr-records-table">
        <thead><tr>
          <th>Date</th><th>Name CSR</th><th>Page Name</th><th>Order ID</th><th>Customer</th><th>Cellphone</th>
          <th>Type of Sales</th><th>Status</th><th>Price</th><th>Tracking Number</th><th>Actions</th>
        </tr></thead>
        <tbody id="csr-tbody"></tbody>
      </table>
    </div>
    <div class="table-pagination" id="csr-pagination"></div>
  </div>`;
}

function renderInventory() {
  const rtsLookups = computeRtsPcsLookups();
  const lowStock = DB.inventory.filter(i => inventoryEffectiveStock(i, rtsLookups) < i.reorder);
  const canEditStock = canManageInventoryStock();

  return `
  <div class="page-header">
    <div class="page-title"><h1>Inventory</h1><p>Manage products, supplies, and stock levels.</p></div>
    <div class="page-actions">
      ${canEditStock ? `<button class="btn btn-secondary" onclick="startCsvImport('inventory')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 14V6M5 9l3-3 3 3M2 3h12"/></svg>
        Import CSV
      </button>` : ''}
      ${canEditStock ? `<button class="btn btn-secondary" onclick="openStockModal()">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>
        Stocks Update
      </button>` : ''}
      ${canEditStock ? `<button class="btn btn-primary" onclick="openModal('add-inventory-modal')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>
        Add Item
      </button>` : ''}
    </div>
  </div>

  ${lowStock.length ? `
  <div class="alert alert-warning">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2L14 13H2L8 2z"/><path d="M8 6v4M8 11v1"/></svg>
    <div><strong>${lowStock.length} item(s) below reorder point:</strong> ${lowStock.map(i => i.name).join(', ')}</div>
  </div>` : ''}

  <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr); margin-bottom:20px;">
    <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">Total Products</div><div class="stat-value">${DB.inventory.filter(i=>i.type==='Product').length}</div></div>
    <div class="stat-card green"><div class="stat-card-accent"></div><div class="stat-label">Total Supplies</div><div class="stat-value">${DB.inventory.filter(i=>i.type==='Supply').length}</div></div>
    <div class="stat-card red"><div class="stat-card-accent"></div><div class="stat-label">Low Stock</div><div class="stat-value">${lowStock.length}</div></div>
    <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">Total SKUs</div><div class="stat-value">${DB.inventory.length}</div></div>
  </div>

  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab(this,'tab-active')">Active</button>
    <button class="tab-btn" onclick="switchTab(this,'tab-inactive')">Not Active</button>
    <button class="tab-btn" onclick="switchTab(this,'tab-supplies')">Supplies</button>
    <button class="tab-btn" onclick="switchTab(this,'tab-rts-return')">RTS Return</button>
    <button class="tab-btn" onclick="switchTab(this,'tab-stock-history')">Stock History</button>
  </div>

  <div id="tab-active" class="tab-content active">
    <div style="margin-bottom:12px;">
      <input type="text" id="inv-products-search" class="form-control" style="max-width:320px;" placeholder="Search by item name or SKU..." oninput="filterInventoryProducts()">
    </div>
    <div class="table-container">
      ${renderInventoryTable(inventoryProductsFiltered())}
    </div>
  </div>
  <div id="tab-supplies" class="tab-content">
    <div class="table-container">
      ${renderInventoryTable(DB.inventory.filter(i => i.type === 'Supply'))}
    </div>
  </div>
  <div id="tab-inactive" class="tab-content">
    <div class="table-container">
      ${renderInventoryTable(DB.inventory.filter(i => i.type === 'Product' && i.active === 0))}
    </div>
  </div>
  <div id="tab-rts-return" class="tab-content">
    ${renderRtsReturnTab()}
  </div>
  <div id="tab-stock-history" class="tab-content">
    ${renderStockHistoryTab()}
  </div>

  <!-- Add/Edit Inventory Modal -->
  ${canEditStock ? `<div class="modal-overlay" id="add-inventory-modal">
    <div class="modal">
      <div class="modal-header"><div class="modal-title">Add Inventory Item</div><button class="modal-close" onclick="closeModal('add-inventory-modal')">×</button></div>
      <div class="modal-body">
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Item Name <span class="required">*</span></label>
            <div id="inv-name-field">${invNameFieldHtml()}</div>
          </div>
          <div class="form-group"><label class="form-label">SKU</label><input type="text" class="form-control" id="inv-sku" placeholder="SKU-XXX"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Type <span class="required">*</span></label>
            <select class="form-control" id="inv-type" onchange="onInventoryTypeChange()"><option>Product</option><option>Supply</option></select></div>
          <div class="form-group"><label class="form-label">Unit</label><input type="text" class="form-control" id="inv-unit" placeholder="pcs, roll, bag..."></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Current Stock</label><input type="number" class="form-control" id="inv-stock" placeholder="0"></div>
          <div class="form-group"><label class="form-label">Cost Price</label><input type="number" class="form-control" id="inv-cost" placeholder="0.00"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('add-inventory-modal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveInventoryItem()">Save Item</button>
      </div>
    </div>
  </div>` : ''}

  <!-- Edit Item Modal -->
  ${canEditStock ? `<div class="modal-overlay" id="edit-inventory-modal">
    <div class="modal">
      <div class="modal-header"><div class="modal-title">Edit Item</div><button class="modal-close" onclick="closeModal('edit-inventory-modal')">×</button></div>
      <div class="modal-body">
        <input type="hidden" id="edit-inv-id">
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Item Name <span class="required">*</span></label><input type="text" class="form-control" id="edit-inv-name" placeholder="Item name"></div>
          <div class="form-group"><label class="form-label">SKU</label><input type="text" class="form-control" id="edit-inv-sku" placeholder="SKU-XXX"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Type</label>
            <select class="form-control" id="edit-inv-type"><option>Product</option><option>Supply</option></select></div>
          <div class="form-group"><label class="form-label">Unit</label><input type="text" class="form-control" id="edit-inv-unit" placeholder="pcs, roll, bag..."></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Cost Price</label><input type="number" class="form-control" id="edit-inv-cost" placeholder="0.00"></div>
          <div class="form-group"><label class="form-label">Sell Price</label><input type="number" class="form-control" id="edit-inv-price" placeholder="0.00"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Current Stock</label><input type="number" class="form-control" id="edit-inv-stock" placeholder="0" min="0"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('edit-inventory-modal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditItem()">Save Changes</button>
      </div>
    </div>
  </div>` : ''}

  <!-- Stocks Update Modal -->
  ${canEditStock ? `<div class="modal-overlay" id="stocks-modal">
    <div class="modal">
      <div class="modal-header"><div class="modal-title">Update Stock</div><button class="modal-close" onclick="closeModal('stocks-modal')">×</button></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Select Item</label>
          <select class="form-control" id="stocks-item">
            ${DB.inventory.map(i => `<option value="${i.id}">${i.name} (Current: ${i.stock} ${i.unit})</option>`).join('')}
          </select>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Action</label>
            <select class="form-control" id="stocks-action"><option value="add">Add Stock (+)</option><option value="remove">Remove Stock (-)</option><option value="set">Set Exact Quantity</option></select>
          </div>
          <div class="form-group"><label class="form-label">Quantity</label><input type="number" class="form-control" id="stocks-qty" placeholder="0" min="0"></div>
        </div>
        <div class="form-group"><label class="form-label">Notes</label><textarea class="form-control" id="stocks-notes" placeholder="Reason for update..."></textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('stocks-modal')">Cancel</button>
        <button class="btn btn-primary" onclick="updateStock()">Update Stock</button>
      </div>
    </div>
  </div>` : ''}`;
}

function renderInventoryTable(items, pageScope) {
  // Per-item RTS pcs: scoped per-page tabs match by name; the main tabs honor the
  // page→SKU mapping (SKU wins, product-name fallback for unmapped pages).
  let getRtsPcs;
  if (pageScope) {
    const rtsMap = (DB.rtsPcsByPageProduct || {})[pageScope] || {};
    getRtsPcs = (item) => Number(rtsMap[normalizeProductKey(item.name)] || 0);
  } else {
    const { skuPcs, namePcs } = computeRtsPcsLookups();
    getRtsPcs = (item) => (item.sku && skuPcs[item.sku] != null)
      ? Number(skuPcs[item.sku])
      : Number(namePcs[normalizeProductKey(item.name)] || 0);
  }
  // Column totals shown in the footer (base stock, RTS pcs, combined total).
  const totalBaseStock = items.reduce((s, it) => s + Number(it.stock || 0), 0);
  const totalRts = items.reduce((s, it) => s + getRtsPcs(it), 0);
  const totalStock = totalBaseStock + totalRts;
  return `
    <table>
      <thead><tr><th>SKU</th><th>Item Name</th><th>Type</th><th title="Managed stock, excluding RTS">Stock</th><th title="${pageScope ? `Pcs scanned in RTS for ${escapeHtml(pageScope)}` : 'Total pcs scanned in RTS for this product'}">RTS Pcs</th><th title="Stock + RTS pcs">Total Stock</th><th title="Stock level that triggers a low-stock alert">Reorder Pt</th><th>Unit Cost</th><th>Status</th><th>Active</th><th>Actions</th></tr></thead>
      <tbody>
        ${items.length ? items.map(item => {
          const rtsPcs = getRtsPcs(item);
          // RTS pcs are returned items physically back in the warehouse, so they
          // count toward total stock (and the OK/Low/Critical status).
          const effectiveStock = Number(item.stock || 0) + rtsPcs;
          const badge = effectiveStock >= item.reorder ? 'badge-success' : effectiveStock >= item.reorder * 0.5 ? 'badge-warning' : 'badge-danger';
          const badgeText = effectiveStock >= item.reorder ? 'OK' : effectiveStock >= item.reorder * 0.5 ? 'Low' : 'Critical';
          const isActive = item.active !== 0;
          return `<tr${isActive ? '' : ' style="opacity:0.55"'}>
            <td><span class="font-mono text-xs text-muted">${item.sku}</span></td>
            <td>${canManageInventoryStock()
              ? `<button type="button" class="inv-name-edit" style="font-weight:500;background:none;border:none;padding:0;color:var(--text);cursor:pointer;text-align:left;font:inherit;font-weight:500" onclick="openEditItemModal('${escapeHtml(item.id)}')" title="Click to edit item details">${escapeHtml(item.name)}</button>`
              : `<div style="font-weight:500">${escapeHtml(item.name)}</div>`}</td>
            <td><span class="badge ${item.type==='Product'?'badge-info':'badge-gray'}">${item.type}</span></td>
            <td><strong>${Number(item.stock || 0).toLocaleString()}</strong> ${item.unit}</td>
            <td>${rtsPcs ? `<strong>${rtsPcs.toLocaleString()}</strong> pcs` : '<span class="text-xs text-muted">—</span>'}</td>
            <td${rtsPcs ? ` title="Stock ${item.stock} + RTS ${rtsPcs.toLocaleString()}"` : ''}><strong>${effectiveStock.toLocaleString()}</strong> ${item.unit}</td>
            <td>
              ${canManageInventoryStock()
                ? `<input type="number" class="form-control" style="width:78px;padding:4px 8px;height:auto;font-size:13px" value="${item.reorder}" min="0" onchange="updateReorderPoint('${escapeHtml(item.id)}', this.value)" title="Editable reorder point">`
                : `<span>${item.reorder}</span>`}
            </td>
            <td>₱${item.cost}</td>
            <td><span class="badge ${badge}">${badgeText}</span></td>
            <td>
              ${canManageInventoryStock()
                ? `<label class="switch" title="${isActive ? 'Active — click to close' : 'Closed — click to activate'}">
                    <input type="checkbox" ${isActive ? 'checked' : ''} onchange="toggleInventoryActive('${escapeHtml(item.id)}', this.checked)">
                    <span class="switch-slider"></span>
                  </label>`
                : `<span class="badge ${isActive ? 'badge-success' : 'badge-gray'}">${isActive ? 'Active' : 'Closed'}</span>`}
            </td>
            <td>
              <div class="flex gap-2">
                ${canManageInventoryStock() ? `<button class="btn btn-ghost btn-sm" onclick="openStockModal('${escapeHtml(item.id)}')">Restock</button>` : '<span class="text-xs text-muted">View only</span>'}
              </div>
            </td>
          </tr>`;
        }).join('') : '<tr><td colspan="11" style="text-align:center;padding:32px;color:var(--text-muted)">No inventory yet. Import a CSV or add an item.</td></tr>'}
      </tbody>
      ${items.length ? `<tfoot>
        <tr style="font-weight:700;border-top:2px solid var(--border)">
          <td colspan="3" style="text-align:right">Totals</td>
          <td><strong>${totalBaseStock.toLocaleString()}</strong></td>
          <td>${totalRts ? `<strong>${totalRts.toLocaleString()}</strong> pcs` : '—'}</td>
          <td><strong>${totalStock.toLocaleString()}</strong></td>
          <td colspan="5"></td>
        </tr>
      </tfoot>` : ''}
    </table>`;
}

// Add Item modal — Item Name is a free-text input for both Product and Supply.
// A datalist suggests product names already seen in RTS scans so a typed name
// matches the RTS pcs roll-up. Same id either way so saveInventoryItem reads it
// uniformly.
function invNameFieldHtml() {
  const names = DB.rtsProductNames || [];
  const list = names.length
    ? `<datalist id="inv-name-options">${names.map((nm) => `<option value="${escapeHtml(nm)}"></option>`).join('')}</datalist>`
    : '';
  return `<input type="text" class="form-control" id="inv-name" placeholder="Item name"${names.length ? ' list="inv-name-options"' : ''}>${list}`;
}

function onInventoryTypeChange() {
  // Item Name field is the same for every type; nothing to swap. Kept so the
  // existing onchange hook on the Type select stays valid.
}

// Refresh the Item Name suggestions once RTS scan data loads, preserving any
// value the user already typed.
function refreshInventoryNamePicker() {
  const field = document.getElementById('inv-name-field');
  if (!field) return;
  const current = document.getElementById('inv-name')?.value || '';
  field.innerHTML = invNameFieldHtml();
  const input = document.getElementById('inv-name');
  if (input) input.value = current;
}

function openStockModal(itemId = '') {
  if (!canManageInventoryStock()) {
    showToast('warning', 'Not allowed', 'Only administrators and logistics staff can edit inventory stock.');
    return;
  }
  openModal('stocks-modal');
  if (itemId) {
    const select = document.getElementById('stocks-item');
    if (select) select.value = itemId;
  }
}

// Open the Edit Item modal prefilled with the item's current details.
function openEditItemModal(itemId) {
  if (!canManageInventoryStock()) {
    showToast('warning', 'Not allowed', 'Only administrators and logistics staff can edit inventory items.');
    return;
  }
  const item = DB.inventory.find(i => i.id === itemId);
  if (!item) return;
  openModal('edit-inventory-modal');
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('edit-inv-id', item.id);
  set('edit-inv-name', item.name || '');
  set('edit-inv-sku', item.sku || '');
  set('edit-inv-type', item.type || 'Product');
  set('edit-inv-unit', item.unit || 'pcs');
  set('edit-inv-cost', item.cost != null ? item.cost : '');
  set('edit-inv-price', item.price != null ? item.price : '');
  set('edit-inv-stock', item.stock != null ? item.stock : '');
}

// Save edits made in the Edit Item modal.
async function saveEditItem() {
  if (!canManageInventoryStock()) {
    showToast('warning', 'Not allowed', 'Only administrators and logistics staff can edit inventory items.');
    return;
  }
  const itemId = document.getElementById('edit-inv-id')?.value;
  const item = DB.inventory.find(i => i.id === itemId);
  if (!item) return;
  const name = document.getElementById('edit-inv-name')?.value?.trim();
  if (!name) { showToast('error', 'Name required', 'Please enter item name'); return; }
  const sku = document.getElementById('edit-inv-sku')?.value?.trim() || null;
  const type = document.getElementById('edit-inv-type')?.value || 'Product';
  const unit = document.getElementById('edit-inv-unit')?.value?.trim() || 'pcs';
  const cost = parseFloat(document.getElementById('edit-inv-cost')?.value || 0) || 0;
  const priceRaw = document.getElementById('edit-inv-price')?.value;
  const sell_price = priceRaw === '' || priceRaw == null ? null : (parseFloat(priceRaw) || 0);
  const stock = Math.max(0, parseInt(document.getElementById('edit-inv-stock')?.value || 0, 10) || 0);

  try {
    await authorizedJsonRequest(`/inventory/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, sku, type, unit, cost_price: cost, sell_price, stock }),
    });
    await refreshInventoryFromBackend();
  } catch (error) {
    showToast('error', 'Update failed', error.message || 'Could not update item.');
    return;
  }
  closeModal('edit-inventory-modal');
  rerenderInventoryTables();
  showToast('success', 'Item updated', name);
}

// ─── RENDER: EXPENSES ──────────────────────────────────────
function renderExpenses() {
  const totalExp = DB.expenses.reduce((s, e) => s + e.total, 0);
  const thisMonth = DB.expenses.filter(e => e.date.startsWith(new Date().toISOString().slice(0,7)));
  const monthTotal = thisMonth.reduce((s, e) => s + e.total, 0);

  return `
  <div class="page-header">
    <div class="page-title"><h1>Expenses</h1><p>Log and track all business expenses.</p></div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="exportTableCSV('expenses-table','expenses')">Export CSV</button>
      <button class="btn btn-primary btn-sm" onclick="openExpenseModal()">+ Log New Expense</button>
    </div>
  </div>

  <!-- Expense Log Modal -->
  <div class="modal-overlay" id="expense-log-modal">
    <div class="modal" style="max-width:480px;">
      <div class="modal-header">
        <div class="modal-title">Log New Expense</div>
        <button class="modal-close" onclick="closeModal('expense-log-modal')">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Date <span class="required">*</span></label><input type="date" class="form-control" id="exp-date" value="${new Date().toISOString().split('T')[0]}"></div>
        <div class="form-group"><label class="form-label">Category <span class="required">*</span></label>
          <select class="form-control" id="exp-cat">
            <option value="">Select category...</option>
            <option>Load</option><option>Utility</option><option>Product Supplies</option><option>Product</option><option>Shipping Fee</option><option>Transfer Fee</option><option>Others</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Classification <span class="required">*</span></label>
          <select class="form-control" id="exp-class">
            <option value="OPEX" selected>OPEX — Operating Expense</option>
            <option value="COGS">COGS — Cost of Goods Sold</option>
            <option value="CAPEX">CAPEX — Capital Expenditure</option>
          </select>
          <div class="field-help">Accounting classification used for reporting.</div>
        </div>
        <div class="form-group"><label class="form-label">Item Details / Name <span class="required">*</span></label><input type="text" class="form-control" id="exp-item" placeholder="e.g. Packing materials, Electricity bill..."></div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Quantity</label><input type="number" class="form-control" id="exp-qty" value="1" min="1" oninput="calcExpTotal()"></div>
          <div class="form-group"><label class="form-label">Price per unit</label>
            <div class="input-group">
              <span class="input-addon">₱</span>
              <input type="number" class="form-control" id="exp-price" placeholder="0.00" oninput="calcExpTotal()">
            </div>
          </div>
        </div>
        <div class="form-group"><label class="form-label">Noted By</label><input type="text" class="form-control" id="exp-noted" value="${App.user?.full_name || App.user?.name || ''}"></div>
        <div class="form-group">
          <label class="form-label">Total Amount</label>
          <div class="input-group">
            <span class="input-addon">₱</span>
            <input type="text" class="form-control" id="exp-total" placeholder="0.00" readonly style="background:var(--surface-3);font-weight:600;font-size:16px;">
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('expense-log-modal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveExpense()">Save Expense</button>
      </div>
    </div>
  </div>

  <div>
    <div class="stats-grid" style="grid-template-columns:repeat(4, 1fr); margin-bottom:16px;">
      <div class="stat-card red"><div class="stat-card-accent"></div><div class="stat-label">Total Expenses</div><div class="stat-value" style="font-size:18px;">₱${totalExp.toLocaleString()}</div></div>
      <div class="stat-card green"><div class="stat-card-accent"></div><div class="stat-label">Credit Received</div><div class="stat-value" style="font-size:18px;" id="exp-credit-total">₱0</div></div>
      <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">Net Expenses</div><div class="stat-value" style="font-size:18px;" id="exp-net-total">₱${totalExp.toLocaleString()}</div></div>
      <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">This Month</div><div class="stat-value" style="font-size:18px;">₱${monthTotal.toLocaleString()}</div></div>
    </div>

    <div class="tabs" style="margin-bottom:16px;">
      <button class="tab-btn active" onclick="switchTab(this,'exp-tab-list')">Expenses</button>
      <button class="tab-btn" onclick="switchTab(this,'exp-tab-summary')">Summary</button>
    </div>

    <!-- Tab: Expenses list -->
    <div class="tab-content active" id="exp-tab-list">
      <div class="card" style="margin-bottom:16px;">
        <div class="card-header" style="flex-wrap:wrap;gap:10px;">
          <div>
            <div class="card-title">Log Credit Received</div>
            <div class="card-subtitle">Refunds, reimbursements, or income that offsets expenses</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="loadExpenseCredits()">↻ Refresh</button>
        </div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:140px 160px 1fr 1fr auto;gap:10px;align-items:end;">
            <div class="form-group" style="margin:0;">
              <label class="form-label">Date</label>
              <input type="date" class="form-control" id="credit-date" value="${new Date().toISOString().split('T')[0]}">
            </div>
            <div class="form-group" style="margin:0;">
              <label class="form-label">Amount</label>
              <div class="input-group">
                <span class="input-addon">₱</span>
                <input type="number" class="form-control" id="credit-amount" placeholder="0.00" min="0" step="0.01">
              </div>
            </div>
            <div class="form-group" style="margin:0;">
              <label class="form-label">Source</label>
              <input type="text" class="form-control" id="credit-source" placeholder="e.g. Refund from supplier">
            </div>
            <div class="form-group" style="margin:0;">
              <label class="form-label">Notes</label>
              <input type="text" class="form-control" id="credit-notes" placeholder="Optional">
            </div>
            <button class="btn btn-primary" onclick="saveCredit()">Add</button>
          </div>
          <div id="credit-list" style="margin-top:14px;"></div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-toolbar">
          <div class="table-search">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
            <input type="text" placeholder="Search expenses..." id="exp-search" oninput="filterExpTable()">
          </div>
          <div class="table-filters">
            ${['All','Load','Utility','Product Supplies','Product','Shipping Fee','Transfer Fee','Others'].map((c,i) =>
              `<button class="filter-pill ${i===0?'active':''}" onclick="setExpCatFilter('${c}',this)">${c}</button>`
            ).join('')}
          </div>
          <div class="table-filters" style="margin-left:8px;">
            ${['All','OPEX','COGS','CAPEX'].map((c,i) =>
              `<button class="filter-pill exp-class-pill ${i===0?'active':''}" onclick="setExpClassFilter('${c}',this)">${c}</button>`
            ).join('')}
          </div>
        </div>
        <table id="expenses-table">
          <thead><tr><th>ID</th><th>Date</th><th>Category</th><th>Class</th><th>Item</th><th>Qty</th><th>Price</th><th>Total</th><th>Noted By</th></tr></thead>
          <tbody id="exp-tbody">
            ${DB.expenses.map(e => `<tr data-classification="${escapeHtml(e.classification || 'OPEX')}">
              <td class="font-mono text-xs text-muted">${e.id}</td>
              <td>${e.date}</td>
              <td><span class="badge ${catBadge(e.category)}">${e.category}</span></td>
              <td><span class="badge ${classBadge(e.classification || 'OPEX')}">${e.classification || 'OPEX'}</span></td>
              <td>${e.item}</td>
              <td>${e.qty}</td>
              <td>₱${e.price.toLocaleString()}</td>
              <td><strong>₱${e.total.toLocaleString()}</strong></td>
              <td>${e.noted}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab: Summary by category -->
    <div class="tab-content" id="exp-tab-summary">
      ${renderExpenseSummary()}
    </div>
  </div>`;
}

function renderExpenseSummary() {
  const allCats = ['Load', 'Utility', 'Product Supplies', 'Product', 'Shipping Fee', 'Transfer Fee', 'Others'];
  const grandTotal = DB.expenses.reduce((s, e) => s + e.total, 0);
  const thisMonth = new Date().toISOString().slice(0, 7);

  const byCategory = allCats.map((cat) => {
    const items = DB.expenses.filter((e) => e.category === cat);
    const monthItems = items.filter((e) => e.date.startsWith(thisMonth));
    return {
      cat,
      count: items.length,
      total: items.reduce((s, e) => s + e.total, 0),
      monthTotal: monthItems.reduce((s, e) => s + e.total, 0),
    };
  }).filter((r) => r.count > 0);

  if (!byCategory.length) {
    return '<div class="empty-state"><h3>No expenses yet</h3><p>Log your first expense to see the summary.</p></div>';
  }

  const byClass = ['OPEX', 'COGS', 'CAPEX'].map((cls) => {
    const items = DB.expenses.filter((e) => (e.classification || 'OPEX') === cls);
    return { cls, count: items.length, total: items.reduce((s, e) => s + e.total, 0) };
  }).filter((r) => r.count > 0);

  return `
    <div style="display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start;">
      <div class="card">
        <div class="card-header"><div class="card-title">By Category</div></div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>Category</th><th>Entries</th><th>This Month</th><th>Total</th><th>% of Total</th></tr></thead>
            <tbody>
              ${byCategory.map((r) => {
                const pct = grandTotal > 0 ? ((r.total / grandTotal) * 100).toFixed(1) : '0.0';
                return `<tr>
                  <td><span class="badge ${catBadge(r.cat)}">${escapeHtml(r.cat)}</span></td>
                  <td>${r.count}</td>
                  <td>₱${r.monthTotal.toLocaleString()}</td>
                  <td><strong>₱${r.total.toLocaleString()}</strong></td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px;">
                      <div style="flex:1;height:6px;background:var(--surface-3);border-radius:999px;min-width:60px;">
                        <div style="width:${pct}%;height:100%;background:var(--primary);border-radius:999px;"></div>
                      </div>
                      <span style="font-size:12px;color:var(--text-muted);min-width:36px;">${pct}%</span>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
              <tr style="border-top:2px solid var(--border);font-weight:700;">
                <td>Total</td>
                <td>${DB.expenses.length}</td>
                <td>₱${DB.expenses.filter(e=>e.date.startsWith(thisMonth)).reduce((s,e)=>s+e.total,0).toLocaleString()}</td>
                <td>₱${grandTotal.toLocaleString()}</td>
                <td>100%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">By Classification</div></div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>Class</th><th>Entries</th><th>Total</th></tr></thead>
            <tbody>
              ${byClass.map((r) => `<tr>
                <td><span class="badge ${classBadge(r.cls)}">${r.cls}</span></td>
                <td>${r.count}</td>
                <td><strong>₱${r.total.toLocaleString()}</strong></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function catBadge(cat) {
  return { Load: 'badge-info', Utility: 'badge-warning', 'Product Supplies': 'badge-purple', Product: 'badge-success', 'Shipping Fee': 'badge-danger', 'Transfer Fee': 'badge-amber', Others: 'badge-gray' }[cat] || 'badge-gray';
}

function classBadge(cls) {
  return { COGS: 'badge-danger', OPEX: 'badge-info', CAPEX: 'badge-success' }[cls] || 'badge-gray';
}

function setExpClassFilter(cls, btn) {
  btn.parentElement.querySelectorAll('.filter-pill').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  const rows = document.querySelectorAll('#exp-tbody tr');
  rows.forEach((row) => {
    if (cls === 'All') { row.style.display = ''; return; }
    row.style.display = row.dataset.classification === cls ? '' : 'none';
  });
}

async function saveCredit() {
  const credit_date = document.getElementById('credit-date')?.value;
  const amount = Number(document.getElementById('credit-amount')?.value || 0);
  const source = document.getElementById('credit-source')?.value || '';
  const notes = document.getElementById('credit-notes')?.value || '';
  if (!credit_date || amount <= 0) {
    showToast('error', 'Validation failed', 'Date and a positive amount are required.');
    return;
  }
  try {
    await authorizedJsonRequest('/expenses/credits', {
      method: 'POST',
      body: JSON.stringify({ credit_date, amount, source, notes }),
    });
    showToast('success', 'Credit recorded', `₱${amount.toLocaleString()}`);
    ['credit-amount', 'credit-source', 'credit-notes'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    loadExpenseCredits();
  } catch (err) {
    showToast('error', 'Save failed', err.message);
  }
}

async function loadExpenseCredits() {
  const wrap = document.getElementById('credit-list');
  if (!wrap) return;
  try {
    const result = await authorizedJsonRequest('/expenses/credits/list?per_page=200');
    const items = Array.isArray(result?.data) ? result.data : [];
    const totalCredits = items.reduce((s, c) => s + Number(c.amount || 0), 0);

    const totalExpEl = document.getElementById('exp-credit-total');
    if (totalExpEl) totalExpEl.textContent = `₱${totalCredits.toLocaleString()}`;
    const netEl = document.getElementById('exp-net-total');
    if (netEl) {
      const expSum = DB.expenses.reduce((s, e) => s + Number(e.total || 0), 0);
      netEl.textContent = `₱${(expSum - totalCredits).toLocaleString()}`;
    }

    if (!items.length) {
      wrap.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:6px 0;">No credits recorded yet.</div>';
      return;
    }
    wrap.innerHTML = `
      <table class="data-table" style="margin-top:8px;font-size:13px;">
        <thead><tr><th>Date</th><th>Source</th><th>Notes</th><th style="text-align:right;">Amount</th><th></th></tr></thead>
        <tbody>
          ${items.slice(0, 10).map((c) => `<tr>
            <td>${escapeHtml(c.credit_date || '')}</td>
            <td>${escapeHtml(c.source || '-')}</td>
            <td>${escapeHtml(c.notes || '-')}</td>
            <td style="text-align:right;color:#059669;font-weight:600;">₱${Number(c.amount || 0).toLocaleString()}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="deleteCredit(${c.id})">×</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    wrap.innerHTML = `<div style="color:var(--text-muted);font-size:12px;">Failed to load credits: ${escapeHtml(err.message)}</div>`;
  }
}

async function deleteCredit(id) {
  if (!confirm('Delete this credit entry?')) return;
  try {
    await authorizedJsonRequest(`/expenses/credits/${id}`, { method: 'DELETE' });
    loadExpenseCredits();
  } catch (err) {
    showToast('error', 'Delete failed', err.message);
  }
}

// ─── RENDER: DAILY PICKUP ──────────────────────────────────
function renderDailyPickup() {
  return `
  <div class="page-header">
    <div class="page-title"><h1>Daily Pickup</h1><p>Log daily product pickups for delivery dispatch.</p></div>
  </div>

  <div class="tabs" style="margin-bottom:16px;">
    <button class="tab-btn active" onclick="switchTab(this,'pickup-tab-log')">Log Pickup</button>
    <button class="tab-btn" onclick="switchTab(this,'pickup-tab-status'); loadPickupStatusSummary()">Pickup Status</button>
  </div>

  <div id="pickup-tab-log" class="tab-content active">
  <div style="display:grid; grid-template-columns:420px 1fr; gap:20px; align-items:start;">
    <div class="card" style="position:sticky; top:80px;">
      <div class="card-header"><div class="card-title">Log Pickup</div></div>
      <div class="card-body">
        <div class="form-group"><label class="form-label">Date <span class="required">*</span></label><input type="date" class="form-control" id="pu-date" value="${new Date().toISOString().split('T')[0]}"></div>
        <div class="form-group"><label class="form-label">Product Name <span class="required">*</span></label>
          <select class="form-control" id="pu-product">
            <option value="">Select product...</option>
            ${DB.inventory.filter(i=>i.type==='Product').map(i=>`<option>${i.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label class="form-label">Type <span class="required">*</span></label>
          <select class="form-control" id="pu-type"><option>Product</option><option>Supplies</option></select>
        </div>
        <div class="form-group">
          <label class="form-label">How many customer orders? <span class="required">*</span></label>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            ${[1,2,3,4,'Others'].map(n => `
              <button class="filter-pill" id="orders-pill-${n}" onclick="selectOrders(${JSON.stringify(n)},this)">${n}</button>
            `).join('')}
          </div>
          <input type="number" class="form-control mt-2 hidden" id="pu-orders-custom" placeholder="Enter number of orders..." min="1">
          <input type="hidden" id="pu-orders" value="">
        </div>
        <div class="form-group"><label class="form-label">Total Pieces (all orders) <span class="required">*</span></label><input type="number" class="form-control" id="pu-pieces" placeholder="Total pieces to pickup" min="1"></div>
        <div class="form-group"><label class="form-label">Notes</label><textarea class="form-control" id="pu-notes" placeholder="Any pickup notes..."></textarea></div>
        <button class="btn btn-success w-full" onclick="savePickup()">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 8h12M2 4h12M2 12h8"/></svg>
          Save to Daily Pickup
        </button>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Pickup Records</div><span class="badge badge-info">${DB.dailyPickups.length} total</span></div>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr><th>ID</th><th>Date</th><th>Product</th><th>Type</th><th>Orders</th><th>Pieces</th><th>Notes</th></tr></thead>
          <tbody id="pickup-tbody">
            ${DB.dailyPickups.map(p => `<tr>
              <td class="font-mono text-xs text-muted">${p.id}</td>
              <td>${p.date}</td>
              <td style="font-weight:500">${p.product}</td>
              <td><span class="badge ${p.type==='Product'?'badge-info':'badge-gray'}">${p.type}</span></td>
              <td style="text-align:center"><strong>${p.customerOrders}</strong></td>
              <td style="text-align:center"><strong>${p.totalPieces}</strong></td>
              <td class="text-secondary text-sm">${p.notes || '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>
  </div>

  <div id="pickup-tab-status" class="tab-content">
    ${renderPickupStatusPanel()}
  </div>`;
}

// Pickup Status tab: per-page count of orders moved to "Waiting for pickup" plus
// pcs (leading number on product name, same rule as RTS Scan). Date-filtered by
// the day the status was updated. Driven by /orders/pos-orders/pickup-summary.
function renderPickupStatusPanel() {
  return `
    <div class="card">
      <div class="card-header" style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;">
        <div><div class="card-title">Pickup Status Updates</div><div class="card-subtitle">Orders tagged "Picked up", grouped by page · pcs from leading number in product</div></div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <div style="display:inline-flex;gap:6px;">
            <button class="btn btn-primary btn-sm" data-pickup-range="today" onclick="setPickupStatusRange('today')">Today</button>
            <button class="btn btn-secondary btn-sm" data-pickup-range="yesterday" onclick="setPickupStatusRange('yesterday')">Yesterday</button>
          </div>
          <input type="date" class="form-control" id="pickup-status-date" style="width:170px;" onchange="setPickupStatusDate()">
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr><th>Page</th><th style="text-align:right;">Total Pick Up</th><th style="text-align:right;">Pcs</th></tr></thead>
          <tbody id="pickup-status-summary">
            <tr><td colspan="3" style="text-align:center;padding:20px;color:var(--text-muted)">Loading...</td></tr>
          </tbody>
          <tfoot id="pickup-status-summary-foot"></tfoot>
        </table>
      </div>
    </div>`;
}

// Honours the Today/Yesterday toggle and the custom date picker, defaulting to
// today. Mirrors loadScanPageSummary().
async function loadPickupStatusSummary() {
  const bodyEl = document.getElementById('pickup-status-summary');
  const footEl = document.getElementById('pickup-status-summary-foot');
  if (!bodyEl) return;
  try {
    const range = window._pickupStatusRange || 'today';
    let dateStr;
    let emptyMsg;
    if (range === 'custom') {
      dateStr = document.getElementById('pickup-status-date')?.value;
      emptyMsg = 'No pickups on this date.';
    } else {
      const d = new Date();
      if (range === 'yesterday') d.setDate(d.getDate() - 1);
      dateStr = normalizeDateString(d);
      emptyMsg = range === 'yesterday' ? 'No pickups yesterday.' : 'No pickups today.';
    }
    if (!dateStr) { dateStr = normalizeDateString(new Date()); }
    const params = new URLSearchParams({ date_from: dateStr, date_to: dateStr });

    const data = await authorizedJsonRequest(`/orders/pos-orders/pickup-summary?${params}`);
    const total = Number(data?.total || 0);
    const byPage = Array.isArray(data?.by_page) ? data.by_page : [];
    const totalPcs = Number(data?.total_pcs || 0);

    bodyEl.innerHTML = byPage.length
      ? byPage.map((p) => `<tr>
          <td>${escapeHtml(p.page || 'Unknown')}</td>
          <td style="text-align:right;">${Number(p.pickups || 0).toLocaleString()}</td>
          <td style="text-align:right;">${Number(p.pcs || 0).toLocaleString()}</td>
        </tr>`).join('')
      : `<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--text-muted)">${emptyMsg}</td></tr>`;
    if (footEl) {
      footEl.innerHTML = byPage.length
        ? `<tr style="font-weight:700;border-top:2px solid var(--border,#e5e7eb);">
            <td>TOTAL</td>
            <td style="text-align:right;">${total.toLocaleString()}</td>
            <td style="text-align:right;">${totalPcs.toLocaleString()}</td>
          </tr>`
        : '';
    }
  } catch {
    bodyEl.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--text-muted)">Failed to load.</td></tr>';
    if (footEl) footEl.innerHTML = '';
  }
}

function setPickupStatusRange(range) {
  window._pickupStatusRange = range;
  const dateEl = document.getElementById('pickup-status-date');
  if (dateEl) dateEl.value = '';
  document.querySelectorAll('button[data-pickup-range]').forEach((b) => {
    const on = b.dataset.pickupRange === range;
    b.classList.toggle('btn-primary', on);
    b.classList.toggle('btn-secondary', !on);
  });
  loadPickupStatusSummary().catch(() => {});
}

// Picking a custom date overrides the Today/Yesterday toggle; clearing it
// falls back to Today.
function setPickupStatusDate() {
  const val = document.getElementById('pickup-status-date')?.value;
  if (!val) { setPickupStatusRange('today'); return; }
  window._pickupStatusRange = 'custom';
  document.querySelectorAll('button[data-pickup-range]').forEach((b) => {
    b.classList.remove('btn-primary');
    b.classList.add('btn-secondary');
  });
  loadPickupStatusSummary().catch(() => {});
}

// ─── RENDER: SCANNING ──────────────────────────────────────
function renderScanning() {
  return renderScanPage('scanning', 'Scanning', 'Standard');
}

function renderRTSScanning() {
  return `
  <div class="page-header">
    <div class="page-title"><h1>RTS Scanning</h1><p>Scan tracking numbers, review scan records, and file damage reports.</p></div>
  </div>

  <div class="tabs" style="margin-bottom:16px;">
    <button class="tab-btn active" onclick="switchTab(this,'rts-tab-scanner')">Scanner</button>
    <button class="tab-btn" onclick="switchTab(this,'rts-tab-records'); loadScanRecords(1)">Scan Records</button>
    <button class="tab-btn" onclick="switchTab(this,'rts-tab-damage')">Damage Report</button>
  </div>

  <div id="rts-tab-scanner" class="tab-content active">
    ${renderScannerBody('rts-scanning', 'RTS')}
  </div>

  <div id="rts-tab-records" class="tab-content">
    ${renderScanRecordsPanel()}
  </div>

  <div id="rts-tab-damage" class="tab-content">
    ${renderDamageReportTab()}
  </div>

  ${renderDamageReportModal()}`;
}

function renderScanPage(pageId, pageTitle, scanType) {
  return `
  <div class="page-header">
    <div class="page-title"><h1>${pageTitle}</h1><p>Scan tracking numbers to retrieve order information.</p></div>
  </div>

  ${renderScanStatBar(pageId, scanType)}
  ${renderScannerBody(pageId, scanType)}`;
}

function renderScannerBody(pageId, scanType) {
  const perPageCard = `
    <div class="card">
      <div class="card-header" style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;">
        <div><div class="card-title">Scan Page</div><div class="card-subtitle">Scans grouped by page · pcs from leading number in product</div></div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <div style="display:inline-flex;gap:6px;">
            <button class="btn btn-primary btn-sm" data-scan-range="${pageId}" data-range="today" onclick="setScanPageRange('${pageId}','${scanType}','today')">Today</button>
            <button class="btn btn-secondary btn-sm" data-scan-range="${pageId}" data-range="yesterday" onclick="setScanPageRange('${pageId}','${scanType}','yesterday')">Yesterday</button>
          </div>
          <input type="date" class="form-control" id="scan-page-date-${pageId}" style="width:170px;" onchange="setScanPageDate('${pageId}','${scanType}')">
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr><th>Page</th><th style="text-align:right;">Total Scan</th><th style="text-align:right;">Pcs</th></tr></thead>
          <tbody id="scan-page-summary-${pageId}">
            <tr><td colspan="3" style="text-align:center;padding:20px;color:var(--text-muted)">Loading...</td></tr>
          </tbody>
          <tfoot id="scan-page-summary-foot-${pageId}"></tfoot>
        </table>
      </div>
    </div>`;

  if (scanType === 'RTS') {
    return `
  <div style="display:flex;flex-direction:column;gap:16px;">
    ${renderScanComboCard(pageId, scanType)}
    ${perPageCard}
  </div>`;
  }

  return `
  <div style="display:grid; grid-template-columns: minmax(0, 700px) minmax(260px, 1fr); gap:16px; align-items:start;">
    <div>
      ${renderScannerCard(pageId, scanType)}
      ${renderScanPreviewCard(pageId, scanType)}
    </div>
    ${perPageCard}
  </div>`;
}

function renderScanStatBar(pageId, scanType) {
  return `
  <div class="card" style="margin-bottom:16px;">
    <div class="card-body" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
      <button class="btn btn-secondary" onclick="exportScans('${scanType}')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px;"><path d="M8 2v8M5 7l3 3 3-3M3 13.5h10"/></svg>
        Export CSV
      </button>
      <div style="text-align:right;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);">Total Scans Today</div>
        <div style="font-size:28px;font-weight:700;line-height:1.1;" id="scan-today-${pageId}">—</div>
      </div>
    </div>
  </div>`;
}

function renderScannerCard(pageId, scanType) {
  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header"><div class="card-title">Scan Tracking Number</div></div>
      <div class="card-body">
        <div class="scan-input-wrapper">
          <input type="text" class="scan-input" id="scan-input-${pageId}" placeholder="Scan or type tracking number..." autocomplete="off">
          <button class="btn btn-primary" onclick="performScan('${pageId}','${scanType}')">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2h2v4H3zM7 2h2v4H7zM11 2h2v4h-2zM3 10h2v4H3zM11 10h2v4h-2z"/></svg>
            Scan
          </button>
        </div>
        <p class="form-hint">Press Enter or click Scan to look up tracking details</p>
        <div id="scan-result-${pageId}"></div>
      </div>
    </div>`;
}

// Merged scanner + stats card (reference design): title and Export CSV in the
// header, the inline-button tracking input on the left, Total Scan Today on
// the right.
function renderScanComboCard(pageId, scanType) {
  return `
    <div class="card">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:16px;">
        <div class="card-title">Scan Tracking Number</div>
        <button class="btn btn-secondary btn-sm" onclick="exportScans('${scanType}')">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px;"><path d="M8 2v8M5 7l3 3 3-3M3 13.5h10"/></svg>
          Export CSV
        </button>
      </div>
      <div class="card-body">
        <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;">
          <div style="flex:1;min-width:280px;">
            <div class="scan-input-wrapper">
              <input type="text" class="scan-input" id="scan-input-${pageId}" placeholder="Scan or type tracking number..." autocomplete="off">
              <button class="btn btn-primary" onclick="performScan('${pageId}','${scanType}')">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2h2v4H3zM7 2h2v4H7zM11 2h2v4h-2zM3 10h2v4H3zM11 10h2v4h-2z"/></svg>
                Scan
              </button>
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:8px;">
              <label for="scan-date-${pageId}" style="font-size:12px;font-weight:600;color:var(--text-muted);white-space:nowrap;">Scan date</label>
              <input type="date" class="form-control" id="scan-date-${pageId}" value="${new Date().toISOString().split('T')[0]}" style="width:170px;">
            </div>
            <p class="form-hint" style="margin-bottom:0;margin-top:8px;">Press Enter or click Scan to look up tracking details. Scans count toward the selected date.</p>
          </div>
          <div style="text-align:right;padding-left:24px;border-left:1px solid var(--border);align-self:stretch;display:flex;flex-direction:column;justify-content:center;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);white-space:nowrap;">Total Scan Today</div>
            <div style="font-size:32px;font-weight:700;line-height:1.1;" id="scan-today-${pageId}">—</div>
          </div>
        </div>
        <div id="scan-result-${pageId}"></div>
      </div>
    </div>`;
}

function renderScanPreviewCard(pageId, scanType) {
  return `
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">${scanType === 'RTS' ? 'RTS' : 'Scan'} Records</div><div class="card-subtitle" id="scan-preview-subtitle-${pageId}">Loading...</div></div>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr><th>Tracking No.</th><th>Customer</th><th>Phone Number</th><th>Product</th><th style="text-align:right;">Pcs</th><th>Province/City</th><th>Date</th><th>Status</th><th>Courier</th></tr></thead>
          <tbody id="scan-preview-tbody-${pageId}">
            <tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-muted)">Loading recent scans...</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderScanRecordsPanel() {
  return `
    <div class="table-container">
      <div class="records-filter-panel">
        <div class="records-filter-row records-filter-primary">
          <div class="records-filter-field records-search-field">
            <label class="records-filter-label">Search</label>
            <div class="table-search">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
              <input type="text" id="scan-records-search" placeholder="Tracking, customer, phone, product, province..." oninput="clearTimeout(window._scanSearchTimer); window._scanSearchTimer = setTimeout(() => loadScanRecords(1), 400)">
            </div>
          </div>
          <div class="records-filter-field">
            <label class="records-filter-label">Type</label>
            <select class="form-control" id="scan-records-type" onchange="loadScanRecords(1)">
              <option value="">All</option>
              <option value="Standard">Standard</option>
              <option value="RTS">RTS</option>
            </select>
          </div>
          <div class="records-filter-field">
            <label class="records-filter-label">Status</label>
            <select class="form-control" id="scan-records-status" onchange="loadScanRecords(1)">
              <option value="">All</option>
              <option value="New">New</option>
              <option value="Confirmed">Confirmed</option>
              <option value="Waiting for pickup">Waiting for pickup</option>
              <option value="Shipped">Shipped</option>
              <option value="Delivered">Delivered</option>
              <option value="Returning">Returning</option>
              <option value="Returned">Returned</option>
              <option value="Canceled">Canceled</option>
            </select>
          </div>
          <div class="records-filter-field">
            <label class="records-filter-label">From</label>
            <input type="date" class="form-control" id="scan-records-date-from" onchange="loadScanRecords(1)">
          </div>
          <div class="records-filter-field">
            <label class="records-filter-label">To</label>
            <input type="date" class="form-control" id="scan-records-date-to" onchange="loadScanRecords(1)">
          </div>
          <div class="records-filter-field" style="align-self:flex-end;">
            <button class="btn btn-secondary btn-sm" onclick="clearScanRecordsFilters()">Clear</button>
          </div>
        </div>
      </div>
      <div id="scan-records-list"><div class="loading-spinner" style="margin:24px auto;"></div></div>
      <div id="scan-records-pagination" style="display:flex; justify-content:center; gap:8px; margin-top:16px;"></div>
    </div>`;
}

async function loadScanToday(pageId, scanType) {
  const counterEl = document.getElementById(`scan-today-${pageId}`);
  if (!counterEl) return;
  try {
    const today = normalizeDateString(new Date());
    const params = new URLSearchParams({ per_page: '10', page: '1', date_from: today, date_to: today });
    if (scanType) params.set('type', scanType);
    const data = await authorizedJsonRequest(`/scans?${params}`);
    counterEl.textContent = Number(data?.total || 0).toLocaleString();
  } catch {
    counterEl.textContent = '0';
  }
}

// Per-page scan summary table. Honours the Today/Yesterday toggle and the
// custom date picker in the Scan Page card (defaults to today when those
// controls aren't present, e.g. standard scan pages).
async function loadScanPageSummary(pageId, scanType) {
  const bodyEl = document.getElementById(`scan-page-summary-${pageId}`);
  const footEl = document.getElementById(`scan-page-summary-foot-${pageId}`);
  if (!bodyEl) return;
  try {
    const range = (window._scanPageRange && window._scanPageRange[pageId]) || 'today';
    let dateStr;
    let emptyMsg;
    if (range === 'custom') {
      dateStr = document.getElementById(`scan-page-date-${pageId}`)?.value;
      emptyMsg = 'No scans on this date.';
    } else {
      const d = new Date();
      if (range === 'yesterday') d.setDate(d.getDate() - 1);
      dateStr = normalizeDateString(d);
      emptyMsg = range === 'yesterday' ? 'No scans yesterday.' : 'No scans today.';
    }
    if (!dateStr) { dateStr = normalizeDateString(new Date()); }
    const params = new URLSearchParams({ per_page: '10', page: '1', date_from: dateStr, date_to: dateStr });
    if (scanType) params.set('type', scanType);

    const data = await authorizedJsonRequest(`/scans?${params}`);
    const total = Number(data?.total || 0);
    const byPage = Array.isArray(data?.summary?.by_page) ? data.summary.by_page : [];
    const totalPcs = Number(data?.summary?.total_pcs || 0);

    bodyEl.innerHTML = byPage.length
      ? byPage.map((p) => `<tr>
          <td>${escapeHtml(p.page || 'Unknown')}</td>
          <td style="text-align:right;">${Number(p.scans || 0).toLocaleString()}</td>
          <td style="text-align:right;">${Number(p.pcs || 0).toLocaleString()}</td>
        </tr>`).join('')
      : `<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--text-muted)">${emptyMsg}</td></tr>`;
    if (footEl) {
      footEl.innerHTML = byPage.length
        ? `<tr style="font-weight:700;border-top:2px solid var(--border,#e5e7eb);">
            <td>TOTAL</td>
            <td style="text-align:right;">${total.toLocaleString()}</td>
            <td style="text-align:right;">${totalPcs.toLocaleString()}</td>
          </tr>`
        : '';
    }
  } catch {
    bodyEl.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--text-muted)">Failed to load.</td></tr>';
    if (footEl) footEl.innerHTML = '';
  }
}

function setScanPageRange(pageId, scanType, range) {
  window._scanPageRange = window._scanPageRange || {};
  window._scanPageRange[pageId] = range;
  const dateEl = document.getElementById(`scan-page-date-${pageId}`);
  if (dateEl) dateEl.value = '';
  document.querySelectorAll(`button[data-scan-range="${pageId}"]`).forEach((b) => {
    const on = b.dataset.range === range;
    b.classList.toggle('btn-primary', on);
    b.classList.toggle('btn-secondary', !on);
  });
  loadScanPageSummary(pageId, scanType).catch(() => {});
}

// Picking a custom date overrides the Today/Yesterday toggle; clearing it
// falls back to Today.
function setScanPageDate(pageId, scanType) {
  const val = document.getElementById(`scan-page-date-${pageId}`)?.value;
  if (!val) { setScanPageRange(pageId, scanType, 'today'); return; }
  window._scanPageRange = window._scanPageRange || {};
  window._scanPageRange[pageId] = 'custom';
  document.querySelectorAll(`button[data-scan-range="${pageId}"]`).forEach((b) => {
    b.classList.remove('btn-primary');
    b.classList.add('btn-secondary');
  });
  loadScanPageSummary(pageId, scanType).catch(() => {});
}

async function exportScans(scanType) {
  try {
    const all = [];
    let page = 1;
    let pages = 1;
    do {
      const params = new URLSearchParams({ page: String(page), per_page: '200' });
      if (scanType) params.set('type', scanType);
      const data = await authorizedJsonRequest(`/scans?${params}`);
      (Array.isArray(data?.data) ? data.data : []).forEach((r) => all.push(r));
      pages = Number(data?.pages || 1);
      page += 1;
    } while (page <= pages && page <= 100);

    if (!all.length) { showToast('warning', 'No data', 'No scan records to export.'); return; }

    const cols = [
      ['tracking_no', 'Tracking No'], ['customer', 'Customer'], ['phone', 'Phone'],
      ['product_name', 'Product'], ['chat_page', 'Page'], ['province_city', 'Province/City'],
      ['scan_date', 'Date'], ['status', 'Status'], ['courier', 'Courier'], ['scan_type', 'Type'],
    ];
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = cols.map((c) => c[1]).join(',');
    const rows = all.map((r) => cols.map((c) => esc(c[0] === 'scan_date' ? String(r[c[0]] || '').slice(0, 10) : r[c[0]])).join(','));
    const csv = [header, ...rows].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scans-${(scanType || 'all').toLowerCase()}-${normalizeDateString(new Date())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('success', 'Exported', `${all.length.toLocaleString()} scan record(s) exported.`);
  } catch (err) {
    showToast('error', 'Export failed', err.message || 'Could not export scans.');
  }
}

async function loadScanPreviewForPage(pageId, scanType) {
  const tbody = document.getElementById(`scan-preview-tbody-${pageId}`);
  const subtitle = document.getElementById(`scan-preview-subtitle-${pageId}`);
  if (!tbody) return;
  try {
    const params = new URLSearchParams({ per_page: '10', page: '1' });
    if (scanType) params.set('type', scanType);
    const data = await authorizedJsonRequest(`/scans?${params}`);
    const records = Array.isArray(data?.data) ? data.data : [];
    if (subtitle) subtitle.textContent = `${Number(data?.total || 0).toLocaleString()} record${data?.total === 1 ? '' : 's'}`;
    if (!records.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-muted)">No scans yet.</td></tr>';
      return;
    }
    tbody.innerHTML = records.map((r) => `<tr>
      <td class="font-mono text-xs">${escapeHtml(r.tracking_no || '')}</td>
      <td style="font-weight:500">${escapeHtml(r.customer || '-')}</td>
      <td class="font-mono text-sm">${escapeHtml(r.phone || '-')}</td>
      <td>${escapeHtml(r.product_name || '-')}</td>
      <td style="text-align:right;font-weight:600;">${scanPcs(r.product_name)}</td>
      <td>${escapeHtml(r.province_city || '-')}</td>
      <td>${escapeHtml((r.scan_date || '').slice(0, 10))}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="text-secondary">${escapeHtml(r.courier || '-')}</td>
    </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-muted)">Failed to load scans: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// Pieces for a scan row = the leading number on the product name ("2 Niacinamide"
// → 2); products with no leading number count as 1. Never returns NaN.
function scanPcs(productName) {
  const match = String(productName || '').match(/^\s*(\d+)/);
  if (!match) return 1;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? Math.min(10000, n) : 1;
}

function statusBadge(status) {
  const map = {
    'New': 'badge-blue',
    'Confirmed': 'badge-gray',
    'Waiting for pickup': 'badge-warning',
    'Delivered': 'badge-success',
    'DELIVERED': 'badge-success',
    'For Delivery': 'badge-info',
    'Out for Delivery': 'badge-info',
    'DELIVERING': 'badge-info',
    'Return to Sender': 'badge-danger',
    'Failed Attempt': 'badge-warning',
    'In Transit': 'badge-gray',
    'INTRANSIT': 'badge-gray',
    'Shipped': 'badge-info',
    'Returned': 'badge-danger',
    'RETURNED': 'badge-danger',
    'Returning': 'badge-warning',
    'Pending': 'badge-gray',
    'PENDING': 'badge-gray',
    'Canceled': 'badge-danger',
    'FOR RETURN': 'badge-warning',
    'FOR MONITORING': 'badge-warning',
    'DASHBOARD CANCELLED': 'badge-danger',
    'CANCELLED': 'badge-danger',
  };
  return `<span class="badge ${map[status]||'badge-gray'}">${status}</span>`;
}

// ─── RENDER: VIEW RECORDS ──────────────────────────────────
function getPosOrderFilterOptions() {
  const rawOrders = Array.isArray(DB.posRawOrders) ? DB.posRawOrders : [];
  const dashboardOrders = Array.isArray(DB.posOrders) ? DB.posOrders : [];
  const backendOptions = DB.posRawFilterOptions || {};
  const posProductOptions = [...new Set([
    ...(Array.isArray(backendOptions.products) ? backendOptions.products : []),
    ...rawOrders.map((o) => o.note_product),
    ...dashboardOrders.map((o) => o.product),
  ].filter(Boolean))].sort();
  const posPageOptions = [...new Set([
    ...(Array.isArray(backendOptions.pages) ? backendOptions.pages : []),
    ...rawOrders.map((o) => o.page_name),
    ...dashboardOrders.map((o) => o.sourceSheet),
  ].filter(Boolean))].sort();
  const posTagOptions = [...new Set([
    ...(Array.isArray(backendOptions.tags) ? backendOptions.tags : []),
    ...rawOrders.flatMap((o) => Array.isArray(o.tags) ? o.tags : []),
    ...dashboardOrders.flatMap((o) => Array.isArray(o.tags) ? o.tags : []),
  ].map((tag) => typeof tag === 'string' ? tag : (tag?.name || tag?.tag_name || tag?.label || '')).filter(Boolean))].sort();
  const posReasonOptions = [...new Set([
    ...(Array.isArray(backendOptions.reasons) ? backendOptions.reasons : []),
    ...rawOrders.map((o) => getRmoUndeliverableReason(o)),
  ].filter(Boolean))].sort();
  return { posProductOptions, posPageOptions, posTagOptions, posReasonOptions };
}

function updatePosFilterSelect(id, allLabel, options, selectedValue) {
  const select = document.getElementById(id);
  if (!select) return;
  const values = [...options];
  if (selectedValue && selectedValue !== 'all' && !values.includes(selectedValue)) values.unshift(selectedValue);
  select.innerHTML = `<option value="all">${allLabel}</option>${values.map((value) =>
    `<option value="${escapeHtml(value)}" ${selectedValue === value ? 'selected' : ''}>${escapeHtml(value)}</option>`
  ).join('')}`;
}

function updateRmoFilterOptions() {
  if (App.currentPage !== 'rmo-management') return;
  const { posProductOptions, posPageOptions, posTagOptions, posReasonOptions } = getPosOrderFilterOptions();
  updatePosFilterSelect('pos-orders-product', 'All Products', posProductOptions, posOrdersProductFilter);
  updatePosFilterSelect('pos-orders-page', 'All Pages', posPageOptions, posOrdersPageFilter);
  updatePosFilterSelect('pos-orders-tags', 'All Tags', posTagOptions, posOrdersTagFilter);
  // Reason select only exists on the Undeliverable / Returning tabs.
  updatePosFilterSelect('pos-orders-reason', 'All Reasons', posReasonOptions, posOrdersReasonFilter);
}

// Server-side totals over the whole filtered set (computed from partner_status /
// courier_note in /pos-orders), not just the current page.
function getRmoProblematicCount() {
  return Number(DB.posRawPartnerCounts?.problematic || 0);
}

function getRmoUndeliverableCount() {
  return Number(DB.posRawPartnerCounts?.undeliverable || 0);
}

// Courier delivery-failure text embeds the reason as `reason [<text>]` inside a
// larger status string, e.g.
//   "...register by [F-DVO Libungan DH] , reason [No Reason to Reject without Opening the Box]"
// Pull the text after `reason [` (supports [] and full-width 【】 brackets).
// Recurse newest-entry-first since extend_update is ordered oldest→newest.
const COURIER_REASON_RE = /reason\s*[\[【]\s*([^\]】]+?)\s*[\]】]/gi;
function collectCourierReasons(node, out) {
  if (node == null) return;
  if (typeof node === 'string') {
    for (const match of node.matchAll(COURIER_REASON_RE)) out.push(match[1].trim());
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectCourierReasons(child, out);
    return;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) collectCourierReasons(node[key], out);
  }
}
// Return only the latest reason: extend_update history is chronological, so the
// last `reason [..]` we encounter is the most recent.
function deepFindCourierReason(node) {
  const out = [];
  collectCourierReasons(node, out);
  return out.length ? out[out.length - 1] : '';
}

// Undeliverable reason, read straight from the order's partner_json
// (returned as order.partner) so it works for already-stored orders without
// waiting for a re-sync. Falls back to the stored partner_reason column.
// Mirrors getPosUndeliverableReason on the backend.
function getRmoUndeliverableReason(order) {
  const partner = order?.partner;
  if (partner && typeof partner === 'object') {
    const reason = deepFindCourierReason(partner.extend_update) || deepFindCourierReason(partner);
    if (reason) return reason;
  }
  return order?.partner_reason || '';
}

// Courier / shipping partner name from partner_json. Mirrors the courier
// extraction in pancakePosSync (partner.name → partner_name → shipping_partner_name).
function getRmoCourier(order) {
  const p = (order && typeof order.partner === 'object' && order.partner) || {};
  return p.name || p.partner_name || p.shipping_partner_name || '';
}

// Bigate J&T puts the real call-attempt detail in a `note` field rather than
// the `reason [..]` text other couriers use.
function isBigateJT(order) {
  return /bigate/i.test(getRmoCourier(order) || '');
}

// Rider (sprinter) name + phone. Most couriers embed it in partner.extend_update
// as `】sprinter【name:tel】` (already parsed into sprinter_name/sprinter_tel).
// Bigate instead stores it in partner_json as delivery_name / delivery_tel, so
// fall back to those when the sprinter fields are empty.
function getRmoRider(order) {
  let name = order?.sprinter_name || '';
  let tel = order?.sprinter_tel || '';
  if (!name || !tel) {
    const p = (order && typeof order.partner === 'object' && order.partner) || {};
    name = name || p.delivery_name || '';
    tel = tel || p.delivery_tel || '';
  }
  return { name, tel };
}

// Latest courier `note` from partner_json.extend_update (chronological, newest
// last), falling back to a partner-level note. Used to surface Bigate J&T's
// call-attempt detail under the reason.
function getRmoCourierNote(order) {
  const partner = order?.partner;
  if (!partner || typeof partner !== 'object') return '';
  const updates = partner.extend_update;
  if (Array.isArray(updates)) {
    for (let i = updates.length - 1; i >= 0; i--) {
      const entry = updates[i];
      const note = entry && typeof entry === 'object' && typeof entry.note === 'string' ? entry.note.trim() : '';
      if (note) return note;
    }
  }
  return typeof partner.note === 'string' ? partner.note.trim() : '';
}

// Reason shown in the RMO "Reason" column: the courier `reason [..]` text when
// present, otherwise Bigate J&T's call-attempt `note` (e.g. "The call is Turned
// Off."), which it uses in place of a reason.
function getRmoReasonDisplay(order) {
  return getRmoUndeliverableReason(order) || (isBigateJT(order) ? getRmoCourierNote(order) : '');
}

// Copy a clickable RMO field (customer name, phone, tracking) to the clipboard.
function copyRmoField(el) {
  const text = el?.dataset?.copy || '';
  if (!text) return;
  const label = el?.dataset?.copyLabel || 'Value';
  const done = () => showToast('success', 'Copied', `${label} copied to clipboard.`);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {});
  }
}

function renderRmoManagement() {
  const { posProductOptions, posPageOptions, posTagOptions, posReasonOptions } = getPosOrderFilterOptions();
  const statusCounts = Object.fromEntries((DB.posRawStatusCounts || []).map((row) => [row.display_status, Number(row.count || 0)]));
  const delivered = statusCounts.Delivered || 0;
  const returning = statusCounts.Returning || 0;
  const problematic = getRmoProblematicCount();
  const undeliverable = getRmoUndeliverableCount();
  const posStatusDisplayOptions = ['New', 'Confirmed', 'Waiting for pickup', 'Shipped', 'Delivered', 'Returning', 'Returned', 'Canceled'];
  const dateLabel = new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });

  return `
  <div class="rmo-management-page">
    <div class="rmo-header">
      <div>
        <h1>RMO Management</h1>
        <p>Delivery tracking for POS orders on ${escapeHtml(dateLabel)}</p>
      </div>
      <div class="rmo-actions">
        <button class="rmo-icon-btn" title="Refresh POS orders" onclick="refreshPosOrdersNow()">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 5a5 5 0 1 0 1 3.8"/><path d="M13 2v3h-3"/></svg>
        </button>
        <button class="rmo-action-btn" onclick="exportRmoCSV()">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8"/><path d="M5 7l3 3 3-3"/><path d="M3 13h10"/></svg>
          Export
        </button>
        <button class="rmo-action-btn" id="pos-sync-now-btn" onclick="syncPosOrdersNow(this)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 5a5 5 0 1 0 1 3.8"/><path d="M13 2v3h-3"/></svg>
          Sync Now
        </button>
      </div>
    </div>

    <div class="rmo-tabs" style="display:flex;gap:8px;margin-bottom:14px;">
      <button class="filter-pill ${rmoTab === 'orders' ? 'active' : ''}" onclick="setRmoTab('orders')">For Delivery</button>
      <button class="filter-pill ${rmoTab === 'delivering' ? 'active' : ''}" onclick="setRmoTab('delivering')">On Delivery</button>
      <button class="filter-pill ${rmoTab === 'undeliverable' ? 'active' : ''}" onclick="setRmoTab('undeliverable')">Undeliverable</button>
      <button class="filter-pill ${rmoTab === 'returning' ? 'active' : ''}" onclick="setRmoTab('returning')">Returning</button>
    </div>

    <div class="rmo-metrics">
      <div class="rmo-metric"><span>Total For Delivery Today</span><strong id="rmo-metric-total">${Number(DB.posRawTotal || 0).toLocaleString()}</strong></div>
      <div class="rmo-metric"><span>Delivered</span><strong id="rmo-metric-delivered">${delivered.toLocaleString()}</strong></div>
      <div class="rmo-metric"><span>Returning</span><strong id="rmo-metric-returning">${returning.toLocaleString()}</strong></div>
      <div class="rmo-metric"><span>Undeliverable</span><strong id="rmo-metric-undeliverable">${undeliverable.toLocaleString()}</strong></div>
      <div class="rmo-metric"><span>Problematic</span><strong id="rmo-metric-problematic">${problematic.toLocaleString()}</strong></div>
    </div>

    <div class="rmo-filter-bar">
      <div class="rmo-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
        <input type="text" placeholder="Search order #, tracking, or phone — separate multiple with spaces" id="pos-orders-search" value="${escapeHtml(posOrdersSearch)}" oninput="applyPosOrdersSearch()">
      </div>
      <select class="rmo-select" id="pos-orders-status" onchange="applyPosOrdersDropdown()">
        <option value="all">All Statuses</option>
        ${posStatusDisplayOptions.map((s) => `<option value="${escapeHtml(s)}" ${posOrdersStatusFilter === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
      </select>
      <select class="rmo-select" id="pos-orders-tags" onchange="applyPosOrdersDropdown()">
        <option value="all">All Tags</option>
        ${posTagOptions.map((t) => `<option value="${escapeHtml(t)}" ${posOrdersTagFilter === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
      </select>
      <select class="rmo-select" id="pos-orders-product" onchange="applyPosOrdersDropdown()">
        <option value="all">All Products</option>
        ${posProductOptions.map((p) => `<option value="${escapeHtml(p)}" ${posOrdersProductFilter === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
      </select>
      <select class="rmo-select" id="pos-orders-page" onchange="applyPosOrdersDropdown()">
        <option value="all">All Pages</option>
        ${posPageOptions.map((p) => `<option value="${escapeHtml(p)}" ${posOrdersPageFilter === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
      </select>
      ${(rmoTab === 'undeliverable' || rmoTab === 'returning') ? `<select class="rmo-select" id="pos-orders-reason" onchange="applyPosOrdersDropdown()">
        <option value="all">All Reasons</option>
        ${posReasonOptions.map((reason) => `<option value="${escapeHtml(reason)}" ${posOrdersReasonFilter === reason ? 'selected' : ''}>${escapeHtml(reason)}</option>`).join('')}
      </select>` : ''}
    </div>

    <div class="rmo-period-bar">
      ${rmoTab !== 'orders' ? `
      <div class="table-filters" title="Filtered by last status update">
        ${[['all','All'],['today','Today'],['yesterday','Yesterday']].map(([v, l]) =>
          `<button class="filter-pill ${rmoUpdatePeriod === v ? 'active' : ''}" onclick="setRmoUpdatePeriod('${v}',this)">${l}</button>`
        ).join('')}
        <span style="font-size:12px;color:var(--text-muted);align-self:center;margin-left:6px;">by last status update</span>
      </div>` : `
      <div class="table-filters">
        ${[['all','All'],['today','Today'],['yesterday','Yesterday'],['month','Month'],['year','Year'],['custom','Custom']].map(([v, l]) =>
          `<button class="filter-pill ${posOrdersPeriod === v ? 'active' : ''}" onclick="setPosOrdersPeriod('${v}',this)">${l}</button>`
        ).join('')}
      </div>
      <div class="custom-range records-custom-range ${posOrdersPeriod === 'custom' ? '' : 'hidden'}" id="pos-orders-custom-range">
        <input type="date" class="form-control" id="pos-orders-date-from" value="${posOrdersDateFrom}">
        <input type="date" class="form-control" id="pos-orders-date-to" value="${posOrdersDateTo}">
        <button class="btn btn-secondary btn-sm" onclick="applyPosOrdersCustomRange()">Apply</button>
      </div>`}
      <div class="rmo-attempts-filter">
        <label for="pos-orders-attempts">Attempts</label>
        <select class="rmo-select" id="pos-orders-attempts" onchange="applyPosOrdersDropdown()">
          ${[['all','All Attempts'],['1','1st attempt'],['2','2nd attempt'],['3','3rd attempt'],['4plus','4+ attempts']].map(([v, l]) =>
            `<option value="${v}" ${posOrdersAttemptFilter === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
    </div>

    <div id="pos-orders-status-summary" class="rmo-status-summary"></div>
    <div id="rmo-bulk-bar" class="rmo-bulk-bar" style="display:none;">
      <span id="rmo-bulk-count">0 selected</span>
      <button class="btn btn-primary btn-sm" onclick="openBotcakeSendModal('selected')">✉ Send message</button>
      <button class="btn btn-secondary btn-sm" onclick="clearRmoSelection()">Clear</button>
    </div>
    <div class="rmo-table-wrap">
      <table class="rmo-table" id="rmo-pos-orders-table">
        <thead><tr><th style="width:34px;text-align:center;"><input type="checkbox" id="rmo-select-all" onclick="toggleRmoSelectAll(this)" title="Select all messageable on this page"></th><th>Items</th><th>Rider</th><th>Customer</th><th>Page</th><th>SRP</th><th>Attempts</th><th>${(rmoTab === 'undeliverable' || rmoTab === 'returning') ? 'Reason' : 'Confirmed By'}</th><th>Tags</th><th>Status</th>${rmoTab !== 'orders' ? `<th>${rmoTab === 'delivering' ? 'Last Update' : ((rmoTab === 'undeliverable' || rmoTab === 'returning') ? 'Confirmed By' : 'Reason')}</th>` : ''}<th>Courier</th><th>Message</th></tr></thead>
        <tbody id="rec-pos-orders-tbody">
          <tr><td colspan="${rmoTab !== 'orders' ? 13 : 11}" style="text-align:center;padding:32px;color:var(--text-muted)">Loading POS orders...</td></tr>
        </tbody>
      </table>
      <div class="table-pagination rmo-pagination" id="pos-orders-pagination"><span>Loading POS orders...</span></div>
    </div>

    <div class="modal-overlay" id="botcake-send-modal">
      <div class="modal" style="max-width:460px;">
        <div class="modal-header">
          <div class="modal-title">Send Messenger Broadcast</div>
          <button class="modal-close" onclick="closeModal('botcake-send-modal')">×</button>
        </div>
        <div class="modal-body">
          <div id="botcake-send-recipients" class="field-help" style="margin-bottom:10px;"></div>
          <div class="form-group">
            <label class="form-label">Broadcast (from the "UPDATE" folder)</label>
            <select class="form-control" id="botcake-flow-select"><option value="">Loading…</option></select>
            <div class="field-help">Move the broadcasts you want here into Botcake's "UPDATE" folder.</div>
          </div>
          <div id="botcake-send-result" style="margin-top:6px;"></div>
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button type="button" class="btn btn-primary" id="botcake-send-confirm" style="flex:1;" onclick="confirmBotcakeSend()">Send</button>
            <button type="button" class="btn btn-secondary" onclick="closeModal('botcake-send-modal')">Cancel</button>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-overlay" id="pos-tags-modal">
      <div class="modal" style="max-width:460px;">
        <div class="modal-header">
          <div class="modal-title">Edit Order Tags</div>
          <button class="modal-close" onclick="closeModal('pos-tags-modal')">×</button>
        </div>
        <div class="modal-body">
          <div id="pos-tags-recap" class="field-help" style="margin-bottom:10px;"></div>
          <div id="pos-tags-list" class="pos-tags-list">Loading…</div>
          <div style="display:flex;gap:8px;margin-top:12px;">
            <button type="button" class="btn btn-primary" id="pos-tags-save" style="flex:1;" onclick="saveOrderTags()">Save tags</button>
            <button type="button" class="btn btn-secondary" onclick="closeModal('pos-tags-modal')">Cancel</button>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-overlay" id="customer-notes-modal">
      <div class="modal" style="max-width:520px;">
        <div class="modal-header">
          <div class="modal-title">Customer Notes</div>
          <button class="modal-close" onclick="closeModal('customer-notes-modal')">×</button>
        </div>
        <div class="modal-body">
          <div id="customer-notes-recap" class="field-help" style="margin-bottom:10px;"></div>
          <div id="customer-notes-thread" style="max-height:300px;overflow-y:auto;margin-bottom:12px;">Loading…</div>
          <div class="form-group" style="margin-bottom:8px;">
            <label class="form-label">Add a note</label>
            <textarea class="form-control" id="customer-note-input" rows="3" placeholder="Type a note for this customer…"></textarea>
          </div>
          <div id="customer-notes-error" style="color:var(--danger);font-size:12px;margin-bottom:6px;"></div>
          <div style="display:flex;gap:8px;">
            <button type="button" class="btn btn-primary" id="customer-note-add" style="flex:1;" onclick="addCustomerNote()">Add note</button>
            <button type="button" class="btn btn-secondary" onclick="closeModal('customer-notes-modal')">Close</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function renderViewRecords() {
  return `
  <div class="page-header">
    <div class="page-title"><h1>View Records</h1><p>Unified records from all modules.</p></div>
  </div>

  <div class="tabs" id="records-tabs">
    <button class="tab-btn active" onclick="switchTab(this,'rec-csr')">CSR Records (<span id="rec-csr-count">${DB.csrRecords.length}</span>)</button>
    <button class="tab-btn" onclick="switchTab(this,'rec-expenses')">Expenses (${DB.expenses.length})</button>
    <button class="tab-btn" onclick="switchTab(this,'rec-pickups')">Daily Pickups (${DB.dailyPickups.length})</button>
  </div>

  <div id="rec-csr" class="tab-content active">
    <div class="table-container">
      <table><thead><tr><th>Date</th><th>Name CSR</th><th>Page Name</th><th>Order ID</th><th>Customer</th><th>Cellphone</th><th>Type of Sales</th><th>Status</th><th>Price</th><th>Tracking Number</th></tr></thead>
        <tbody id="rec-csr-tbody">${renderRecCsrRows()}</tbody>
      </table>
    </div>
  </div>

  <div id="rec-expenses" class="tab-content">
    <div class="table-container">
      <table><thead><tr><th>ID</th><th>Date</th><th>Category</th><th>Item</th><th>Qty</th><th>Price</th><th>Total</th><th>Noted</th></tr></thead>
        <tbody>${DB.expenses.map(e => `<tr>
          <td class="font-mono text-xs text-muted">${e.id}</td><td>${e.date}</td>
          <td><span class="badge ${catBadge(e.category)}">${e.category}</span></td>
          <td>${e.item}</td><td>${e.qty}</td><td>₱${e.price.toLocaleString()}</td>
          <td><strong>₱${e.total.toLocaleString()}</strong></td><td>${e.noted}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </div>

  <div id="rec-pickups" class="tab-content">
    <div class="table-container">
      <table><thead><tr><th>ID</th><th>Date</th><th>Product</th><th>Type</th><th>Orders</th><th>Pieces</th><th>Notes</th></tr></thead>
        <tbody>${DB.dailyPickups.map(p => `<tr>
          <td class="font-mono text-xs text-muted">${p.id}</td><td>${p.date}</td>
          <td style="font-weight:500">${p.product}</td>
          <td><span class="badge ${p.type==='Product'?'badge-info':'badge-gray'}">${p.type}</span></td>
          <td>${p.customerOrders}</td><td>${p.totalPieces}</td>
          <td class="text-secondary text-sm">${p.notes||'—'}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </div>

  </div>`;
}

// ─── RENDER: DAMAGE SHEETS ─────────────────────────────────
function renderDamageReportTab() {
  return `
  <div style="display:flex; justify-content:flex-end; gap:8px; margin-bottom:16px;">
    <button class="btn btn-primary" onclick="openDamageReportModal()">+ Add Damage Report</button>
    <button class="btn btn-secondary" onclick="window.print()">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px;"><rect x="3" y="6" width="10" height="8" rx="1"/><path d="M3 6V4a1 1 0 011-1h8a1 1 0 011 1v2M6 10h4M6 12h2"/></svg>
      Print Sheet
    </button>
  </div>
  <div id="damage-saved-wrap">${renderDamageSheet()}</div>`;
}

function renderDamageReportModal() {
  return `
  <div class="modal-overlay" id="damage-report-modal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Damage Report Form</div>
        <button class="modal-close" onclick="closeModal('damage-report-modal')">×</button>
      </div>
      <div class="modal-body">
        <div class="form-grid two-col">
          <div class="form-group"><label class="form-label">Date</label><input type="date" class="form-control" id="damage-date" value="${normalizeDateString(new Date())}"></div>
          <div class="form-group"><label class="form-label">Page Name</label><input type="text" class="form-control" id="damage-page-name" placeholder="Page name"></div>
          <div class="form-group"><label class="form-label">Product</label><input type="text" class="form-control" id="damage-product" placeholder="Product name"></div>
          <div class="form-group"><label class="form-label">Tracking</label><input type="text" class="form-control" id="damage-tracking" placeholder="Tracking number"></div>
          <div class="form-group"><label class="form-label">COD Amount</label><input type="number" class="form-control" id="damage-cod" min="0" step="0.01" placeholder="0"></div>
          <div class="form-group">
            <label class="form-label">Damage Reason</label>
            <select class="form-control" id="damage-reason">
              <option value="">Select reason...</option>
              <option value="Missing">Missing</option>
              <option value="Switch Item">Switch Item</option>
              <option value="Damage Item">Damage Item</option>
              <option value="Repack Pouch">Repack Pouch</option>
            </select>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="clearDamageReportForm()">Clear Form</button>
        <button class="btn btn-primary" onclick="saveDamageReport()">Save Damage Report</button>
      </div>
    </div>
  </div>`;
}

function openDamageReportModal() {
  const dateInput = document.getElementById('damage-date');
  if (dateInput && !dateInput.value) dateInput.value = normalizeDateString(new Date());
  openModal('damage-report-modal');
}

function refreshDamageSaved() {
  const wrap = document.getElementById('damage-saved-wrap');
  if (wrap) wrap.innerHTML = renderDamageSheet();
}

function renderDamageSheet() {
  const damaged = DB.damageReports;
  const today = new Date().toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });
  return `
  <div class="damage-sheet" id="damage-sheet-print">
    <div style="display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:28px; padding-bottom:20px; border-bottom:2px solid var(--primary);">
      <div>
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
          <div style="width:44px; height:44px; background:var(--accent); border-radius:10px; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:18px; color:#fff;">Y</div>
          <div>
            <div style="font-size:20px; font-weight:700; letter-spacing:-0.4px;">YNT Digital Marketing</div>
            <div style="font-size:12px; color:var(--text-muted); letter-spacing:1px; text-transform:uppercase;">Damage / Return Report</div>
          </div>
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:13px; color:var(--text-secondary)">Date Generated:</div>
        <div style="font-weight:600;">${today}</div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">Sheet #DS-${Date.now().toString().slice(-6)}</div>
      </div>
    </div>

    <table style="width:100%; border-collapse:collapse; margin-bottom:24px;">
      <thead>
        <tr style="background:var(--surface-2);">
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">#</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">Date</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">Page Name</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">Product</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">Tracking</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">COD Amt</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">Damage Reason</th>
        </tr>
      </thead>
      <tbody>
        ${damaged.map((o, i) => `
          <tr style="${i%2===1?'background:var(--surface-2);':''}">
            <td style="padding:10px 12px; border:1px solid var(--border); font-size:13px; color:var(--text-muted);">${i+1}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-size:13px;">${o.date}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-weight:500; font-size:13px;">${escapeHtml(o.pageName || o.customer || '')}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-size:13px;">${escapeHtml(o.product || '')}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-family:'DM Mono',monospace; font-size:12px;">${escapeHtml(o.tracking || '')}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-weight:600; font-size:13px;">₱${Number(o.cod || 0).toLocaleString()}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-size:13px; color:var(--text-muted);">${escapeHtml(o.reason || o.notes || '')}</td>
          </tr>
        `).join('') || '<tr><td colspan="8" style="padding:24px; text-align:center; border:1px solid var(--border); color:var(--text-muted);">No damage reports saved yet.</td></tr>'}
      </tbody>
    </table>

    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:24px; margin-top:32px; padding-top:20px; border-top:1px solid var(--border);">
      <div>
        <div style="font-size:11px; color:var(--text-muted); margin-bottom:40px; text-transform:uppercase; letter-spacing:0.6px;">Prepared by</div>
        <div style="border-top:1px solid var(--primary); padding-top:6px; font-size:12px; color:var(--text-secondary);">Signature over printed name</div>
      </div>
      <div>
        <div style="font-size:11px; color:var(--text-muted); margin-bottom:40px; text-transform:uppercase; letter-spacing:0.6px;">Checked by</div>
        <div style="border-top:1px solid var(--primary); padding-top:6px; font-size:12px; color:var(--text-secondary);">Signature over printed name</div>
      </div>
      <div>
        <div style="font-size:11px; color:var(--text-muted); margin-bottom:40px; text-transform:uppercase; letter-spacing:0.6px;">Approved by</div>
        <div style="border-top:1px solid var(--primary); padding-top:6px; font-size:12px; color:var(--text-secondary);">Signature over printed name</div>
      </div>
    </div>
  </div>`;
}

// ─── CHARTS ────────────────────────────────────────────────
function clearDamageReportForm() {
  ['damage-page-name', 'damage-product', 'damage-tracking', 'damage-cod', 'damage-reason'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const dateInput = document.getElementById('damage-date');
  if (dateInput) dateInput.value = normalizeDateString(new Date());
}

function saveDamageReport() {
  const record = {
    id: `DMG-${Date.now()}`,
    pageName: document.getElementById('damage-page-name')?.value.trim() || '',
    tracking: document.getElementById('damage-tracking')?.value.trim() || '',
    product: document.getElementById('damage-product')?.value.trim() || '',
    date: document.getElementById('damage-date')?.value || normalizeDateString(new Date()),
    cod: Number(document.getElementById('damage-cod')?.value || 0),
    reason: document.getElementById('damage-reason')?.value || '',
  };

  if (!record.date || !record.pageName || !record.product || !record.tracking || !record.reason) {
    showToast('warning', 'Missing details', 'Fill in date, page name, product, tracking, and damage reason.');
    return;
  }

  DB.damageReports.unshift(record);
  saveDamageReports();
  showToast('success', 'Damage report saved', record.tracking);
  clearDamageReportForm();
  closeModal('damage-report-modal');
  refreshDamageSaved();
}

const chartRefs = {};
let csrPage = 1;
let csrFilter = 'daily';
let csrSearch = '';
let csrDateFrom = '';
let csrDateTo = '';
let csrNameFilter = '';
let editingCSRRecordId = '';

function normalizeDateString(date) {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().split('T')[0];
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRoleName(role) {
  const value = String(role || '').trim();
  if (!value) return '';
  const normalized = normalizeText(value);
  if (normalized === 'admin' || normalized === 'administrator') return 'Administrator';
  return value;
}

function isAdminUser() {
  return normalizeText(normalizeRoleName(App.user?.role)) === 'administrator';
}

function isHRUser() {
  return normalizeText(normalizeRoleName(App.user?.role)) === 'hr';
}

function canManageAccounts() {
  return isAdminUser() || isHRUser();
}

function canManageHR() {
  return isAdminUser() || isHRUser();
}

function isLogisticsUser() {
  return normalizeText(normalizeRoleName(App.user?.role)) === 'logistics';
}

function canManageInventoryStock() {
  return isAdminUser() || isLogisticsUser();
}

function isSalesMarketingUser(role = App.user?.role) {
  const normalized = normalizeRoleName(role);
  return normalized === 'Sales and Marketing' || normalized === 'Sales and Marketing TL';
}

function canManageMarketing() {
  // Sales and Marketing (regular) now has the same management access as the TL.
  return isAdminUser() || isSalesMarketingUser();
}

function getDefaultPageForCurrentUser() {
  // All users land on the home page after login.
  return 'home';
}

function getAccessiblePagesForCurrentUser() {
  if (!App.user) return [];
  const role = normalizeRoleName(App.user.role);
  return NAV_ACCESS[role] || ['home', 'rts-rate', 'data-report'];
}

function canAccessPage(page) {
  if (page === 'login') return true;
  return getAccessiblePagesForCurrentUser().includes(page);
}

function refreshSidebarAccess() {
  const accessiblePages = new Set(getAccessiblePagesForCurrentUser());
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.style.display = accessiblePages.has(item.dataset.page) ? 'flex' : 'none';
  });

  const hasSales = ['data-report', 'marketing-center', 'adspend-roas', 'csr', 'inventory'].some((page) => accessiblePages.has(page));
  const hasRmo = ['rmo-management'].some((page) => accessiblePages.has(page));
  const hasOperations = ['daily-pickup', 'rts-scanning', 'rts-rate', 'scanning'].some((page) => accessiblePages.has(page));
  const hasReports = ['data-report', 'view-records'].some((page) => accessiblePages.has(page));
  const hasSystem = ['manage-users', 'api-connections'].some((page) => accessiblePages.has(page));

  const salesLabel = document.getElementById('nav-section-sales');
  const rmoLabel = document.getElementById('nav-section-rmo');
  const operationsLabel = document.getElementById('nav-section-operations');
  const reportsLabel = document.getElementById('nav-section-reports');
  const systemLabel = document.getElementById('nav-section-system');

  if (salesLabel) salesLabel.style.display = hasSales ? 'flex' : 'none';
  if (rmoLabel) rmoLabel.style.display = hasRmo ? 'flex' : 'none';
  if (operationsLabel) operationsLabel.style.display = hasOperations ? 'flex' : 'none';
  if (reportsLabel) reportsLabel.style.display = hasReports ? 'flex' : 'none';
  if (systemLabel) systemLabel.style.display = hasSystem ? 'flex' : 'none';

  const salesBody = document.getElementById('nav-section-body-sales');
  const rmoBody = document.getElementById('nav-section-body-rmo');
  const operationsBody = document.getElementById('nav-section-body-operations');
  const reportsBody = document.getElementById('nav-section-body-reports');
  const systemBody = document.getElementById('nav-section-body-system');
  if (salesBody && !hasSales) salesBody.style.display = 'none';
  else if (salesBody) salesBody.style.display = '';
  if (rmoBody && !hasRmo) rmoBody.style.display = 'none';
  else if (rmoBody) rmoBody.style.display = '';
  if (operationsBody && !hasOperations) operationsBody.style.display = 'none';
  else if (operationsBody) operationsBody.style.display = '';
  if (reportsBody && !hasReports) reportsBody.style.display = 'none';
  else if (reportsBody) reportsBody.style.display = '';
  if (systemBody && !hasSystem) systemBody.style.display = 'none';
  else if (systemBody) systemBody.style.display = '';
}

function toggleNavSection(sectionId) {
  const body = document.getElementById('nav-section-body-' + sectionId);
  const label = document.getElementById('nav-section-' + sectionId);
  if (!body) return;
  const isCollapsed = body.classList.toggle('collapsed');
  if (label) label.classList.toggle('collapsed', isCollapsed);
  if (isCollapsed) localStorage.setItem('nav_collapsed_' + sectionId, '1');
  else localStorage.removeItem('nav_collapsed_' + sectionId);
}

function initNavSectionStates() {
  ['main', 'sales', 'rmo', 'operations', 'reports', 'people', 'system'].forEach((sectionId) => {
    if (localStorage.getItem('nav_collapsed_' + sectionId)) {
      const body = document.getElementById('nav-section-body-' + sectionId);
      const label = document.getElementById('nav-section-' + sectionId);
      if (body) body.classList.add('collapsed');
      if (label) label.classList.add('collapsed');
    }
  });
}

function getRoleOptionsMarkup(selectedRole = 'Trainee') {
  const currentRole = normalizeRoleName(selectedRole) || 'Trainee';
  return [
    `<option value="Administrator" ${currentRole === 'Administrator' ? 'selected' : ''}>Admin</option>`,
    ...ROLE_OPTIONS.map((role) => `<option value="${role}" ${currentRole === role ? 'selected' : ''}>${role}</option>`),
  ].join('');
}

function isCSRLikeUser() {
  const role = normalizeRoleName(App.user?.role);
  return role === 'CSR' || role === 'CSR TL' || role === 'Trainee';
}

function getHomeQuickActions() {
  if (isCSRLikeUser()) {
    return [
      ['🏠', 'Home', 'home'],
      ['📊', 'Sales Dashboard', 'data-report'],
    ];
  }

  return [
    ['📦', 'New Pickup', 'daily-pickup'],
    ['🔍', 'Scan Package', 'scanning'],
    ['↩️', 'RTS Scan', 'rts-scanning'],
    ['📊', 'View Sales', 'data-report'],
    ['🗃️', 'Inventory', 'inventory'],
    ['💰', 'Log Expense', 'expenses'],
  ].filter(([, , page]) => canAccessPage(page));
}

function isCurrentUserCSRRecord(record) {
  return normalizeText(record?.csrName) === normalizeText(getCurrentCsrName());
}

function canManageCSRRecord(record) {
  return isAdminUser() || isCurrentUserCSRRecord(record);
}

// Roles that can see the CSR Records page but only to view — no Daily Record
// input form and no edit/delete (Logistics, Sales and Marketing, S&M TL).
function isCSRViewOnlyUser() {
  return isLogisticsUser() || isSalesMarketingUser();
}

function canViewAllCSRRecords() {
  return isAdminUser() || isCSRViewOnlyUser() || normalizeRoleName(App.user?.role) === 'CSR TL';
}

function getCSRPrimaryButtonLabel() {
  return editingCSRRecordId ? 'Update Daily Record' : 'Save Daily Record';
}

function refreshCSRFormActions() {
  const primaryButton = document.getElementById('csr-save-btn');
  const secondaryButton = document.getElementById('csr-reset-btn');
  if (primaryButton) primaryButton.textContent = getCSRPrimaryButtonLabel();
  if (secondaryButton) secondaryButton.textContent = editingCSRRecordId ? 'Cancel Edit' : 'Reset';
}

function getDateDaysAgo(daysAgo) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date;
}

function getFilteredCSRRecords() {
  let data = [...DB.csrRecords];
  const today = normalizeDateString(new Date());

  if (!canViewAllCSRRecords()) {
    data = data.filter((record) => isCurrentUserCSRRecord(record));
  }

  if (csrFilter === 'daily') {
    data = data.filter((record) => record.date === today);
  } else if (csrFilter === 'weekly') {
    const weekStart = getDateDaysAgo(6);
    data = data.filter((record) => new Date(record.date) >= weekStart);
  } else if (csrFilter === 'monthly') {
    const currentMonth = new Date().toISOString().slice(0, 7);
    data = data.filter((record) => record.date.startsWith(currentMonth));
  } else if (csrFilter === 'custom') {
    if (csrDateFrom) data = data.filter((record) => record.date >= csrDateFrom);
    if (csrDateTo) data = data.filter((record) => record.date <= csrDateTo);
  }

  if (csrNameFilter) {
    data = data.filter((record) => record.csrName === csrNameFilter);
  }

  if (csrSearch) {
    const query = csrSearch.toLowerCase();
    data = data.filter((record) =>
      record.csrName.toLowerCase().includes(query)
      || record.pageName.toLowerCase().includes(query)
      || String(record.orderId || '').toLowerCase().includes(query)
      || record.customerName.toLowerCase().includes(query)
      || record.cellphoneNumber.toLowerCase().includes(query)
      || record.salesType.toLowerCase().includes(query)
      || record.status.toLowerCase().includes(query)
      || record.trackingNumber.toLowerCase().includes(query)
    );
  }

  return data.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

function renderCSRSummaryCards(records) {
  const totalSales = records.reduce((sum, record) => sum + Number(record.price || 0), 0);
  const delivered = records.filter((record) => csrLiveStatus(record).toUpperCase() === 'DELIVERED').length;
  const cancelled = records.filter((record) => csrLiveStatus(record).toUpperCase().includes('CANCELLED')).length;
  const pages = new Set(records.map((record) => record.pageName)).size;
  const summary = document.getElementById('csr-summary');

  if (!summary) return;

  summary.innerHTML = `
    <div class="stats-grid csr-summary-grid">
      <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">Filtered Records</div><div class="stat-value">${records.length}</div><div class="stat-meta">Daily, weekly, monthly, or custom range</div></div>
      <div class="stat-card green"><div class="stat-card-accent"></div><div class="stat-label">Delivered</div><div class="stat-value">${delivered}</div><div class="stat-meta">Successful customer deliveries</div></div>
      <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">Sales Amount</div><div class="stat-value" style="font-size:20px;">₱${totalSales.toLocaleString()}</div><div class="stat-meta">Total from visible records</div></div>
      <div class="stat-card red"><div class="stat-card-accent"></div><div class="stat-label">Cancelled</div><div class="stat-value">${cancelled}</div><div class="stat-meta">${pages} active page${pages === 1 ? '' : 's'} in filter</div></div>
    </div>`;
}

function renderCSRChart(records) {
  if (typeof Chart === 'undefined') return;

  const canvas = document.getElementById('csr-status-pie-chart');
  if (!canvas) return;

  if (chartRefs.csrStatusPie) {
    chartRefs.csrStatusPie.destroy();
  }

  const statusCounts = records.reduce((map, record) => {
    map[record.status] = (map[record.status] || 0) + 1;
    return map;
  }, {});

  const labels = Object.keys(statusCounts);
  const values = Object.values(statusCounts);

  chartRefs.csrStatusPie = new Chart(canvas, {
    type: 'pie',
    plugins: [doughnutPctPlugin],
    data: {
      labels: labels.length ? labels : ['No Records'],
      datasets: [{
        data: values.length ? values : [1],
        backgroundColor: ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#6366f1', '#14b8a6', '#8b5cf6', '#64748b'],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom' },
      },
    },
  });
}

// Locate the live Google Orders (sheet) record a CSR row is linked to, by Order ID.
function getCsrLinkedOrder(record) {
  const id = String(record?.orderId || '').trim();
  if (!id) return null;
  return DB.csrPosOrders[id] || null;
}

// Status/tracking shown for a CSR record always reflect the latest Google Orders
// values (looked up by Order ID), falling back to the stored snapshot.
function csrLiveStatus(record) {
  const linked = getCsrLinkedOrder(record);
  return (linked && linked.status) ? linked.status : (record.status || '');
}

function csrLiveTracking(record) {
  const linked = getCsrLinkedOrder(record);
  return (linked && linked.tracking) ? linked.tracking : (record.trackingNumber || '');
}

// Rows for the CSR Records tab on the View Records page (includes Order ID and
// pulls live status/tracking from the linked Google Orders record).
function renderRecCsrRows() {
  if (!DB.csrRecords.length) {
    return '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text-muted)">No CSR records yet.</td></tr>';
  }
  return DB.csrRecords.map((record) => `<tr>
    <td>${record.date}</td>
    <td style="font-weight:500">${record.csrName}</td>
    <td>${record.pageName}</td>
    <td class="font-mono text-xs">${record.orderId || ''}</td>
    <td>${record.customerName}</td>
    <td class="font-mono text-xs">${record.cellphoneNumber}</td>
    <td><span class="badge badge-info">${record.salesType}</span></td>
    <td>${statusBadge(csrLiveStatus(record))}</td>
    <td>₱${Number(record.price || 0).toLocaleString()}</td>
    <td class="font-mono text-xs">${csrLiveTracking(record)}</td>
  </tr>`).join('');
}

function refreshRecCsrTable() {
  const tbody = document.getElementById('rec-csr-tbody');
  if (tbody) tbody.innerHTML = renderRecCsrRows();
  const count = document.getElementById('rec-csr-count');
  if (count) count.textContent = DB.csrRecords.length;
}

function renderCSRTable() {
  const tbody = document.getElementById('csr-tbody');
  if (!tbody) return;

  const perPage = 10;
  const records = getFilteredCSRRecords();
  const pages = Math.max(1, Math.ceil(records.length / perPage));
  if (csrPage > pages) csrPage = pages;

  const sliced = records.slice((csrPage - 1) * perPage, csrPage * perPage);

  tbody.innerHTML = sliced.map((record) => `<tr>
    <td>${record.date}</td>
    <td style="font-weight:500">${record.csrName}</td>
    <td>${record.pageName}</td>
    <td class="font-mono text-xs">${record.orderId || ''}</td>
    <td>${record.customerName}</td>
    <td class="font-mono text-xs">${record.cellphoneNumber}</td>
    <td><span class="badge badge-info">${record.salesType}</span></td>
    <td>${statusBadge(csrLiveStatus(record))}</td>
    <td>₱${Number(record.price || 0).toLocaleString()}</td>
    <td class="font-mono text-xs">${csrLiveTracking(record)}</td>
    <td>${canManageCSRRecord(record) ? `<div class="flex gap-2"><button class="btn btn-ghost btn-sm" onclick="editCSRRecord('${record.id}')">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteCSRRecord('${record.id}')">Delete</button></div>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="11" style="text-align:center;padding:32px;color:var(--text-muted)">No CSR records found for the selected range.</td></tr>';

  const pagination = document.getElementById('csr-pagination');
  if (pagination) {
    const start = records.length ? ((csrPage - 1) * perPage) + 1 : 0;
    const end = Math.min(csrPage * perPage, records.length);
    pagination.innerHTML = `
      <span>${start}-${end} of ${records.length} records</span>
      <div class="pagination-buttons">
        <button class="page-btn" onclick="changeCSRPage(${csrPage - 1})" ${csrPage <= 1 ? 'disabled' : ''}>‹</button>
        ${Array.from({ length: Math.min(pages, 5) }, (_, index) => `<button class="page-btn ${index + 1 === csrPage ? 'active' : ''}" onclick="changeCSRPage(${index + 1})">${index + 1}</button>`).join('')}
        <button class="page-btn" onclick="changeCSRPage(${csrPage + 1})" ${csrPage >= pages ? 'disabled' : ''}>›</button>
      </div>`;
  }

  renderCSRSummaryCards(records);
}

function changeCSRPage(page) {
  if (page < 1) return;
  csrPage = page;
  renderCSRTable();
}

function setCSRFilter(filter, btn) {
  csrFilter = filter;
  csrPage = 1;

  document.querySelectorAll('#csr-filter-group .filter-pill').forEach((pill) => pill.classList.remove('active'));
  btn.classList.add('active');

  const customRange = document.getElementById('csr-custom-range');
  if (customRange) customRange.classList.toggle('hidden', filter !== 'custom');

  if (filter !== 'custom') {
    renderCSRTable();
  }
}

function applyCSRCustomRange() {
  csrDateFrom = document.getElementById('csr-date-from')?.value || '';
  csrDateTo = document.getElementById('csr-date-to')?.value || '';
  csrPage = 1;
  renderCSRTable();
}

function filterCSRTable() {
  csrSearch = document.getElementById('csr-search')?.value.trim() || '';
  csrPage = 1;
  renderCSRTable();
}

function setCSRNameFilter() {
  csrNameFilter = document.getElementById('csr-name-filter')?.value || '';
  csrPage = 1;
  renderCSRTable();
}

function setCSRFieldValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value ?? '';
}

// Search Google Orders by Order ID and auto-fill the customer, contact, price,
// tracking, and latest status, then link the record to the order's chat page.
function lookupCSROrder() {
  const orderId = (document.getElementById('csr-order-id')?.value || '').trim();
  const help = document.getElementById('csr-lookup-help');
  const autoFilled = ['csr-customer-name', 'csr-cellphone-number', 'csr-price', 'csr-tracking-number', 'csr-status'];

  if (!orderId) {
    showToast('warning', 'Order ID required', 'Enter an Order ID to search the chat page.');
    return;
  }

  const records = DB.sheetRecordsForReport || [];
  if (!records.length) {
    showToast('warning', 'Orders still loading', 'Google Orders are still loading — please try again in a moment.');
    loadSheetRecordsForDataReport().then(() => { if (App.currentPage === 'csr') loadPage('csr'); }).catch(() => {});
    return;
  }

  const match = records.find((record) => String(record.id || '').trim().toLowerCase() === orderId.toLowerCase());
  if (!match) {
    autoFilled.forEach((id) => setCSRFieldValue(id, ''));
    if (help) help.textContent = `No order found for "${orderId}". Check the Order ID and try again.`;
    showToast('error', 'Order not found', `No Google Orders record matches Order ID ${orderId}.`);
    return;
  }

  setCSRFieldValue('csr-customer-name', match.customer || '');
  setCSRFieldValue('csr-cellphone-number', match.phone || '');
  setCSRFieldValue('csr-price', match.cod != null && match.cod !== '' ? match.cod : '');
  setCSRFieldValue('csr-tracking-number', match.tracking || '');
  setCSRFieldValue('csr-status', match.status || '');

  // Link the record to the order's chat page when available.
  const pageSelect = document.getElementById('csr-page-name');
  const orderPage = String(match.sourceSheet || match.source_sheet || '').trim();
  if (pageSelect && orderPage) {
    const hasOption = Array.from(pageSelect.options).some((opt) => opt.value === orderPage);
    if (!hasOption) pageSelect.add(new Option(orderPage, orderPage));
    pageSelect.value = orderPage;
  }

  if (help) {
    help.textContent = `Linked to ${match.customer || 'customer'} • ${orderPage || 'page'} • status ${match.status || 'n/a'}.`;
  }
  showToast('success', 'Order found', `${match.customer || 'Customer'} • ₱${Number(match.cod || 0).toLocaleString()}`);
}

function resetCSRForm() {
  editingCSRRecordId = '';
  const today = new Date().toISOString().split('T')[0];
  const defaults = {
    'csr-date': today,
    'csr-name': getCurrentCsrName(),
    'csr-page-name': '',
    'csr-order-id': '',
    'csr-customer-name': '',
    'csr-cellphone-number': '',
    'csr-sales-type': '',
    'csr-status': '',
    'csr-price': '',
    'csr-tracking-number': '',
  };

  Object.entries(defaults).forEach(([id, value]) => {
    const input = document.getElementById(id);
    if (input) input.value = value;
  });

  const help = document.getElementById('csr-lookup-help');
  if (help) help.textContent = 'Search the chat page by Order ID to auto-fill the details below.';

  refreshCSRFormActions();
}

function editCSRRecord(recordId) {
  const record = DB.csrRecords.find((item) => item.id === recordId);
  if (!record) {
    showToast('error', 'Record not found', 'The selected CSR record could not be found.');
    return;
  }

  if (!canManageCSRRecord(record)) {
    showToast('error', 'Access denied', 'You can only edit your own CSR daily records.');
    return;
  }

  if (isAdminUser()) {
    editCSRRecordInline(record);
    return;
  }

  editingCSRRecordId = record.id;

  const fieldMap = {
    'csr-date': record.date,
    'csr-name': record.csrName,
    'csr-page-name': record.pageName,
    'csr-order-id': record.orderId,
    'csr-customer-name': record.customerName,
    'csr-cellphone-number': record.cellphoneNumber,
    'csr-sales-type': record.salesType,
    'csr-status': record.status,
    'csr-price': record.price,
    'csr-tracking-number': record.trackingNumber,
  };

  // Make sure the stored page is selectable even if it isn't in the live list.
  const pageSelect = document.getElementById('csr-page-name');
  if (pageSelect && record.pageName
      && !Array.from(pageSelect.options).some((opt) => opt.value === record.pageName)) {
    pageSelect.add(new Option(record.pageName, record.pageName));
  }

  Object.entries(fieldMap).forEach(([id, value]) => {
    const input = document.getElementById(id);
    if (input) input.value = value ?? '';
  });

  refreshCSRFormActions();
  document.getElementById('csr-date')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function editCSRRecordInline(record) {
  const next = {
    ...record,
    date: window.prompt('Date', record.date) || record.date,
    csrName: window.prompt('Name CSR', record.csrName) || record.csrName,
    pageName: window.prompt('Page Name', record.pageName) || record.pageName,
    customerName: window.prompt('Customer Name', record.customerName) || record.customerName,
    cellphoneNumber: window.prompt('Cellphone Number', record.cellphoneNumber) || record.cellphoneNumber,
    salesType: window.prompt('Type of Sales', record.salesType) || record.salesType,
    status: window.prompt('Status', record.status) || record.status,
    price: Number(window.prompt('Price', record.price) || record.price),
    trackingNumber: window.prompt('Tracking Number', record.trackingNumber || '') || record.trackingNumber,
  };

  if (!next.date || !next.pageName || !next.customerName || !next.cellphoneNumber || !next.salesType || !next.status || Number(next.price || 0) <= 0) {
    showToast('error', 'Incomplete CSR record', 'Admin edit was cancelled or has missing required fields.');
    return;
  }

  try {
    const updated = await authorizedJsonRequest(`/csr/${encodeURIComponent(record.id)}`, {
      method: 'PUT',
      body: JSON.stringify(next),
    });
    const index = DB.csrRecords.findIndex((item) => item.id === record.id);
    if (index !== -1) DB.csrRecords[index] = updated;
  } catch (error) {
    showToast('error', 'Update failed', error.message || 'Could not update the CSR record.');
    return;
  }

  renderCSRTable();
  showToast('success', 'CSR record updated', `${next.customerName} • ${next.pageName}`);
}

async function deleteCSRRecord(recordId) {
  const record = DB.csrRecords.find((item) => item.id === recordId);
  if (!record) {
    showToast('error', 'Record not found', 'The selected CSR record could not be found.');
    return;
  }

  if (!canManageCSRRecord(record)) {
    showToast('error', 'Access denied', 'You can only delete your own CSR daily records.');
    return;
  }

  if (!confirm(`Delete CSR record for ${record.customerName}?`)) return;

  try {
    await authorizedJsonRequest(`/csr/${encodeURIComponent(recordId)}`, { method: 'DELETE' });
  } catch (error) {
    showToast('error', 'Delete failed', error.message || 'Could not delete the CSR record.');
    return;
  }

  const index = DB.csrRecords.findIndex((item) => item.id === recordId);
  if (index !== -1) DB.csrRecords.splice(index, 1);

  if (editingCSRRecordId === recordId) {
    resetCSRForm();
  }

  renderCSRTable();
  showToast('success', 'CSR record deleted', `${record.customerName} • ${record.pageName}`);
}

async function saveCSRRecord() {
  const record = {
    date: document.getElementById('csr-date')?.value || '',
    csrName: (document.getElementById('csr-name')?.value || getCurrentCsrName()).trim(),
    pageName: (document.getElementById('csr-page-name')?.value || '').trim(),
    orderId: (document.getElementById('csr-order-id')?.value || '').trim(),
    customerName: (document.getElementById('csr-customer-name')?.value || '').trim(),
    cellphoneNumber: (document.getElementById('csr-cellphone-number')?.value || '').trim(),
    salesType: (document.getElementById('csr-sales-type')?.value || '').trim(),
    status: (document.getElementById('csr-status')?.value || '').trim(),
    price: parseFloat(document.getElementById('csr-price')?.value || '0'),
    trackingNumber: (document.getElementById('csr-tracking-number')?.value || '').trim(),
  };

  if (!record.date || !record.pageName || !record.orderId || !record.salesType) {
    showToast('error', 'Incomplete CSR record', 'Select a page, enter an Order ID, and choose a type of sales.');
    return;
  }

  if (!record.customerName || !record.cellphoneNumber) {
    showToast('error', 'Order not linked', 'Search the Order ID first so the customer details auto-fill before saving.');
    return;
  }

  if (!isAdminUser()) {
    record.csrName = getCurrentCsrName();
  }

  try {
    if (editingCSRRecordId) {
      const existing = DB.csrRecords.find((item) => item.id === editingCSRRecordId);
      if (existing && !canManageCSRRecord(existing)) {
        showToast('error', 'Access denied', 'You can only edit your own CSR daily records.');
        return;
      }
      const updated = await authorizedJsonRequest(`/csr/${encodeURIComponent(editingCSRRecordId)}`, {
        method: 'PUT',
        body: JSON.stringify(record),
      });
      const index = DB.csrRecords.findIndex((item) => item.id === editingCSRRecordId);
      if (index !== -1) DB.csrRecords[index] = updated;
    } else {
      const created = await authorizedJsonRequest('/csr', {
        method: 'POST',
        body: JSON.stringify(record),
      });
      DB.csrRecords.unshift(created);
    }
  } catch (error) {
    showToast('error', 'Save failed', error.message || 'Could not save the CSR record.');
    return;
  }

  const successMessage = editingCSRRecordId ? 'CSR record updated' : 'CSR record saved';
  resetCSRForm();
  renderCSRTable();
  showToast('success', successMessage, `${record.customerName} • ${record.pageName} • ₱${record.price.toLocaleString()}`);
}

function formatClockValue(value) {
  if (!value) return '<span class="text-muted">--:--</span>';
  return escapeHtml(formatClock12(value));
}

function formatClock12(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return raw;
  let hour = parseInt(match[1], 10);
  const minute = match[2];
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return raw;
  const period = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${period}`;
}

function renderTimeClockStatus(record, date) {
  const wrapper = document.getElementById('time-clock-status');
  lockTimeInIfDone(record);
  if (!wrapper) return;
  wrapper.innerHTML = `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; text-align:left;">
      <div><div class="text-xs text-muted">Date</div><strong>${escapeHtml(date || normalizeDateString(new Date()))}</strong></div>
      <div><div class="text-xs text-muted">Break</div><strong>${Number(record?.break_minutes || 15)} mins</strong></div>
      <div><div class="text-xs text-muted">Time In</div><strong>${formatClockValue(record?.time_in)}</strong></div>
      <div><div class="text-xs text-muted">Break Out</div><strong>${formatClockValue(record?.break_out)}</strong></div>
      <div><div class="text-xs text-muted">Break In</div><strong>${formatClockValue(record?.break_in)}</strong></div>
      <div><div class="text-xs text-muted">15-min Out</div><strong>${formatClockValue(record?.break2_out)}</strong></div>
      <div><div class="text-xs text-muted">15-min In</div><strong>${formatClockValue(record?.break2_in)}</strong></div>
      <div><div class="text-xs text-muted">Time Out</div><strong>${formatClockValue(record?.time_out)}</strong></div>
    </div>`;
}

async function loadTimeClockStatus() {
  const wrapper = document.getElementById('time-clock-status');
  try {
    const data = await authorizedJsonRequest(`/hr/today?_=${Date.now()}`);
    renderTimeClockStatus(data?.record, data?.date);
  } catch (error) {
    if (wrapper) {
      wrapper.innerHTML = `<h3>Clock unavailable</h3><p>${escapeHtml(error.message || 'Could not load today attendance.')}</p>`;
    }
  }
}

// kind: 'break' = 1-hour break out (break_out/break_in),
//       'break2' = separate 15-min break (break2_out/break2_in).
function startBreakWithCountdown(minutes, kind = 'break') {
  const duration = Math.max(1, Number(minutes) || 15) * 60;
  const outAction = kind === 'break2' ? 'break2_out' : 'break_out';
  const state = { endsAt: Date.now() + duration * 1000, duration, kind };
  try { localStorage.setItem('breakCountdown', JSON.stringify(state)); } catch {}
  submitTimeClock(outAction);
  startBreakCountdownTicker();
}

function endBreakCountdown() {
  let state = null;
  try { state = JSON.parse(localStorage.getItem('breakCountdown') || 'null'); } catch {}
  const inAction = state?.kind === 'break2' ? 'break2_in' : 'break_in';
  try { localStorage.removeItem('breakCountdown'); } catch {}
  stopBreakCountdownTicker();
  hideBreakCountdownUI();
  submitTimeClock(inAction);
}

let _breakCountdownTimer = null;
function startBreakCountdownTicker() {
  stopBreakCountdownTicker();
  tickBreakCountdown();
  _breakCountdownTimer = setInterval(tickBreakCountdown, 1000);
}

function stopBreakCountdownTicker() {
  if (_breakCountdownTimer) { clearInterval(_breakCountdownTimer); _breakCountdownTimer = null; }
}

function tickBreakCountdown() {
  let state = null;
  try { state = JSON.parse(localStorage.getItem('breakCountdown') || 'null'); } catch {}
  if (!state || !state.endsAt) { hideBreakCountdownUI(); stopBreakCountdownTicker(); return; }
  const remainingMs = state.endsAt - Date.now();
  const remainingSec = Math.max(0, Math.floor(remainingMs / 1000));
  const mm = String(Math.floor(remainingSec / 60)).padStart(2, '0');
  const ss = String(remainingSec % 60).padStart(2, '0');
  const display = `${mm}:${ss}`;
  const pctRemaining = state.duration ? (remainingSec / state.duration) * 100 : 0;
  const fillPct = Math.max(0, Math.min(100, 100 - pctRemaining));
  const labelText = state.duration === 60 * 60 ? 'On 1-hour break' : state.duration === 15 * 60 ? 'On 15-minute break' : 'On break';

  ['break-countdown-card', 'attendance-break-countdown'].forEach((id) => {
    const card = document.getElementById(id);
    if (card) card.classList.remove('hidden');
    if (card) card.classList.toggle('expired', remainingSec === 0);
  });
  ['break-countdown-time', 'attendance-break-countdown-time'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = remainingSec === 0 ? "Time's up!" : display;
  });
  ['break-countdown-label', 'attendance-break-countdown-label'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = labelText;
  });
  ['break-countdown-fill', 'attendance-break-countdown-fill'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.width = `${fillPct.toFixed(1)}%`;
  });

  if (remainingSec === 0) {
    stopBreakCountdownTicker();
    // Auto-notify once
    if (!state.notified) {
      state.notified = true;
      try { localStorage.setItem('breakCountdown', JSON.stringify(state)); } catch {}
      showToast('warning', 'Break is over', 'Click "End Break Now" to clock back in.');
    }
  }
}

function hideBreakCountdownUI() {
  ['break-countdown-card', 'attendance-break-countdown'].forEach((id) => {
    const card = document.getElementById(id);
    if (card) card.classList.add('hidden');
  });
}

function restoreBreakCountdownIfActive() {
  let state = null;
  try { state = JSON.parse(localStorage.getItem('breakCountdown') || 'null'); } catch {}
  if (state && state.endsAt && state.endsAt > Date.now() - 60 * 60 * 1000) {
    startBreakCountdownTicker();
  }
}

let _philippineClockTimer = null;
function startPhilippineClockTicker() {
  if (_philippineClockTimer) clearInterval(_philippineClockTimer);
  const tick = () => {
    const now = new Date();
    const formatted = now.toLocaleTimeString('en-PH', {
      timeZone: 'Asia/Manila',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
    document.querySelectorAll('#philippine-clock, .philippine-clock').forEach((el) => {
      el.textContent = formatted;
    });
  };
  tick();
  _philippineClockTimer = setInterval(tick, 1000);
}

async function submitTimeClock(action) {
  const labels = {
    time_in: 'Time in',
    break_out: 'Break out',
    break_in: 'Break in',
    break2_out: '15-min break out',
    break2_in: '15-min break in',
    time_out: 'Time out',
  };
  try {
    const data = await authorizedJsonRequest('/hr/clock', {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    renderTimeClockStatus(data?.record, data?.record?.work_date);
    if (document.getElementById('attendance-clock-status')) {
      await loadAttendanceDashboard();
    }
    showToast('success', labels[action] || 'Clock', 'Attendance record updated.');
  } catch (error) {
    showToast('error', 'Clock failed', error.message || 'Could not update time clock.');
  }
}

function initAttendancePage() {
  loadAttendanceDashboard();
}

async function submitOTRequest() {
  const work_date = document.getElementById('ot-work-date')?.value;
  const hours = Number(document.getElementById('ot-hours')?.value || 0);
  const reason = document.getElementById('ot-reason')?.value || '';
  if (!work_date || hours <= 0) {
    showToast('error', 'Validation', 'Pick a date and a positive OT hours value.');
    return;
  }
  try {
    await authorizedJsonRequest('/hr/ot-requests', {
      method: 'POST',
      body: JSON.stringify({ work_date, requested_minutes: Math.round(hours * 60), reason }),
    });
    showToast('success', 'Request submitted', `${hours}h on ${work_date}`);
    document.getElementById('ot-hours').value = '';
    document.getElementById('ot-reason').value = '';
    loadMyOTRequests();
  } catch (err) {
    showToast('error', 'Submit failed', err.message);
  }
}

async function loadMyOTRequests() {
  const wrap = document.getElementById('ot-request-list');
  if (!wrap) return;
  try {
    const result = await authorizedJsonRequest('/hr/ot-requests');
    const rows = Array.isArray(result?.data) ? result.data : [];
    if (!rows.length) {
      wrap.innerHTML = '<div class="empty-state"><h3>No requests yet</h3><p>Submit an OT request on the left.</p></div>';
      return;
    }
    wrap.innerHTML = `
      <table class="data-table" style="font-size:13px;">
        <thead><tr><th>Date</th><th>Hours</th><th>Status</th><th>Reviewer</th><th></th></tr></thead>
        <tbody>
          ${rows.slice(0, 25).map((r) => {
            const cls = r.status === 'approved' ? 'badge-success' : r.status === 'rejected' ? 'badge-danger' : 'badge-warning';
            const hours = (Number(r.requested_minutes || 0) / 60).toFixed(2);
            return `<tr>
              <td>${escapeHtml(r.work_date || '')}</td>
              <td>${hours}h <span style="color:var(--text-muted);font-size:11px;">${r.reason ? '· ' + escapeHtml(r.reason).slice(0, 40) : ''}</span></td>
              <td><span class="badge ${cls}">${escapeHtml(r.status)}</span></td>
              <td>${escapeHtml(r.reviewer_name || '-')}</td>
              <td>${r.status === 'pending' ? `<button class="btn btn-ghost btn-sm" onclick="deleteOTRequest(${r.id})">×</button>` : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function deleteOTRequest(id) {
  if (!confirm('Cancel this OT request?')) return;
  try {
    await authorizedJsonRequest(`/hr/ot-requests/${id}`, { method: 'DELETE' });
    loadMyOTRequests();
    if (typeof loadHRPendingOT === 'function') loadHRPendingOT();
  } catch (err) {
    showToast('error', 'Delete failed', err.message);
  }
}

async function loadHRPendingOT() {
  const wrap = document.getElementById('hr-ot-request-list');
  if (!wrap) return;
  try {
    const result = await authorizedJsonRequest('/hr/ot-requests?status=pending');
    const rows = Array.isArray(result?.data) ? result.data : [];
    if (!rows.length) {
      wrap.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:14px 0;">No pending OT requests.</div>';
      return;
    }
    wrap.innerHTML = `
      <table class="data-table" style="font-size:13px;">
        <thead><tr><th>User</th><th>Date</th><th>Hours</th><th>Reason</th><th>Actions</th></tr></thead>
        <tbody>
          ${rows.map((r) => {
            const hours = (Number(r.requested_minutes || 0) / 60).toFixed(2);
            return `<tr>
              <td><strong>${escapeHtml(r.user_name || '')}</strong></td>
              <td>${escapeHtml(r.work_date || '')}</td>
              <td>${hours}h</td>
              <td style="max-width:240px;white-space:normal;">${escapeHtml(r.reason || '-')}</td>
              <td>
                <button class="btn btn-primary btn-sm" onclick="reviewOTRequest(${r.id}, 'approved')">Approve</button>
                <button class="btn btn-secondary btn-sm" onclick="reviewOTRequest(${r.id}, 'rejected')">Reject</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    wrap.innerHTML = `<div style="color:var(--text-muted);">Failed: ${escapeHtml(err.message)}</div>`;
  }
}

async function reviewOTRequest(id, status) {
  try {
    await authorizedJsonRequest(`/hr/ot-requests/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    showToast('success', `Request ${status}`, `#${id}`);
    loadHRPendingOT();
    if (App.currentPage === 'hr') loadHRDashboard();
  } catch (err) {
    showToast('error', 'Update failed', err.message);
  }
}

async function loadMyWorkHours() {
  const wrap = document.getElementById('attendance-hours-wrap');
  if (!wrap) return;
  const today = normalizeDateString(new Date());
  const from = document.getElementById('wh-date-from')?.value || today.slice(0, 8) + '01';
  const to = document.getElementById('wh-date-to')?.value || today;
  wrap.innerHTML = '<div class="empty-state"><h3>Loading</h3><p>Fetching your work hour records.</p></div>';
  try {
    const query = new URLSearchParams({ from, to, _: Date.now().toString() });
    const data = await authorizedJsonRequest(`/hr/payslip?${query.toString()}`);
    renderMyWorkHours(data?.payslip);
  } catch (error) {
    wrap.innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${escapeHtml(error.message || 'Could not load work hours.')}</p></div>`;
  }
}

function renderMyWorkHours(payslip) {
  const wrap = document.getElementById('attendance-hours-wrap');
  if (!wrap) return;
  const records = Array.isArray(payslip?.attendance) ? payslip.attendance : [];
  if (!records.length) {
    wrap.innerHTML = '<div class="empty-state"><h3>No records</h3><p>No attendance records for the selected period.</p></div>';
    return;
  }

  const totals = payslip?.totals || {};
  const totalWorked = records.reduce((sum, r) => sum + Number(r.worked_minutes || 0), 0);
  const totalOt = records.reduce((sum, r) => sum + Number(r.calculated_ot_minutes || r.ot_minutes || 0), 0);

  wrap.innerHTML = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;padding:16px 16px 8px;">
      <div class="stat-card" style="flex:1;min-width:120px;padding:12px 16px;">
        <div class="stat-label">Days Worked</div>
        <div class="stat-value" style="font-size:1.4rem;">${totals.days_worked || records.filter((r) => r.time_in && r.time_out).length}</div>
      </div>
      <div class="stat-card" style="flex:1;min-width:120px;padding:12px 16px;">
        <div class="stat-label">Total Work Hours</div>
        <div class="stat-value" style="font-size:1.4rem;">${formatMinutes(totalWorked)}</div>
      </div>
      <div class="stat-card amber" style="flex:1;min-width:120px;padding:12px 16px;">
        <div class="stat-label">Total OT</div>
        <div class="stat-value" style="font-size:1.4rem;">${formatMinutes(totalOt)}</div>
      </div>
    </div>
    <div style="overflow-x:auto;">
      <table style="margin:0;">
        <thead>
          <tr>
            <th>Date</th>
            <th>Time In</th>
            <th>Break Out</th>
            <th>Break In</th>
            <th>Time Out</th>
            <th>Work Hours</th>
            <th>OT</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${records.map((r) => {
            const worked = Number(r.worked_minutes || 0);
            const ot = Number(r.calculated_ot_minutes || r.ot_minutes || 0);
            const complete = r.time_in && r.time_out;
            return `<tr>
              <td><strong>${escapeHtml(r.work_date || '')}</strong></td>
              <td class="font-mono text-xs">${r.time_in ? escapeHtml(formatClock12(r.time_in)) : '—'}</td>
              <td class="font-mono text-xs">${r.break_out ? escapeHtml(formatClock12(r.break_out)) : '—'}</td>
              <td class="font-mono text-xs">${r.break_in ? escapeHtml(formatClock12(r.break_in)) : '—'}</td>
              <td class="font-mono text-xs">${r.time_out ? escapeHtml(formatClock12(r.time_out)) : '—'}</td>
              <td>${complete ? `<strong>${formatMinutes(worked)}</strong>` : '<span style="color:var(--text-muted)">Incomplete</span>'}</td>
              <td>${ot > 0 ? `<span class="badge badge-warning">${formatMinutes(ot)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
              <td class="text-xs text-muted">${escapeHtml(r.notes || '')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

// Disable the Time In button(s) once the user has timed in today, so they can't
// time in twice (the backend also rejects a second time-in).
function lockTimeInIfDone(record) {
  const done = Boolean(record?.time_in);
  document.querySelectorAll('.btn-time-in').forEach((btn) => {
    btn.disabled = done;
    btn.textContent = done ? 'Timed In ✓' : 'Time In';
  });
  // Two independent breaks: lock each button on its own punches. The 1-hour
  // break out uses break_out/break_in; the 15-min break uses break2_out/break2_in.
  // Buttons without a data-break marker fall back to the 1-hour break for safety.
  document.querySelectorAll('.btn-break').forEach((btn) => {
    const kind = btn.dataset.break === 'break2' ? 'break2' : 'break';
    const outVal = kind === 'break2' ? record?.break2_out : record?.break_out;
    const inVal = kind === 'break2' ? record?.break2_in : record?.break_in;
    const started = Boolean(outVal);
    const done = Boolean(outVal && inVal);
    btn.disabled = started;
    btn.title = done
      ? (kind === 'break2' ? '15-min break already taken today' : 'Break out already taken today')
      : '';
  });
}

function renderAttendanceClockStatus(record, date) {
  const wrapper = document.getElementById('attendance-clock-status');
  lockTimeInIfDone(record);
  if (!wrapper) return;
  wrapper.className = '';
  wrapper.innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; text-align:left;">
      <div><div class="text-xs text-muted">Date</div><strong>${escapeHtml(date || normalizeDateString(new Date()))}</strong></div>
      <div><div class="text-xs text-muted">Break</div><strong>${Number(record?.break_minutes || 15)} mins</strong></div>
      <div><div class="text-xs text-muted">Time In</div><strong>${formatClockValue(record?.time_in)}</strong></div>
      <div><div class="text-xs text-muted">Time Out</div><strong>${formatClockValue(record?.time_out)}</strong></div>
      <div><div class="text-xs text-muted">Break Out</div><strong>${formatClockValue(record?.break_out)}</strong></div>
      <div><div class="text-xs text-muted">Break In</div><strong>${formatClockValue(record?.break_in)}</strong></div>
      <div><div class="text-xs text-muted">15-min Out</div><strong>${formatClockValue(record?.break2_out)}</strong></div>
      <div><div class="text-xs text-muted">15-min In</div><strong>${formatClockValue(record?.break2_in)}</strong></div>
    </div>`;
}

function fillAttendanceInputs(record) {
  const setValue = (id, value) => {
    const input = document.getElementById(id);
    if (input) input.value = value || '';
  };
  setValue('attendance-time-in', record?.time_in);
  setValue('attendance-time-out', record?.time_out);
  setValue('attendance-break-out', record?.break_out);
  setValue('attendance-break-in', record?.break_in);
  setValue('attendance-break2-out', record?.break2_out);
  setValue('attendance-break2-in', record?.break2_in);
  setValue('attendance-notes', record?.notes);
}

async function loadAttendanceDashboard() {
  const today = normalizeDateString(new Date());
  const monthStart = today.slice(0, 8) + '01';
  const query = new URLSearchParams({ from: monthStart, to: today, _: Date.now().toString() });
  try {
    const [todayData, advancesData, leavesData] = await Promise.all([
      authorizedJsonRequest(`/hr/today?_=${Date.now()}`),
      authorizedJsonRequest(`/hr/cash-advances?${query.toString()}`),
      authorizedJsonRequest(`/hr/leave-requests?${query.toString()}`),
    ]);
    attendanceState.today = todayData?.record || null;
    attendanceState.date = todayData?.date || today;
    attendanceState.advances = Array.isArray(advancesData?.advances) ? advancesData.advances : [];
    attendanceState.leaves = Array.isArray(leavesData?.requests) ? leavesData.requests : [];
    renderAttendanceClockStatus(attendanceState.today, attendanceState.date);
    fillAttendanceInputs(attendanceState.today);
    renderAttendanceCashList();
    renderAttendanceLeaveList();
  } catch (error) {
    showToast('error', 'Attendance load failed', error.message || 'Could not load attendance records.');
  }
}

async function saveAttendanceTimes() {
  if (!canManageHR()) {
    showToast('warning', 'Access denied', 'Only HR or Admin can edit time records.');
    return;
  }
  try {
    const data = await authorizedJsonRequest('/hr/attendance/self', {
      method: 'PUT',
      body: JSON.stringify({
        time_in: document.getElementById('attendance-time-in')?.value || '',
        time_out: document.getElementById('attendance-time-out')?.value || '',
        break_out: document.getElementById('attendance-break-out')?.value || '',
        break_in: document.getElementById('attendance-break-in')?.value || '',
        break2_out: document.getElementById('attendance-break2-out')?.value || '',
        break2_in: document.getElementById('attendance-break2-in')?.value || '',
        notes: document.getElementById('attendance-notes')?.value || '',
      }),
    });
    attendanceState.today = data?.record || attendanceState.today;
    renderAttendanceClockStatus(attendanceState.today, attendanceState.today?.work_date || attendanceState.date);
    showToast('success', 'Time saved', 'Attendance time record was updated.');
  } catch (error) {
    showToast('error', 'Time save failed', error.message || 'Could not save attendance time.');
  }
}

async function requestCashAdvance(event) {
  event.preventDefault();
  try {
    await authorizedJsonRequest('/hr/cash-advances/request', {
      method: 'POST',
      body: JSON.stringify({
        amount: Number(document.getElementById('attendance-cash-amount')?.value || 0),
        reason: document.getElementById('attendance-cash-reason')?.value || '',
      }),
    });
    const amount = document.getElementById('attendance-cash-amount');
    const reason = document.getElementById('attendance-cash-reason');
    if (amount) amount.value = '';
    if (reason) reason.value = '';
    showToast('success', 'Cash advance sent', 'Your cash advance request was saved.');
    await loadAttendanceDashboard();
  } catch (error) {
    showToast('error', 'Request failed', error.message || 'Could not submit cash advance.');
  }
}

async function requestLeave(event) {
  event.preventDefault();
  try {
    await authorizedJsonRequest('/hr/leave-requests', {
      method: 'POST',
      body: JSON.stringify({
        leave_type: document.getElementById('attendance-leave-type')?.value || 'Personal',
        leave_date_from: document.getElementById('attendance-leave-from')?.value,
        leave_date_to: document.getElementById('attendance-leave-to')?.value,
        reason: document.getElementById('attendance-leave-reason')?.value || '',
      }),
    });
    const reason = document.getElementById('attendance-leave-reason');
    if (reason) reason.value = '';
    showToast('success', 'Leave requested', 'Your leave request was saved.');
    await loadAttendanceDashboard();
  } catch (error) {
    showToast('error', 'Leave failed', error.message || 'Could not submit leave request.');
  }
}

function renderAttendanceCashList() {
  const wrap = document.getElementById('attendance-cash-list');
  if (!wrap) return;
  if (!attendanceState.advances.length) {
    wrap.innerHTML = '<div class="empty-state"><h3>No cash advances</h3><p>Submitted requests will appear here.</p></div>';
    return;
  }
  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Date</th><th>User</th><th>Amount</th><th>Status</th><th>Reason</th></tr></thead>
        <tbody>
          ${attendanceState.advances.map((advance) => `
            <tr>
              <td>${escapeHtml(advance.advance_date || '')}</td>
              <td>${escapeHtml(advance.full_name || App.user?.full_name || 'User')}</td>
              <td><strong>${formatPHP(advance.amount)}</strong></td>
              <td><span class="badge ${advance.status === 'void' ? 'badge-danger' : 'badge-info'}">${escapeHtml(advance.status || 'open')}</span></td>
              <td>${escapeHtml(advance.reason || '')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderAttendanceLeaveList() {
  const wrap = document.getElementById('attendance-leave-list');
  if (!wrap) return;
  if (!attendanceState.leaves.length) {
    wrap.innerHTML = '<div class="empty-state"><h3>No leave requests</h3><p>Submitted leave requests will appear here.</p></div>';
    return;
  }
  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Date</th><th>User</th><th>Type</th><th>Status</th><th>Reason</th></tr></thead>
        <tbody>
          ${attendanceState.leaves.map((leave) => `
            <tr>
              <td>${escapeHtml(leave.leave_date_from || '')}${leave.leave_date_to && leave.leave_date_to !== leave.leave_date_from ? ` to ${escapeHtml(leave.leave_date_to)}` : ''}</td>
              <td>${escapeHtml(leave.full_name || App.user?.full_name || 'User')}</td>
              <td>${escapeHtml(leave.leave_type || 'Personal')}</td>
              <td><span class="badge ${leave.status === 'approved' ? 'badge-success' : leave.status === 'rejected' ? 'badge-danger' : 'badge-warning'}">${escapeHtml(leave.status || 'pending')}</span></td>
              <td>${escapeHtml(leave.reason || '')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function initCharts(page) {
  if (typeof Chart === 'undefined') return;

  Chart.defaults.font.family = "'DM Sans', sans-serif";
  Chart.defaults.color = '#94a3b8';

  if (page === 'home') {
    renderHomeOrderCharts();
  }

  if (page === 'data-report') {
    // Monthly bar chart
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthlyCOD = Array(12).fill(0);
    DB.orders.forEach(o => {
      const m = new Date(o.date).getMonth();
      monthlyCOD[m] += o.cod;
    });

    new Chart(document.getElementById('sales-bar-chart'), {
      type: 'bar',
      data: {
        labels: months,
        datasets: [{
          label: 'COD Revenue',
          data: monthlyCOD,
          backgroundColor: '#3b82f6',
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: '#f1f5f9' }, ticks: { callback: v => '₱'+v.toLocaleString() } },
          x: { grid: { display: false } }
        }
      }
    });

    // Status donut
    const statusCounts = {};
    DB.orders.forEach(o => { statusCounts[o.status] = (statusCounts[o.status]||0) + 1; });
    new Chart(document.getElementById('sales-donut-chart'), {
      type: 'doughnut',
      plugins: [doughnutPctPlugin],
      data: {
        labels: Object.keys(statusCounts),
        datasets: [{ data: Object.values(statusCounts), backgroundColor: ['#3b82f6','#10b981','#ef4444','#f59e0b','#6b7280'], borderWidth: 0 }]
      },
      options: { responsive:true, plugins: { legend: { position:'right' } }, cutout:'65%' }
    });
  }
}

// ─── PAGE INIT ─────────────────────────────────────────────
function initPage(page) {
  setTimeout(() => initCharts(page), 50);

  if (page === 'home') {
    const today = new Date().toISOString().split('T')[0];
    const homeDateFromInput = document.getElementById('home-date-from');
    const homeDateToInput = document.getElementById('home-date-to');
    if (homeDateFromInput && !homeDateFromInput.value) homeDateFromInput.value = today;
    if (homeDateToInput && !homeDateToInput.value) homeDateToInput.value = today;
    loadTimeClockStatus();
    loadHomeAnnouncements().catch(() => {});
    if (!DB.sheetRecordsForReport.length) {
      loadSheetRecordsForDataReport().then(() => { if (App.currentPage === 'home') loadPage('home'); }).catch(() => {});
    }
  }

  if (page === 'attendance') {
    initAttendancePage();
  }

  if (page === 'rts-rate') {
    const today = new Date().toISOString().split('T')[0];
    const dateFromInput = document.getElementById('rts-rate-date-from');
    const dateToInput = document.getElementById('rts-rate-date-to');
    if (dateFromInput && !dateFromInput.value) dateFromInput.value = today;
    if (dateToInput && !dateToInput.value) dateToInput.value = today;
    renderRTSRateDashboard();
    if (!DB.sheetRecordsForReport.length) {
      loadSheetRecordsForDataReport().then(() => { if (App.currentPage === 'rts-rate') renderRTSRateDashboard(); }).catch(() => {});
    }
  }

  if (page === 'data-report') {
    const today = new Date().toISOString().split('T')[0];
    const salesDateFromInput = document.getElementById('sales-date-from');
    const salesDateToInput = document.getElementById('sales-date-to');
    if (salesDateFromInput && !salesDateFromInput.value) salesDateFromInput.value = today;
    if (salesDateToInput && !salesDateToInput.value) salesDateToInput.value = today;
    renderRTSRateDashboard();
    if (!DB.sheetRecordsForReport.length) {
      loadSheetRecordsForDataReport().then(() => {
        if (App.currentPage === 'data-report') renderRTSRateDashboard();
      }).catch(() => {});
    }
    const firstLoad = dataReportMonths.length === 0;
    loadDataReportSummary().then(() => {
      if (App.currentPage !== 'data-report') return;
      if (firstLoad && dataReportMonths.length) loadPage('data-report');
      else renderDataReportDashboard();
    }).catch((error) => {
      showToast('warning', 'Data report load failed', error.message || 'Could not load report.');
      renderDataReportDashboard();
    });
    renderDataReportDashboard();
  }

  if (page === 'marketing-center') {
    syncMarketingPageMeta();
    if (!DB.sheetRecordsForReport.length) {
      loadSheetRecordsForDataReport().then(() => { if (App.currentPage === 'marketing-center') loadPage('marketing-center'); }).catch(() => {});
    }
    const refreshMarketingCenterEntries = () => loadMarketingEntries()
      .then(() => {
        if (App.currentPage !== 'marketing-center') return;
        document.getElementById('main-page-content').innerHTML = renderMarketingCenter();
        syncMarketingPageMeta();
      });
    const entriesPromise = !DB.marketingEntriesLoaded
      ? migrateLocalMarketingEntriesIfNeeded().then(refreshMarketingCenterEntries)
      : refreshMarketingCenterEntries();
    entriesPromise.catch(() => {});
  }

  if (page === 'adspend-roas') {
    loadMarketingEntries()
      .then(() => {
        if (App.currentPage !== 'adspend-roas') return;
        document.getElementById('main-page-content').innerHTML = renderAdspendRoas();
        loadAdspendAdsSummary().catch(() => {});
      })
      .catch(() => {});
    loadAdspendAdsSummary().catch(() => {});
  }

  if (page === 'csr') {
    resetCSRForm();
    const today = new Date().toISOString().split('T')[0];
    const dateFromInput = document.getElementById('csr-date-from');
    const dateToInput = document.getElementById('csr-date-to');
    if (dateFromInput && !dateFromInput.value) dateFromInput.value = today;
    if (dateToInput && !dateToInput.value) dateToInput.value = today;
    csrPage = 1;
    renderCSRTable();
    // CSR records are stored server-side so every authorized user sees the same
    // entries — refresh on each visit to pick up other members' new records.
    loadCsrAgentNames()
      .then(() => { if (App.currentPage === 'csr') renderCSRTable(); })
      .catch(() => {});
    loadCsrRecordsFromBackend({ force: true })
      .then(() => { if (App.currentPage === 'csr') renderCSRTable(); })
      .catch(() => {});
    // Google Orders power the Page Name dropdown and the Order ID auto-fill.
    if (!DB.sheetRecordsForReport.length) {
      loadSheetRecordsForDataReport().then(() => { if (App.currentPage === 'csr') loadPage('csr'); }).catch(() => {});
    }
  }

  if (page === 'expenses') {
    loadExpensesFromBackend().then(() => {
      if (App.currentPage !== 'expenses') return;
      document.getElementById('main-page-content').innerHTML = renderExpenses();
      loadExpenseCredits().catch(() => {});
    }).catch(() => {});
    loadExpenseCredits().catch(() => {});
  }

  if (page === 'rmo-management') {
    loadAssignableUsers().catch(() => {});
    refreshPosRawOrdersFromBackend()
      .then(renderPosOrdersTable)
      .catch((error) => {
        const tbody = document.getElementById('rec-pos-orders-tbody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--danger)">POS Orders load failed: ${escapeHtml(error.message || 'Request failed')}</td></tr>`;
      });
  }

  if (page === 'view-records') {
    // CSR Records tab is server-backed; pull the latest entries, then repaint.
    loadCsrRecordsFromBackend({ force: true })
      .then(() => { if (App.currentPage === 'view-records') refreshRecCsrTable(); })
      .catch(() => {});
    // CSR Records tab shows live status/tracking from pos_orders — ensure they
    // are loaded, then repaint the rows once available.
    if (!DB.sheetRecordsForReport.length) {
      loadSheetRecordsForDataReport()
        .then(() => { if (App.currentPage === 'view-records') refreshRecCsrTable(); })
        .catch(() => {});
    }
  }

  if (page === 'manage-users') {
    if (canManageAccounts()) loadManagedUsers();
  }

  if (page === 'api-connections') {
    renderPancakePagesTable();
    const hydrate = hydrateIntegrationStateFromBackend();
    if (hydrate && typeof hydrate.then === 'function') hydrate.then(() => renderPancakePagesTable()).catch(() => {});
    loadPosOwnerOptions();
  }

  if (page === 'hr') {
    initHRPage();
  }

  if (page === 'attendance-log') {
    initAttendanceLogPage();
  }

  if (page === 'schedule') {
    initSchedulePage();
  }

  if (page === 'inventory') {
    loadRtsReturnRecords().catch(() => {});
    loadStockHistory().catch(() => {});
    refreshRtsPcsByProduct()
      .then((ok) => {
        if (!ok || App.currentPage !== 'inventory') return;
        rerenderInventoryTables();
        refreshInventoryNamePicker();
      })
      .catch(() => {});
  }

  if (page === 'scanning' || page === 'rts-scanning') {
    const inputId = `scan-input-${page}`;
    const el = document.getElementById(inputId);
    if (el) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') performScan(page, page === 'rts-scanning' ? 'RTS' : 'Standard');
      });
      el.focus();
    }
    loadScanPreviewForPage(page, page === 'rts-scanning' ? 'RTS' : 'Standard').catch(() => {});
    loadScanToday(page, page === 'rts-scanning' ? 'RTS' : 'Standard').catch(() => {});
    loadScanPageSummary(page, page === 'rts-scanning' ? 'RTS' : 'Standard').catch(() => {});
  }
}

function renderManagedUsersTable() {
  const wrapper = document.getElementById('manage-users-table-wrap');
  if (!wrapper) return;

  if (!managedUsers.length) {
    wrapper.innerHTML = `
      <div class="empty-state">
        <h3>No active accounts found</h3>
        <p>Create accounts here as admin or restore them in the database if needed.</p>
      </div>`;
    return;
  }

  wrapper.innerHTML = `
    <table id="manage-users-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Username</th>
          <th>Role</th>
          <th>Created</th>
          <th>Updated</th>
          <th style="width:160px;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${managedUsers.map((user) => `
          <tr>
            <td>
              <div style="font-weight:600;">${escapeHtml(user.full_name)}</div>
              <div class="text-xs text-muted">${escapeHtml(user.email_address || user.phone_number || user.address || 'No owner details yet')}</div>
              <div class="text-xs text-muted">ID ${user.id}${App.user?.id === user.id ? ' • Signed in' : ''}</div>
            </td>
            <td class="font-mono text-sm">${escapeHtml(user.username)}</td>
            <td><span class="badge ${getUserRoleBadgeClass(user.role)}">${escapeHtml(formatRoleLabel(user.role))}</span></td>
            <td class="text-sm text-secondary">${escapeHtml(formatDateTime(user.created_at))}</td>
            <td class="text-sm text-secondary">${escapeHtml(formatDateTime(user.updated_at))}</td>
            <td>
              <div class="flex gap-2">
                <button class="btn btn-ghost btn-sm" onclick="openManageUserEditor(${user.id})">Edit</button>
                <button class="btn btn-danger btn-sm" onclick="deleteManagedUser(${user.id})" ${App.user?.id === user.id ? 'disabled' : ''}>Delete</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

async function loadManagedUsers() {
  const wrapper = document.getElementById('manage-users-table-wrap');
  if (wrapper) {
    wrapper.innerHTML = `
      <div class="empty-state">
        <h3>Loading accounts</h3>
        <p>Pulling the latest user list from the server.</p>
      </div>`;
  }

  try {
    const data = await authorizedJsonRequest('/auth/users');
    managedUsers = Array.isArray(data?.users) ? data.users : [];
    renderManagedUsersTable();
  } catch (error) {
    if (wrapper) {
      wrapper.innerHTML = `
        <div class="empty-state">
          <h3>Could not load accounts</h3>
          <p>${escapeHtml(error.message || 'The user list is unavailable right now.')}</p>
        </div>`;
    }
    showToast('error', 'Load failed', error.message || 'Could not load user accounts.');
  }
}

function formatPHP(value) {
  return `PHP ${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatMinutes(value) {
  const minutes = Math.max(0, Number(value || 0));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours ? `${hours}h ${mins}m` : `${mins}m`;
}

function getHRFilters() {
  const today = normalizeDateString(new Date());
  return {
    from: document.getElementById('hr-date-from')?.value || today,
    to: document.getElementById('hr-date-to')?.value || today,
    userId: document.getElementById('hr-user-filter')?.value || '',
  };
}

function populateHRUserSelects() {
  const options = [
    '<option value="">All users</option>',
    ...hrState.users.map((user) => `<option value="${user.id}">${escapeHtml(user.full_name)} (${escapeHtml(formatRoleLabel(user.role))})</option>`),
  ].join('');
  const filter = document.getElementById('hr-user-filter');
  if (filter && !filter.dataset.ready) {
    filter.innerHTML = options;
    filter.dataset.ready = '1';
  }
  const userOptions = hrState.users.map((user) => `<option value="${user.id}">${escapeHtml(user.full_name)}</option>`).join('');
  const cashSelect = document.getElementById('cash-advance-user');
  if (cashSelect) cashSelect.innerHTML = userOptions;
  const scheduleUserSelect = document.getElementById('schedule-user');
  if (scheduleUserSelect) scheduleUserSelect.innerHTML = userOptions;
}

async function initHRPage() {
  if (!canManageHR()) {
    const wrap = document.getElementById('hr-payroll-table-wrap');
    if (wrap) wrap.innerHTML = '<div class="empty-state"><h3>HR access required</h3><p>Your account can only use the Home time clock.</p></div>';
    return;
  }

  try {
    const data = await authorizedJsonRequest('/auth/users');
    hrState.users = Array.isArray(data?.users) ? data.users : [];
    populateHRUserSelects();
  } catch (error) {
    showToast('error', 'Users unavailable', error.message || 'Could not load HR users.');
  }
  await loadHRDashboard();
}

// Attendance edits live on both the HR/Payroll page and the Attendance Log page.
// Refresh whichever view is currently open so the table + summary stay in sync.
function refreshHRViews() {
  if (App.currentPage === 'attendance-log') return loadAttendanceLogDashboard();
  return loadHRDashboard();
}

// ─── ATTENDANCE LOG PAGE (summary + daily log, own nav button) ──────
function renderAttendanceLog() {
  const today = normalizeDateString(new Date());
  const monthStart = today.slice(0, 8) + '01';
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Attendance Log</h1>
      <p>All-user salary summary and the daily time records for a custom date range.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="loadAttendanceLogDashboard()">Refresh</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px;">
    <div class="card-body">
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">From</label>
          <input type="date" id="al-date-from" class="form-control" value="${monthStart}">
        </div>
        <div class="form-group">
          <label class="form-label">To</label>
          <input type="date" id="al-date-to" class="form-control" value="${today}">
        </div>
        <div class="form-group">
          <label class="form-label">User</label>
          <select id="al-user-filter" class="form-control">
            <option value="">All users</option>
          </select>
        </div>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;">
        <button class="btn btn-primary" onclick="loadAttendanceLogDashboard()">Apply</button>
      </div>
    </div>
  </div>

  <div class="tabs" style="margin-bottom:16px;">
    <button class="tab-btn active" onclick="switchTab(this,'al-tab-log')">Attendance Log</button>
    <button class="tab-btn" onclick="switchTab(this,'al-tab-announcements'); loadHRAnnouncements();">Announcements</button>
    <button class="tab-btn" onclick="switchTab(this,'al-tab-ot'); loadHRPendingOT();">Overtime Approvals</button>
  </div>

  <div id="al-tab-log" class="tab-content active">
    <div class="card">
      <div class="card-header"><div><div class="card-title">Attendance Log</div><div class="card-subtitle">Click any row to edit. Days under 4 hrs do not count toward salary.</div></div></div>
      <div class="card-body" id="al-attendance-wrap">
        <div class="empty-state"><h3>Loading attendance</h3><p>Pulling user time records.</p></div>
      </div>
    </div>
  </div>

  <div id="al-tab-announcements" class="tab-content">
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Announcements</div><div class="card-subtitle">Posts here appear on every user's Home page.</div></div>
        <button class="btn btn-ghost btn-sm" onclick="loadHRAnnouncements()">Refresh</button>
      </div>
      <div class="card-body">
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Title</label>
            <input type="text" class="form-control" id="hr-announce-title" placeholder="e.g. Holiday schedule update">
          </div>
          <div class="form-group">
            <label class="form-label">Expires On (optional)</label>
            <input type="date" class="form-control" id="hr-announce-expires">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Message</label>
          <textarea class="form-control" id="hr-announce-body" rows="3" placeholder="Write the announcement details..."></textarea>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-primary" onclick="submitHRAnnouncement()">Post Announcement</button>
          <button class="btn btn-secondary" onclick="clearHRAnnouncementForm()">Clear</button>
        </div>
        <div id="hr-announcement-list" style="margin-top:16px;display:grid;gap:8px;"></div>
      </div>
    </div>
  </div>

  <div id="al-tab-ot" class="tab-content">
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Overtime Approvals</div><div class="card-subtitle">Approved hours count toward pay. Pending and rejected do not.</div></div>
        <button class="btn btn-ghost btn-sm" onclick="loadHRPendingOT()">Refresh</button>
      </div>
      <div class="card-body" id="hr-ot-request-list">
        <div style="color:var(--text-muted);font-size:13px;">Loading OT requests...</div>
      </div>
    </div>
  </div>

  <!-- Edit Attendance Modal -->
  <div class="modal-overlay" id="edit-attendance-modal">
    <div class="modal" style="max-width:500px;">
      <div class="modal-header">
        <div>
          <div class="modal-title" id="att-modal-title">Edit Attendance</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;" id="att-modal-subtitle"></div>
        </div>
        <button class="modal-close" onclick="closeModal('edit-attendance-modal')">×</button>
      </div>
      <div class="modal-body">
        <input type="hidden" id="att-modal-record-id">
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Time In</label>
            <input type="time" id="att-modal-time-in" class="form-control">
          </div>
          <div class="form-group">
            <label class="form-label">Time Out</label>
            <input type="time" id="att-modal-time-out" class="form-control">
          </div>
          <div class="form-group">
            <label class="form-label">Break Out</label>
            <input type="time" id="att-modal-break-out" class="form-control">
          </div>
          <div class="form-group">
            <label class="form-label">Break In</label>
            <input type="time" id="att-modal-break-in" class="form-control">
          </div>
          <div class="form-group">
            <label class="form-label">15-min Out</label>
            <input type="time" id="att-modal-break2-out" class="form-control">
          </div>
          <div class="form-group">
            <label class="form-label">15-min In</label>
            <input type="time" id="att-modal-break2-in" class="form-control">
          </div>
          <div class="form-group">
            <label class="form-label">OT (minutes)</label>
            <input type="number" min="0" id="att-modal-ot-minutes" class="form-control" placeholder="0">
          </div>
          <div class="form-group">
            <label class="form-label">Holiday %</label>
            <select id="att-modal-holiday-pct" class="form-control">
              <option value="100">100 — Regular day</option>
              <option value="125">125 — Special Holiday</option>
              <option value="150">150 — Regular Holiday</option>
              <option value="200">200 — Double pay</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Notes</label>
          <textarea id="att-modal-notes" class="form-control" rows="2" placeholder="Optional note"></textarea>
        </div>
        <div style="display:flex;gap:8px;margin-top:4px;">
          <button class="btn btn-primary" style="flex:1;" onclick="saveAttendanceFromModal()">Save Changes</button>
          <button class="btn btn-secondary" onclick="closeModal('edit-attendance-modal')">Cancel</button>
          <button class="btn btn-ghost" style="color:var(--error-color,#dc2626);" onclick="deleteAttendanceFromModal()">Delete</button>
        </div>
      </div>
    </div>
  </div>`;
}

function getAttendanceLogFilters() {
  const today = normalizeDateString(new Date());
  return {
    from: document.getElementById('al-date-from')?.value || today,
    to: document.getElementById('al-date-to')?.value || today,
    userId: document.getElementById('al-user-filter')?.value || '',
  };
}

async function initAttendanceLogPage() {
  if (!canManageHR()) {
    const wrap = document.getElementById('al-attendance-wrap');
    if (wrap) wrap.innerHTML = '<div class="empty-state"><h3>HR access required</h3><p>Your account cannot view the attendance log.</p></div>';
    return;
  }
  try {
    if (!hrState.users.length) {
      const data = await authorizedJsonRequest('/auth/users');
      hrState.users = Array.isArray(data?.users) ? data.users : [];
    }
    const filter = document.getElementById('al-user-filter');
    if (filter && !filter.dataset.ready) {
      filter.innerHTML = [
        '<option value="">All users</option>',
        ...hrState.users.map((u) => `<option value="${u.id}">${escapeHtml(u.full_name)} (${escapeHtml(formatRoleLabel(u.role))})</option>`),
      ].join('');
      filter.dataset.ready = '1';
    }
  } catch (error) {
    showToast('error', 'Users unavailable', error.message || 'Could not load users.');
  }
  await loadAttendanceLogDashboard();
  loadHRAnnouncements().catch(() => {});
  loadHRPendingOT().catch(() => {});
}

async function loadAttendanceLogDashboard() {
  if (!canManageHR()) return;
  const { from, to, userId } = getAttendanceLogFilters();
  const query = new URLSearchParams({ from, to, _: Date.now().toString() });
  if (userId) query.set('user_id', userId);

  // Schedules need the full date range without user filter so we can look up any user's schedule
  const scheduleQuery = new URLSearchParams({ from, to });
  if (userId) scheduleQuery.set('user_id', userId);

  try {
    const [attendanceData, scheduleData] = await Promise.all([
      authorizedJsonRequest(`/hr/attendance?${query.toString()}`),
      authorizedJsonRequest(`/hr/schedules?${scheduleQuery.toString()}`).catch(() => ({ schedules: [] })),
    ]);
    hrState.attendance = Array.isArray(attendanceData?.records) ? attendanceData.records : [];

    // Build lookup: "userId|date" → schedule row
    hrState.scheduleMap = {};
    for (const s of (scheduleData?.schedules || [])) {
      hrState.scheduleMap[`${s.user_id}|${s.schedule_date}`] = s;
    }

    renderHRAttendanceTable('al-attendance-wrap');
  } catch (error) {
    showToast('error', 'Attendance log failed', error.message || 'Could not load attendance log.');
  }
}

function renderAttendanceLogSummary() {
  const wrap = document.getElementById('al-summary-wrap');
  if (!wrap) return;
  if (!hrState.summary.length) {
    wrap.innerHTML = '<div class="empty-state"><h3>No records</h3><p>No attendance in this period yet.</p></div>';
    return;
  }

  const totals = hrState.summary.reduce((acc, item) => {
    acc.days += Number(item.days_worked || 0);
    acc.ot += Number(item.ot_minutes || 0);
    acc.holiday += Number(item.holiday_pay || 0);
    acc.cash += Number(item.cash_advances || 0);
    acc.net += Number(item.net_pay || 0);
    return acc;
  }, { days: 0, ot: 0, holiday: 0, cash: 0, net: 0 });

  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Name</th><th>Total Work Days</th><th>OT</th><th>Holiday</th><th>Cash Advance</th><th>Total Salary</th></tr></thead>
        <tbody>
          ${hrState.summary.map((item) => {
            const user = item.user || {};
            return `
              <tr>
                <td><strong>${escapeHtml(user.full_name || user.username || 'User')}</strong><div class="text-xs text-muted">${escapeHtml(formatRoleLabel(user.role))}</div></td>
                <td>${Number(item.days_worked || 0)}</td>
                <td>${formatMinutes(item.ot_minutes)}</td>
                <td>${formatPHP(item.holiday_pay)}</td>
                <td>${formatPHP(item.cash_advances)}</td>
                <td><strong>${formatPHP(item.net_pay)}</strong></td>
              </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr style="border-top:2px solid var(--border, #e5e7eb);font-weight:700;">
            <td>TOTAL</td>
            <td>${totals.days}</td>
            <td>${formatMinutes(totals.ot)}</td>
            <td>${formatPHP(totals.holiday)}</td>
            <td>${formatPHP(totals.cash)}</td>
            <td>${formatPHP(totals.net)}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
}

async function loadHRDashboard() {
  if (!canManageHR()) return;
  const { from, to, userId } = getHRFilters();
  const query = new URLSearchParams({ from, to, _: Date.now().toString() });
  if (userId) query.set('user_id', userId);

  try {
    const [summaryData, attendanceData, advancesData] = await Promise.all([
      authorizedJsonRequest(`/hr/summary?${query.toString()}`),
      authorizedJsonRequest(`/hr/attendance?${query.toString()}`),
      authorizedJsonRequest(`/hr/cash-advances?${query.toString()}`),
    ]);
    hrState.summary = Array.isArray(summaryData?.summary) ? summaryData.summary : [];
    hrState.attendance = Array.isArray(attendanceData?.records) ? attendanceData.records : [];
    hrState.advances = Array.isArray(advancesData?.advances) ? advancesData.advances : [];
    renderHRSummary();
    renderHRPayrollTable();
    renderHRAttendanceTable();
  } catch (error) {
    showToast('error', 'HR load failed', error.message || 'Could not load HR records.');
  }
}

function renderHRSummary() {
  const wrap = document.getElementById('hr-summary-wrap');
  if (!wrap) return;
  const totals = hrState.summary.reduce((acc, item) => {
    acc.days += Number(item.days_worked || 0);
    acc.ot += Number(item.ot_minutes || 0);
    acc.cash += Number(item.cash_advances || 0);
    acc.net += Number(item.net_pay || 0);
    return acc;
  }, { days: 0, ot: 0, cash: 0, net: 0 });

  wrap.innerHTML = `
    <div class="stat-card blue"><div class="stat-label">Work Days</div><div class="stat-value">${totals.days}</div></div>
    <div class="stat-card amber"><div class="stat-label">OT Time</div><div class="stat-value">${formatMinutes(totals.ot)}</div></div>
    <div class="stat-card red"><div class="stat-label">Cash Advances</div><div class="stat-value">${formatPHP(totals.cash)}</div></div>
    <div class="stat-card green"><div class="stat-label">Net Pay</div><div class="stat-value">${formatPHP(totals.net)}</div></div>`;
}

function renderHRPayrollTable() {
  const wrap = document.getElementById('hr-payroll-table-wrap');
  if (!wrap) return;
  if (!hrState.summary.length) {
    wrap.innerHTML = '<div class="empty-state"><h3>No payroll records</h3><p>No attendance in this period yet.</p></div>';
    return;
  }

  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>User</th><th>Rate / Day</th><th>Days</th><th>OT</th><th>Holiday</th><th>Cash Adv.</th><th>Net Pay</th></tr></thead>
        <tbody>
          ${hrState.summary.map((item) => {
            const user = item.user || {};
            return `
              <tr onclick="openPayrollEditModal(${user.id})" style="cursor:pointer;" title="Click to edit daily rate">
                <td><strong>${escapeHtml(user.full_name || user.username || 'User')}</strong><div class="text-xs text-muted">${escapeHtml(formatRoleLabel(user.role))}</div></td>
                <td><strong>${formatPHP(user.daily_rate)}</strong></td>
                <td>${Number(item.days_worked || 0)}</td>
                <td>${formatMinutes(item.ot_minutes)}</td>
                <td>${formatPHP(item.holiday_pay)}</td>
                <td>${formatPHP(item.cash_advances)}</td>
                <td><strong>${formatPHP(item.net_pay)}</strong></td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderHRAttendanceTable(containerId = 'hr-attendance-table-wrap') {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  if (!hrState.attendance.length) {
    wrap.innerHTML = '<div class="empty-state"><h3>No attendance logs</h3><p>Users can create records from the Home time clock.</p></div>';
    return;
  }

  const timeTxt = (v) => v ? escapeHtml(v) : '<span style="color:var(--text-muted)">—</span>';
  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="data-table" style="cursor:pointer;">
        <thead><tr><th>Date</th><th>User</th><th>Time In</th><th>Break Out</th><th>Break In</th><th>Time Out</th><th>Work Hours</th><th>OT</th><th>Daily Salary</th></tr></thead>
        <tbody>
          ${hrState.attendance.map((record) => {
            const workedMins = Number(record.worked_minutes || 0);
            const otMins = Number(record.calculated_ot_minutes || record.ot_minutes || 0);
            const qualifies = workedMins >= 240;
            const holidayPct = Number(record.holiday_percentage || 100);
            const dailyRate = Number(record.daily_rate || 0);
            const dailySalary = qualifies ? dailyRate * (holidayPct / 100) : 0;

            // Schedule lookup for this user + date
            const sched = (hrState.scheduleMap || {})[`${record.user_id}|${record.work_date}`] || null;
            let scheduleHtml = '';
            if (sched) {
              const shiftLabel = sched.shift_start
                ? escapeHtml(sched.shift_start) + (sched.shift_end ? ' – ' + escapeHtml(sched.shift_end) : '')
                : (sched.notes ? '' : '—');
              const statusInfo = (() => {
                if (!sched.shift_start) return { label: sched.notes ? 'Scheduled' : '', color: '#6b7280', bg: 'transparent' };
                const toMin = (t) => { const m = String(t||'').match(/^(\d{1,2}):(\d{2})/); return m ? +m[1]*60 + +m[2] : null; };
                const shiftMin = toMin(sched.shift_start);
                const clockMin = toMin(record.time_in);
                if (clockMin !== null && shiftMin !== null && clockMin > shiftMin) {
                  const late = clockMin - shiftMin;
                  return { label: `Late ${late}m`, color: '#b45309', bg: '#fef3c7' };
                }
                return { label: 'On Time', color: '#16a34a', bg: '#dcfce7' };
              })();
              const holidayTag = sched.is_holiday
                ? `<span style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;color:#7c3aed;background:#ede9fe;">${escapeHtml(sched.holiday_type || 'Holiday')}${sched.holiday_percentage ? ` +${sched.holiday_percentage}%` : ''}</span>`
                : '';
              scheduleHtml = `<div style="margin-top:3px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                ${shiftLabel ? `<span style="font-size:11px;color:var(--text-muted);">${shiftLabel}</span>` : ''}
                ${statusInfo.label ? `<span style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;color:${statusInfo.color};background:${statusInfo.bg};">${statusInfo.label}</span>` : ''}
                ${holidayTag}
                ${sched.notes ? `<span style="font-size:10px;color:var(--text-muted);font-style:italic;">${escapeHtml(sched.notes)}</span>` : ''}
              </div>`;
            }

            return `
            <tr onclick="openAttendanceEditModal(${record.id})" style="cursor:pointer;" title="Click to edit">
              <td><strong>${escapeHtml(record.work_date || '')}</strong></td>
              <td>${escapeHtml(record.full_name || '')}${scheduleHtml}</td>
              <td>${timeTxt(record.time_in)}</td>
              <td>${timeTxt(record.break_out)}</td>
              <td>${timeTxt(record.break_in)}</td>
              <td>${timeTxt(record.time_out)}</td>
              <td>${workedMins ? `<span class="${qualifies ? '' : 'text-muted'}">${formatMinutes(workedMins)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
              <td>${otMins > 0 ? `<span class="badge badge-warning">${formatMinutes(otMins)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
              <td><strong>${qualifies ? formatPHP(dailySalary) : '<span class="text-muted text-xs">< 4 hrs</span>'}</strong></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function openPayrollEditModal(userId) {
  const item = (hrState.summary || []).find((s) => Number(s.user?.id) === Number(userId));
  if (!item) return;
  const user = item.user || {};
  document.getElementById('payroll-modal-user-id').value = userId;
  document.getElementById('payroll-modal-title').textContent = user.full_name || user.username || 'User';
  document.getElementById('payroll-modal-role').textContent = formatRoleLabel(user.role);
  document.getElementById('payroll-modal-rate').value = Number(user.daily_rate || 0);
  openModal('payroll-edit-modal');
}

async function savePayrollRate() {
  const userId = Number(document.getElementById('payroll-modal-user-id')?.value || 0);
  const dailyRate = Number(document.getElementById('payroll-modal-rate')?.value || 0);
  if (!userId) return;
  try {
    await authorizedJsonRequest(`/hr/users/${userId}/rate`, {
      method: 'PATCH',
      body: JSON.stringify({ daily_rate: dailyRate }),
    });
    closeModal('payroll-edit-modal');
    showToast('success', 'Rate saved', 'Daily rate was updated.');
    await loadHRDashboard();
  } catch (error) {
    showToast('error', 'Rate failed', error.message || 'Could not update rate.');
  }
}

function printPayslipFromModal() {
  const userId = Number(document.getElementById('payroll-modal-user-id')?.value || 0);
  if (userId) printPayslip(userId);
}

function openAttendanceEditModal(recordId) {
  const record = (hrState.attendance || []).find((r) => Number(r.id) === Number(recordId));
  if (!record) return;
  document.getElementById('att-modal-record-id').value = recordId;
  document.getElementById('att-modal-title').textContent = `Edit — ${record.full_name || 'User'}`;
  document.getElementById('att-modal-subtitle').textContent = record.work_date || '';
  document.getElementById('att-modal-time-in').value = record.time_in || '';
  document.getElementById('att-modal-time-out').value = record.time_out || '';
  document.getElementById('att-modal-break-out').value = record.break_out || '';
  document.getElementById('att-modal-break-in').value = record.break_in || '';
  document.getElementById('att-modal-break2-out').value = record.break2_out || '';
  document.getElementById('att-modal-break2-in').value = record.break2_in || '';
  document.getElementById('att-modal-ot-minutes').value = record.ot_minutes || 0;
  const pctSelect = document.getElementById('att-modal-holiday-pct');
  const pct = String(Number(record.holiday_percentage || 100));
  if ([...pctSelect.options].some((o) => o.value === pct)) pctSelect.value = pct;
  else pctSelect.value = '100';
  document.getElementById('att-modal-notes').value = record.notes || '';
  openModal('edit-attendance-modal');
}

async function saveAttendanceFromModal() {
  const recordId = Number(document.getElementById('att-modal-record-id')?.value || 0);
  if (!recordId) return;
  const record = (hrState.attendance || []).find((r) => Number(r.id) === recordId);
  if (!record) return;
  const holidayPercentage = Math.max(100, Number(document.getElementById('att-modal-holiday-pct')?.value || 100));
  try {
    await authorizedJsonRequest(`/hr/attendance/${recordId}`, {
      method: 'PUT',
      body: JSON.stringify({
        time_in: document.getElementById('att-modal-time-in')?.value || '',
        break_out: document.getElementById('att-modal-break-out')?.value || '',
        break_in: document.getElementById('att-modal-break-in')?.value || '',
        break2_out: document.getElementById('att-modal-break2-out')?.value || '',
        break2_in: document.getElementById('att-modal-break2-in')?.value || '',
        time_out: document.getElementById('att-modal-time-out')?.value || '',
        break_minutes: Number(record.break_minutes || 0),
        ot_minutes: Math.max(0, Number(document.getElementById('att-modal-ot-minutes')?.value || 0)),
        holiday_type: holidayPercentage > 100 ? (record.holiday_type || 'Holiday') : 'Regular day',
        holiday_percentage: holidayPercentage,
        notes: document.getElementById('att-modal-notes')?.value || '',
      }),
    });
    closeModal('edit-attendance-modal');
    showToast('success', 'Attendance saved', 'Attendance record was updated.');
    await refreshHRViews();
  } catch (error) {
    showToast('error', 'Attendance failed', error.message || 'Could not save attendance.');
  }
}

async function deleteAttendanceFromModal() {
  const recordId = Number(document.getElementById('att-modal-record-id')?.value || 0);
  if (!recordId) return;
  const record = (hrState.attendance || []).find((r) => Number(r.id) === recordId);
  const who = record ? `${record.full_name || 'user'} on ${record.work_date}` : `record #${recordId}`;
  if (!window.confirm(`Delete attendance for ${who}? This cannot be undone.`)) return;
  try {
    await authorizedJsonRequest(`/hr/attendance/${recordId}`, { method: 'DELETE' });
    closeModal('edit-attendance-modal');
    showToast('success', 'Attendance deleted', 'The attendance record was removed.');
    await refreshHRViews();
  } catch (error) {
    showToast('error', 'Delete failed', error.message || 'Could not delete attendance.');
  }
}

// ─── SCHEDULE PAGE ─────────────────────────────────────────
function renderSchedulePage() {
  const today = new Date().toLocaleDateString('en-CA');
  return `
    <div class="page-header">
      <div>
        <h1>Schedule</h1>
        <p class="page-subtitle">Staff daily schedules</p>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px;padding:16px 20px;">
      <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
        <div>
          <label class="form-label" style="display:block;margin-bottom:4px;font-size:12px;font-weight:600;">From</label>
          <input type="date" id="sched-page-from" class="form-control" value="${today}" style="width:160px;">
        </div>
        <div>
          <label class="form-label" style="display:block;margin-bottom:4px;font-size:12px;font-weight:600;">To</label>
          <input type="date" id="sched-page-to" class="form-control" value="${today}" style="width:160px;">
        </div>
        <div>
          <label class="form-label" style="display:block;margin-bottom:4px;font-size:12px;font-weight:600;">User</label>
          <select id="sched-page-user" class="form-control" style="min-width:200px;">
            <option value="">All Users</option>
          </select>
        </div>
        <button class="btn btn-secondary" onclick="loadSchedulePageData()" style="margin-bottom:1px;">Apply</button>
      </div>
    </div>
    <div class="card">
      <div id="sched-page-table-wrap">
        <div class="empty-state"><p>Loading schedules...</p></div>
      </div>
    </div>`;
}

async function initSchedulePage() {
  const today = new Date().toLocaleDateString('en-CA');
  const fromEl = document.getElementById('sched-page-from');
  const toEl = document.getElementById('sched-page-to');
  if (fromEl) fromEl.value = today;
  if (toEl) toEl.value = today;

  const select = document.getElementById('sched-page-user');
  if (select && canManageHR()) {
    try {
      let users = hrState.users.length ? hrState.users : null;
      if (!users) {
        const data = await authorizedJsonRequest('/auth/users');
        users = Array.isArray(data?.users) ? data.users : [];
      }
      users.forEach((u) => {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.full_name || u.username || '';
        select.appendChild(opt);
      });
    } catch (e) {}
  }

  loadSchedulePageData();
}

async function loadSchedulePageData() {
  const wrap = document.getElementById('sched-page-table-wrap');
  if (!wrap) return;
  const today = new Date().toLocaleDateString('en-CA');
  const from = document.getElementById('sched-page-from')?.value || today;
  const to = document.getElementById('sched-page-to')?.value || today;
  const userId = document.getElementById('sched-page-user')?.value || '';
  wrap.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  try {
    let url = `/hr/schedules?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    if (userId) url += `&user_id=${encodeURIComponent(userId)}`;
    const data = await authorizedJsonRequest(url);
    renderSchedulePageTable(data.schedules || []);
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">Failed to load: ${escapeHtml(e.message || 'Request failed')}</p></div>`;
  }
}

function renderSchedulePageTable(schedules) {
  const wrap = document.getElementById('sched-page-table-wrap');
  if (!wrap) return;
  if (!schedules.length) {
    wrap.innerHTML = '<div class="empty-state"><h3>No schedules</h3><p>No schedules found for the selected date and user.</p></div>';
    return;
  }
  const statusBadge = (s) => {
    const map = {
      'on-time': ['On Time', '#16a34a', '#dcfce7'],
      late: [`Late${s.minutes_late ? ` ${s.minutes_late}m` : ''}`, '#b45309', '#fef3c7'],
      absent: ['Absent', '#dc2626', '#fee2e2'],
      upcoming: ['Upcoming', '#6b7280', '#f3f4f6'],
      present: ['Present', '#2563eb', '#dbeafe'],
    };
    const [label, color, bg] = map[s.status] || ['—', '', ''];
    return label !== '—'
      ? `<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;color:${color};background:${bg};">${label}</span>`
      : '<span style="color:var(--text-muted)">—</span>';
  };
  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          <th>Date</th><th>User</th><th>Shift</th><th>Status</th><th>Holiday</th><th>Notes</th>
        </tr></thead>
        <tbody>
          ${schedules.map((s) => {
            const shiftLabel = s.shift_start
              ? escapeHtml(s.shift_start) + (s.shift_end ? ' – ' + escapeHtml(s.shift_end) : '')
              : '<span style="color:var(--text-muted)">—</span>';
            const holidayHtml = s.is_holiday
              ? `<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;color:#7c3aed;background:#ede9fe;">${escapeHtml(s.holiday_type || 'Holiday')}${s.holiday_percentage ? ` +${s.holiday_percentage}%` : ''}</span>`
              : '<span style="color:var(--text-muted)">—</span>';
            return `<tr>
              <td><strong>${escapeHtml(s.schedule_date || '')}</strong></td>
              <td>${escapeHtml(s.full_name || s.username || '')}</td>
              <td>${shiftLabel}</td>
              <td>${statusBadge(s)}</td>
              <td>${holidayHtml}</td>
              <td>${s.notes ? `<span style="font-size:12px;color:var(--text-muted);">${escapeHtml(s.notes)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function openScheduleModal() {
  populateHRUserSelects();
  openModal('schedule-modal');
  loadUserSchedules();
}

async function loadUserSchedules() {
  const wrap = document.getElementById('schedule-list');
  if (!wrap) return;
  const userId = document.getElementById('schedule-user')?.value;
  if (!userId) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Loading...</div>';
  try {
    const today = normalizeDateString(new Date());
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const from = normalizeDateString(monthAgo);
    const params = new URLSearchParams({ user_id: userId, from, to: today });
    const data = await authorizedJsonRequest(`/hr/schedules?${params}`);
    const rows = data?.schedules || [];
    if (!rows.length) {
      wrap.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:12px 0;">No schedules found for this user.</div>';
      return;
    }
    function scheduleStatusBadge(r) {
      const map = {
        'on-time':  { label: 'On Time',  color: '#16a34a', bg: '#dcfce7' },
        'late':     { label: r.minutes_late ? `Late ${r.minutes_late}m` : 'Late', color: '#b45309', bg: '#fef3c7' },
        'absent':   { label: 'Absent',   color: '#dc2626', bg: '#fee2e2' },
        'present':  { label: 'Present',  color: '#16a34a', bg: '#dcfce7' },
        'upcoming': { label: 'Upcoming', color: '#6b7280', bg: '#f3f4f6' },
        'no-schedule': { label: '—',     color: '#6b7280', bg: 'transparent' },
      };
      const s = map[r.status] || map['no-schedule'];
      const holidayBadge = r.is_holiday
        ? `<span style="display:inline-block;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:600;color:#7c3aed;background:#ede9fe;margin-left:4px;">${escapeHtml(r.holiday_type || 'Holiday')}${r.holiday_percentage ? ` +${r.holiday_percentage}%` : ''}</span>`
        : '';
      return `<span style="display:inline-block;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:600;color:${s.color};background:${s.bg};">${s.label}</span>${holidayBadge}`;
    }
    wrap.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px;">Recent schedules (last 30 days)</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:1px solid var(--border-color);">
            <th style="padding:6px 8px;text-align:left;">Date</th>
            <th style="padding:6px 8px;text-align:left;">Shift</th>
            <th style="padding:6px 8px;text-align:left;">Status</th>
            <th style="padding:6px 8px;text-align:left;">Clock In</th>
            <th style="padding:6px 8px;text-align:left;">Notes</th>
            <th style="padding:6px 8px;width:36px;"></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr style="border-bottom:1px solid var(--border-color);">
              <td style="padding:6px 8px;white-space:nowrap;">${escapeHtml(r.schedule_date || '')}</td>
              <td style="padding:6px 8px;white-space:nowrap;">${r.shift_start ? escapeHtml(r.shift_start) + (r.shift_end ? ' – ' + escapeHtml(r.shift_end) : '') : '—'}</td>
              <td style="padding:6px 8px;">${scheduleStatusBadge(r)}</td>
              <td style="padding:6px 8px;color:var(--text-muted);white-space:nowrap;">${r.time_in ? escapeHtml(r.time_in) : '—'}</td>
              <td style="padding:6px 8px;color:var(--text-muted);">${escapeHtml(r.notes || '')}</td>
              <td style="padding:6px 8px;">
                <button class="btn btn-ghost btn-sm" style="color:var(--error-color);padding:2px 6px;" onclick="deleteUserSchedule(${r.id})">×</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (error) {
    wrap.innerHTML = `<div style="color:var(--error-color);font-size:13px;">${escapeHtml(error.message)}</div>`;
  }
}

function toggleScheduleHoliday() {
  const checked = document.getElementById('schedule-is-holiday')?.checked;
  const opts = document.getElementById('schedule-holiday-options');
  if (opts) opts.style.display = checked ? '' : 'none';
  if (checked) selectSchedulePct(30);
}

function selectSchedulePct(pct) {
  document.getElementById('schedule-holiday-percentage').value = pct;
  [30, 50, 100].forEach((v) => {
    const btn = document.getElementById(`sched-pct-${v}`);
    if (btn) btn.className = `btn btn-sm ${v === pct ? 'btn-primary' : 'btn-secondary'}`;
  });
}

async function createUserSchedule(event) {
  event.preventDefault();
  const isHoliday = document.getElementById('schedule-is-holiday')?.checked || false;
  const holidayType = isHoliday ? (document.getElementById('schedule-holiday-type')?.value || 'Special Holiday') : 'Regular day';
  const holidayPercentage = isHoliday ? Number(document.getElementById('schedule-holiday-percentage')?.value || 30) : 0;
  try {
    await authorizedJsonRequest('/hr/schedules', {
      method: 'POST',
      body: JSON.stringify({
        user_id: Number(document.getElementById('schedule-user')?.value || 0),
        schedule_date: document.getElementById('schedule-date')?.value,
        shift_start: document.getElementById('schedule-shift-start')?.value || null,
        shift_end: document.getElementById('schedule-shift-end')?.value || null,
        notes: document.getElementById('schedule-notes')?.value || '',
        is_holiday: isHoliday,
        holiday_type: holidayType,
        holiday_percentage: holidayPercentage,
      }),
    });
    document.getElementById('schedule-shift-start').value = '';
    document.getElementById('schedule-shift-end').value = '';
    document.getElementById('schedule-notes').value = '';
    const cb = document.getElementById('schedule-is-holiday');
    if (cb) { cb.checked = false; toggleScheduleHoliday(); }
    showToast('success', 'Schedule added', 'Daily schedule entry was saved.');
    await loadUserSchedules();
  } catch (error) {
    showToast('error', 'Schedule failed', error.message || 'Could not save schedule.');
  }
}

async function deleteUserSchedule(id) {
  try {
    await authorizedJsonRequest(`/hr/schedules/${id}`, { method: 'DELETE' });
    showToast('success', 'Deleted', 'Schedule entry removed.');
    await loadUserSchedules();
  } catch (error) {
    showToast('error', 'Delete failed', error.message || 'Could not delete schedule.');
  }
}

async function createCashAdvance(event) {
  event.preventDefault();
  try {
    await authorizedJsonRequest('/hr/cash-advances', {
      method: 'POST',
      body: JSON.stringify({
        user_id: Number(document.getElementById('cash-advance-user')?.value || 0),
        advance_date: document.getElementById('cash-advance-date')?.value,
        amount: Number(document.getElementById('cash-advance-amount')?.value || 0),
        reason: document.getElementById('cash-advance-reason')?.value || '',
      }),
    });
    const amount = document.getElementById('cash-advance-amount');
    const reason = document.getElementById('cash-advance-reason');
    if (amount) amount.value = '';
    if (reason) reason.value = '';
    closeModal('cash-advance-modal');
    showToast('success', 'Cash advance saved', 'Payroll deduction was recorded.');
    await loadHRDashboard();
  } catch (error) {
    showToast('error', 'Cash advance failed', error.message || 'Could not save cash advance.');
  }
}

function printSelectedPayslip() {
  const selected = document.getElementById('hr-user-filter')?.value;
  const firstUser = hrState.summary[0]?.user?.id || hrState.users[0]?.id;
  printPayslip(selected || firstUser);
}

async function printPayslip(userId) {
  if (!userId) {
    showToast('warning', 'Choose user', 'Select a user before printing a payslip.');
    return;
  }
  const { from, to } = getHRFilters();
  const query = new URLSearchParams({ user_id: String(userId), from, to, _: Date.now().toString() });
  try {
    const data = await authorizedJsonRequest(`/hr/payslip?${query.toString()}`);
    const slip = data?.payslip;
    if (!slip) throw new Error('Payslip not found');
    const totals = slip.totals || {};
    const user = slip.user || {};
    const win = window.open('', '_blank', 'width=860,height=900');
    if (!win) throw new Error('Popup was blocked');
    win.document.write(`
      <html><head><title>Payslip - ${escapeHtml(user.full_name || '')}</title>
      <style>
        body{font-family:Arial,sans-serif;color:#111827;padding:32px}
        h1{margin:0 0 4px;font-size:24px}.muted{color:#6b7280}
        table{width:100%;border-collapse:collapse;margin-top:20px}td,th{border:1px solid #e5e7eb;padding:8px;text-align:left}
        .totals{max-width:380px;margin-left:auto}.total{font-size:20px;font-weight:700}
        @media print{button{display:none}}
      </style></head><body>
      <button onclick="window.print()">Print</button>
      <h1>YNT Digital Marketing Payslip</h1>
      <div class="muted">${escapeHtml(slip.from)} to ${escapeHtml(slip.to)}</div>
      <h2>${escapeHtml(user.full_name || user.username || 'User')}</h2>
      <div>${escapeHtml(formatRoleLabel(user.role))} | Daily rate: ${formatPHP(user.daily_rate)}</div>
      <table><tbody>
        <tr><th>Days Worked</th><td>${Number(totals.days_worked || 0)}</td></tr>
        <tr><th>Base Pay</th><td>${formatPHP(totals.base_pay)}</td></tr>
        <tr><th>OT (${formatMinutes(totals.ot_minutes)})</th><td>${formatPHP(totals.ot_pay)}</td></tr>
        <tr><th>Holiday Pay</th><td>${formatPHP(totals.holiday_pay)}</td></tr>
        <tr><th>Cash Advances</th><td>-${formatPHP(totals.cash_advances)}</td></tr>
        <tr><th class="total">Net Pay</th><td class="total">${formatPHP(totals.net_pay)}</td></tr>
      </tbody></table>
      <table><thead><tr><th>Date</th><th>Time In</th><th>Time Out</th><th>OT</th><th>Holiday %</th></tr></thead><tbody>
        ${(slip.attendance || []).map((record) => `<tr><td>${escapeHtml(record.work_date || '')}</td><td>${escapeHtml(record.time_in || '')}</td><td>${escapeHtml(record.time_out || '')}</td><td>${formatMinutes(record.calculated_ot_minutes || record.ot_minutes)}</td><td>${Number(record.holiday_percentage || 100)}%</td></tr>`).join('')}
      </tbody></table>
      </body></html>`);
    win.document.close();
    win.focus();
  } catch (error) {
    showToast('error', 'Payslip failed', error.message || 'Could not print payslip.');
  }
}

function openManageUserEditor(userId) {
  if (!canManageAccounts()) {
    showToast('warning', 'Access denied', 'Only Administrator or HR accounts can edit accounts.');
    return;
  }

  const user = managedUsers.find((entry) => Number(entry.id) === Number(userId));
  if (!user) {
    showToast('error', 'User not found', 'The selected account is no longer available.');
    return;
  }

  setManageUserModalState('edit', user);
  openModal('manage-user-modal');
}

function setManageUserModalState(mode, user = null) {
  const isCreateMode = mode === 'create';
  const titleEl = document.querySelector('#manage-user-modal .modal-title');
  const copyEl = document.getElementById('manage-user-mode-copy');
  const passwordLabelEl = document.getElementById('manage-user-password-label');
  const passwordHelpEl = document.getElementById('manage-user-password-help');
  const submitBtnEl = document.getElementById('manage-user-submit-btn');
  const idEl = document.getElementById('manage-user-id');
  const nameEl = document.getElementById('manage-user-full-name');
  const usernameEl = document.getElementById('manage-user-username');
  const roleEl = document.getElementById('manage-user-role');
  const birthdayEl = document.getElementById('manage-user-birthday');
  const addressEl = document.getElementById('manage-user-address');
  const phoneEl = document.getElementById('manage-user-phone-number');
  const emailEl = document.getElementById('manage-user-email-address');
  const fbEl = document.getElementById('manage-user-fb-account-name');
  const passwordEl = document.getElementById('manage-user-password');

  if (titleEl) titleEl.textContent = isCreateMode ? 'Create Account' : 'Edit Account';
  if (copyEl) copyEl.textContent = isCreateMode
    ? 'Administrator and HR can create new accounts and assign positions here.'
    : 'Update an existing account profile and role.';
  if (passwordLabelEl) passwordLabelEl.textContent = isCreateMode ? 'Password *' : 'New Password';
  if (passwordHelpEl) passwordHelpEl.textContent = isCreateMode
    ? 'Set the first password for this account.'
    : 'Only fill this in when the password needs to change.';
  if (submitBtnEl) submitBtnEl.textContent = isCreateMode ? 'Create Account' : 'Save Changes';
  if (idEl) idEl.value = user?.id || '';
  if (nameEl) nameEl.value = user?.full_name || '';
  if (usernameEl) usernameEl.value = user?.username || '';
  if (roleEl) roleEl.innerHTML = getRoleOptionsMarkup(user?.role || 'Trainee');
  if (birthdayEl) birthdayEl.value = user?.birthday || '';
  if (addressEl) addressEl.value = user?.address || '';
  if (phoneEl) phoneEl.value = user?.phone_number || '';
  if (emailEl) emailEl.value = user?.email_address || '';
  if (fbEl) fbEl.value = user?.fb_account_name || '';
  if (passwordEl) {
    passwordEl.value = '';
    passwordEl.placeholder = isCreateMode ? 'Enter password' : 'Leave blank to keep current password';
  }
}

function openManageUserCreator() {
  if (!canManageAccounts()) {
    showToast('warning', 'Access denied', 'Only Administrator or HR accounts can create accounts.');
    return;
  }

  setManageUserModalState('create');
  openModal('manage-user-modal');
}

function syncCurrentUserFromManagedAccount(user) {
  if (!user || Number(App.user?.id) !== Number(user.id)) return;
  persistLoggedInUser(
    {
      id: user.id,
      username: user.username,
      name: user.name || user.full_name,
      role: user.role,
      birthday: user.birthday,
      address: user.address,
      phone_number: user.phone_number,
      email_address: user.email_address,
      fb_account_name: user.fb_account_name,
      daily_rate: user.daily_rate,
    },
    getAuthToken(),
  );
  refreshCurrentUserChip();
}

async function handleOwnAccountSave(event) {
  event.preventDefault();

  const fullName = document.getElementById('own-account-full-name')?.value.trim();
  const username = document.getElementById('own-account-username')?.value.trim();
  const birthday = document.getElementById('own-account-birthday')?.value || '';
  const address = document.getElementById('own-account-address')?.value.trim() || '';
  const phoneNumber = document.getElementById('own-account-phone-number')?.value.trim() || '';
  const emailAddress = document.getElementById('own-account-email-address')?.value.trim() || '';
  const fbAccountName = document.getElementById('own-account-fb-account-name')?.value.trim() || '';
  const password = document.getElementById('own-account-password')?.value || '';

  if (!fullName || !username) {
    showToast('error', 'Missing details', 'Full name and username are required.');
    return;
  }

  try {
    const payload = {
      full_name: fullName,
      username,
      birthday,
      address,
      phone_number: phoneNumber,
      email_address: emailAddress,
      fb_account_name: fbAccountName,
    };
    if (password) payload.password = password;

    const data = await authorizedJsonRequest('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });

    persistLoggedInUser(
      {
        id: data.user.id,
        username: data.user.username,
        name: data.user.name,
        role: data.user.role,
        birthday: data.user.birthday,
        address: data.user.address,
        phone_number: data.user.phone_number,
        email_address: data.user.email_address,
        fb_account_name: data.user.fb_account_name,
        daily_rate: data.user.daily_rate,
      },
      getAuthToken(),
    );
    showToast('success', 'Account updated', 'Your account details were updated.');
    loadPage(isAdminUser() ? 'manage-users' : 'profile');
  } catch (error) {
    showToast('error', 'Update failed', error.message || 'Could not update your account.');
  }
}

async function handleManageUserSave(event) {
  event.preventDefault();

  const userId = document.getElementById('manage-user-id')?.value;
  const fullName = document.getElementById('manage-user-full-name')?.value.trim();
  const username = document.getElementById('manage-user-username')?.value.trim();
  const role = document.getElementById('manage-user-role')?.value || 'Trainee';
  const birthday = document.getElementById('manage-user-birthday')?.value || '';
  const address = document.getElementById('manage-user-address')?.value.trim() || '';
  const phoneNumber = document.getElementById('manage-user-phone-number')?.value.trim() || '';
  const emailAddress = document.getElementById('manage-user-email-address')?.value.trim() || '';
  const fbAccountName = document.getElementById('manage-user-fb-account-name')?.value.trim() || '';
  const password = document.getElementById('manage-user-password')?.value || '';

  if (!fullName || !username) {
    showToast('error', 'Missing details', 'Full name and username are required.');
    return;
  }

  try {
    const payload = {
      full_name: fullName,
      username,
      role,
      birthday,
      address,
      phone_number: phoneNumber,
      email_address: emailAddress,
      fb_account_name: fbAccountName,
    };
    let data = null;

    if (userId) {
      if (password) payload.password = password;
      data = await authorizedJsonRequest(`/auth/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      syncCurrentUserFromManagedAccount(data?.user);
      showToast('success', 'Account updated', `${data?.user?.name || fullName} was updated.`);
    } else {
      if (!password) {
        showToast('error', 'Missing password', 'Password is required when creating an account.');
        return;
      }
      payload.password = password;
      data = await authorizedJsonRequest('/auth/register', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      showToast('success', 'Account created', `${data?.user?.name || fullName} was added.`);
    }

    closeModal('manage-user-modal');
    if (!canManageAccounts()) {
      navigateTo('home');
      return;
    }
    await loadManagedUsers();
  } catch (error) {
    showToast('error', 'Update failed', error.message || 'Could not update account.');
  }
}

async function deleteManagedUser(userId) {
  if (!canManageAccounts()) {
    showToast('warning', 'Access denied', 'Only Administrator or HR accounts can delete accounts.');
    return;
  }

  const user = managedUsers.find((entry) => Number(entry.id) === Number(userId));
  if (!user) {
    showToast('error', 'User not found', 'The selected account is no longer available.');
    return;
  }

  if (!window.confirm(`Delete ${user.full_name}? This will disable the account from logging in.`)) {
    return;
  }

  try {
    await authorizedJsonRequest(`/auth/users/${userId}`, { method: 'DELETE' });
    showToast('success', 'Account deleted', `${user.full_name} can no longer sign in.`);
    await loadManagedUsers();
  } catch (error) {
    showToast('error', 'Delete failed', error.message || 'Could not delete account.');
  }
}

// ─── SALES TABLE ───────────────────────────────────────────
let salesPage = 1;
let salesFilter = 'all';
let salesSearch = '';
let salesDateFrom = '';
let salesDateTo = '';
let salesSourceFilter = 'all';
let salesYearFilter = 'all';
let salesMonthFilter = 'all';
let salesMonth = '';
let salesPagedRows = [];
let salesPagedTotal = 0;
let salesPagedPages = 1;
let salesPagedSummary = { totalCod: 0, statusCounts: [] };
let salesPagedLoading = false;
let salesPagedRequestId = 0;
let rtsRateFilter = 'all';
let rtsRateSourceFilter = 'all';
let rtsRateDateFrom = '';
let rtsRateDateTo = '';
let rtsRateMonth = '';
let recordsPage = 1;
let recordsSearch = '';
let recordsPosStatusFilter = 'All';
let recordsProductFilter = 'all';
let recordsDateFilter = 'all';
let recordsDateFrom = '';
let recordsDateTo = '';
let recordsSourceFilter = 'all';
let recordsYearFilter = 'all';
let recordsMonthFilter = 'all';
let posRawSearch = '';
let posOrdersSearch = '';
let posOrdersProductFilter = 'all';
let posOrdersPageFilter = 'all';
let posOrdersStatusFilter = 'all';
let posOrdersTagFilter = 'all';
let posOrdersAttemptFilter = 'all';
let posOrdersReasonFilter = 'all'; // RMO Undeliverable/Returning tabs only
let posOrdersPeriod = 'all';
let posOrdersDateFrom = '';
let posOrdersDateTo = '';
// RMO management view tabs: 'orders' (For Delivery) | 'undeliverable'.
let rmoTab = 'orders';
// Undeliverable tab quick filter on last status-update date.
let rmoUpdatePeriod = 'today';
let recordsPosTagFilter = 'all';
let recordsSummaryState = { total: 0, totalCod: 0, statusCounts: [], loading: false };
let posRawPage = 1;
let homeOrderFilter = 'all';
let homeSourceFilter = 'all';
let homeDateFrom = '';
let homeDateTo = '';
const HOME_STATUS_CHART_ITEMS = [
  { status: 'Delivered', key: 'delivered', color: '#10b981' },
  { status: 'Shipped', key: 'shipped', color: '#f59e0b' },
  { status: 'Returning', key: 'returning', color: '#fca5a5' },
  { status: 'Returned', key: 'returned', color: '#ef4444' },
];

function getPosSourceOptions() {
  return [...new Set(DB.sheetRecordsForReport.map((o) => o.sourceSheet || 'Sheets').filter(Boolean))].sort();
}

// Available chat-page names, unioned from whatever page-bearing data is loaded
// (RTS scans, POS orders, sheet records). Used by the Add Item page picker.
function getAvailablePageNames() {
  const set = new Set();
  (DB.rtsScanPages || []).forEach((p) => { if (p) set.add(p); });
  (DB.posOrders || []).forEach((o) => { if (o.page_name) set.add(o.page_name); });
  (DB.sheetRecordsForReport || []).forEach((o) => { if (o.sourceSheet) set.add(o.sourceSheet); });
  return [...set].sort((a, b) => String(a).localeCompare(String(b)));
}

function getPosYearOptions() {
  return [...new Set(DB.sheetRecordsForReport.map((o) => (o.date || '').slice(0, 4)).filter(Boolean))].sort((a, b) => b.localeCompare(a));
}

function getPosMonthOptions(year = '') {
  const formatter = new Intl.DateTimeFormat('en-US', { month: 'long' });
  return [...new Set(DB.posOrders
    .filter((o) => !year || (o.date || '').startsWith(year))
    .map((o) => (o.date || '').slice(5, 7)).filter(Boolean)
  )].sort().map((m) => ({ value: m, label: formatter.format(new Date(2000, parseInt(m) - 1, 1)) }));
}

function getFilteredHomeOrders() {
  let data = [...DB.sheetRecordsForReport];
  const today = normalizeDateString(new Date());

  if (homeOrderFilter === 'today') {
    data = data.filter((order) => String(order.date || '').slice(0, 10) === today);
  } else if (homeOrderFilter === 'weekly') {
    const week = getDateDaysAgo(6);
    data = data.filter((order) => new Date(order.date) >= week);
  } else if (homeOrderFilter === 'monthly') {
    data = data.filter((order) => String(order.date || '').startsWith(today.slice(0, 7)));
  } else if (homeOrderFilter === 'custom') {
    if (homeDateFrom) data = data.filter((order) => order.date >= homeDateFrom);
    if (homeDateTo) data = data.filter((order) => order.date <= homeDateTo);
  }

  if (homeSourceFilter !== 'all') {
    data = data.filter((order) => (order.sourceSheet || 'Sheets') === homeSourceFilter);
  }

  return data;
}

function getHomeFilterLabel() {
  const filterLabels = {
    all: 'All time',
    today: 'Today',
    weekly: 'Last 7 days',
    monthly: 'This month',
    custom: homeDateFrom || homeDateTo ? `${homeDateFrom || 'Start'} to ${homeDateTo || 'Today'}` : 'Custom range',
  };
  const sheetLabel = homeSourceFilter === 'all' ? 'All pages' : homeSourceFilter;
  return `${filterLabels[homeOrderFilter] || 'All time'} - ${sheetLabel}`;
}

function getStatusDistribution(orders) {
  const counts = {};
  HOME_STATUS_CHART_ITEMS.forEach((item) => {
    counts[item.status] = orders.filter((order) => getOrderStatusKey(order.status) === item.key).length;
  });
  return counts;
}

function getHomeRtsDistribution(orders) {
  const labels = HOME_STATUS_CHART_ITEMS.map((item) => item.status);
  const counts = HOME_STATUS_CHART_ITEMS.map((item) => (
    orders.filter((order) => getOrderStatusKey(order.status) === item.key).length
  ));
  const total = counts.reduce((sum, count) => sum + count, 0);
  return {
    labels,
    counts,
    colors: HOME_STATUS_CHART_ITEMS.map((item) => item.color),
    percentages: counts.map((count) => total ? Number(((count / total) * 100).toFixed(1)) : 0),
  };
}

function renderHomeOrderCharts() {
  if (typeof Chart === 'undefined') return;

  const orders = getFilteredHomeOrders();
  const subtitle = document.getElementById('home-status-subtitle');
  if (subtitle) subtitle.textContent = `${getHomeFilterLabel()} - ${orders.length.toLocaleString()} orders`;

  const donutCanvas = document.getElementById('home-donut-chart');
  if (donutCanvas) {
    const statusCounts = getStatusDistribution(orders);
    const donutTotal = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
    const donutEmpty = document.getElementById('home-donut-empty');
    if (donutEmpty) donutEmpty.classList.toggle('hidden', donutTotal > 0);
    donutCanvas.style.display = donutTotal > 0 ? '' : 'none';
    homeDonutChart = upsertChart(homeDonutChart, donutCanvas, donutTotal > 0, {
      type: 'doughnut',
      plugins: [doughnutPctPlugin],
      data: {
        labels: Object.keys(statusCounts),
        datasets: [{
          data: Object.values(statusCounts),
          backgroundColor: HOME_STATUS_CHART_ITEMS.map((item) => item.color),
          borderWidth: 0,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } },
        cutout: '65%',
      }
    });
  }

  const barCanvas = document.getElementById('home-rts-bar-chart');
  if (barCanvas) {
    const rts = getHomeRtsDistribution(orders);
    const rtsTotal = rts.counts.reduce((sum, count) => sum + count, 0);
    const rtsEmpty = document.getElementById('home-rts-empty');
    if (rtsEmpty) rtsEmpty.classList.toggle('hidden', rtsTotal > 0);
    barCanvas.style.display = rtsTotal > 0 ? '' : 'none';
    homeRtsBarChart = upsertChart(homeRtsBarChart, barCanvas, rtsTotal > 0, {
      type: 'bar',
      data: {
        labels: rts.labels,
        datasets: [{
          label: 'Percentage',
          data: rts.percentages,
          backgroundColor: rts.colors,
          borderRadius: 6,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => `${context.parsed.y}% (${rts.counts[context.dataIndex].toLocaleString()} orders)`,
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            grid: { color: '#f1f5f9' },
            ticks: { callback: (value) => `${value}%` },
          },
          x: { grid: { display: false } },
        }
      }
    });
  }
}

function setHomeOrderFilter(filter, btn) {
  homeOrderFilter = filter;
  document.querySelectorAll('#home-order-filter-group .filter-pill').forEach((pill) => pill.classList.remove('active'));
  btn?.classList.add('active');
  const customRange = document.getElementById('home-custom-range');
  if (customRange) customRange.classList.toggle('hidden', filter !== 'custom');
  if (filter !== 'custom') renderHomeOrderCharts();
}

function setHomeSourceFilter() {
  homeSourceFilter = document.getElementById('home-source-filter')?.value || 'all';
  renderHomeOrderCharts();
}

function applyHomeCustomRange() {
  homeDateFrom = document.getElementById('home-date-from')?.value || '';
  homeDateTo = document.getElementById('home-date-to')?.value || '';
  renderHomeOrderCharts();
}

function renderSalesSummaryCards(data) {
  const summary = document.getElementById('sales-summary-cards');
  if (!summary) return;

  const statusCounts = Array.isArray(data?.statusCounts) ? data.statusCounts : null;
  const sourceRows = Array.isArray(data) ? data : [];
  const getCount = (status) => statusCounts
    ? Number((statusCounts.find((row) => String(row.status || '').toLowerCase() === status.toLowerCase()) || {}).count || 0)
    : sourceRows.filter((o) => o.status === status).length;
  const newOrders = getCount('New');
  const shipped = getCount('Shipped');
  const delivered = getCount('Delivered');
  const returned = getCount('Returned');
  const returning = getCount('Returning');
  const canceled = getCount('Canceled');
  const totalCOD = statusCounts ? Number(data.totalCod || 0) : sourceRows.reduce((sum, o) => sum + Number(o.cod || 0), 0);

  summary.innerHTML = `
    <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">New</div><div class="stat-value">${newOrders}</div><div class="stat-meta">Pending / Submitted</div></div>
    <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">Shipped</div><div class="stat-value">${shipped}</div><div class="stat-meta">Awaiting delivery</div></div>
    <div class="stat-card green"><div class="stat-card-accent"></div><div class="stat-label">Delivered</div><div class="stat-value">${delivered}</div><div class="stat-meta">Completed</div></div>
    <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">Returning</div><div class="stat-value">${returning}</div><div class="stat-meta">In transit back</div></div>
    <div class="stat-card red"><div class="stat-card-accent"></div><div class="stat-label">Returned</div><div class="stat-value">${returned}</div><div class="stat-meta">Received back</div></div>
    <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">Canceled</div><div class="stat-value">${canceled}</div><div class="stat-meta">Canceled orders</div></div>
    <div class="stat-card purple"><div class="stat-card-accent"></div><div class="stat-label">COD Amount</div><div class="stat-value" style="font-size:20px;">₱${totalCOD.toLocaleString()}</div><div class="stat-meta">Total collected</div></div>`;
}

function getSalesDateRange() {
  const today = normalizeDateString(new Date());
  if (salesFilter === 'daily') return { from: today, to: today };
  if (salesFilter === 'weekly') return { from: normalizeDateString(getDateDaysAgo(6)), to: today };
  if (salesFilter === 'monthly') { const ym = salesMonth || today.slice(0, 7); return { from: `${ym}-01`, to: today }; }
  if (salesFilter === 'yearly') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (salesFilter === 'custom') return { from: salesDateFrom, to: salesDateTo };
  if (salesYearFilter !== 'all' && salesMonthFilter !== 'all') {
    const month = String(salesMonthFilter).padStart(2, '0');
    const endDate = new Date(Number(salesYearFilter), Number(month), 0);
    return { from: `${salesYearFilter}-${month}-01`, to: normalizeDateString(endDate) };
  }
  if (salesYearFilter !== 'all') return { from: `${salesYearFilter}-01-01`, to: `${salesYearFilter}-12-31` };
  return { from: '', to: '' };
}

async function loadSalesPageFromBackend() {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;
  const perPage = parseInt(document.getElementById('sales-per-page')?.value || '10', 10) || 10;
  const requestId = ++salesPagedRequestId;
  salesPagedLoading = true;

  const params = new URLSearchParams({
    view: 'report',
    page: String(salesPage),
    per_page: String(perPage),
    _: String(Date.now()),
  });
  if (salesSearch) params.set('search', salesSearch);
  if (salesSourceFilter !== 'all') params.set('sheet', salesSourceFilter);
  const range = getSalesDateRange();
  if (range.from) params.set('date_from', range.from);
  if (range.to) params.set('date_to', range.to);

  try {
    const result = await authorizedJsonRequest(`/integrations/google-sheets/records?${params}`);
    if (requestId !== salesPagedRequestId) return false;
    salesPagedRows = (Array.isArray(result?.records) ? result.records : []).map(mapGoogleSheetReportRecord);
    salesPagedTotal = Number(result?.total || 0);
    salesPagedPages = Math.max(1, Number(result?.pages || 1));
    salesPagedSummary = {
      totalCod: Number(result?.total_cod || 0),
      statusCounts: Array.isArray(result?.status_counts) ? result.status_counts : [],
    };
    return true;
  } finally {
    if (requestId === salesPagedRequestId) salesPagedLoading = false;
  }
}

function getFilteredSalesOrders() {
  let data = [...DB.sheetRecordsForReport];
  const today = normalizeDateString(new Date());
  if (salesFilter === 'all') {
    data = [...DB.sheetRecordsForReport];
  } else if (salesFilter === 'daily') {
    data = data.filter((order) => order.date === today);
  } else if (salesFilter === 'weekly') {
    const week = getDateDaysAgo(6);
    data = data.filter((order) => new Date(order.date) >= week);
  } else if (salesFilter === 'monthly') {
    const ym = salesMonth || today.slice(0, 7);
    data = data.filter((order) => String(order.date || '').startsWith(ym));
  } else if (salesFilter === 'yearly') {
    data = data.filter((order) => order.date.startsWith(today.slice(0, 4)));
  } else if (salesFilter === 'custom') {
    if (salesDateFrom) data = data.filter((order) => order.date >= salesDateFrom);
    if (salesDateTo) data = data.filter((order) => order.date <= salesDateTo);
  }

  if (salesSourceFilter !== 'all') data = data.filter((order) => (order.sourceSheet || 'Manual') === salesSourceFilter);
  if (salesYearFilter !== 'all') data = data.filter((order) => (order.date || '').startsWith(salesYearFilter));
  if (salesMonthFilter !== 'all') data = data.filter((order) => (order.date || '').slice(5, 7) === salesMonthFilter);

  if (salesSearch) {
    const q = salesSearch.toLowerCase();
    data = data.filter(o =>
      String(o.id || '').toLowerCase().includes(q) ||
      String(o.customer || '').toLowerCase().includes(q) ||
      String(o.product || '').toLowerCase().includes(q) ||
      String(o.tracking || '').toLowerCase().includes(q) ||
      (o.sourceSheet || '').toLowerCase().includes(q) ||
      (o.assigning_seller_name || '').toLowerCase().includes(q)
    );
  }

  return data.sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b.id || '').localeCompare(String(a.id || '')));
}

function renderSalesTable() {
  const perPage = parseInt(document.getElementById('sales-per-page')?.value || '10');
  const tbody = document.getElementById('sales-tbody');
  if (!tbody) return;

  const data = getFilteredSalesOrders();

  renderSalesSummaryCards(data);

  if (!DB.sheetRecordsForReport.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text-muted)">Loading sheet records...</td></tr>';
    const pag = document.getElementById('sales-pagination');
    if (pag) pag.innerHTML = '<span>Loading...</span>';
    return;
  }

  const total = data.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const sliced = data.slice((salesPage - 1) * perPage, salesPage * perPage);

  tbody.innerHTML = sliced.map(o => `<tr>
    <td class="font-mono text-xs text-muted">${escapeHtml(o.id || '')}</td>
    <td class="font-mono text-xs">${escapeHtml(o.tracking || '')}</td>
    <td>${escapeHtml(o.sourceSheet || 'POS')}</td>
    <td>${escapeHtml(o.date || '')}</td>
    <td style="font-weight:500">${escapeHtml(o.customer || '')}</td>
    <td>${escapeHtml(o.product || '')}</td>
    <td>${o.attempts > 1 ? `<span class="badge badge-warning">${o.attempts}</span>` : (o.attempts || '')}</td>
    <td>₱${Number(o.cod || 0).toLocaleString()}</td>
    <td>${escapeHtml(o.assigning_seller_name || '')}</td>
    <td>${statusBadge(o.status)}</td>
  </tr>`).join('') || '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text-muted)">No records found</td></tr>';

  // Pagination
  const pag = document.getElementById('sales-pagination');
  if (pag) {
    pag.innerHTML = `
      <span>${((salesPage-1)*perPage)+1}–${Math.min(salesPage*perPage, total)} of ${total} records</span>
      <div class="pagination-buttons">
        <button class="page-btn" onclick="changeSalesPage(${salesPage-1})" ${salesPage<=1?'disabled':''}>‹</button>
        ${Array.from({length:Math.min(pages,5)},(_,i) => `<button class="page-btn ${i+1===salesPage?'active':''}" onclick="changeSalesPage(${i+1})">${i+1}</button>`).join('')}
        <button class="page-btn" onclick="changeSalesPage(${salesPage+1})" ${salesPage>=pages?'disabled':''}>›</button>
      </div>`;
  }
}

function changeSalesPage(p) {
  const perPage = parseInt(document.getElementById('sales-per-page')?.value || '10');
  const total = getFilteredSalesOrders();
  const pages = Math.max(1, Math.ceil(total.length / perPage));
  if (p < 1 || p > pages) return;
  salesPage = p;
  renderSalesTable();
}

async function renderSalesTable() {
  const perPage = parseInt(document.getElementById('sales-per-page')?.value || '10', 10) || 10;
  const tbody = document.getElementById('sales-tbody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text-muted)">Loading sales records...</td></tr>';
  const pagLoading = document.getElementById('sales-pagination');
  if (pagLoading) pagLoading.innerHTML = '<span>Loading...</span>';

  try {
    await loadSalesPageFromBackend();
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--danger)">Sales records failed: ${escapeHtml(error.message || 'Request failed')}</td></tr>`;
    const pag = document.getElementById('sales-pagination');
    if (pag) pag.innerHTML = '';
    return;
  }

  renderSalesSummaryCards(salesPagedSummary);

  const total = salesPagedTotal;
  const pages = salesPagedPages;
  const rows = salesPagedRows;

  tbody.innerHTML = rows.map(o => `<tr>
    <td class="font-mono text-xs text-muted">${escapeHtml(o.id || '')}</td>
    <td class="font-mono text-xs">${escapeHtml(o.tracking || '')}</td>
    <td>${escapeHtml(o.sourceSheet || 'POS')}</td>
    <td>${escapeHtml(o.date || '')}</td>
    <td style="font-weight:500">${escapeHtml(o.customer || '')}</td>
    <td>${escapeHtml(o.product || '')}</td>
    <td>${o.attempts > 1 ? `<span class="badge badge-warning">${o.attempts}</span>` : (o.attempts || '')}</td>
    <td>&#8369;${Number(o.cod || 0).toLocaleString()}</td>
    <td>${escapeHtml(o.assigning_seller_name || '')}</td>
    <td>${statusBadge(o.status)}</td>
  </tr>`).join('') || '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text-muted)">No records found</td></tr>';

  const pag = document.getElementById('sales-pagination');
  if (pag) {
    pag.innerHTML = `
      <span>${total ? ((salesPage - 1) * perPage) + 1 : 0}-${Math.min(salesPage * perPage, total)} of ${total} records</span>
      <div class="pagination-buttons">
        <button class="page-btn" onclick="changeSalesPage(${salesPage - 1})" ${salesPage <= 1 ? 'disabled' : ''}>&lsaquo;</button>
        ${renderPaginationButtons(salesPage, pages, 'changeSalesPage')}
        <button class="page-btn" onclick="changeSalesPage(${salesPage + 1})" ${salesPage >= pages ? 'disabled' : ''}>&rsaquo;</button>
      </div>`;
  }
}

function changeSalesPage(p) {
  if (p < 1 || p > salesPagedPages) return;
  salesPage = p;
  renderSalesTable();
}

function setSalesFilter(filter, btn) {
  salesFilter = filter; salesPage = 1;
  document.querySelectorAll('#sales-filter-group .filter-pill').forEach((pill) => pill.classList.remove('active'));
  btn.classList.add('active');
  const customRange = document.getElementById('sales-custom-range');
  if (customRange) customRange.classList.toggle('hidden', filter !== 'custom');
  const monthPicker = document.getElementById('sales-month-picker');
  if (monthPicker) monthPicker.classList.toggle('hidden', filter !== 'monthly');
  if (filter === 'monthly' && !salesMonth) {
    const months = getDataReportMonths();
    salesMonth = months[0] || normalizeDateString(new Date()).slice(0, 7);
  }
  if (filter !== 'custom') renderSalesTable();
}

function setSalesMonthDropdown() {
  salesMonth = document.getElementById('sales-month-dropdown')?.value || '';
  salesPage = 1;
  renderSalesTable();
}

function applySalesCustomRange() {
  salesDateFrom = document.getElementById('sales-date-from')?.value || '';
  salesDateTo = document.getElementById('sales-date-to')?.value || '';
  salesPage = 1;
  renderSalesTable();
}

function filterSalesTable() {
  salesSearch = document.getElementById('sales-search')?.value || '';
  salesPage = 1;
  renderSalesTable();
}

function setSalesSourceFilter() {
  salesSourceFilter = document.getElementById('sales-source-filter')?.value || 'all';
  salesPage = 1;
  renderSalesTable();
}

function setSalesYearFilter() {
  salesYearFilter = document.getElementById('sales-year-filter')?.value || 'all';
  salesMonthFilter = 'all';
  const monthSelect = document.getElementById('sales-month-filter');
  if (monthSelect) {
    const months = getOrderMonthOptions(salesYearFilter === 'all' ? '' : salesYearFilter);
    monthSelect.innerHTML = `<option value="all">All Months</option>${months.map((month) => `<option value="${month.value}">${month.label}</option>`).join('')}`;
  }
  salesPage = 1;
  renderSalesTable();
}

function setSalesMonthFilter() {
  salesMonthFilter = document.getElementById('sales-month-filter')?.value || 'all';
  salesPage = 1;
  renderSalesTable();
}

function setRTSRateFilter(filter, btn) {
  rtsRateFilter = filter;
  // Clear the active state from the clicked pill's own group (works whether the
  // pills live in the standalone RTS Rate page or the Sales Dashboard tab).
  const pillGroup = btn?.parentElement || document.getElementById('rts-rate-filter-group');
  pillGroup?.querySelectorAll('.filter-pill').forEach((pill) => pill.classList.remove('active'));
  btn?.classList.add('active');
  const customRange = document.getElementById('rts-rate-custom-range');
  if (customRange) customRange.classList.toggle('hidden', filter !== 'custom');
  const monthGroup = document.getElementById('rts-rate-month-group');
  if (monthGroup) monthGroup.classList.toggle('hidden', filter !== 'monthly');
  if (filter === 'monthly' && !rtsRateMonth) {
    const months = getDataReportMonths();
    rtsRateMonth = months[0] || normalizeDateString(new Date()).slice(0, 7);
  }
  if (filter !== 'custom') renderRTSRateDashboard();
}

function setRTSRateMonth() {
  rtsRateMonth = document.getElementById('rts-rate-month')?.value || '';
  renderRTSRateDashboard();
}

function setRTSRateSourceFilter() {
  rtsRateSourceFilter = document.getElementById('rts-rate-source-filter')?.value || 'all';
  renderRTSRateDashboard();
}

function applyRTSRateCustomRange() {
  rtsRateDateFrom = document.getElementById('rts-rate-date-from')?.value || '';
  rtsRateDateTo = document.getElementById('rts-rate-date-to')?.value || '';
  renderRTSRateDashboard();
}

function syncMarketingPageMeta() {
  // Legacy: kept for backward compatibility but no longer used by the new
  // multi-row entry form. Individual rows derive their owner via state.pages.
}

function marketingProductRowHtml(state, selected = '', spend = '') {
  // Products = chat_page values discovered in google_orders (Sheet Records)
  const chatPages = getPosSourceOptions();
  const allOptions = [...new Set([...chatPages, selected].filter(Boolean))].sort();
  return `
    <div class="mkt-product-row" style="display:flex;gap:8px;align-items:center;">
      <select class="form-control mkt-row-page" style="flex:1;">
        <option value="">— Select product / page —</option>
        ${allOptions.map((name) => `<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}
      </select>
      <input type="number" class="form-control mkt-row-spend" min="0" step="0.01" placeholder="Ad Spend" value="${spend !== '' && spend !== null && spend !== undefined ? Number(spend) : ''}" oninput="recalcMarketingTotal()" style="width:140px;">
      <button type="button" class="btn btn-ghost btn-sm" onclick="removeMarketingProductRow(this)" style="font-size:18px;line-height:1;padding:4px 10px;color:var(--danger);">×</button>
    </div>`;
}

function addMarketingProductRow() {
  const container = document.getElementById('mkt-product-rows');
  if (!container) return;
  const state = getMarketingState();
  container.insertAdjacentHTML('beforeend', marketingProductRowHtml(state));
  recalcMarketingTotal();
}

function removeMarketingProductRow(btn) {
  const row = btn.closest('.mkt-product-row');
  if (!row) return;
  const container = row.parentElement;
  row.remove();
  if (container && !container.querySelector('.mkt-product-row')) {
    const state = getMarketingState();
    container.insertAdjacentHTML('beforeend', marketingProductRowHtml(state));
  }
  recalcMarketingTotal();
}

function recalcMarketingTotal() {
  const inputs = document.querySelectorAll('#mkt-product-rows .mkt-row-spend');
  let total = 0;
  inputs.forEach((el) => { total += Number(el.value || 0); });
  const display = document.getElementById('mkt-total-adspend');
  if (display) display.textContent = Number(total).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function submitMarketingEntries() {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can add entries.');
    return;
  }
  const state = getMarketingState();
  const date = document.getElementById('mkt-date')?.value || normalizeDateString(new Date());
  const editIdValue = document.getElementById('mkt-entry-edit-index')?.value || '';
  const editId = editIdValue === '' ? 0 : Number(editIdValue);

  const rows = [...document.querySelectorAll('#mkt-product-rows .mkt-product-row')];
  const collected = rows.map((row) => {
    const pageName = row.querySelector('.mkt-row-page')?.value || '';
    const spend = Number(row.querySelector('.mkt-row-spend')?.value || 0);
    if (!pageName || spend <= 0) return null;
    const configured = state.pages.find((p) => p.name === pageName);
    const teamMember = (state.team || []).find((t) => getMemberPages(t).includes(pageName));
    const owner = App.user?.name || App.user?.username || configured?.owner || teamMember?.name || '';
    const product = configured?.product || '';
    return { date, page: pageName, product, owner, spend, sales: 0, orders: 0, rts: 0 };
  }).filter(Boolean);

  if (!collected.length) {
    showToast('error', 'Nothing to save', 'Pick a product and enter an ad spend.');
    return;
  }

  try {
    if (editId > 0) {
      await authorizedJsonRequest(`/marketing/entries/${editId}`, { method: 'PUT', body: JSON.stringify(collected[0]) });
      for (const entry of collected.slice(1)) {
        await authorizedJsonRequest('/marketing/entries', { method: 'POST', body: JSON.stringify(entry) });
      }
    } else {
      for (const entry of collected) {
        await authorizedJsonRequest('/marketing/entries', { method: 'POST', body: JSON.stringify(entry) });
      }
    }
  } catch (error) {
    showToast('error', 'Save failed', error.message || 'Could not save entries.');
    return;
  }

  await loadMarketingEntries();
  showToast('success', editId > 0 ? 'Entry updated' : `${collected.length} entr${collected.length === 1 ? 'y' : 'ies'} saved`, collected.map((e) => e.page).join(', '));
  closeModal('mkt-entry-modal');
  navigateTo('marketing-center');
}

function openMarketingEntryModal() {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can add entries.');
    return;
  }
  // Reset fields to a blank entry
  const editInput = document.getElementById('mkt-entry-edit-index');
  if (editInput) editInput.value = '';
  const dateInput = document.getElementById('mkt-date');
  if (dateInput) dateInput.value = normalizeDateString(new Date());
  const container = document.getElementById('mkt-product-rows');
  if (container) {
    container.innerHTML = marketingProductRowHtml(getMarketingState());
    recalcMarketingTotal();
  }
  const titleEl = document.getElementById('mkt-entry-modal-title');
  if (titleEl) titleEl.textContent = 'Log Daily Entry';
  openModal('mkt-entry-modal');
}

function closeMarketingEntryModal() {
  closeModal('mkt-entry-modal');
}

function editMarketingEntry(id) {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can update entries.');
    return;
  }
  const state = getMarketingState();
  const entry = (DB.marketingEntries || []).find((e) => Number(e.id) === Number(id));
  if (!entry) return;
  const editInput = document.getElementById('mkt-entry-edit-index');
  if (editInput) editInput.value = String(entry.id);
  const dateInput = document.getElementById('mkt-date');
  if (dateInput) dateInput.value = entry.date || '';
  const container = document.getElementById('mkt-product-rows');
  if (container) {
    container.innerHTML = marketingProductRowHtml(state, entry.page, entry.spend);
    recalcMarketingTotal();
  }
  const titleEl = document.getElementById('mkt-entry-modal-title');
  if (titleEl) titleEl.textContent = 'Edit Daily Entry';
  openModal('mkt-entry-modal');
}

async function updateMarketingEntrySpend(id, value) {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can update entries.');
    return;
  }
  const entry = (DB.marketingEntries || []).find((e) => Number(e.id) === Number(id));
  if (!entry) return;
  const spend = Math.max(0, Number(value) || 0);
  try {
    const result = await authorizedJsonRequest(`/marketing/entries/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...entry, spend }),
    });
    if (result?.entry) {
      const idx = DB.marketingEntries.findIndex((e) => Number(e.id) === Number(id));
      if (idx >= 0) DB.marketingEntries[idx] = result.entry;
    }
    showToast('success', 'Ad spend updated', `${entry.page}: ${marketingMoney(spend)}`);
  } catch (error) {
    showToast('error', 'Update failed', error.message || 'Could not update ad spend.');
  }
}

function applyMarketingRecentFilter() {
  const from = document.getElementById('mkt-recent-from')?.value || '';
  const to = document.getElementById('mkt-recent-to')?.value || '';
  const product = document.getElementById('mkt-recent-product')?.value || '';
  window.mktRecentFilter = { from, to, product };
  navigateTo('marketing-center');
  setTimeout(() => {
    const tab = document.querySelector('.erp-tabs .tab-btn[onclick*="mkt-entries"]');
    if (tab) tab.click();
  }, 50);
}

function clearMarketingRecentFilter() {
  window.mktRecentFilter = { from: '', to: '', product: '' };
  navigateTo('marketing-center');
  setTimeout(() => {
    const tab = document.querySelector('.erp-tabs .tab-btn[onclick*="mkt-entries"]');
    if (tab) tab.click();
  }, 50);
}

function setMarketingRecentLimit(val) {
  window.mktRecentLimit = Number(val) || 10;
  navigateTo('marketing-center');
  setTimeout(() => {
    const tab = document.querySelector('.erp-tabs .tab-btn[onclick*="mkt-entries"]');
    if (tab) tab.click();
  }, 50);
}

async function deleteMarketingEntry(id) {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can delete entries.');
    return;
  }
  try {
    await authorizedJsonRequest(`/marketing/entries/${id}`, { method: 'DELETE' });
    await loadMarketingEntries();
    navigateTo('marketing-center');
  } catch (error) {
    showToast('error', 'Delete failed', error.message || 'Could not delete entry.');
  }
}

function addMarketingCreative() {
  const state = getMarketingState();
  const item = {
    date: document.getElementById('mkt-creative-date')?.value || normalizeDateString(new Date()),
    page: document.getElementById('mkt-creative-page')?.value || '',
    hook: document.getElementById('mkt-creative-hook')?.value || '',
    status: document.getElementById('mkt-creative-status')?.value || 'Live',
    spend: Number(document.getElementById('mkt-creative-spend')?.value || 0),
    roas: Number(document.getElementById('mkt-creative-roas')?.value || 0),
    notes: document.getElementById('mkt-creative-notes')?.value || '',
  };

  if (!item.date || !item.page) {
    showToast('error', 'Creative incomplete', 'Date and page are required.');
    return;
  }

  state.creatives.push(item);
  saveMarketingState(state);
  showToast('success', 'Creative logged', `${item.hook} - ${item.status}`);
  navigateTo('marketing-center');
}

function deleteMarketingCreative(index) {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can delete creatives.');
    return;
  }
  const state = getMarketingState();
  if (index < 0 || index >= state.creatives.length) return;
  state.creatives.splice(index, 1);
  saveMarketingState(state);
  navigateTo('marketing-center');
}

function addMarketingStandup() {
  const state = getMarketingState();
  state.standups.push({
    date: document.getElementById('mkt-standup-date')?.value || normalizeDateString(new Date()),
    owner: document.getElementById('mkt-standup-owner')?.value || '',
    yesterday: document.getElementById('mkt-standup-yesterday')?.value || '',
    today: document.getElementById('mkt-standup-today')?.value || '',
    blockers: document.getElementById('mkt-standup-blockers')?.value || '',
  });
  saveMarketingState(state);
  showToast('success', 'Standup logged', 'Daily standup was saved.');
  navigateTo('marketing-center');
}

function deleteMarketingStandup(index) {
  const state = getMarketingState();
  if (index < 0 || index >= state.standups.length) return;
  state.standups.splice(index, 1);
  saveMarketingState(state);
  navigateTo('marketing-center');
}

function saveMarketingTeamMember() {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can manage team members.');
    return;
  }
  const name = document.getElementById('mkt-team-name')?.value.trim() || '';
  const role = document.getElementById('mkt-team-role')?.value.trim() || '';
  const pages = Array.from(document.querySelectorAll('.mkt-team-page-cb:checked'))
    .map((el) => el.value.trim())
    .filter(Boolean);
  const primary = document.getElementById('mkt-team-primary')?.value.trim() || '';
  if (!name) { showToast('error', 'Name required', 'Please enter a team member name.'); return; }
  const state = getMarketingState();
  const editVal = document.getElementById('mkt-team-edit-index')?.value;
  const editIndex = editVal === '' ? -1 : Number(editVal);
  const payload = { name, role, pages, primary };
  if (editIndex >= 0) {
    state.team[editIndex] = payload;
  } else {
    state.team.push(payload);
  }
  saveMarketingState(state);
  showToast('success', editIndex >= 0 ? 'Team member updated' : 'Team member added', name);
  navigateTo('marketing-center');
}

function editMarketingTeamMember(index) {
  if (!canManageMarketing()) return;
  const state = getMarketingState();
  const member = state.team[index];
  if (!member) return;
  const fields = { 'mkt-team-name': member.name, 'mkt-team-role': member.role, 'mkt-team-primary': member.primary, 'mkt-team-edit-index': index };
  Object.entries(fields).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = val; });
  const memberPages = getMemberPages(member);
  document.querySelectorAll('.mkt-team-page-cb').forEach((el) => {
    el.checked = memberPages.includes(el.value);
  });
  document.getElementById('mkt-team-name')?.focus();
  showToast('success', 'Editing member', 'Update fields and click Save Member.');
}

function deleteMarketingTeamMember(index) {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can manage team members.');
    return;
  }
  const state = getMarketingState();
  if (index < 0 || index >= state.team.length) return;
  const name = state.team[index].name;
  state.team.splice(index, 1);
  saveMarketingState(state);
  showToast('success', 'Member removed', name);
  navigateTo('marketing-center');
}

function cancelMarketingTeamEdit() {
  ['mkt-team-name', 'mkt-team-role', 'mkt-team-primary'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.querySelectorAll('.mkt-team-page-cb').forEach((el) => { el.checked = false; });
  const idx = document.getElementById('mkt-team-edit-index'); if (idx) idx.value = '';
}

function clearMarketingAdAccountForm() {
  ['mkt-adaccount-bm', 'mkt-adaccount-acc', 'mkt-adaccount-page', 'mkt-adaccount-product', 'mkt-adaccount-advertiser', 'mkt-adaccount-payment']
    .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  const statusEl = document.getElementById('mkt-adaccount-status'); if (statusEl) statusEl.value = 'RUNNING';
  const idx = document.getElementById('mkt-adaccount-edit-index'); if (idx) idx.value = '';
}

function openMarketingAdAccountModal() {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can manage ad accounts.');
    return;
  }
  clearMarketingAdAccountForm();
  const titleEl = document.getElementById('mkt-adaccount-modal-title');
  if (titleEl) titleEl.textContent = 'Add Ad Account';
  openModal('mkt-adaccount-modal');
  document.getElementById('mkt-adaccount-bm')?.focus();
}

function closeMarketingAdAccountModal() {
  closeModal('mkt-adaccount-modal');
  clearMarketingAdAccountForm();
}

function saveMarketingAdAccount() {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can manage ad accounts.');
    return;
  }
  const status = document.getElementById('mkt-adaccount-status')?.value || 'RUNNING';
  const bm = document.getElementById('mkt-adaccount-bm')?.value.trim() || '';
  const acc = document.getElementById('mkt-adaccount-acc')?.value.trim() || '';
  const page = document.getElementById('mkt-adaccount-page')?.value.trim() || '';
  const product = document.getElementById('mkt-adaccount-product')?.value.trim() || '';
  const advertiser = document.getElementById('mkt-adaccount-advertiser')?.value.trim() || '';
  const payment = document.getElementById('mkt-adaccount-payment')?.value.trim() || '';
  if (!acc) { showToast('error', 'Account required', 'Please enter the account name or ID.'); return; }

  const state = getMarketingState();
  const editVal = document.getElementById('mkt-adaccount-edit-index')?.value;
  const editIndex = editVal === '' ? -1 : Number(editVal);
  const payload = { status, bm, acc, page, product, advertiser, payment };
  if (editIndex >= 0 && editIndex < state.adAccounts.length) {
    state.adAccounts[editIndex] = payload;
  } else {
    state.adAccounts.push(payload);
  }
  saveMarketingState(state);
  showToast('success', editIndex >= 0 ? 'Ad account updated' : 'Ad account added', acc || 'Account registry was updated.');
  lastMarketingTab = 'mkt-adaccounts';
  closeModal('mkt-adaccount-modal');
  navigateTo('marketing-center');
}

function editMarketingAdAccount(index) {
  if (!canManageMarketing()) return;
  const state = getMarketingState();
  const account = state.adAccounts[index];
  if (!account) return;
  lastMarketingTab = 'mkt-adaccounts';
  const fields = {
    'mkt-adaccount-status': account.status || 'RUNNING',
    'mkt-adaccount-bm': account.bm || '',
    'mkt-adaccount-acc': account.acc || '',
    'mkt-adaccount-page': account.page || '',
    'mkt-adaccount-product': account.product || '',
    'mkt-adaccount-advertiser': account.advertiser || '',
    'mkt-adaccount-payment': account.payment || '',
    'mkt-adaccount-edit-index': String(index),
  };
  Object.entries(fields).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = val; });
  const titleEl = document.getElementById('mkt-adaccount-modal-title');
  if (titleEl) titleEl.textContent = 'Edit Ad Account';
  openModal('mkt-adaccount-modal');
  document.getElementById('mkt-adaccount-acc')?.focus();
}

function cancelMarketingAdAccountEdit() {
  closeMarketingAdAccountModal();
}

function deleteMarketingAdAccount(index) {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can manage ad accounts.');
    return;
  }
  const state = getMarketingState();
  if (index < 0 || index >= state.adAccounts.length) return;
  state.adAccounts.splice(index, 1);
  saveMarketingState(state);
  lastMarketingTab = 'mkt-adaccounts';
  navigateTo('marketing-center');
}

function generateMarketingWeeklyText(state = getMarketingState()) {
  const entries = getMarketingMonthEntries(state);
  const totals = aggregateMarketing(entries);
  const byPage = aggregateMarketingByPage(entries).sort((a, b) => b.sales - a.sales);
  const topPage = byPage[0];
  return [
    'YNT SALES & MARKETING WEEKLY REPORT',
    `Generated: ${new Date().toLocaleString('en-PH')}`,
    '',
    `Sales: ${marketingMoney(totals.sales)}`,
    `Ad Spend: ${marketingMoney(totals.spend)}`,
    `Orders: ${totals.orders}`,
    `ROAS: ${marketingRoas(totals.roas)}`,
    `CPP: ${marketingMoney(totals.cpp)}`,
    `RTS Rate: ${marketingPct(totals.rtsRate)}`,
    '',
    `Top Page: ${topPage ? `${topPage.page} (${marketingRoas(topPage.roas)})` : 'No entries yet'}`,
    '',
    'Priorities:',
    '- Scale pages above target ROAS.',
    '- Cut weak creatives below benchmark.',
    '- Review ad accounts and payment health.',
  ].join('\n');
}

async function copyMarketingWeeklyReport() {
  const text = generateMarketingWeeklyText();
  try {
    await navigator.clipboard.writeText(text);
    showToast('success', 'Copied', 'Weekly report copied to clipboard.');
  } catch {
    showToast('warning', 'Copy failed', 'Select the report text and copy manually.');
  }
}

function openMarketingTargetsModal() {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can update settings.');
    return;
  }
  openModal('mkt-targets-modal');
  document.getElementById('mkt-target-sales')?.focus();
}

function saveMarketingTargets() {
  if (!canManageMarketing()) {
    showToast('warning', 'TL only', 'Only Sales and Marketing TL can update settings.');
    return;
  }
  const state = getMarketingState();
  state.targets = {
    sales: Number(document.getElementById('mkt-target-sales')?.value || 7000000),
    spend: Number(document.getElementById('mkt-target-spend')?.value || 85000),
    roas: Number(document.getElementById('mkt-target-roas')?.value || 3.8),
    rts: Number(document.getElementById('mkt-target-rts')?.value || 17),
  };
  saveMarketingState(state);
  showToast('success', 'Targets saved', 'Marketing pacing targets were updated.');
  closeModal('mkt-targets-modal');
  navigateTo('marketing-center');
}

function exportMarketingEntries() {
  const state = getMarketingState();
  const rows = [['date', 'page', 'product', 'owner', 'orders', 'sales', 'ad_spend', 'rts', 'roas', 'cpp', 'rts_rate']];
  state.entries.forEach((entry) => {
    const roas = Number(entry.spend || 0) ? Number(entry.sales || 0) / Number(entry.spend || 0) : 0;
    const cpp = Number(entry.orders || 0) ? Number(entry.spend || 0) / Number(entry.orders || 0) : 0;
    const rtsRate = Number(entry.orders || 0) ? Number(entry.rts || 0) / Number(entry.orders || 0) : 0;
    rows.push([entry.date, entry.page, entry.product, entry.owner, entry.orders, entry.sales, entry.spend, entry.rts, roas.toFixed(3), cpp.toFixed(2), (rtsRate * 100).toFixed(2)]);
  });
  const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ynt-marketing-entries-${normalizeDateString(new Date())}.csv`;
  a.click();
  showToast('success', 'CSV exported', 'Marketing entries downloaded.');
}

function getFilteredViewRecordOrders() {
  let data = [...DB.orders];
  const today = normalizeDateString(new Date());

  if (recordsPosStatusFilter !== 'All') {
    const posStatus = recordsPosStatusFilter.toLowerCase();
    data = data.filter((order) =>
      String(order.status || '').toLowerCase() === posStatus
      || String(order.tags || '').toLowerCase().split(',').map((tag) => tag.trim()).includes(posStatus)
    );
  }

  if (recordsProductFilter !== 'all') {
    data = data.filter((order) => order.product === recordsProductFilter);
  }

  if (recordsSourceFilter !== 'all') {
    data = data.filter((order) => (order.sourceSheet || 'Manual') === recordsSourceFilter);
  }

  if (recordsPosTagFilter !== 'all') {
    data = data.filter((order) => (order.posTags || []).includes(recordsPosTagFilter));
  }

  if (recordsYearFilter !== 'all') {
    data = data.filter((order) => (order.date || '').startsWith(recordsYearFilter));
  }

  if (recordsMonthFilter !== 'all') {
    data = data.filter((order) => (order.date || '').slice(5, 7) === recordsMonthFilter);
  }

  if (recordsDateFilter === 'today') {
    data = data.filter((order) => order.date === today);
  } else if (recordsDateFilter === 'yesterday') {
    const yesterday = normalizeDateString(getDateDaysAgo(1));
    data = data.filter((order) => order.date === yesterday);
  } else if (recordsDateFilter === 'month') {
    data = data.filter((order) => order.date.startsWith(today.slice(0, 7)));
  } else if (recordsDateFilter === 'year') {
    data = data.filter((order) => order.date.startsWith(today.slice(0, 4)));
  } else if (recordsDateFilter === 'custom') {
    if (recordsDateFrom) data = data.filter((order) => order.date >= recordsDateFrom);
    if (recordsDateTo) data = data.filter((order) => order.date <= recordsDateTo);
  }

  if (recordsSearch) {
    const query = recordsSearch.toLowerCase();
    data = data.filter((order) =>
      order.id.toLowerCase().includes(query)
      || order.customer.toLowerCase().includes(query)
      || (order.phone || '').toLowerCase().includes(query)
      || order.product.toLowerCase().includes(query)
      || (order.tags || '').toLowerCase().includes(query)
      || (order.posTags || []).join(' ').toLowerCase().includes(query)
      || order.courier.toLowerCase().includes(query)
      || order.status.toLowerCase().includes(query)
      || order.tracking.toLowerCase().includes(query)
      || (order.sourceSheet || '').toLowerCase().includes(query)
      || (order.confirmedBy || '').toLowerCase().includes(query)
    );
  }

  return data.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

function getRecordsSummaryQuery() {
  return new URLSearchParams({
    search: recordsSearch || '',
    source_sheet: recordsSourceFilter || 'all',
    product: recordsProductFilter || 'all',
    pos_tag: recordsPosTagFilter || 'all',
    year: recordsYearFilter || 'all',
    month: recordsMonthFilter || 'all',
    date_filter: recordsDateFilter || 'all',
    date_from: recordsDateFrom || '',
    date_to: recordsDateTo || '',
    _: String(Date.now()),
  });
}

async function refreshRecordsSummaryFromBackend() {
  if (!App.user || !getAuthToken() || !getApiBase()) return false;
  recordsSummaryState = { ...recordsSummaryState, loading: true };
  const summary = await authorizedJsonRequest(`/orders/summary?${getRecordsSummaryQuery().toString()}`);
  recordsSummaryState = {
    total: Number(summary?.total || 0),
    totalCod: Number(summary?.total_cod || 0),
    statusCounts: Array.isArray(summary?.status_counts) ? summary.status_counts : [],
    loading: false,
  };
  if (App.currentPage === 'view-records') renderViewRecordsStatusSummary();
  return true;
}

function renderViewRecordsStatusSummary(records = null) {
  const summaryEl = document.getElementById('rec-orders-status-summary');
  if (!summaryEl) return;

  const statusColors = {
    'New': 'badge-blue',
    'Confirmed': 'badge-info',
    'Waiting for pickup': 'badge-warning',
    'Shipped': 'badge-purple',
    'Delivered': 'badge-success',
    'Returning': 'badge-warning',
    'Returned': 'badge-danger',
    'Canceled': 'badge-gray',
  };

  let statusEntries, total, totalCod;

  if (Array.isArray(records)) {
    // Always use the already-filtered records array — guaranteed to match current filters
    const counts = {};
    records.forEach((order) => { counts[order.status] = (counts[order.status] || 0) + 1; });
    statusEntries = Object.entries(counts);
    total = records.length;
    totalCod = records.reduce((s, o) => s + Number(o.cod || 0), 0);
  } else {
    statusEntries = recordsSummaryState.statusCounts.map((row) => [row.status, Number(row.count || 0)]);
    total = Number(recordsSummaryState.total || 0);
    totalCod = Number(recordsSummaryState.totalCod || 0);
  }

  if (!total) {
    summaryEl.innerHTML = '';
    return;
  }

  const chips = statusEntries
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `<span class="badge ${statusColors[status] || 'badge-gray'}" style="font-size:12px;padding:4px 10px;">${escapeHtml(status)}: <strong>${Number(count).toLocaleString()}</strong></span>`)
    .join('');

  summaryEl.innerHTML = `<span class="badge badge-dark" style="font-size:12px;padding:4px 10px;">Total: <strong>${total.toLocaleString()}</strong></span>${chips}<span style="margin-left:auto;font-size:12px;color:var(--text-muted);align-self:center;">COD <strong>₱${Number(totalCod).toLocaleString()}</strong></span>`;
}

function renderPaginationButtons(currentPage, totalPages, onClickName) {
  const windowStart = Math.max(1, Math.min(currentPage - 2, totalPages - 4));
  const windowEnd = Math.min(totalPages, windowStart + 4);
  const buttons = [];

  if (windowStart > 1) {
    buttons.push(`<button class="page-btn" onclick="${onClickName}(1)">1</button>`);
    if (windowStart > 2) buttons.push('<span class="page-ellipsis">...</span>');
  }

  for (let page = windowStart; page <= windowEnd; page += 1) {
    buttons.push(`<button class="page-btn ${page === currentPage ? 'active' : ''}" onclick="${onClickName}(${page})">${page}</button>`);
  }

  if (windowEnd < totalPages) {
    if (windowEnd < totalPages - 1) buttons.push('<span class="page-ellipsis">...</span>');
    buttons.push(`<button class="page-btn" onclick="${onClickName}(${totalPages})">${totalPages}</button>`);
  }

  return buttons.join('');
}

function renderViewRecordsOrdersTable() {
  const tbody = document.getElementById('rec-orders-tbody');
  if (!tbody) return;
  const pagination = document.getElementById('records-pagination');

  if (!DB.orders.length && ordersLoadPromise) {
    tbody.innerHTML = '<tr><td colspan="16" style="text-align:center;padding:32px;color:var(--text-muted)">Loading saved orders from the database...</td></tr>';
    if (pagination) pagination.innerHTML = '<span>Loading orders...</span>';
    return;
  }

  const perPage = 10;
  const records = getFilteredViewRecordOrders();
  const pages = Math.max(1, Math.ceil(records.length / perPage));
  if (recordsPage > pages) recordsPage = pages;
  const sliced = records.slice((recordsPage - 1) * perPage, recordsPage * perPage);

  renderViewRecordsStatusSummary(records);
  if (false) {
    const statusColors = {
      'New': 'badge-blue',
      'Confirmed': 'badge-info',
      'Waiting for pickup': 'badge-warning',
      'Shipped': 'badge-purple',
      'Delivered': 'badge-success',
      'Returning': 'badge-warning',
      'Returned': 'badge-danger',
      'Canceled': 'badge-gray',
    };
    const counts = {};
    records.forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1; });
    const totalCod = records.reduce((s, o) => s + Number(o.cod || 0), 0);
    const chips = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `<span class="badge ${statusColors[status] || 'badge-gray'}" style="font-size:12px;padding:4px 10px;">${escapeHtml(status)}: <strong>${count}</strong></span>`)
      .join('');
    summaryEl.innerHTML = records.length
      ? `${chips}<span style="margin-left:auto;font-size:12px;color:var(--text-muted);align-self:center;"><strong>${records.length}</strong> total · COD <strong>₱${totalCod.toLocaleString()}</strong></span>`
      : '';
  }

  tbody.innerHTML = sliced.map((order) => `<tr data-status="${order.status}">
    <td class="font-mono text-xs text-muted">${order.id}</td>
    <td class="font-mono text-xs">${escapeHtml(order.tracking || '')}</td>
    <td>${escapeHtml(order.sourceSheet || 'Manual')}</td>
    <td class="text-xs">${order.confirmedBy ? `<span style="color:var(--text-muted)">${escapeHtml(order.confirmedBy)}</span>` : '<span style="color:var(--text-muted);opacity:0.4">—</span>'}</td>
    <td>${order.date}</td>
    <td style="font-weight:500">${escapeHtml(order.customer || '')}</td>
    <td class="font-mono text-xs">${escapeHtml(order.phone || '')}</td>
    <td>${escapeHtml(order.product || '')}</td>
    <td>${escapeHtml(order.tags || '')}</td>
    <td>${(order.posTags || []).map((t) => `<span class="badge badge-danger" style="margin:1px 2px;">${escapeHtml(t)}</span>`).join('')}</td>
    <td>${order.attempts > 1 ? `<span class="badge badge-warning">${order.attempts}</span>` : order.attempts}</td>
    <td>${order.qty}</td>
    <td>₱${order.cod.toLocaleString()}</td>
    <td>${escapeHtml(order.courier || '')}</td>
    <td>${statusBadge(order.status)}</td>
    <td>
      <div class="flex gap-2">
        <button class="btn btn-ghost btn-sm" onclick="editOrderRecord('${escapeHtml(order.dbId || order.id)}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteOrderRecord('${escapeHtml(order.dbId || order.id)}')">Delete</button>
      </div>
    </td>
  </tr>`).join('') || '<tr><td colspan="16" style="text-align:center;padding:32px;color:var(--text-muted)">No records found for the selected filters.</td></tr>';

  if (pagination) {
    const start = records.length ? ((recordsPage - 1) * perPage) + 1 : 0;
    const end = Math.min(recordsPage * perPage, records.length);
    pagination.innerHTML = `
      <span>${start}-${end} of ${records.length} orders</span>
      <div class="pagination-buttons">
        <button class="page-btn" onclick="changeRecordsPage(${recordsPage - 1})" ${recordsPage <= 1 ? 'disabled' : ''}>‹</button>
        ${renderPaginationButtons(recordsPage, pages, 'changeRecordsPage')}
        <button class="page-btn" onclick="changeRecordsPage(${recordsPage + 1})" ${recordsPage >= pages ? 'disabled' : ''}>›</button>
      </div>`;
  }
}

function changeRecordsPage(page) {
  const pages = Math.max(1, Math.ceil(getFilteredViewRecordOrders().length / 10));
  if (page < 1 || page > pages) return;
  recordsPage = page;
  renderViewRecordsOrdersTable();
}

// Per-row Assignee dropdown listing dashboard users; selecting one persists via
// assignPosOrder(). Falls back to showing the saved assignee even if that user
// is no longer in the active list, so an existing assignment never disappears.
function renderAssigneeSelect(order) {
  const users = Array.isArray(DB.assignableUsers) ? DB.assignableUsers : [];
  const currentId = order.assigned_to_user_id != null ? String(order.assigned_to_user_id) : '';
  const inList = users.some((u) => String(u.id) === currentId);
  const orphan = currentId && !inList && order.assigned_to_name
    ? `<option value="${escapeHtml(currentId)}" selected>${escapeHtml(order.assigned_to_name)}</option>`
    : '';
  const options = users.map((u) =>
    `<option value="${escapeHtml(String(u.id))}" ${String(u.id) === currentId ? 'selected' : ''}>${escapeHtml(u.name)}</option>`
  ).join('');
  return `<select class="rmo-assign-select" aria-label="Assign POS order" onchange="assignPosOrder(${JSON.stringify(String(order.external_id))}, this.value, ${JSON.stringify(String(order.shop_id || ''))})">
    <option value="" ${currentId ? '' : 'selected'}>Unassigned</option>
    ${orphan}${options}
  </select>`;
}

function renderPosOrdersTable() {
  const tbody = document.getElementById('rec-pos-orders-tbody');
  if (!tbody) return;
  const isRmoPage = App.currentPage === 'rmo-management';

  if (isRmoPage) {
    updateRmoFilterOptions();
    const statusCounts = Object.fromEntries((DB.posRawStatusCounts || []).map((row) => [row.display_status, Number(row.count || 0)]));
    const metricValues = {
      total: Number(DB.posRawTotal || 0),
      delivered: statusCounts.Delivered || 0,
      returning: statusCounts.Returning || 0,
      undeliverable: getRmoUndeliverableCount(),
      problematic: getRmoProblematicCount(),
    };
    Object.entries(metricValues).forEach(([key, value]) => {
      const el = document.getElementById(`rmo-metric-${key}`);
      if (el) el.textContent = Number(value || 0).toLocaleString();
    });
  }

  const summaryEl = document.getElementById('pos-orders-status-summary');
  if (summaryEl) {
    const statusStyleMap = {
      New: 'background:var(--info,#3b82f6);color:#fff',
      Confirmed: 'background:#0ea5e9;color:#fff',
      Shipped: 'background:var(--primary,#6366f1);color:#fff',
      Delivered: 'background:var(--success,#22c55e);color:#fff',
      Returning: 'background:var(--danger,#ef4444);color:#fff',
      Returned: 'background:#b91c1c;color:#fff',
      Canceled: 'background:var(--warning,#f59e0b);color:#fff',
      Other: 'background:var(--border,#e2e8f0);color:var(--text-secondary,#64748b)',
    };
    const ORDER = ['New','Confirmed','Shipped','Delivered','Returning','Returned','Canceled','Other'];
    const sorted = [...DB.posRawStatusCounts].sort((a, b) =>
      ORDER.indexOf(a.display_status) - ORDER.indexOf(b.display_status)
    );
    summaryEl.innerHTML = sorted.map(({ display_status: s, count: c }) =>
      `<span class="${isRmoPage ? 'rmo-summary-chip' : ''}" style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;${statusStyleMap[s] || statusStyleMap.Other}">
        ${escapeHtml(s)} <span style="opacity:0.85">${Number(c).toLocaleString()}</span>
      </span>`
    ).join('') + (DB.posRawTotal
      ? `<span class="${isRmoPage ? 'rmo-summary-chip' : ''}" style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--border,#e2e8f0);color:var(--text-secondary,#64748b)">Total ${DB.posRawTotal.toLocaleString()}</span>`
      : '');
  }

  const dash = '<span style="color:var(--text-muted)">—</span>';
  const posStatusMap = {
    new:        ['New',        'badge-info'],
    pending:    ['New',        'badge-info'],
    submitted:  ['Confirmed',  'badge-primary'],
    wait_print: ['Confirmed',  'badge-primary'],
    shipped:    ['Shipped',    'badge-primary'],
    delivered:  ['Delivered',  'badge-success'],
    returning:  ['Returning',  'badge-danger'],
    returned:   ['Returned',   'badge-danger'],
    canceled:   ['Canceled',   'badge-warning'],
    removed:    ['Canceled',   'badge-warning'],
  };
  tbody.innerHTML = DB.posRawOrders.map((order) => {
    const tags = Array.isArray(order.tags) ? order.tags : [];
    const tagLabels = tags.map((tag) => typeof tag === 'string' ? tag : (tag?.name || tag?.tag_name || tag?.label || '')).filter(Boolean);
    const [statusText, statusClass] = posStatusMap[order.status_name] || [
      order.status_name ? order.status_name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null,
      'badge-gray',
    ];
    const statusLabel = statusText
      ? `<span class="badge ${statusClass}">${escapeHtml(statusText)}</span>`
      : dash;
    if (isRmoPage) {
      const product = order.note_product || 'POS order';
      const tagHtml = tagLabels.map((t) => `<span class="rmo-alert-tag">${escapeHtml(t)}</span>`).join('');
      const statusTone = ['returning', 'returned', 'canceled', 'removed'].includes(order.status_name) ? 'danger'
        : order.status_name === 'delivered' ? 'success'
        : ['shipped', 'submitted', 'wait_print'].includes(order.status_name) ? 'primary'
        : 'info';
      const msgId = escapeHtml(order.external_id || '');
      const msgShop = escapeHtml(order.shop_id || '');
      return `<tr>
        <td style="text-align:center;">${order.can_message
          ? `<input type="checkbox" class="rmo-row-check" data-id="${msgId}" data-shop="${msgShop}" data-name="${escapeHtml(order.customer_name || '')}" onchange="onRmoRowCheck()">`
          : '<span class="rmo-muted" title="No Messenger contact for this order">—</span>'}</td>
        <td>
          <div class="rmo-item-main">${escapeHtml(product)}</div>
          <div class="rmo-item-sub">${escapeHtml(order.external_id || '')}${order.tracking_no ? ` - <span class="rmo-copy" data-copy="${escapeHtml(order.tracking_no)}" data-copy-label="Tracking number" onclick="copyRmoField(this)" title="Click to copy">${escapeHtml(order.tracking_no)}</span>` : ''}</div>
          <div class="rmo-item-sub">${escapeHtml(formatPosTimestamp(order.inserted_at || order.date)) || ''}</div>
        </td>
        <td>
          ${(() => { const rider = getRmoRider(order); return `
          <div class="rmo-item-main">${escapeHtml(rider.name || 'Unassigned rider')}</div>
          <div class="rmo-item-sub">${escapeHtml(rider.tel || 'No rider phone')}</div>`; })()}
        </td>
        <td>
          <div class="rmo-item-main rmo-copy" data-copy="${escapeHtml(order.customer_name || '')}" data-copy-label="Customer name" onclick="copyRmoField(this)" title="Click to copy">${escapeHtml(order.customer_name || 'Unknown customer')}</div>
          <div class="rmo-item-sub rmo-copy" data-copy="${escapeHtml(order.customer_phone || '')}" data-copy-label="Phone number" onclick="copyRmoField(this)" title="Click to copy">${escapeHtml(order.customer_phone || 'No phone')}</div>
          <div class="rmo-item-sub">${escapeHtml(order.province || '')}</div>
        </td>
        <td><div class="rmo-item-main">${escapeHtml(order.page_name || '') || dash}</div></td>
        <td class="rmo-money">${Number(order.cod || 0) ? `&#8369;${Number(order.cod || 0).toLocaleString()}` : dash}</td>
        <td>${Number(order.attempts || 0) > 1 ? `<span class="rmo-attempt">${Number(order.attempts || 0)}</span>` : (Number(order.attempts || 0) || dash)}</td>
        <td>${(rmoTab === 'undeliverable' || rmoTab === 'returning') ? (getRmoReasonDisplay(order) ? `<span class="rmo-reason-text">${escapeHtml(getRmoReasonDisplay(order))}</span>` : dash) : (escapeHtml(order.assigning_seller_name || '') || dash)}</td>
        <td><div class="rmo-tag-line">${tagHtml || '<span class="rmo-muted">No tag</span>'}<button class="rmo-tag-edit" onclick="openTagEditor('${msgId}','${msgShop}')" title="Edit tags">&#9998;</button></div></td>
        <td><span class="rmo-status ${statusTone}">${escapeHtml(statusText || 'Unknown')}</span></td>
        ${rmoTab !== 'orders' ? `<td class="rmo-item-sub">${rmoTab === 'delivering' ? (escapeHtml(formatPosTimestamp(order.updated_at)) || dash) : ((rmoTab === 'undeliverable' || rmoTab === 'returning') ? (escapeHtml(order.assigning_seller_name || '') || dash) : (getRmoReasonDisplay(order) ? `<span class="rmo-reason-text">${escapeHtml(getRmoReasonDisplay(order))}</span>` : dash))}</td>` : ''}
        <td><div class="rmo-item-main">${escapeHtml(getRmoCourier(order)) || dash}</div></td>
        <td>
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;">
            ${order.can_message
              ? `<button class="rmo-msg-btn" onclick="openBotcakeSendModal('single','${msgId}','${msgShop}')" title="Send Messenger broadcast">✉ Send</button>`
              : '<span class="rmo-muted">—</span>'}
            ${rmoTab !== 'orders'
              ? `<button class="rmo-msg-btn" data-phone="${escapeHtml(order.customer_phone || '')}" data-name="${escapeHtml(order.customer_name || '')}" onclick="openCustomerNotesModal(this)" ${order.customer_phone ? '' : 'disabled'} title="View / add customer notes">📝 Notes</button>`
              : ''}
          </div>
        </td>
      </tr>`;
    }
    return `<tr>
      <td class="font-mono text-xs">${escapeHtml(order.external_id || '')}</td>
      <td class="font-mono text-xs">${escapeHtml(order.tracking_no || '') || dash}</td>
      <td>${escapeHtml(order.page_name || '') || dash}</td>
      <td>${escapeHtml(order.date || '')}</td>
      <td style="font-weight:500">${escapeHtml(order.customer_name || '') || dash}</td>
      <td class="font-mono text-xs">${escapeHtml(order.customer_phone || '') || dash}</td>
      <td>${escapeHtml(order.note_product || '') || dash}</td>
      <td>${tagLabels.map((t) => `<span class="badge badge-danger" style="margin:1px 2px;">${escapeHtml(t)}</span>`).join('') || dash}</td>
      <td>${order.attempts > 1 ? `<span class="badge badge-warning">${order.attempts}</span>` : (order.attempts || dash)}</td>
      <td>₱${Number(order.cod || 0).toLocaleString()}</td>
      <td>${escapeHtml(order.assigning_seller_name || '') || dash}</td>
      <td>${statusLabel}</td>
      <td>${escapeHtml(order.sprinter_name || '') || dash}</td>
      <td class="font-mono text-xs">${escapeHtml(order.sprinter_tel || '') || dash}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="${isRmoPage ? (rmoTab !== 'orders' ? 12 : 11) : 14}" style="text-align:center;padding:32px;color:var(--text-muted)">No POS orders found.</td></tr>`;

  // The repaint replaced the row checkboxes, so reset the bulk selection bar.
  if (isRmoPage) updateRmoBulkBar();

  const pagination = document.getElementById('pos-orders-pagination');
  if (pagination) {
    const perPage = 50;
    const pages = Math.max(1, Math.ceil(DB.posRawTotal / perPage));
    const start = DB.posRawTotal ? ((posRawPage - 1) * perPage) + 1 : 0;
    const end = Math.min(posRawPage * perPage, DB.posRawTotal);
    pagination.innerHTML = `
      <span>${start}-${end} of ${DB.posRawTotal} POS orders</span>
      <div class="pagination-buttons">
        <button class="page-btn" onclick="changePosRawPage(${posRawPage - 1})" ${posRawPage <= 1 ? 'disabled' : ''}>‹</button>
        ${renderPaginationButtons(posRawPage, pages, 'changePosRawPage')}
        <button class="page-btn" onclick="changePosRawPage(${posRawPage + 1})" ${posRawPage >= pages ? 'disabled' : ''}>›</button>
      </div>`;
  }
}

function renderPosRawOrdersTable() { renderPosOrdersTable(); }

function filterPosOrders() {
  posRawSearch = document.getElementById('rec-pos-search')?.value || '';
  posRawPage = 1;
  refreshPosRawOrdersFromBackend().then(renderPosOrdersTable).catch((error) => {
    showToast('warning', 'POS Orders refresh failed', error.message || 'Could not load POS orders.');
  });
}

function filterPosRawOrders() { filterPosOrders(); }

function applyPosOrdersSearch() {
  posOrdersSearch = document.getElementById('pos-orders-search')?.value || '';
  posRawPage = 1;
  refreshPosRawOrdersFromBackend().then(renderPosOrdersTable).catch((err) => {
    showToast('warning', 'POS Orders filter failed', err.message || 'Could not load POS orders.');
  });
}

function applyPosOrdersDropdown() {
  posOrdersProductFilter = document.getElementById('pos-orders-product')?.value || 'all';
  posOrdersPageFilter = document.getElementById('pos-orders-page')?.value || 'all';
  posOrdersStatusFilter = document.getElementById('pos-orders-status')?.value || 'all';
  posOrdersTagFilter = document.getElementById('pos-orders-tags')?.value || 'all';
  posOrdersAttemptFilter = document.getElementById('pos-orders-attempts')?.value || 'all';
  posOrdersReasonFilter = document.getElementById('pos-orders-reason')?.value || 'all';
  posRawPage = 1;
  refreshPosRawOrdersFromBackend().then(renderPosOrdersTable).catch((err) => {
    showToast('warning', 'POS Orders filter failed', err.message || 'Could not load POS orders.');
  });
}

function setPosOrdersPeriod(period, btn) {
  posOrdersPeriod = period;
  document.querySelectorAll('.rmo-period-bar .filter-pill, #rec-pos-orders .filter-pill').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const customRange = document.getElementById('pos-orders-custom-range');
  if (customRange) customRange.classList.toggle('hidden', period !== 'custom');
  if (period !== 'custom') {
    posRawPage = 1;
    refreshPosRawOrdersFromBackend().then(renderPosOrdersTable).catch((err) => {
      showToast('warning', 'POS Orders filter failed', err.message || 'Could not load POS orders.');
    });
  }
}

// Switch the RMO management view between the regular delivery list and the
// Undeliverable tab. Re-renders the page shell (different filter bar) and
// reloads orders with the tab's params.
function setRmoTab(tab) {
  if (rmoTab === tab) return;
  rmoTab = tab;
  posRawPage = 1;
  posOrdersReasonFilter = 'all'; // reasons differ per tab; don't carry the selection over
  navigateTo('rmo-management');
}

// Undeliverable tab: quick filter on the last status-update date.
function setRmoUpdatePeriod(period, btn) {
  rmoUpdatePeriod = period;
  posRawPage = 1;
  document.querySelectorAll('.rmo-period-bar .filter-pill').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  refreshPosRawOrdersFromBackend().then(renderPosOrdersTable).catch((err) => {
    showToast('warning', 'POS Orders filter failed', err.message || 'Could not load POS orders.');
  });
}

function applyPosOrdersCustomRange() {
  posOrdersDateFrom = document.getElementById('pos-orders-date-from')?.value || '';
  posOrdersDateTo = document.getElementById('pos-orders-date-to')?.value || '';
  posRawPage = 1;
  refreshPosRawOrdersFromBackend().then(renderPosOrdersTable).catch((err) => {
    showToast('warning', 'POS Orders filter failed', err.message || 'Could not load POS orders.');
  });
}

function refreshPosOrdersNow() {
  refreshPosRawOrdersFromBackend()
    .then(() => {
      renderPosOrdersTable();
      showToast('success', 'POS Orders refreshed', 'Latest POS order data loaded.');
    })
    .catch((error) => {
      showToast('warning', 'POS Orders refresh failed', error.message || 'Could not load POS orders.');
    });
}

async function deletePosRawNoContact() {
  if (!confirm('Delete all POS raw orders that have neither a phone number nor a customer name? This cannot be undone.')) return;
  try {
    const result = await apiFetch('/api/orders/pos-orders/no-contact', { method: 'DELETE' });
    showToast('success', 'Deleted', `Removed ${result.deleted || 0} anonymous POS raw orders.`);
    posRawPage = 1;
    refreshPosRawOrdersFromBackend().then(renderPosRawOrdersTable);
  } catch (error) {
    showToast('error', 'Delete failed', error.message || 'Could not delete POS raw orders.');
  }
}

function changePosRawPage(page) {
  const pages = Math.max(1, Math.ceil(DB.posRawTotal / 50));
  if (page < 1 || page > pages) return;
  posRawPage = page;
  refreshPosRawOrdersFromBackend().then(renderPosOrdersTable).catch((error) => {
    showToast('warning', 'POS Orders refresh failed', error.message || 'Could not load POS orders.');
  });
}

function filterViewRecordsTable() {
  recordsSearch = document.getElementById('rec-orders-search')?.value || '';
  recordsPage = 1;
  renderViewRecordsOrdersTable();
  refreshRecordsSummaryFromBackend().catch(() => {});
}

function filterRecordsByProduct() {
  recordsProductFilter = document.getElementById('rec-orders-product')?.value || 'all';
  recordsPage = 1;
  renderViewRecordsOrdersTable();
  refreshRecordsSummaryFromBackend().catch(() => {});
}

function filterRecordsBySource() {
  recordsSourceFilter = document.getElementById('rec-orders-source')?.value || 'all';
  recordsPage = 1;
  renderViewRecordsOrdersTable();
  refreshRecordsSummaryFromBackend().catch(() => {});
}

function filterRecordsByPosTag() {
  recordsPosTagFilter = document.getElementById('rec-orders-pos-tag')?.value || 'all';
  recordsPage = 1;
  renderViewRecordsOrdersTable();
  refreshRecordsSummaryFromBackend().catch(() => {});
}

function filterRecordsByYear() {
  recordsYearFilter = document.getElementById('rec-orders-year')?.value || 'all';
  recordsMonthFilter = 'all';
  const monthSelect = document.getElementById('rec-orders-month');
  if (monthSelect) {
    const months = getOrderMonthOptions(recordsYearFilter === 'all' ? '' : recordsYearFilter);
    monthSelect.innerHTML = `<option value="all">All Months</option>${months.map((month) => `<option value="${month.value}">${month.label}</option>`).join('')}`;
  }
  recordsPage = 1;
  renderViewRecordsOrdersTable();
  refreshRecordsSummaryFromBackend().catch(() => {});
}

function filterRecordsByMonth() {
  recordsMonthFilter = document.getElementById('rec-orders-month')?.value || 'all';
  recordsPage = 1;
  renderViewRecordsOrdersTable();
  refreshRecordsSummaryFromBackend().catch(() => {});
}

function addCourierOption() {
  const input = document.getElementById('records-new-courier');
  const value = input?.value.trim();
  if (!value) {
    showToast('warning', 'Courier required', 'Enter a courier name first.');
    return;
  }
  saveCourierOptions([...getCourierOptions(), value]);
  showToast('success', 'Courier added', value);
  loadPage('view-records');
}

function removeCourierOption() {
  const value = document.getElementById('records-remove-courier')?.value || '';
  if (!value) return;
  const inUse = DB.orders.some((order) => normalizeText(order.courier) === normalizeText(value));
  if (inUse) {
    showToast('warning', 'Courier is in use', 'Edit those orders to another courier before removing it from the list.');
    return;
  }
  saveCourierOptions(loadCourierOptions().filter((courier) => courier !== value));
  showToast('success', 'Courier removed', value);
  loadPage('view-records');
}

async function editOrderRecord(orderId) {
  const order = getOrderById(orderId);
  if (!order) {
    showToast('error', 'Order not found', 'The selected order is not available.');
    return;
  }

  const tracking = window.prompt('Tracking number', order.tracking || '');
  if (tracking === null) return;
  const pageName = window.prompt('Page / sheet name', order.sourceSheet || 'Manual');
  if (pageName === null) return;
  const tags = window.prompt('Tags', order.tags || '');
  if (tags === null) return;
  const courier = window.prompt(`Courier (${getCourierOptions().join(', ')})`, order.courier || '');
  if (courier === null) return;

  const payload = {
    tracking_no: tracking.trim(),
    source_sheet: pageName.trim() || 'Manual',
    tags: tags.trim(),
    courier: courier.trim(),
  };

  try {
    if (order.dbId && getApiBase()) {
      await authorizedJsonRequest(`/orders/${order.dbId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      await refreshOrdersFromBackend();
    } else {
      order.tracking = payload.tracking_no;
      order.sourceSheet = payload.source_sheet;
      order.tags = payload.tags;
      order.courier = payload.courier;
    }
    saveCourierOptions([...getCourierOptions(), payload.courier]);
    showToast('success', 'Order updated', `${order.id} was saved.`);
    renderViewRecordsOrdersTable();
  } catch (error) {
    showToast('error', 'Update failed', error.message || 'Could not update order.');
  }
}

async function deleteOrderRecord(orderId) {
  const order = getOrderById(orderId);
  if (!order) {
    showToast('error', 'Order not found', 'The selected order is not available.');
    return;
  }
  if (!window.confirm(`Delete ${order.id}? This removes the synced/local dashboard record.`)) return;

  try {
    if (order.dbId && getApiBase()) {
      await authorizedJsonRequest(`/orders/${order.dbId}`, { method: 'DELETE' });
      await refreshOrdersFromBackend();
    } else {
      DB.orders = DB.orders.filter((item) => item !== order);
    }
    showToast('success', 'Order deleted', order.id);
    renderViewRecordsOrdersTable();
  } catch (error) {
    showToast('error', 'Delete failed', error.message || 'Could not delete order.');
  }
}

function setRecordsPosStatusFilter(status, btn) {
  recordsPosStatusFilter = status;
  recordsPage = 1;
  document.querySelectorAll('#rec-orders-pos-status-filters .filter-pill').forEach((pill) => pill.classList.remove('active'));
  btn.classList.add('active');
  renderViewRecordsOrdersTable();
}

function setRecordsDateFilter(filter, btn) {
  recordsDateFilter = filter;
  recordsPage = 1;
  document.querySelectorAll('#rec-orders-date-filters .filter-pill').forEach((pill) => pill.classList.remove('active'));
  btn.classList.add('active');

  if (filter !== 'custom') {
    recordsDateFrom = '';
    recordsDateTo = '';
  }

  const customRange = document.getElementById('rec-orders-custom-range');
  if (customRange) customRange.classList.toggle('hidden', filter !== 'custom');

  const fromInput = document.getElementById('rec-orders-date-from');
  const toInput = document.getElementById('rec-orders-date-to');
  if (fromInput && filter !== 'custom') fromInput.value = '';
  if (toInput && filter !== 'custom') toInput.value = '';

  renderViewRecordsOrdersTable();
  refreshRecordsSummaryFromBackend().catch(() => {});
}

function applyRecordsCustomDateRange() {
  recordsDateFrom = document.getElementById('rec-orders-date-from')?.value || '';
  recordsDateTo = document.getElementById('rec-orders-date-to')?.value || '';
  recordsPage = 1;
  renderViewRecordsOrdersTable();
  refreshRecordsSummaryFromBackend().catch(() => {});
}

// ─── SCAN ──────────────────────────────────────────────────
async function performScan(pageId, scanType) {
  const input = document.getElementById(`scan-input-${pageId}`);
  const tracking = input?.value?.trim();
  if (!tracking) { showToast('warning', 'No input', 'Please enter a tracking number'); return; }

  const resultEl = document.getElementById(`scan-result-${pageId}`);

  // Look up in existing records
  let found = DB.scanRecords.find(r => r.tracking.toLowerCase() === tracking.toLowerCase());

  if (!found && getApiBase() && getAuthToken()) {
    try {
      const row = await authorizedJsonRequest(`/scans/lookup/${encodeURIComponent(tracking)}`);
      found = {
        tracking: row.tracking_no || tracking,
        customer: row.customer || 'Unknown Customer',
        phone: row.phone || 'N/A',
        product: row.product_name || '',
        province: row.province_city || '',
        date: normalizeDateString(row.scan_date || row.order_date || new Date()),
        status: row.status || (scanType === 'RTS' ? 'Return to Sender' : 'For Delivery'),
        courier: row.courier || 'Unknown',
        type: scanType,
      };
    } catch {}
  }

  if (!found) {
    // Also check orders
    const order = DB.orders.find(o => o.tracking.toLowerCase() === tracking.toLowerCase());
    if (order) {
      found = {
        tracking: order.tracking,
        customer: order.customer,
        phone: order.phone,
        date: order.date,
        status: order.status,
        courier: order.courier,
        type: scanType,
      };
    }
  }

  if (!found) {
    // Create a new scan entry
    found = {
      tracking,
      customer: 'Unknown Customer',
      phone: 'N/A',
      date: new Date().toISOString().split('T')[0],
      status: scanType === 'RTS' ? 'Return to Sender' : 'For Delivery',
      courier: 'Unknown',
      type: scanType,
    };
  }

  // Scan date: honour the date picker if present (RTS scanner lets you back-date
  // a scan); otherwise default to today.
  const today = new Date().toISOString().split('T')[0];
  const dateEl = document.getElementById(`scan-date-${pageId}`);
  const scanDate = (dateEl && dateEl.value) || today;

  // Fast local pre-check: block if this tracking was already scanned on the
  // selected date in this session
  const alreadyLocal = DB.scanRecords.some(
    (r) => r.tracking.toLowerCase() === tracking.toLowerCase() && r.type === scanType && r.date === scanDate
  );
  if (alreadyLocal) {
    showToast('warning', 'Already scanned', `${tracking} was already scanned today.`);
    resultEl.innerHTML = `<div class="scan-result-card" style="border-color:var(--warning);"><div class="scan-result-header" style="color:var(--warning);">Already Scanned Today</div><div class="scan-result-body"><div class="scan-field"><div class="scan-field-label">Tracking No.</div><div class="scan-field-value font-mono">${escapeHtml(tracking)}</div></div><div class="scan-field"><div class="scan-field-label">Note</div><div class="scan-field-value">This tracking number was already scanned today and will not be counted again.</div></div></div></div>`;
    input.value = '';
    input.focus();
    return;
  }

  // Add to scan records
  const newRecord = {
    id: `SCN-${String(DB.scanRecords.length + 1).padStart(4, '0')}`,
    ...found,
    type: scanType,
    date: scanDate,
  };

  if (getApiBase() && getAuthToken()) {
    try {
      await authorizedJsonRequest('/scans', {
        method: 'POST',
        body: JSON.stringify({
          tracking_no: newRecord.tracking,
          customer: newRecord.customer,
          phone: newRecord.phone,
          status: newRecord.status,
          courier: newRecord.courier,
          scan_type: scanType,
          scan_date: newRecord.date,
        }),
      });
      DB.scanRecords.unshift(newRecord);
    } catch (error) {
      // 409 = already scanned (caught by server); surface as a warning, not a success
      if (error?.status === 409 || String(error?.message || '').toLowerCase().includes('already scanned')) {
        showToast('warning', 'Already scanned', `${tracking} was already scanned today.`);
        resultEl.innerHTML = `<div class="scan-result-card" style="border-color:var(--warning);"><div class="scan-result-header" style="color:var(--warning);">Already Scanned Today</div><div class="scan-result-body"><div class="scan-field"><div class="scan-field-label">Tracking No.</div><div class="scan-field-value font-mono">${escapeHtml(tracking)}</div></div><div class="scan-field"><div class="scan-field-label">Note</div><div class="scan-field-value">This tracking number was already scanned today and will not be counted again.</div></div></div></div>`;
        input.value = '';
        input.focus();
        return;
      }
      DB.scanRecords.unshift(newRecord);
      showToast('warning', 'Saved locally', error.message || 'The scan could not be saved to the server.');
    }
  } else {
    DB.scanRecords.unshift(newRecord);
  }

  resultEl.innerHTML = `
    <div class="scan-result-card">
      <div class="scan-result-header">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px"><path d="M3 2h2v4H3zM7 2h2v4H7zM11 2h2v4h-2z"/></svg>
        Tracking Result — ${scanType === 'RTS' ? 'Return to Sender' : 'Standard Scan'}
      </div>
      <div class="scan-result-body">
        <div class="scan-field"><div class="scan-field-label">Page</div><div class="scan-field-value">${scanType === 'RTS' ? 'RTS Scanning' : 'Scanning'}</div></div>
        <div class="scan-field"><div class="scan-field-label">Tracking No.</div><div class="scan-field-value font-mono">${found.tracking}</div></div>
        <div class="scan-field"><div class="scan-field-label">Customer Name</div><div class="scan-field-value">${found.customer}</div></div>
        <div class="scan-field"><div class="scan-field-label">Phone Number</div><div class="scan-field-value font-mono">${found.phone}</div></div>
        ${found.product ? `<div class="scan-field"><div class="scan-field-label">Product</div><div class="scan-field-value">${escapeHtml(found.product)}</div></div>` : ''}
        ${found.province ? `<div class="scan-field"><div class="scan-field-label">Province/City</div><div class="scan-field-value">${escapeHtml(found.province)}</div></div>` : ''}
        <div class="scan-field"><div class="scan-field-label">Attempt Date</div><div class="scan-field-value">${new Date(scanDate + 'T00:00:00').toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' })}</div></div>
        <div class="scan-field"><div class="scan-field-label">Order Status</div><div class="scan-field-value">${statusBadge(found.status)}</div></div>
        <div class="scan-field"><div class="scan-field-label">Courier</div><div class="scan-field-value">${found.courier}</div></div>
      </div>
    </div>`;

  showToast('success', 'Scan recorded', `${tracking} — ${found.customer}`);
  input.value = '';
  input.focus();
  loadScanPreviewForPage(pageId, scanType).catch(() => {});
  loadScanToday(pageId, scanType).catch(() => {});
  loadScanPageSummary(pageId, scanType).catch(() => {});
}

// ─── EXPENSE HELPERS ───────────────────────────────────────
function openExpenseModal() {
  const dateEl = document.getElementById('exp-date');
  if (dateEl) dateEl.value = new Date().toISOString().split('T')[0];
  ['exp-cat','exp-item','exp-price','exp-total'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = id === 'exp-cat' ? '' : '';
  });
  const qtyEl = document.getElementById('exp-qty');
  if (qtyEl) qtyEl.value = '1';
  const clsEl = document.getElementById('exp-class');
  if (clsEl) clsEl.value = 'OPEX';
  openModal('expense-log-modal');
}

function calcExpTotal() {
  const qty = parseFloat(document.getElementById('exp-qty')?.value || 0);
  const price = parseFloat(document.getElementById('exp-price')?.value || 0);
  const total = qty * price;
  const el = document.getElementById('exp-total');
  if (el) el.value = total > 0 ? total.toFixed(2) : '';
}

async function loadExpensesFromBackend() {
  try {
    const result = await authorizedJsonRequest('/expenses?per_page=500');
    const rows = Array.isArray(result?.data) ? result.data : [];
    DB.expenses = rows.map((r) => ({
      id: r.expense_ref || `EXP-${r.id}`,
      date: r.exp_date || '',
      category: r.category || 'Others',
      classification: r.classification || 'OPEX',
      item: r.item_name || '',
      qty: Number(r.quantity || 1),
      price: Number(r.unit_price || 0),
      total: Number(r.quantity || 1) * Number(r.unit_price || 0),
      noted: r.noted_by || '',
    }));
  } catch (e) {
    // keep existing DB.expenses if fetch fails
  }
}

async function saveExpense() {
  const date = document.getElementById('exp-date')?.value;
  const category = document.getElementById('exp-cat')?.value;
  const classification = document.getElementById('exp-class')?.value || 'OPEX';
  const item = document.getElementById('exp-item')?.value;
  const qty = parseInt(document.getElementById('exp-qty')?.value || 0);
  const price = parseFloat(document.getElementById('exp-price')?.value || 0);
  const noted = document.getElementById('exp-noted')?.value || App.user?.full_name || App.user?.name || '';

  if (!date || !category || !item || qty < 1 || price <= 0) {
    showToast('error', 'Validation failed', 'Please fill in all required fields.');
    return;
  }

  try {
    await authorizedJsonRequest('/expenses', {
      method: 'POST',
      body: JSON.stringify({
        exp_date: date,
        category,
        classification,
        item_name: item,
        quantity: qty,
        unit_price: price,
        noted_by: noted,
      }),
    });
    showToast('success', 'Expense saved', `${item} — ₱${(qty * price).toLocaleString()}`);
    closeModal('expense-log-modal');
    await loadExpensesFromBackend();
    if (App.currentPage === 'expenses') {
      document.getElementById('main-page-content').innerHTML = renderExpenses();
      loadExpenseCredits().catch(() => {});
    }
  } catch (err) {
    showToast('error', 'Save failed', err.message || 'Could not save expense.');
  }
}

// ─── PICKUP HELPERS ────────────────────────────────────────
function selectOrders(val, btn) {
  document.querySelectorAll('[id^="orders-pill-"]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const custom = document.getElementById('pu-orders-custom');
  const hidden = document.getElementById('pu-orders');
  if (val === 'Others') {
    custom.classList.remove('hidden');
    hidden.value = '';
  } else {
    custom.classList.add('hidden');
    hidden.value = val;
  }
}

function savePickup() {
  const date = document.getElementById('pu-date')?.value;
  const product = document.getElementById('pu-product')?.value;
  const type = document.getElementById('pu-type')?.value;
  const pieces = document.getElementById('pu-pieces')?.value;
  const notes = document.getElementById('pu-notes')?.value || '';
  let orders = document.getElementById('pu-orders')?.value;
  if (!orders) orders = document.getElementById('pu-orders-custom')?.value;

  if (!date || !product || !pieces || !orders) {
    showToast('error', 'Incomplete form', 'Please fill in all required fields.'); return;
  }

  const newPU = {
    id: `PU-${String(DB.dailyPickups.length + 1).padStart(4, '0')}`,
    date, product, type, customerOrders: parseInt(orders),
    totalPieces: parseInt(pieces), notes,
  };

  DB.dailyPickups.unshift(newPU);

  const tbody = document.getElementById('pickup-tbody');
  if (tbody) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="font-mono text-xs text-muted">${newPU.id}</td>
      <td>${newPU.date}</td>
      <td style="font-weight:500">${newPU.product}</td>
      <td><span class="badge ${newPU.type==='Product'?'badge-info':'badge-gray'}">${newPU.type}</span></td>
      <td>${newPU.customerOrders}</td>
      <td>${newPU.totalPieces}</td>
      <td class="text-secondary text-sm">${newPU.notes||'—'}</td>`;
    tbody.insertBefore(row, tbody.firstChild);
  }

  showToast('success', 'Pickup saved', `${product} — ${pieces} pieces`);

  ['pu-notes','pu-pieces'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('pu-orders').value = '';
  document.querySelectorAll('[id^="orders-pill-"]').forEach(b => b.classList.remove('active'));
}

// ─── INVENTORY HELPERS ─────────────────────────────────────
async function saveInventoryItem() {
  if (!canManageInventoryStock()) {
    showToast('warning', 'Not allowed', 'Only administrators and logistics staff can add inventory items.');
    return;
  }
  const name = document.getElementById('inv-name')?.value;
  const sku = document.getElementById('inv-sku')?.value;
  const type = document.getElementById('inv-type')?.value;
  const unit = document.getElementById('inv-unit')?.value || 'pcs';
  const stock = parseInt(document.getElementById('inv-stock')?.value || 0);
  const cost = parseFloat(document.getElementById('inv-cost')?.value || 0);

  if (!name) { showToast('error', 'Name required', 'Please enter item name'); return; }

  try {
    await authorizedJsonRequest('/inventory', {
      method: 'POST',
      body: JSON.stringify({
        name,
        sku: sku || null,
        type,
        unit,
        stock,
        cost_price: cost,
        reorder_pt: type === 'Product' ? 200 : 15,
      }),
    });
    await refreshInventoryFromBackend();
  } catch {
    DB.inventory.push({
      id: `P${String(DB.inventory.length + 1).padStart(3,'0')}`,
      name,
      sku: sku || `SKU-${String(DB.inventory.length+1).padStart(3,'0')}`,
      type,
      unit,
      stock,
      cost,
      price: null,
      reorder: type === 'Product' ? 200 : 15,
    });
  }
  closeModal('add-inventory-modal');
  showToast('success', 'Item added', name);
  navigateTo('inventory');
}

async function updateStock() {
  if (!canManageInventoryStock()) {
    showToast('warning', 'Not allowed', 'Only administrators and logistics staff can edit inventory stock.');
    return;
  }
  const itemId = document.getElementById('stocks-item')?.value;
  const action = document.getElementById('stocks-action')?.value;
  const qty = parseInt(document.getElementById('stocks-qty')?.value || 0);

  const item = DB.inventory.find(i => i.id === itemId);
  if (!item || qty < 0) { showToast('error', 'Invalid input', 'Please check your inputs'); return; }

  if (action === 'add') item.stock += qty;
  else if (action === 'remove') item.stock = Math.max(0, item.stock - qty);
  else item.stock = qty;

  try {
    await authorizedJsonRequest(`/inventory/${encodeURIComponent(item.id)}/stock`, {
      method: 'PATCH',
      body: JSON.stringify({
        action,
        qty,
        notes: document.getElementById('stocks-notes')?.value || '',
      }),
    });
    await refreshInventoryFromBackend();
  } catch {}

  closeModal('stocks-modal');
  showToast('success', 'Stock updated', `${item.name} — ${item.stock} ${item.unit}`);
  navigateTo('inventory');
}

// Toggle an inventory item active (on) / closed (off) via the switch in the Stock table.
async function toggleInventoryActive(itemId, active) {
  if (!canManageInventoryStock()) {
    showToast('warning', 'Not allowed', 'Only administrators and logistics staff can edit inventory.');
    return;
  }
  const item = DB.inventory.find(i => i.id === itemId);
  if (!item) return;
  const prev = item.active;
  item.active = active ? 1 : 0;
  try {
    await authorizedJsonRequest(`/inventory/${encodeURIComponent(itemId)}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ active: !!active }),
    });
    rerenderInventoryTables();
    showToast('success', active ? 'Item activated' : 'Item closed', item.name);
  } catch (error) {
    item.active = prev;
    rerenderInventoryTables();
    showToast('error', 'Update failed', error.message || 'Could not update item.');
  }
}

// Inline-edit an item's reorder point from the Stock table.
async function updateReorderPoint(itemId, value) {
  if (!canManageInventoryStock()) {
    showToast('warning', 'Not allowed', 'Only administrators and logistics staff can edit inventory.');
    return;
  }
  const item = DB.inventory.find(i => i.id === itemId);
  if (!item) return;
  const reorder = Math.max(0, parseInt(value, 10) || 0);
  const prev = item.reorder;
  if (reorder === prev) return;
  item.reorder = reorder;
  try {
    await authorizedJsonRequest(`/inventory/${encodeURIComponent(itemId)}/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ reorder_pt: reorder }),
    });
    rerenderInventoryTables();
    showToast('success', 'Reorder point updated', `${item.name} — ${reorder} ${item.unit}`);
  } catch (error) {
    item.reorder = prev;
    rerenderInventoryTables();
    showToast('error', 'Update failed', error.message || 'Could not update reorder point.');
  }
}

// ─── RECORDS HELPERS ───────────────────────────────────────
function filterRecordsTable(tbodyId, query) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr');
  const q = query.toLowerCase();
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

function filterRecordsByStatus(tbodyId, status, btn) {
  document.querySelectorAll('#rec-orders .filter-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr');
  rows.forEach(row => {
    const s = row.dataset.status;
    row.style.display = (status === 'All' || s === status) ? '' : 'none';
  });
}

function filterExpTable() {
  const q = (document.getElementById('exp-search')?.value || '').toLowerCase();
  const rows = document.querySelectorAll('#exp-tbody tr');
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

function setExpCatFilter(cat, btn) {
  document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const rows = document.querySelectorAll('#exp-tbody tr');
  rows.forEach(row => {
    const catCell = row.cells[2]?.textContent?.trim();
    row.style.display = (cat === 'All' || catCell === cat) ? '' : 'none';
  });
}

// ─── EXPORT CSV ────────────────────────────────────────────
function collectGoogleSheetsFormState() {
  const previous = getIntegrationState().googleSheets;
  return {
    enabled: Boolean(document.getElementById('google-sheets-enabled')?.checked),
    syncMode: document.getElementById('google-sheets-sync-mode')?.value || 'manual',
    spreadsheetId: (document.getElementById('google-sheets-spreadsheet-id')?.value || '').trim(),
    sheetName: (document.getElementById('google-sheets-sheet-name')?.value || '').trim(),
    serviceAccountEmail: (document.getElementById('google-sheets-service-account-email')?.value || '').trim(),
    privateKey: document.getElementById('google-sheets-private-key')?.value || '',
    syncIntervalMinutes: (document.getElementById('google-sheets-sync-interval-minutes')?.value || '5').trim(),
    notes: (document.getElementById('google-sheets-notes')?.value || '').trim(),
    lastSavedAt: new Date().toISOString(),
    lastCollectedAt: previous.lastCollectedAt || null,
    lastCollectionSummary: previous.lastCollectionSummary || '',
  };
}

function formatPancakePosConnections(connections = []) {
  return connections
    .filter((connection) => connection && (connection.apiKey || connection.api_key || connection.shopId || connection.shop_id))
    .filter((connection) => connection.id !== 'primary')
    .map((connection) => {
      const cols = [
        connection.name || '',
        connection.apiKey || connection.api_key || '',
        connection.shopId || connection.shop_id || '',
        connection.baseUrl || connection.base_url || '',
        connection.messagingPageId || connection.messaging_page_id || '',
        connection.pageAccessToken || connection.page_access_token || '',
      ];
      // Trim trailing empty columns
      while (cols.length > 3 && !cols[cols.length - 1]) cols.pop();
      return cols.join(' | ');
    })
    .join('\n');
}

function parsePancakePosConnections(text = '', fallbackBaseUrl = 'https://pos.pages.fm/api/v1', fallbackSyncMode = 'pull_only') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line, index) => {
      const parts = line.split('|').map((part) => part.trim());
      if (parts.length < 3) return null;
      const [name, apiKey, shopId, baseUrl, messagingPageId, pageAccessToken] = parts;
      if (!apiKey || !shopId) return null;
      return {
        id: `${normalizeText(name || shopId) || 'pos'}-${index + 1}`,
        name: name || `POS ${index + 1}`,
        enabled: true,
        syncMode: fallbackSyncMode,
        baseUrl: baseUrl || fallbackBaseUrl,
        apiKey,
        shopId,
        messagingPageId: messagingPageId || '',
        pageAccessToken: pageAccessToken || '',
      };
    })
    .filter(Boolean);
}

function collectPancakePosFormState() {
  const previous = getIntegrationState().pancakePos;
  const syncMode = document.getElementById('pancake-pos-sync-mode')?.value || 'pull_only';
  const baseUrl = (document.getElementById('pancake-pos-base-url')?.value || 'https://pos.pages.fm/api/v1').trim();
  const primaryApiKey = (document.getElementById('pancake-pos-api-key')?.value || '').trim();
  const primaryShopName = (document.getElementById('pancake-pos-shop-name')?.value || '').trim();
  const primaryShopId = (document.getElementById('pancake-pos-shop-id')?.value || '').trim();
  const pageId = (document.getElementById('pancake-pos-page-id')?.value || '').trim();
  const owner = (document.getElementById('pancake-pos-owner')?.value || '').trim();
  const pancakeToken = (document.getElementById('pancake-pos-pancake-token')?.value || '').trim();
  const botcakeToken = (document.getElementById('pancake-pos-botcake-token')?.value || '').trim();
  const extraConnections = parsePancakePosConnections(
    document.getElementById('pancake-pos-connections')?.value || '',
    baseUrl,
    syncMode
  );
  const primaryConnection = primaryShopId && (primaryApiKey || primaryShopName) ? [{
    id: 'primary',
    name: primaryShopName || `Shop ${primaryShopId}`,
    enabled: true,
    syncMode,
    baseUrl,
    apiKey: primaryApiKey,
    shopName: primaryShopName,
    shopId: primaryShopId,
    // Page ID drives the Pancake messaging API; Pancake token is the page token.
    messagingPageId: pageId || undefined,
    pageAccessToken: pancakeToken || undefined,
    owner: owner || undefined,
    botcakeToken: botcakeToken || undefined,
  }] : [];
  return {
    enabled: Boolean(document.getElementById('pancake-pos-enabled')?.checked),
    syncMode,
    baseUrl,
    apiKey: primaryApiKey,
    shopId: primaryShopId,
    pageId,
    owner,
    pancakeToken,
    botcakeToken,
    connections: [...primaryConnection, ...extraConnections],
    notes: (document.getElementById('pancake-pos-notes')?.value || '').trim(),
    lastSavedAt: new Date().toISOString(),
    lastCollectedAt: previous.lastCollectedAt || null,
    lastCollectionSummary: previous.lastCollectionSummary || '',
  };
}

async function syncPancakePosConfigToBackend(settings) {
  const connectionPayload = (settings.connections || [])
    .filter((connection) => connection.apiKey || connection.api_key || connection.shopId || connection.shop_id || connection.name)
    .map((connection) => ({
      id: connection.id,
      name: connection.name,
      enabled: connection.enabled,
      sync_mode: connection.syncMode || connection.sync_mode || settings.syncMode,
      base_url: connection.baseUrl || connection.base_url || settings.baseUrl,
      api_key: connection.apiKey || connection.api_key,
      shop_id: connection.shopId || connection.shop_id,
      messaging_page_id: connection.messagingPageId || connection.messaging_page_id || undefined,
      page_access_token: connection.pageAccessToken || connection.page_access_token || undefined,
      owner: connection.owner || undefined,
      botcake_token: connection.botcakeToken || connection.botcake_token || undefined,
      notes: connection.notes || '',
    }));
  const payload = {
    enabled: settings.enabled,
    base_url: settings.baseUrl,
    page_id: settings.shopId || undefined,
    sync_mode: settings.syncMode,
    notes: settings.notes,
  };
  if (settings.apiKey) payload.api_key = settings.apiKey;
  if (connectionPayload.length) payload.connections = connectionPayload;

  return authorizedJsonRequest('/integrations/pancake-pos/config', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function syncGoogleSheetsConfigToBackend(settings) {
  const payload = {
    enabled: settings.enabled,
    spreadsheet_id: settings.spreadsheetId,
    sheet_name: settings.sheetName,
    sync_mode: settings.syncMode,
    sync_interval_ms: Math.max(1, Number(settings.syncIntervalMinutes || 5)) * 60 * 1000,
    notes: settings.notes,
  };
  if (settings.serviceAccountEmail) payload.service_account_email = settings.serviceAccountEmail;
  if (settings.privateKey && settings.privateKey.trim()) payload.private_key = settings.privateKey;

  return authorizedJsonRequest('/integrations/google-sheets/config', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

function saveGoogleSheetsConnection() {
  const state = getIntegrationState();
  state.googleSheets = collectGoogleSheetsFormState();

  saveIntegrationState(state);
  syncGoogleSheetsConfigToBackend(state.googleSheets)
    .then(() => {
      showToast('success', 'Google Sheets saved', 'The spreadsheet connection was saved to the dashboard backend.');
    })
    .catch(() => {
      showToast('warning', 'Saved locally only', 'The browser settings were saved, but the backend Google Sheets config endpoint was not reachable.');
    });
}

function savePancakePosConnection() {
  const state = getIntegrationState();
  state.pancakePos = collectPancakePosFormState();

  saveIntegrationState(state);
  syncPancakePosConfigToBackend(state.pancakePos)
    .then(() => {
      showToast('success', 'POS connection saved', 'Pancake POS API settings were saved to the dashboard backend.');
    })
    .catch(() => {
      showToast('warning', 'Saved locally only', 'The browser POS settings were saved, but the backend config endpoint was not reachable.');
    });
}

async function fetchPancakePosShops() {
  const state = getIntegrationState();
  state.pancakePos = collectPancakePosFormState();
  saveIntegrationState(state);

  if (!state.pancakePos.apiKey) {
    showToast('warning', 'POS API key required', 'Enter the Pancake POS API key first.');
    return;
  }

  try {
    await syncPancakePosConfigToBackend(state.pancakePos);
    const data = await authorizedJsonRequest('/integrations/pancake-pos/shops', {
      method: 'POST',
      body: JSON.stringify({
        api_key: state.pancakePos.apiKey,
        base_url: state.pancakePos.baseUrl,
      }),
    });

    const shops = Array.isArray(data.shops) ? data.shops : [];
    if (!shops.length) {
      showToast('warning', 'No shops returned', 'The POS API key worked, but Pancake POS did not return shops.');
      return;
    }

    const firstShop = shops[0];
    const shopInput = document.getElementById('pancake-pos-shop-id');
    const nameInput = document.getElementById('pancake-pos-shop-name');
    if (shopInput) shopInput.value = firstShop.id || '';
    if (nameInput && firstShop.name) nameInput.value = firstShop.name;
    showToast('success', 'POS shops loaded', `Found ${shops.length} shop(s). Filled shop_id with ${firstShop.name || firstShop.id}.`);
  } catch (error) {
    showToast('error', 'Get POS Shops failed', error.message || 'Could not load shops from Pancake POS.');
  }
}

// Validate the POS token live against the Pancake POS shops API.
async function validatePosToken() {
  const apiKey = (document.getElementById('pancake-pos-api-key')?.value || '').trim();
  const baseUrl = (document.getElementById('pancake-pos-base-url')?.value || 'https://pos.pages.fm/api/v1').trim();
  if (!apiKey) {
    showToast('warning', 'POS token required', 'Enter the POS token before validating.');
    return;
  }
  showToast('info', 'Validating POS token…', 'Checking the token against Pancake POS.');
  try {
    const data = await authorizedJsonRequest('/integrations/pancake-pos/shops', {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey, base_url: baseUrl }),
    });
    const shops = Array.isArray(data?.shops) ? data.shops : [];
    showToast('success', 'POS token is valid', shops.length
      ? `Connected — ${shops.length} shop(s) accessible.`
      : 'Pancake POS accepted the token.');
  } catch (error) {
    showToast('error', 'POS token invalid', error.message || 'Pancake POS rejected this token.');
  }
}

// Validate Pancake/Botcake tokens through backend endpoints so secrets do not
// need to be exposed after they are saved.
async function validateIntegrationToken(kind) {
  const map = {
    pancake: {
      id: 'pancake-pos-pancake-token',
      label: 'Pancake token',
      endpoint: '/integrations/pancake-pos/validate-page-token',
    },
    botcake: {
      id: 'pancake-pos-botcake-token',
      label: 'Botcake token',
      endpoint: '/integrations/pancake-pos/validate-botcake-token',
    },
  };
  const cfg = map[kind];
  if (!cfg) return;
  const value = (document.getElementById(cfg.id)?.value || '').trim();
  const pageId = (document.getElementById('pancake-pos-page-id')?.value || '').trim();
  const state = getIntegrationState();
  const primary = (state.pancakePos.connections || []).find((connection) => connection.id === 'primary') || state.pancakePos.connections?.[0] || {};
  const hasSavedToken = kind === 'pancake'
    ? Boolean(primary.hasPageToken || state.pancakePos.hasPageToken)
    : Boolean(primary.hasBotcakeToken || state.pancakePos.hasBotcakeToken);

  if (!pageId && !(primary.messagingPageId || primary.messaging_page_id || state.pancakePos.pageId)) {
    showToast('warning', 'Page ID required', `Enter the Page ID before validating the ${cfg.label.toLowerCase()}.`);
    return;
  }
  if (!value && !hasSavedToken) {
    showToast('warning', `${cfg.label} required`, `Enter the ${cfg.label.toLowerCase()} before validating.`);
    return;
  }

  showToast('info', `Validating ${cfg.label}...`, 'Checking the saved connection against Pancake.');
  try {
    const data = await authorizedJsonRequest(cfg.endpoint, {
      method: 'POST',
      body: JSON.stringify({
        connection_id: primary.id || 'primary',
        page_id: pageId || primary.messagingPageId || primary.messaging_page_id || state.pancakePos.pageId,
        page_access_token: kind === 'pancake' ? value || undefined : undefined,
        botcake_token: kind === 'botcake' ? value || undefined : undefined,
      }),
    });

    if (kind === 'pancake') {
      const totalUsers = Number(data.active_users || 0) + Number(data.disabled_users || 0);
      showToast('success', 'Pancake token is valid', `Connected to page ${data.page_id}. Users visible: ${totalUsers}.`);
      return;
    }
    showToast('success', 'Botcake token is valid', `Botcake accepted the token for page ${data.page_id}. Flows found: ${Number(data.flow_count || 0)}.`);
  } catch (error) {
    showToast('error', `${cfg.label} invalid`, error.message || 'The token could not be validated.');
  }
}

// Toggle the small Connection Status popup (name + status only).
function toggleConnStatusPopup(btn) {
  const popup = btn.parentElement?.querySelector('.conn-status-popup');
  if (!popup) return;
  popup.hidden = !popup.hidden;
}

// Populate the Owner dropdown from the dashboard's active users.
async function loadPosOwnerOptions() {
  const select = document.getElementById('pancake-pos-owner');
  if (!select) return;
  const selected = select.getAttribute('data-selected') || '';
  try {
    const result = await authorizedJsonRequest('/auth/users');
    const users = Array.isArray(result?.users) ? result.users : [];
    const names = Array.from(new Set(users.map((u) => u.full_name || u.username).filter(Boolean)));
    select.innerHTML = `<option value="">Select owner…</option>`
      + names.map((n) => `<option value="${escapeHtml(n)}" ${n === selected ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
  } catch {
    /* Keep the inline fallback option already rendered. */
  }
}

// ─── Pancake POS Pages (table + modal) ─────────────────────
let posPagesSearch = '';
let posPagesPage = 1;
let posPagesPerPage = 10;
let posPagesSort = { key: 'name', dir: 'asc' };
let editingPosPageId = null;

function getPosPagesRows() {
  const pos = getIntegrationState().pancakePos;
  let rows = (pos.connections || []).map((c) => ({
    id: c.id,
    name: c.name || c.shopName || (c.shopId || c.shop_id ? `Shop ${c.shopId || c.shop_id}` : 'Untitled Page'),
    shop: c.shopName || c.name || (c.shopId || c.shop_id ? `Shop ${c.shopId || c.shop_id}` : '—'),
    shopId: c.shopId || c.shop_id || '',
    owner: c.owner || '—',
    enabled: c.enabled !== false,
    lastSync: c.lastSyncedAt || c.last_synced_at || c.lastSync || pos.lastCollectedAt || pos.lastSavedAt || null,
  }));
  if (posPagesSearch) {
    const q = posPagesSearch.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q)
      || String(r.shop).toLowerCase().includes(q)
      || String(r.owner).toLowerCase().includes(q));
  }
  const k = posPagesSort.key;
  rows.sort((a, b) => {
    const av = String(a[k] || '').toLowerCase();
    const bv = String(b[k] || '').toLowerCase();
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return posPagesSort.dir === 'asc' ? cmp : -cmp;
  });
  return rows;
}

function renderPancakePagesTable() {
  const body = document.getElementById('pos-pages-body');
  if (!body) return;
  const all = getPosPagesRows();
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / posPagesPerPage));
  if (posPagesPage > pages) posPagesPage = pages;
  if (posPagesPage < 1) posPagesPage = 1;
  const start = (posPagesPage - 1) * posPagesPerPage;
  const slice = all.slice(start, start + posPagesPerPage);

  body.innerHTML = slice.length
    ? slice.map((r) => `<tr onclick="openPosPageModal('${escapeHtml(String(r.id))}')">
        <td class="pp-name">${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.shop)}</td>
        <td>${escapeHtml(r.owner)}</td>
        <td>
          <button class="pos-status-toggle ${r.enabled ? 'is-active' : 'is-off'}" type="button" onclick="togglePosPageEnabled(event, '${escapeHtml(String(r.id))}')" title="Click to ${r.enabled ? 'turn off' : 'turn on'} syncing for this page">
            <span class="pos-status-dot"></span>${r.enabled ? 'Active' : 'Off'}
          </button>
        </td>
        <td>${r.lastSync ? escapeHtml(new Date(r.lastSync).toLocaleString()) : '—'}</td>
        <td>
          <button class="btn btn-secondary btn-sm" type="button" data-pos-sync-id="${escapeHtml(r.id)}" onclick="syncPancakePosPage(event, '${escapeHtml(String(r.id))}')">Sync</button>
          <button class="btn btn-danger btn-sm" type="button" onclick="deletePancakePosPage(event, '${escapeHtml(String(r.id))}')">Delete</button>
          <span class="pos-page-sync-status" data-pos-sync-status="${escapeHtml(r.id)}"></span>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="pp-empty">No pages yet. Click “Add New Page” to connect a shop.</td></tr>`;

  const used = document.getElementById('pos-pages-used');
  if (used) used.textContent = `${total}/15 PAGES USED`;
  const info = document.getElementById('pos-pages-info');
  if (info) info.textContent = total
    ? `Showing ${start + 1} to ${Math.min(start + posPagesPerPage, total)} of ${total} entries`
    : 'No entries';
  const cur = document.getElementById('pos-pg-cur');
  if (cur) cur.textContent = String(posPagesPage);
  const atFirst = posPagesPage <= 1;
  const atLast = posPagesPage >= pages;
  ['pos-pg-first', 'pos-pg-prev'].forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = atFirst; });
  ['pos-pg-next', 'pos-pg-last'].forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = atLast; });
}

function setPosPagesSearch(v) { posPagesSearch = v || ''; posPagesPage = 1; renderPancakePagesTable(); }
function setPosPagesPerPage(v) { posPagesPerPage = Math.max(1, parseInt(v, 10) || 10); posPagesPage = 1; renderPancakePagesTable(); }
function setPosPagesSort(key) {
  if (posPagesSort.key === key) posPagesSort.dir = posPagesSort.dir === 'asc' ? 'desc' : 'asc';
  else posPagesSort = { key, dir: 'asc' };
  renderPancakePagesTable();
}
function gotoPosPage(where) {
  const total = getPosPagesRows().length;
  const pages = Math.max(1, Math.ceil(total / posPagesPerPage));
  if (where === 'first') posPagesPage = 1;
  else if (where === 'prev') posPagesPage = Math.max(1, posPagesPage - 1);
  else if (where === 'next') posPagesPage = Math.min(pages, posPagesPage + 1);
  else if (where === 'last') posPagesPage = pages;
  renderPancakePagesTable();
}

function findPosPageSyncElement(attribute, connectionId) {
  return Array.from(document.querySelectorAll(`[${attribute}]`))
    .find((el) => el.getAttribute(attribute) === String(connectionId)) || null;
}

function setPosPageSyncStatus(connectionId, text = '', tone = 'muted') {
  const status = findPosPageSyncElement('data-pos-sync-status', connectionId);
  if (!status) return;
  status.textContent = text;
  status.className = `pos-page-sync-status ${tone ? `is-${tone}` : ''}`;
}

function setPosPageSyncButton(connectionId, text = 'Sync', disabled = false) {
  const button = findPosPageSyncElement('data-pos-sync-id', connectionId);
  if (!button) return null;
  button.disabled = Boolean(disabled);
  button.textContent = text;
  return button;
}

// Flip a page's Active/Off status straight from the table row (no modal).
// A disabled page is skipped by the backend sync (collectPosData filters on enabled).
function togglePosPageEnabled(event, id) {
  if (event) event.stopPropagation();
  const state = getIntegrationState();
  const pos = state.pancakePos;
  const conns = Array.isArray(pos.connections) ? pos.connections : [];
  const conn = conns.find((c) => String(c.id) === String(id));
  if (!conn) return;
  const nextEnabled = !(conn.enabled !== false);
  conn.enabled = nextEnabled;
  pos.enabled = conns.some((c) => c.enabled !== false);
  pos.lastSavedAt = new Date().toISOString();
  saveIntegrationState(state);
  renderPancakePagesTable();
  syncPancakePosConfigToBackend(pos)
    .then(() => showToast('success', nextEnabled ? 'Page active' : 'Page turned off',
      `${conn.name || conn.shopName || 'Page'} will ${nextEnabled ? 'now sync' : 'no longer sync'}.`))
    .catch(() => showToast('warning', 'Saved locally', 'Saved in the dashboard config; backend not reachable.'));
}

function openPosPageModal(id) {
  editingPosPageId = id || null;
  const pos = getIntegrationState().pancakePos;
  const conn = id ? (pos.connections || []).find((c) => c.id === id) : null;
  const set = (x, v) => { const el = document.getElementById(x); if (el) el.value = v ?? ''; };
  set('pancake-pos-page-id', conn?.messagingPageId || conn?.messaging_page_id || '');
  set('pancake-pos-shop-id', conn?.shopId || conn?.shop_id || '');
  set('pancake-pos-shop-name', conn?.name || conn?.shopName || '');
  set('pancake-pos-api-key', conn?.apiKey || conn?.api_key || '');
  set('pancake-pos-pancake-token', conn?.pageAccessToken || conn?.page_access_token || '');
  set('pancake-pos-botcake-token', conn?.botcakeToken || '');
  set('pancake-pos-base-url', conn?.baseUrl || conn?.base_url || 'https://pos.pages.fm/api/v1');
  set('pancake-pos-sync-mode', conn?.syncMode || conn?.sync_mode || 'pull_only');
  set('pancake-pos-notes', conn?.notes || '');
  const enabledEl = document.getElementById('pancake-pos-enabled');
  if (enabledEl) enabledEl.checked = conn ? Boolean(conn.enabled) : true;
  const ownerEl = document.getElementById('pancake-pos-owner');
  if (ownerEl) ownerEl.setAttribute('data-selected', conn?.owner || '');
  loadPosOwnerOptions();
  const title = document.getElementById('pos-page-modal-title');
  if (title) title.textContent = id ? 'Edit Page' : 'Add New Page';
  openModal('pos-page-modal');
}

function savePosPageFromModal() {
  const get = (x) => (document.getElementById(x)?.value || '').trim();
  const name = get('pancake-pos-shop-name');
  const shopId = get('pancake-pos-shop-id');
  if (!name || !shopId) {
    showToast('error', 'Missing details', 'Page Name and Shop ID are required.');
    return;
  }
  const state = getIntegrationState();
  const pos = state.pancakePos;
  const conns = Array.isArray(pos.connections) ? [...pos.connections] : [];
  const id = editingPosPageId || `pos-${Date.now()}`;
  const page = {
    id,
    name,
    shopName: name,
    shopId,
    enabled: Boolean(document.getElementById('pancake-pos-enabled')?.checked),
    syncMode: get('pancake-pos-sync-mode') || 'pull_only',
    baseUrl: get('pancake-pos-base-url') || 'https://pos.pages.fm/api/v1',
    apiKey: get('pancake-pos-api-key'),
    messagingPageId: get('pancake-pos-page-id') || undefined,
    pageAccessToken: get('pancake-pos-pancake-token') || undefined,
    owner: get('pancake-pos-owner') || undefined,
    botcakeToken: get('pancake-pos-botcake-token') || undefined,
    notes: get('pancake-pos-notes'),
  };
  const idx = conns.findIndex((c) => c.id === id);
  if (idx >= 0) conns[idx] = { ...conns[idx], ...page };
  else conns.push(page);
  pos.connections = conns;
  // Mirror the first connection into the top-level fields for compatibility.
  const primary = conns[0];
  if (primary) {
    pos.apiKey = primary.apiKey || pos.apiKey;
    pos.shopId = primary.shopId || pos.shopId;
    pos.shopName = primary.shopName || pos.shopName;
    pos.enabled = conns.some((c) => c.enabled);
  }
  pos.lastSavedAt = new Date().toISOString();
  saveIntegrationState(state);
  closeModal('pos-page-modal');
  renderPancakePagesTable();
  const wasEditing = Boolean(editingPosPageId);
  syncPancakePosConfigToBackend(pos)
    .then(() => showToast('success', wasEditing ? 'Page updated' : 'Page added', `${name} was saved.`))
    .catch(() => showToast('warning', 'Saved locally', 'Saved in the dashboard config; backend not reachable.'));
  editingPosPageId = null;
}

// Fill the modal's Shop ID from the POS token without touching saved pages.
async function fetchShopsForModal() {
  const apiKey = (document.getElementById('pancake-pos-api-key')?.value || '').trim();
  const baseUrl = (document.getElementById('pancake-pos-base-url')?.value || 'https://pos.pages.fm/api/v1').trim();
  if (!apiKey) { showToast('warning', 'POS token required', 'Enter the POS token first.'); return; }
  try {
    const data = await authorizedJsonRequest('/integrations/pancake-pos/shops', {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey, base_url: baseUrl }),
    });
    const shops = Array.isArray(data?.shops) ? data.shops : [];
    if (!shops.length) { showToast('warning', 'No shops returned', 'The token worked but Pancake POS returned no shops.'); return; }
    const first = shops[0];
    const shopInput = document.getElementById('pancake-pos-shop-id');
    const nameInput = document.getElementById('pancake-pos-shop-name');
    if (shopInput) shopInput.value = first.id || '';
    if (nameInput && !nameInput.value && first.name) nameInput.value = first.name;
    showToast('success', 'POS shops loaded', `Found ${shops.length} shop(s). Filled Shop ID.`);
  } catch (e) {
    showToast('error', 'Get POS Shops failed', e.message || 'Could not load shops from Pancake POS.');
  }
}

// ─── InfoTXT SMS automation (Integrations → InfoTXT SMS) ───
let smsRules = [];
let editingSmsTag = null;

async function loadSmsSettings() {
  try {
    const [cfg, rulesResp] = await Promise.all([
      authorizedJsonRequest('/integrations/infotxt/config'),
      authorizedJsonRequest('/integrations/infotxt/rules'),
    ]);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
    set('sms-endpoint', cfg.endpoint || '');
    set('sms-userid', cfg.user_id || '');
    set('sms-sim', cfg.sim || '');
    const keyEl = document.getElementById('sms-api-key');
    if (keyEl) keyEl.placeholder = cfg.has_api_key ? 'Saved key — leave blank to keep it' : 'Enter InfoTXT API Key';
    const enEl = document.getElementById('sms-enabled');
    if (enEl) enEl.checked = Boolean(cfg.enabled);
    const badge = document.getElementById('sms-status-badge');
    if (badge) {
      const ready = cfg.enabled && cfg.has_api_key && cfg.user_id;
      badge.textContent = cfg.enabled ? (ready ? 'Active' : 'On — incomplete setup') : 'Off';
      badge.className = `badge ${cfg.enabled ? (ready ? 'badge-success' : 'badge-warning') : 'badge-gray'}`;
    }
    smsRules = Array.isArray(rulesResp.rules) ? rulesResp.rules : [];
    renderSmsRules();
  } catch (e) {
    showToast('error', 'Could not load InfoTXT settings', e.message || 'Request failed.');
  }
}

function renderSmsRules() {
  const body = document.getElementById('sms-rules-body');
  if (!body) return;
  body.innerHTML = smsRules.length
    ? smsRules.map((r) => `<tr>
        <td class="pp-name">${escapeHtml(r.tag)}</td>
        <td style="max-width:340px; white-space:normal; color:var(--text-muted);">${escapeHtml(r.message || '')}</td>
        <td>
          <button class="pos-status-toggle ${r.enabled ? 'is-active' : 'is-off'}" type="button" onclick="toggleSmsRule(event, '${escapeHtml(String(r.tag))}')">
            <span class="pos-status-dot"></span>${r.enabled ? 'Active' : 'Off'}
          </button>
        </td>
        <td>
          <button class="btn btn-secondary btn-sm" type="button" onclick="openSmsRuleModal('${escapeHtml(String(r.tag))}')">Edit</button>
          <button class="btn btn-danger btn-sm" type="button" onclick="deleteSmsRule(event, '${escapeHtml(String(r.tag))}')">Delete</button>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="pp-empty">No tag rules yet. Click “Add Tag Rule” to create one.</td></tr>`;
}

async function toggleSmsRule(event, tag) {
  if (event) event.stopPropagation();
  const rule = smsRules.find((r) => String(r.tag) === String(tag));
  if (!rule) return;
  const next = !rule.enabled;
  rule.enabled = next; // optimistic
  renderSmsRules();
  try {
    await authorizedJsonRequest('/integrations/infotxt/rules', {
      method: 'PUT',
      body: JSON.stringify({ tag: rule.tag, message: rule.message, enabled: next }),
    });
    showToast('success', next ? 'Tag active' : 'Tag turned off', `"${rule.tag}" will ${next ? 'now text' : 'no longer text'} customers.`);
  } catch (e) {
    rule.enabled = !next; // revert
    renderSmsRules();
    showToast('error', 'Update failed', e.message || 'Could not save.');
  }
}

function openSmsRuleModal(tag) {
  editingSmsTag = tag || null;
  const rule = tag ? smsRules.find((r) => String(r.tag) === String(tag)) : null;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  set('sms-rule-tag', rule?.tag || '');
  set('sms-rule-message', rule?.message || '');
  const enEl = document.getElementById('sms-rule-enabled');
  if (enEl) enEl.checked = rule ? Boolean(rule.enabled) : true;
  const tagInput = document.getElementById('sms-rule-tag');
  if (tagInput) tagInput.disabled = Boolean(tag); // tag is the key — don't rename in edit
  const title = document.getElementById('sms-rule-modal-title');
  if (title) title.textContent = tag ? 'Edit Tag Rule' : 'Add Tag Rule';
  openModal('sms-rule-modal');
}

async function saveSmsRuleFromModal() {
  const tag = (document.getElementById('sms-rule-tag')?.value || '').trim();
  const message = (document.getElementById('sms-rule-message')?.value || '').trim();
  const enabled = Boolean(document.getElementById('sms-rule-enabled')?.checked);
  if (!tag || !message) {
    showToast('error', 'Missing details', 'Tag and Message are both required.');
    return;
  }
  try {
    await authorizedJsonRequest('/integrations/infotxt/rules', {
      method: 'PUT',
      body: JSON.stringify({ tag, message, enabled }),
    });
    closeModal('sms-rule-modal');
    editingSmsTag = null;
    await loadSmsSettings();
    showToast('success', 'Rule saved', `"${tag}" saved.`);
  } catch (e) {
    showToast('error', 'Save failed', e.message || 'Could not save the rule.');
  }
}

async function deleteSmsRule(event, tag) {
  if (event) event.stopPropagation();
  if (!confirm(`Delete the SMS rule for tag "${tag}"?`)) return;
  try {
    await authorizedJsonRequest('/integrations/infotxt/rules/delete', {
      method: 'POST',
      body: JSON.stringify({ tag }),
    });
    smsRules = smsRules.filter((r) => String(r.tag) !== String(tag));
    renderSmsRules();
    showToast('success', 'Rule deleted', `"${tag}" removed.`);
  } catch (e) {
    showToast('error', 'Delete failed', e.message || 'Could not delete.');
  }
}

async function saveSmsConfig() {
  const payload = {
    endpoint: (document.getElementById('sms-endpoint')?.value || '').trim(),
    user_id: (document.getElementById('sms-userid')?.value || '').trim(),
    sim: (document.getElementById('sms-sim')?.value || '').trim(),
    api_key: (document.getElementById('sms-api-key')?.value || '').trim(),
    enabled: Boolean(document.getElementById('sms-enabled')?.checked),
  };
  try {
    await authorizedJsonRequest('/integrations/infotxt/config', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const keyEl = document.getElementById('sms-api-key');
    if (keyEl) keyEl.value = '';
    await loadSmsSettings();
    showToast('success', 'Saved', 'InfoTXT connection saved.');
  } catch (e) {
    showToast('error', 'Save failed', e.message || 'Could not save connection.');
  }
}

function openSmsTest() {
  const r = document.getElementById('sms-test-result');
  if (r) r.textContent = '';
  openModal('sms-test-modal');
}

async function sendSmsTest() {
  const number = (document.getElementById('sms-test-number')?.value || '').trim();
  const message = (document.getElementById('sms-test-message')?.value || '').trim();
  const resultEl = document.getElementById('sms-test-result');
  if (!number) { showToast('error', 'Number required', 'Enter a mobile number.'); return; }
  if (resultEl) resultEl.textContent = 'Sending…';
  try {
    const data = await authorizedJsonRequest('/integrations/infotxt/test', {
      method: 'POST',
      body: JSON.stringify({ number, message }),
    });
    const ok = data.ok || data.status === 'sent';
    const okMsg = `Sent to ${data.phone || number}${data.smsid ? ` (id ${data.smsid})` : ''}.`;
    if (resultEl) {
      resultEl.style.color = ok ? 'var(--success)' : 'var(--danger)';
      const head = ok ? okMsg : `Failed: ${data.error || data.status || 'unknown'}`;
      resultEl.innerHTML = `${escapeHtml(head)}${data.raw ? `<br><span style="color:var(--text-muted);font-size:12px;">Gateway response: <code>${escapeHtml(String(data.raw))}</code></span>` : ''}`;
    }
    showToast(ok ? 'success' : 'error', ok ? 'Test sent' : 'Test failed', ok ? okMsg : (data.error || 'Send failed.'));
  } catch (e) {
    if (resultEl) { resultEl.style.color = 'var(--danger)'; resultEl.textContent = `Failed: ${e.message}`; }
    showToast('error', 'Test failed', e.message || 'Request failed.');
  }
}

async function loadPosUsers(page = posUsersState.page || 1) {
  if (!canManageAccounts()) return;
  posUsersState = { ...posUsersState, page, loading: true };
  renderPosUsersTable();

  try {
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(posUsersState.perPage),
      search: posUsersState.search || '',
      _: String(Date.now()),
    });
    const data = await authorizedJsonRequest(`/integrations/pancake-pos/users?${query.toString()}`);
    posUsersState = {
      ...posUsersState,
      users: Array.isArray(data?.data) ? data.data : [],
      total: Number(data?.total || 0),
      page: Number(data?.page || page),
      perPage: Number(data?.per_page || posUsersState.perPage),
      loading: false,
    };
    renderPosUsersTable();
  } catch (error) {
    posUsersState = { ...posUsersState, loading: false };
    const tbody = document.getElementById('pos-users-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--danger)">POS users load failed: ${escapeHtml(error.message || 'Request failed')}</td></tr>`;
  }
}

function renderPosUsersTable() {
  const tbody = document.getElementById('pos-users-tbody');
  const pagination = document.getElementById('pos-users-pagination');
  if (!tbody) return;

  if (posUsersState.loading) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted)">Loading POS users...</td></tr>';
    if (pagination) pagination.innerHTML = '<span>Loading users...</span>';
    return;
  }

  tbody.innerHTML = posUsersState.users.map((user) => `
    <tr>
      <td>${escapeHtml(user.name || user.external_id || 'Unnamed user')}</td>
      <td>${escapeHtml(user.username || '—')}</td>
      <td>${escapeHtml(user.role_name || '—')}</td>
      <td>${escapeHtml(user.shop_id || '—')}</td>
      <td>${escapeHtml(user.email || '—')}</td>
      <td>${escapeHtml(user.phone_number || '—')}</td>
      <td><span class="badge ${user.is_active ? 'badge-success' : 'badge-warning'}">${user.is_active ? 'Active' : 'Disabled'}</span></td>
    </tr>
  `).join('') || '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted)">No POS users synced yet. Click Sync Users.</td></tr>';

  if (pagination) {
    const start = posUsersState.total ? ((posUsersState.page - 1) * posUsersState.perPage) + 1 : 0;
    const end = Math.min(posUsersState.total, posUsersState.page * posUsersState.perPage);
    const totalPages = Math.max(1, Math.ceil(posUsersState.total / posUsersState.perPage));
    pagination.innerHTML = `
      <span>${start}-${end} of ${posUsersState.total.toLocaleString()} users</span>
      <div>
        <button class="btn btn-secondary btn-sm" ${posUsersState.page <= 1 ? 'disabled' : ''} onclick="loadPosUsers(${posUsersState.page - 1})">Prev</button>
        <span style="padding:0 10px;color:var(--text-muted);font-size:12px;">${posUsersState.page} / ${totalPages}</span>
        <button class="btn btn-secondary btn-sm" ${posUsersState.page >= totalPages ? 'disabled' : ''} onclick="loadPosUsers(${posUsersState.page + 1})">Next</button>
      </div>`;
  }
}

function searchPosUsers() {
  posUsersState.search = document.getElementById('pos-users-search')?.value || '';
  loadPosUsers(1);
}

async function collectPancakePosUsers() {
  const state = getIntegrationState();
  state.pancakePos = collectPancakePosFormState();
  saveIntegrationState(state);

  if (!state.pancakePos.connections.length) {
    showToast('warning', 'POS setup required', 'Enter at least one Pancake POS API key and shop ID first.');
    return;
  }

  try {
    showToast('info', 'POS user sync started', 'Pulling POS users, staffs, or employees from connected shops.');
    await syncPancakePosConfigToBackend(state.pancakePos);
    const data = await authorizedJsonRequest('/integrations/pancake-pos/collect', {
      method: 'POST',
      body: JSON.stringify({
        api_key: state.pancakePos.apiKey,
        base_url: state.pancakePos.baseUrl,
        shop_id: state.pancakePos.shopId,
        connections: state.pancakePos.connections,
        resources: ['users'],
        page_size: 100,
        max_pages: 200,
      }),
    });
    const count = data.resources?.users?.count || 0;
    await loadPosUsers(1);
    showToast('success', 'POS users synced', `${Number(count).toLocaleString()} user record(s) collected.`);
  } catch (error) {
    showToast('error', 'POS user sync failed', error.message || 'Could not collect users from Pancake POS.');
  }
}

async function syncPosOrdersNow(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }
  try {
    showToast('info', 'Syncing POS orders', 'Fetching latest orders from Pancake...');
    const data = await authorizedJsonRequest('/integrations/pancake-pos/collect', {
      method: 'POST',
      body: JSON.stringify({ resources: ['orders'], page_size: 100, max_pages: 5, replay_stored_orders: false }),
    });
    const counts = Object.entries(data.resources || {}).map(([k, v]) => `${k}: ${v.count}`).join(', ');
    const failed = Array.isArray(data.failed_resources) && data.failed_resources.length
      ? data.failed_resources.map((f) => f.error || f.resource).join('; ')
      : null;
    if (failed) { showToast('warning', 'Sync partial', failed); }
    else { showToast('success', 'Sync complete', counts || 'POS orders up to date'); }
    await refreshPosRawOrdersFromBackend();
    renderPosOrdersTable();
  } catch (error) {
    showToast('error', 'Sync failed', error.message || 'Could not reach Pancake POS.');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 5a5 5 0 1 0 1 3.8"/><path d="M13 2v3h-3"/></svg> Sync Now'; }
  }
}

async function collectPancakePosData() {
  const state = getIntegrationState();
  // Only collect form state when the Integrations form is actually rendered —
  // calling this from another page (e.g. RMO) returns empty fields and wipes
  // saved API keys from localStorage.
  if (document.getElementById('pancake-pos-api-key')) {
    state.pancakePos = collectPancakePosFormState();
    saveIntegrationState(state);
  }
  const syncButton = document.getElementById('pancake-pos-sync-button');

  if (!state.pancakePos.connections.length) {
    showToast('warning', 'POS setup required', 'Enter at least one Pancake POS API key and shop ID first.');
    return;
  }

  try {
    if (syncButton) {
      syncButton.disabled = true;
      syncButton.textContent = 'Syncing...';
    }
    showToast('info', 'POS sync started', 'Pulling Pancake POS orders from January 1 to today.');
    await syncPancakePosConfigToBackend(state.pancakePos);
    const currentYearStart = Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
    const data = await authorizedJsonRequest('/integrations/pancake-pos/collect', {
      method: 'POST',
      body: JSON.stringify({
        api_key: state.pancakePos.apiKey,
        base_url: state.pancakePos.baseUrl,
        shop_id: state.pancakePos.shopId,
        connections: state.pancakePos.connections,
        resources: ['orders'],
        page_size: 100,
        max_pages: 2000,
        replay_stored_orders: false,
        transfer_dashboard_orders: false,
        startDateTime: currentYearStart,
        endDateTime: Math.floor(Date.now() / 1000),
      }),
    });

    const collectedResources = Object.entries(data.resources || {}).map(([name, details]) => `${name}:${details.count}`).join(', ');
    const failedResources = Array.isArray(data.failed_resources) ? data.failed_resources : [];
    if (failedResources.length) {
      const details = failedResources
        .map((item) => `${item.resource || 'resource'}: ${item.error || 'failed'}`)
        .join('; ');
      throw new Error(details || 'Pancake POS returned a partial sync error.');
    }

    const refreshed = getIntegrationState();
    refreshed.pancakePos = {
      ...state.pancakePos,
      lastCollectedAt: new Date().toISOString(),
      lastCollectionSummary: data.connections?.length
        ? `${data.connections.length} POS account(s) synced`
        : `${collectedResources || 'POS orders transferred to SQL'}`,
    };
    saveIntegrationState(refreshed);

    await refreshOrderViewsFromBackend();
    showToast('success', 'POS sync complete', refreshed.pancakePos.lastCollectionSummary);
  } catch (error) {
    showToast('error', 'POS sync failed', error.message || 'Could not transfer Pancake POS API data to SQL.');
  } finally {
    if (syncButton) {
      syncButton.disabled = false;
      syncButton.textContent = 'Sync POS Orders';
    }
  }
}

// Delete a connected page: remove the connection from the backend and the local
// integration state. Stored orders already synced are kept.
async function deletePancakePosPage(event, connectionId) {
  if (event) event.stopPropagation();
  const state = getIntegrationState();
  const connections = Array.isArray(state.pancakePos?.connections) ? state.pancakePos.connections : [];
  const connection = connections.find((item) => String(item.id) === String(connectionId));
  const name = connection?.name || connection?.shopName || `Shop ${connection?.shopId || connection?.shop_id || connectionId}`;
  const shopId = connection?.shopId || connection?.shop_id || '';
  if (!confirm(`Delete the page "${name}"? This removes the connection from the dashboard.`)) return;
  // Second prompt: optionally also purge this page's stored orders.
  const deleteOrders = confirm(`Also delete "${name}"'s synced orders from the dashboard?\n\nOK = delete the page AND its stored orders (cannot be undone).\nCancel = delete the page only, keep its orders.`);
  try {
    const data = await authorizedJsonRequest('/integrations/pancake-pos/connections/delete', {
      method: 'POST',
      body: JSON.stringify({ connection_id: connectionId, shop_id: shopId, delete_orders: deleteOrders }),
    });
    state.pancakePos.connections = connections.filter((item) => String(item.id) !== String(connectionId));
    saveIntegrationState(state);
    renderPancakePagesTable();
    const extra = Number(data?.deleted_orders) ? ` and ${Number(data.deleted_orders).toLocaleString()} order(s)` : '';
    showToast('success', 'Page deleted', `"${name}"${extra} removed from the dashboard.`);
  } catch (error) {
    showToast('error', 'Delete failed', error.message || 'Could not delete the page.');
  }
}

async function syncPancakePosPage(event, connectionId) {
  if (event) event.stopPropagation();
  const state = getIntegrationState();
  const connections = Array.isArray(state.pancakePos?.connections) ? state.pancakePos.connections : [];
  const connection = connections.find((item) => item.id === connectionId);
  if (!connection) {
    showToast('error', 'Page not found', 'Refresh API Connections and try again.');
    return;
  }
  const shopId = connection.shopId || connection.shop_id;
  if (!shopId) {
    showToast('warning', 'Shop ID required', 'This page needs a POS Shop ID before it can sync.');
    return;
  }

  const button = findPosPageSyncElement('data-pos-sync-id', connectionId);
  const previousText = button?.textContent || 'Sync';
  let progressToast = null;
  try {
    setPosPageSyncButton(connectionId, 'Syncing...', true);
    setPosPageSyncStatus(connectionId, 'Syncing...', 'info');
    const pageName = connection.name || connection.shopName || `Shop ${shopId}`;
    progressToast = showToast('info', 'POS page sync in progress', `Pulling orders for ${pageName}. This may take a moment.`, { durationMs: 0 });
    const currentYearStart = Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
    const data = await authorizedJsonRequest('/integrations/pancake-pos/collect', {
      method: 'POST',
      body: JSON.stringify({
        connection_id: connection.id,
        shop_id: shopId,
        resources: ['orders'],
        page_size: 100,
        max_pages: 2000,
        replay_stored_orders: false,
        transfer_dashboard_orders: false,
        startDateTime: currentYearStart,
        endDateTime: Math.floor(Date.now() / 1000),
      }),
    });

    const failedResources = Array.isArray(data.failed_resources) ? data.failed_resources : [];
    if (failedResources.length) {
      const details = failedResources.map((item) => `${item.resource || 'resource'}: ${item.error || 'failed'}`).join('; ');
      throw new Error(details || 'Pancake POS returned a sync error.');
    }

    const count = Number(data.resources?.orders?.count || data.sql_tables?.orders?.stored || 0);
    const syncMessage = count > 0
      ? `${pageName}: ${count.toLocaleString()} POS order(s) synced.`
      : `${pageName}: already synced. No new POS orders found.`;
    const refreshed = getIntegrationState();
    const nextConnections = (refreshed.pancakePos.connections || []).map((item) => (
      item.id === connectionId ? { ...item, lastSyncedAt: new Date().toISOString() } : item
    ));
    refreshed.pancakePos = {
      ...refreshed.pancakePos,
      connections: nextConnections,
      lastCollectedAt: new Date().toISOString(),
      lastCollectionSummary: syncMessage,
    };
    saveIntegrationState(refreshed);
    renderPancakePagesTable();
    await refreshPosOrdersNow();
    if (progressToast) progressToast.remove();
    setPosPageSyncStatus(connectionId, 'Done', 'success');
    setPosPageSyncButton(connectionId, count > 0 ? 'Synced' : 'Up to date', false);
    showToast('success', count > 0 ? 'POS page synced' : 'Already synced', syncMessage, { durationMs: 7000 });
    setTimeout(() => setPosPageSyncButton(connectionId, previousText, false), 3000);
  } catch (error) {
    if (progressToast) progressToast.remove();
    setPosPageSyncStatus(connectionId, 'Failed', 'error');
    showToast('error', 'POS page sync failed', error.message || 'Could not sync this POS page.');
  } finally {
    const currentButton = findPosPageSyncElement('data-pos-sync-id', connectionId);
    if (currentButton && currentButton.textContent === 'Syncing...') {
      currentButton.disabled = false;
      currentButton.textContent = previousText;
    }
  }
}

async function replayPancakePosOrders(options = {}) {
  const state = getIntegrationState();
  state.pancakePos = collectPancakePosFormState();
  saveIntegrationState(state);
  const replayButton = document.getElementById('pancake-pos-replay-button');

  if (!state.pancakePos.shopId && !state.pancakePos.connections.length) {
    showToast('warning', 'POS setup required', 'Enter at least one Pancake POS API key and shop ID first.');
    return null;
  }

  try {
    if (replayButton) {
      replayButton.disabled = true;
      replayButton.textContent = 'Transferring...';
    }
    if (!options.silent) {
      showToast('info', 'POS transfer started', 'Re-mapping saved POS SQL orders into dashboard records.');
    }
    await syncPancakePosConfigToBackend(state.pancakePos);
    const data = await authorizedJsonRequest('/integrations/pancake-pos/replay', {
      method: 'POST',
      body: JSON.stringify({
        shop_id: state.pancakePos.connections.length > 1 ? undefined : state.pancakePos.shopId,
        all: true,
        missing_only: true,
      }),
    });
    await refreshOrderViewsFromBackend();
    if (!options.silent) {
      const reasons = Object.entries(data.skip_reasons || {})
        .map(([reason, count]) => `${reason}: ${count}`)
        .join(', ');
      showToast('success', 'POS SQL transfer complete', `${data.transferred || 0} transferred, ${data.skipped || 0} skipped${reasons ? ` (${reasons})` : ''}.`);
    }
    return data;
  } catch (error) {
    showToast('error', 'POS transfer failed', error.message || 'Could not transfer saved POS orders to dashboard.');
    return null;
  } finally {
    if (replayButton) {
      replayButton.disabled = false;
      replayButton.textContent = 'Transfer POS SQL';
    }
  }
}

async function syncPancakePageUsers() {
  const btn = document.getElementById('pancake-pos-sync-users-button');
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing users...'; }
    showToast('info', 'Syncing staff users', 'Fetching Pancake page users and updating cache...');
    const data = await authorizedJsonRequest('/integrations/pancake-pos/sync-users', { method: 'POST' });
    if (data.errors?.length) {
      showToast('warning', 'Users synced with errors', `${data.synced || 0} users synced. Errors: ${data.errors.map((e) => e.connection || e.error).join(', ')}`);
    } else if (!data.synced) {
      showToast('warning', 'No users synced', 'Add Page ID and Page Token (columns 5–6) in Additional POS Accounts and save first.');
    } else {
      showToast('success', 'Staff users synced', `${data.synced} users cached from Pancake messaging API.`);
    }
  } catch (error) {
    showToast('error', 'Sync failed', error.message || 'Could not sync Pancake page users.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sync Staff Users'; }
  }
}

async function runPosHistoricalSync() {
  const fromVal = document.getElementById('pos-hist-from')?.value;
  const toVal = document.getElementById('pos-hist-to')?.value;
  const maxPages = Math.max(1, Math.min(2000, Number(document.getElementById('pos-hist-max-pages')?.value || 200)));
  const pageSize = Math.max(10, Math.min(100, Number(document.getElementById('pos-hist-page-size')?.value || 100)));
  const statusEl = document.getElementById('pos-hist-status');
  const btn = document.getElementById('pos-hist-btn');

  if (!fromVal || !toVal) {
    showToast('warning', 'Date range required', 'Select both From and To dates.');
    return;
  }
  if (fromVal > toVal) {
    showToast('warning', 'Invalid range', 'From date must be before To date.');
    return;
  }

  // Convert YYYY-MM-DD to Unix timestamps
  const startDateTime = Math.floor(new Date(fromVal + 'T00:00:00').getTime() / 1000);
  const endDateTime = Math.floor(new Date(toVal + 'T23:59:59').getTime() / 1000);
  const state = getIntegrationState();
  state.pancakePos = collectPancakePosFormState();
  saveIntegrationState(state);

  if (!state.pancakePos.connections.length) {
    showToast('warning', 'POS setup required', 'Save at least one POS connection first.');
    return;
  }

  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }
    if (statusEl) statusEl.textContent = `Syncing ${fromVal} → ${toVal} (up to ${maxPages} pages × ${pageSize})…`;
    showToast('info', 'Historical sync started', `Fetching POS orders from ${fromVal} to ${toVal}.`);
    await syncPancakePosConfigToBackend(state.pancakePos);

    const data = await authorizedJsonRequest('/integrations/pancake-pos/collect', {
      method: 'POST',
      body: JSON.stringify({
        connections: state.pancakePos.connections,
        resources: ['orders'],
        startDateTime,
        endDateTime,
        max_pages: maxPages,
        page_size: pageSize,
        replay_stored_orders: true,
      }),
    });

    const fetched = data.resources?.orders?.count ?? 0;
    if (statusEl) statusEl.textContent = `Done — ${fetched} orders fetched from ${fromVal} to ${toVal}.`;
    showToast('success', 'Historical sync complete', `${fetched} POS orders synced for ${fromVal} → ${toVal}.`);

    await refreshOrderViewsFromBackend();
    const replayed = data.dashboard_replay?.transferred ?? 0;
    showToast('success', 'Transfer complete', `${replayed} POS records verified into dashboard orders.`);
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
    showToast('error', 'Historical sync failed', err.message || 'Check POS settings and try again.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Start Historical Sync'; }
  }
}

async function collectGoogleSheetsData() {
  const state = getIntegrationState();
  state.googleSheets = collectGoogleSheetsFormState();
  saveIntegrationState(state);

  if (!state.googleSheets.spreadsheetId || !state.googleSheets.serviceAccountEmail || !state.googleSheets.privateKey.trim()) {
    showToast('warning', 'Google Sheets setup required', 'Fill in spreadsheet ID, service account email, and private key first.');
    return;
  }

  try {
    await syncGoogleSheetsConfigToBackend(state.googleSheets);

    const data = await authorizedJsonRequest('/integrations/google-sheets/collect', {
      method: 'POST',
      body: JSON.stringify({
        spreadsheet_id: state.googleSheets.spreadsheetId,
        sheet_name: state.googleSheets.sheetName,
      }),
    });

    const refreshed = getIntegrationState();
    const sheetSummary = Array.isArray(data.sheets) && data.sheets.length
      ? data.sheets.map((sheet) => `${sheet.sheet_name}: +${sheet.imported}/~${sheet.updated}/!${sheet.failed || 0}`).join(', ')
      : '';
    const firstFailure = data.first_error
      ? ` First error row ${data.first_error.row_number}: ${data.first_error.error}`
      : Array.isArray(data.failed_rows) && data.failed_rows.length
        ? ` First error row ${data.failed_rows[0].row_number}: ${data.failed_rows[0].error}`
      : '';
    refreshed.googleSheets = {
      ...state.googleSheets,
      lastCollectedAt: new Date().toISOString(),
      lastCollectionSummary: `Imported ${data.imported || 0}, updated ${data.updated || 0}, failed ${Array.isArray(data.failed_rows) ? data.failed_rows.length : 0}${sheetSummary ? ` (${sheetSummary})` : ''}.${firstFailure}`,
    };
    saveIntegrationState(refreshed);

    await refreshOrderViewsFromBackend();
    showToast('success', 'Google Sheets synced', refreshed.googleSheets.lastCollectionSummary);
  } catch (error) {
    showToast('error', 'Google Sheets sync failed', error.message || 'Could not collect data from Google Sheets.');
  }
}

// ─── API KEYS ──────────────────────────────────────────────
function showCreateApiKeyForm() {
  document.getElementById('api-key-form').style.display = '';
  document.getElementById('api-key-result').style.display = 'none';
  document.getElementById('new-api-key-name').value = '';
  document.querySelectorAll('.api-key-scope').forEach((cb) => { cb.checked = cb.value === 'orders:read'; });
}

// ─── SCAN RECORDS (View Records sub-tab) ───────────────────
let scanRecordsPage = 1;

function clearScanRecordsFilters() {
  ['scan-records-search', 'scan-records-type', 'scan-records-status', 'scan-records-date-from', 'scan-records-date-to']
    .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  loadScanRecords(1);
}

async function loadScanRecords(page) {
  if (page) scanRecordsPage = page;
  const listEl = document.getElementById('scan-records-list');
  const pagEl = document.getElementById('scan-records-pagination');
  if (!listEl) return;
  listEl.innerHTML = '<div class="loading-spinner" style="margin:24px auto;"></div>';

  const params = new URLSearchParams({ page: String(scanRecordsPage), per_page: '50' });
  const search = (document.getElementById('scan-records-search')?.value || '').trim();
  const type = document.getElementById('scan-records-type')?.value || '';
  const status = document.getElementById('scan-records-status')?.value || '';
  const dateFrom = document.getElementById('scan-records-date-from')?.value || '';
  const dateTo = document.getElementById('scan-records-date-to')?.value || '';
  if (search) params.set('search', search);
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);

  try {
    const data = await authorizedJsonRequest(`/scans?${params}`);
    const records = Array.isArray(data?.data) ? data.data : [];
    if (!records.length) {
      listEl.innerHTML = '<div class="empty-state" style="padding:40px 0;"><p>No scan records found.</p></div>';
      if (pagEl) pagEl.innerHTML = '';
      return;
    }

    const summary = data.summary || { by_status: [], by_page: [], total_pcs: 0 };
    const statusChipClass = {
      'New': 'badge-info',
      'Confirmed': 'badge-gray',
      'Waiting for pickup': 'badge-warning',
      'Shipped': 'badge-warning',
      'Delivered': 'badge-success',
      'Returning': 'badge-warning',
      'Returned': 'badge-danger',
      'Canceled': 'badge-danger',
      'Cancelled': 'badge-danger',
      'DELIVERED': 'badge-success',
      'RETURNED': 'badge-danger',
      'CANCELLED': 'badge-danger',
    };
    const chip = (label, count, cls) =>
      `<span class="badge ${cls || 'badge-secondary'}" style="font-size:12px;padding:6px 10px;margin:2px;">
        ${escapeHtml(label)} ${Number(count || 0).toLocaleString()}
      </span>`;
    const statusChips = (summary.by_status || [])
      .map((s) => chip(s.status, s.pcs, statusChipClass[s.status] || 'badge-gray'))
      .join('');
    const pageChips = (summary.by_page || [])
      .map((p) => chip(`${p.page} · ${p.scans} scans`, `${p.pcs} pcs`, 'badge-info'))
      .join('');

    listEl.innerHTML = `
      <div style="margin-bottom:12px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;">
        ${statusChips}
        ${chip('Total', `${Number(summary.total_pcs || 0).toLocaleString()} pcs`, 'badge-gray')}
      </div>
      ${pageChips ? `<div style="margin-bottom:12px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;">
        <span style="font-size:11px;color:var(--text-muted);margin-right:4px;">Per page:</span>
        ${pageChips}
      </div>` : ''}
      <table>
        <thead><tr>
          <th>Tracking No.</th><th>Customer</th><th>Phone</th>
          <th>Product</th><th style="text-align:right;">Pcs</th><th>Page</th><th>Province/City</th>
          <th>Date</th><th>Status</th><th>Courier</th><th>Type</th>
        </tr></thead>
        <tbody>
          ${records.map((r) => `<tr>
            <td class="font-mono text-xs">${escapeHtml(r.tracking_no || '')}</td>
            <td style="font-weight:500">${escapeHtml(r.customer || '-')}</td>
            <td class="font-mono text-sm">${escapeHtml(r.phone || '-')}</td>
            <td>${escapeHtml(r.product_name || '-')}</td>
            <td style="text-align:right;font-weight:600;">${scanPcs(r.product_name)}</td>
            <td>${escapeHtml(r.chat_page || '-')}</td>
            <td>${escapeHtml(r.province_city || '-')}</td>
            <td>${escapeHtml((r.scan_date || '').slice(0, 10))}</td>
            <td>${statusBadge(r.status)}</td>
            <td>${escapeHtml(r.courier || '-')}</td>
            <td><span class="badge ${r.scan_type === 'RTS' ? 'badge-danger' : 'badge-info'}">${escapeHtml(r.scan_type || 'Standard')}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div style="font-size:12px;color:var(--text-muted);margin-top:8px;">
        Showing ${records.length} of ${Number(data.total || 0).toLocaleString()} scan${data.total === 1 ? '' : 's'}
      </div>`;

    if (pagEl) {
      pagEl.innerHTML = '';
      if (Number(data.pages || 1) > 1) {
        const mkBtn = (label, p, disabled = false, active = false) => {
          const btn = document.createElement('button');
          btn.className = `btn btn-secondary${active ? ' btn-primary' : ''}`;
          btn.style.minWidth = '36px';
          btn.textContent = label;
          btn.disabled = disabled;
          if (!disabled) btn.onclick = () => loadScanRecords(p);
          return btn;
        };
        pagEl.appendChild(mkBtn('‹', scanRecordsPage - 1, scanRecordsPage <= 1));
        for (let p = Math.max(1, scanRecordsPage - 2); p <= Math.min(Number(data.pages), scanRecordsPage + 2); p++) {
          pagEl.appendChild(mkBtn(p, p, false, p === scanRecordsPage));
        }
        pagEl.appendChild(mkBtn('›', scanRecordsPage + 1, scanRecordsPage >= Number(data.pages)));
      }
    }
  } catch (err) {
    listEl.innerHTML = `<div class="alert alert-danger">Failed to load scan records: ${escapeHtml(err.message)}</div>`;
  }
}

// ─── SHEET RECORDS ─────────────────────────────────────────
let sheetRecordsPage = 1;

function setSheetDatePreset(preset) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const customDiv = document.getElementById('sheet-date-custom');
  const fromEl = document.getElementById('sheet-date-from');
  const toEl = document.getElementById('sheet-date-to');

  document.querySelectorAll('.sheet-date-preset').forEach((b) => b.classList.remove('active', 'btn-primary'));
  const activeBtn = document.querySelector(`.sheet-date-preset[data-preset="${preset}"]`);
  if (activeBtn) { activeBtn.classList.add('active', 'btn-primary'); activeBtn.classList.remove('btn-secondary'); }

  if (preset === 'custom') {
    if (customDiv) customDiv.style.display = 'flex';
    return;
  }
  if (customDiv) customDiv.style.display = 'none';

  let from = '', to = '';
  if (preset === 'today') {
    from = to = fmt(today);
  } else if (preset === 'yesterday') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    from = to = fmt(y);
  } else if (preset === 'month') {
    from = fmt(new Date(today.getFullYear(), today.getMonth(), 1));
    to = fmt(today);
  } else if (preset === 'year') {
    from = `${today.getFullYear()}-01-01`;
    to = fmt(today);
  }
  if (fromEl) fromEl.value = from;
  if (toEl) toEl.value = to;
  loadSheetRecords(1);
}

function showRenameSourceModal() {
  const sel = document.getElementById('sheet-records-sheet-filter');
  const current = sel?.value;
  if (!current || current === 'all') {
    showToast('warning', 'Select a page first', 'Choose a specific Page from the dropdown before renaming.');
    return;
  }

  let modal = document.getElementById('ynt-rename-source-modal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'ynt-rename-source-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border-radius:12px;padding:28px 32px;min-width:360px;max-width:480px;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
      <div style="font-size:16px;font-weight:600;margin-bottom:18px;">Rename Page</div>
      <div class="form-group" style="margin-bottom:14px;">
        <label class="form-label">Current name</label>
        <input class="form-control" id="rename-src-old" value="${escapeHtml(current)}" readonly style="opacity:0.6;">
      </div>
      <div class="form-group" style="margin-bottom:20px;">
        <label class="form-label">New name</label>
        <input class="form-control" id="rename-src-new" value="${escapeHtml(current)}" autofocus>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="document.getElementById('ynt-rename-source-modal').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="confirmRenameSource()">Rename</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.getElementById('rename-src-new').focus();
}

async function confirmRenameSource() {
  const oldName = document.getElementById('rename-src-old')?.value;
  const newName = document.getElementById('rename-src-new')?.value?.trim();
  if (!newName) { showToast('warning', 'Name required', 'Enter a new name.'); return; }
  if (newName === oldName) { document.getElementById('ynt-rename-source-modal')?.remove(); return; }

  try {
    const result = await authorizedJsonRequest('/integrations/google-sheets/rename-source', {
      method: 'PATCH',
      body: JSON.stringify({ old_name: oldName, new_name: newName }),
    });
    document.getElementById('ynt-rename-source-modal')?.remove();
    showToast('success', 'Source renamed', `${result.updated} record${result.updated !== 1 ? 's' : ''} updated from "${oldName}" to "${newName}".`);
    // Reset dropdown and reload
    const sel = document.getElementById('sheet-records-sheet-filter');
    if (sel) { [...sel.options].forEach(o => { if (o.value === oldName) o.remove(); }); sel.value = 'all'; }
    loadSheetRecords(1);
  } catch (err) {
    showToast('error', 'Rename failed', err.message);
  }
}

// Sheet "Shipping info" holds the sprinter as e.g. "sprinter 【AR_Josefine
// Marquez : 639360488957】". Show only the text inside 【…】; if there are no
// brackets, show the raw value as-is.
function extractSprinter(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/【([^】]+)】/);
  return match ? match[1].trim() : text;
}

async function loadSheetRecords(page) {
  if (page) sheetRecordsPage = page;
  const tableEl = document.getElementById('sheet-records-table');
  const pagEl = document.getElementById('sheet-records-pagination');
  if (!tableEl) return;
  tableEl.innerHTML = '<div class="loading-spinner"></div>';

  const sheet = document.getElementById('sheet-records-sheet-filter')?.value || 'all';
  const status = document.getElementById('sheet-records-status-filter')?.value || 'all';
  const tag = document.getElementById('sheet-records-tag-filter')?.value || 'all';
  const search = (document.getElementById('sheet-records-search')?.value || '').trim();
  const dateFrom = (document.getElementById('sheet-date-from')?.value || '').trim();
  const dateTo = (document.getElementById('sheet-date-to')?.value || '').trim();

  const params = new URLSearchParams({ page: sheetRecordsPage, per_page: 50 });
  if (sheet !== 'all') params.set('sheet', sheet);
  if (status !== 'all') params.set('status', status);
  if (tag !== 'all') params.set('tag', tag);
  if (search) params.set('search', search);
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);

  try {
    const data = await authorizedJsonRequest(`/integrations/google-sheets/records?${params}`);

    // Populate sheet dropdown on first load
    const sheetSel = document.getElementById('sheet-records-sheet-filter');
    if (sheetSel && data.sheet_names?.length) {
      const current = sheetSel.value;
      const existingOptions = [...sheetSel.options].map((o) => o.value);
      data.sheet_names.forEach((name) => {
        if (!existingOptions.includes(name)) {
          const opt = document.createElement('option');
          opt.value = name; opt.textContent = name;
          sheetSel.appendChild(opt);
        }
      });
      sheetSel.value = current;
    }

    // Populate tag dropdown on first load
    const tagSel = document.getElementById('sheet-records-tag-filter');
    if (tagSel && data.tags?.length) {
      const current = tagSel.value;
      const existingOptions = [...tagSel.options].map((o) => o.value);
      data.tags.forEach((name) => {
        if (!existingOptions.includes(name)) {
          const opt = document.createElement('option');
          opt.value = name; opt.textContent = name;
          tagSel.appendChild(opt);
        }
      });
      tagSel.value = current;
    }

    // Render status count chips
    const summaryEl = document.getElementById('sheet-records-status-summary');
    if (summaryEl && Array.isArray(data.status_counts) && data.status_counts.length) {
      const statusColors = {
        New: 'badge-info', Confirmed: 'badge-info', 'Waiting for pickup': 'badge-warning',
        Shipped: 'badge-warning', Delivered: 'badge-success',
        Returning: 'badge-warning', Returned: 'badge-danger', Canceled: 'badge-danger',
      };
      const chips = data.status_counts
        .filter((r) => Number(r.count) > 0)
        .map((r) => `<span class="badge ${statusColors[r.status] || 'badge-secondary'}" style="font-size:12px;padding:4px 10px;cursor:pointer;" onclick="document.getElementById('sheet-records-status-filter').value=${JSON.stringify(r.status)};loadSheetRecords(1);">${escapeHtml(r.status)}: <strong>${Number(r.count).toLocaleString()}</strong></span>`)
        .join('');
      const total = data.status_counts.reduce((s, r) => s + Number(r.count), 0);
      summaryEl.innerHTML = `<span class="badge badge-dark" style="font-size:12px;padding:4px 10px;">Total: <strong>${total.toLocaleString()}</strong></span>${chips}`;
    } else if (summaryEl) {
      summaryEl.innerHTML = '';
    }

    if (!data.records?.length) {
      tableEl.innerHTML = '<div class="empty-state" style="padding:40px 0;"><p>No records found. Run a Google Sheets sync first.</p></div>';
      if (pagEl) pagEl.innerHTML = '';
      return;
    }

    const statusBadge = (s) => {
      const map = {
        New: 'badge-info',
        Confirmed: 'badge-info',
        'Waiting for pickup': 'badge-warning',
        Shipped: 'badge-warning',
        Delivered: 'badge-success',
        Returning: 'badge-warning',
        Returned: 'badge-danger',
        Canceled: 'badge-danger',
      };
      return `<span class="badge ${map[s] || 'badge-secondary'}">${escapeHtml(s || '-')}</span>`;
    };
    const clip = (text, max = 60) => {
      const t = String(text || '');
      return t.length > max ? escapeHtml(t.slice(0, max - 1)) + '…' : escapeHtml(t);
    };
    const tdClip = 'style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"';

    const customerCell = (r) => {
      const name = clip(r.customer || '-', 32);
      const phone = r.phone ? `<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(r.phone)}</div>` : '';
      const titleParts = [r.customer, r.phone, r.province_city, r.address].filter(Boolean);
      return `<td style="max-width:220px;" title="${escapeHtml(titleParts.join(' • '))}">
        <div style="font-weight:500;">${name}</div>${phone}
      </td>`;
    };

    tableEl.innerHTML = `
      <div style="overflow-x:auto;">
        <table class="data-table" style="font-size:13px;table-layout:auto;">
          <thead><tr>
            <th>Order ID</th><th>Page</th><th>Customer</th><th>Province/City</th>
            <th>Product</th><th>COD</th><th>Tracking</th>
            <th style="text-align:center;">Attempts</th><th>Status</th>
            <th>Notes</th><th>Courier</th><th>Tag</th>
            <th>Sprinter</th>
            <th>Confirmed By</th><th>Date</th>
          </tr></thead>
          <tbody>
            ${data.records.map((r) => `<tr>
              <td ${tdClip} title="${escapeHtml(r.order_ref || String(r.id))}"><span class="mono-text" style="font-size:12px;">${clip(r.order_ref || String(r.id), 24)}</span></td>
              <td style="white-space:nowrap;" title="${escapeHtml(r.source_sheet || '')}"><span class="badge badge-secondary" style="font-size:11px;">${clip(r.chat_page || r.source_sheet || '-', 24)}</span></td>
              ${customerCell(r)}
              <td ${tdClip} title="${escapeHtml(r.province_city || '')}">${clip(r.province_city || '-', 24)}</td>
              <td ${tdClip} title="${escapeHtml(r.product || '')}">${clip(r.product || '-', 40)}</td>
              <td style="white-space:nowrap;">${r.cod_amount ? Number(r.cod_amount).toLocaleString() : '-'}</td>
              <td ${tdClip} title="${escapeHtml(r.tracking_no || '')}"><span class="mono-text" style="font-size:12px;">${clip(r.tracking_no || '-', 20)}</span></td>
              <td style="text-align:center;">${r.attempts || 1}</td>
              <td style="white-space:nowrap;">${statusBadge(r.status)}</td>
              <td ${tdClip} title="${escapeHtml(r.internal_notes || '')}">${clip(r.internal_notes || '-', 30)}</td>
              <td ${tdClip} title="${escapeHtml(r.courier || '')}">${clip(r.courier || '-', 20)}</td>
              <td ${tdClip} title="${escapeHtml(r.tag || '')}">${clip(r.tag || '-', 24)}</td>
              <td ${tdClip} title="${escapeHtml(r.shipping_info || '')}">${clip(extractSprinter(r.shipping_info) || '-', 40)}</td>
              <td ${tdClip} title="${escapeHtml(r.confirmed_by || '')}">${clip(r.confirmed_by || '-', 20)}</td>
              <td style="white-space:nowrap;">${escapeHtml((r.order_date || '').slice(0, 10))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div style="font-size:12px; color:var(--text-muted); margin-top:8px;">
        Showing ${data.records.length} of ${data.total.toLocaleString()} record${data.total !== 1 ? 's' : ''}
      </div>`;

    if (pagEl) {
      pagEl.innerHTML = '';
      if (data.pages > 1) {
        const mkBtn = (label, p, disabled = false, active = false) => {
          const btn = document.createElement('button');
          btn.className = `btn btn-secondary${active ? ' btn-primary' : ''}`;
          btn.style.minWidth = '36px';
          btn.textContent = label;
          btn.disabled = disabled;
          if (!disabled) btn.onclick = () => loadSheetRecords(p);
          return btn;
        };
        pagEl.appendChild(mkBtn('‹', sheetRecordsPage - 1, sheetRecordsPage <= 1));
        for (let p = Math.max(1, sheetRecordsPage - 2); p <= Math.min(data.pages, sheetRecordsPage + 2); p++) {
          pagEl.appendChild(mkBtn(p, p, false, p === sheetRecordsPage));
        }
        pagEl.appendChild(mkBtn('›', sheetRecordsPage + 1, sheetRecordsPage >= data.pages));
      }
    }
  } catch (err) {
    tableEl.innerHTML = `<div class="alert alert-danger">Failed to load sheet records: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadApiKeys() {
  const el = document.getElementById('api-keys-list');
  if (!el) return;
  try {
    const keys = await authorizedJsonRequest('/api-keys');
    if (!keys.length) {
      el.innerHTML = '<div class="empty-state" style="padding:24px 0;"><p>No API keys yet. Create one to let external apps connect.</p></div>';
      return;
    }
    el.innerHTML = `
      <table class="data-table" style="margin-top:0;">
        <thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last Used</th><th>Created</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${keys.map((k) => `
            <tr>
              <td>${escapeHtml(k.name)}</td>
              <td><code>${escapeHtml(k.key_prefix)}...</code></td>
              <td style="font-size:12px;">${(Array.isArray(k.scopes) ? k.scopes : []).map((s) => `<span class="badge badge-blue" style="font-size:11px;">${escapeHtml(s)}</span>`).join(' ')}</td>
              <td>${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'Never'}</td>
              <td>${k.created_at ? new Date(k.created_at).toLocaleDateString() : ''}</td>
              <td>${k.is_active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-danger">Revoked</span>'}</td>
              <td>${k.is_active ? `<button class="btn btn-sm btn-danger" onclick="revokeApiKey(${k.id})">Revoke</button>` : ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    el.innerHTML = `<div class="error-state">${escapeHtml(err.message)}</div>`;
  }
}

async function createApiKey() {
  const name = document.getElementById('new-api-key-name').value.trim();
  if (!name) { showToast('warning', 'Name required', 'Enter a name for the API key.'); return; }
  const scopes = [...document.querySelectorAll('.api-key-scope:checked')].map((cb) => cb.value);
  if (!scopes.length) { showToast('warning', 'Scope required', 'Select at least one scope.'); return; }
  try {
    const result = await authorizedJsonRequest('/api-keys', { method: 'POST', body: JSON.stringify({ name, scopes }) });
    document.getElementById('api-key-form').style.display = 'none';
    document.getElementById('api-key-result').style.display = '';
    document.getElementById('api-key-result-value').textContent = result.key;
    loadApiKeys();
  } catch (err) {
    showToast('error', 'Failed to create key', err.message);
  }
}

async function revokeApiKey(id) {
  if (!confirm('Revoke this API key? Any apps using it will lose access immediately.')) return;
  try {
    await authorizedJsonRequest(`/api-keys/${id}`, { method: 'DELETE' });
    showToast('success', 'API key revoked', 'The key has been deactivated.');
    loadApiKeys();
  } catch (err) {
    showToast('error', 'Failed to revoke', err.message);
  }
}

function copyApiKeyResult() {
  const val = document.getElementById('api-key-result-value').textContent;
  navigator.clipboard.writeText(val).then(() => showToast('success', 'Copied', 'API key copied to clipboard.'));
}

// ─── WEBHOOKS ──────────────────────────────────────────────
function showCreateWebhookForm() {
  document.getElementById('webhook-form').style.display = '';
  document.getElementById('webhook-secret-result').style.display = 'none';
  document.getElementById('new-webhook-name').value = '';
  document.getElementById('new-webhook-url').value = '';
  document.querySelectorAll('.webhook-event').forEach((cb) => { cb.checked = cb.value === 'order.created'; });
}

async function loadWebhooks() {
  const el = document.getElementById('webhooks-list');
  if (!el) return;
  try {
    const hooks = await authorizedJsonRequest('/webhooks');
    if (!hooks.length) {
      el.innerHTML = '<div class="empty-state" style="padding:24px 0;"><p>No webhooks yet. Create one to push events to your external apps.</p></div>';
      return;
    }
    el.innerHTML = `
      <table class="data-table" style="margin-top:0;">
        <thead><tr><th>Name</th><th>URL</th><th>Events</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${hooks.map((h) => `
            <tr>
              <td>${escapeHtml(h.name)}</td>
              <td style="font-size:12px; max-width:200px; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(h.url)}</td>
              <td style="font-size:12px;">${(Array.isArray(h.events) ? h.events : []).map((e) => `<span class="badge badge-purple" style="font-size:11px;">${escapeHtml(e)}</span>`).join(' ')}</td>
              <td>${h.is_active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-warning">Paused</span>'}</td>
              <td style="display:flex; gap:6px;">
                <button class="btn btn-sm btn-secondary" onclick="viewWebhookDeliveries(${h.id}, '${escapeHtml(h.name)}')">History</button>
                <button class="btn btn-sm btn-${h.is_active ? 'secondary' : 'primary'}" onclick="toggleWebhook(${h.id}, ${h.is_active ? 0 : 1})">${h.is_active ? 'Pause' : 'Resume'}</button>
                <button class="btn btn-sm btn-danger" onclick="deleteWebhook(${h.id})">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    el.innerHTML = `<div class="error-state">${escapeHtml(err.message)}</div>`;
  }
}

async function createWebhook() {
  const name = document.getElementById('new-webhook-name').value.trim();
  const url = document.getElementById('new-webhook-url').value.trim();
  if (!name) { showToast('warning', 'Name required', 'Enter a name for the webhook.'); return; }
  if (!url) { showToast('warning', 'URL required', 'Enter the destination URL.'); return; }
  const events = [...document.querySelectorAll('.webhook-event:checked')].map((cb) => cb.value);
  if (!events.length) { showToast('warning', 'Events required', 'Select at least one event.'); return; }
  try {
    const result = await authorizedJsonRequest('/webhooks', { method: 'POST', body: JSON.stringify({ name, url, events }) });
    document.getElementById('webhook-form').style.display = 'none';
    document.getElementById('webhook-secret-result').style.display = '';
    document.getElementById('webhook-secret-value').textContent = result.secret;
    loadWebhooks();
  } catch (err) {
    showToast('error', 'Failed to create webhook', err.message);
  }
}

async function toggleWebhook(id, active) {
  try {
    await authorizedJsonRequest(`/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify({ is_active: active }) });
    loadWebhooks();
  } catch (err) {
    showToast('error', 'Failed to update webhook', err.message);
  }
}

async function deleteWebhook(id) {
  if (!confirm('Delete this webhook? Delivery history will also be removed.')) return;
  try {
    await authorizedJsonRequest(`/webhooks/${id}`, { method: 'DELETE' });
    showToast('success', 'Webhook deleted', '');
    loadWebhooks();
  } catch (err) {
    showToast('error', 'Failed to delete', err.message);
  }
}

async function viewWebhookDeliveries(id, name) {
  try {
    const deliveries = await authorizedJsonRequest(`/webhooks/${id}/deliveries`);
    const rows = deliveries.length
      ? deliveries.map((d) => `
          <tr>
            <td>${escapeHtml(d.event)}</td>
            <td><span class="badge badge-${d.status === 'delivered' ? 'success' : d.status === 'failed' ? 'danger' : 'gray'}">${d.status}</span></td>
            <td>${d.response_status || '-'}</td>
            <td>${d.created_at ? new Date(d.created_at).toLocaleString() : ''}</td>
            <td style="font-size:11px; max-width:180px; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(d.response_body || '')}</td>
          </tr>`).join('')
      : '<tr><td colspan="5" style="text-align:center; color:var(--text-secondary);">No deliveries yet</td></tr>';

    let overlay = document.getElementById('ynt-dynamic-modal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ynt-dynamic-modal';
      overlay.className = 'modal-overlay';
      overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('open'); };
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="modal" style="max-width:720px;">
        <div class="modal-header">
          <div class="modal-title">Webhook History: ${escapeHtml(name)}</div>
          <button class="modal-close" onclick="document.getElementById('ynt-dynamic-modal').classList.remove('open')">×</button>
        </div>
        <div class="modal-body" style="overflow-x:auto;">
          <table class="data-table">
            <thead><tr><th>Event</th><th>Status</th><th>HTTP</th><th>Time</th><th>Response</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
    overlay.classList.add('open');
  } catch (err) {
    showToast('error', 'Failed to load history', err.message);
  }
}

function copyWebhookSecret() {
  const val = document.getElementById('webhook-secret-value').textContent;
  navigator.clipboard.writeText(val).then(() => showToast('success', 'Copied', 'Signing secret copied to clipboard.'));
}

// Dedicated RMO Management export: clean columns with a separate Phone column,
// and without the on-screen Notes / Message action columns.
function exportRmoCSV() {
  const orders = Array.isArray(DB.posRawOrders) ? DB.posRawOrders : [];
  const statusName = {
    new: 'New', pending: 'New', submitted: 'Confirmed', wait_print: 'Confirmed',
    shipped: 'Shipped', delivered: 'Delivered', returning: 'Returning',
    returned: 'Returned', canceled: 'Canceled', removed: 'Canceled',
  };
  const isExtra = rmoTab !== 'orders';
  const extraHeader = rmoTab === 'delivering' ? 'Last Update' : 'Reason';
  const headers = ['Order #', 'Tracking No', 'Date', 'Product', 'Rider', 'Rider Phone',
    'Customer', 'Phone', 'Page', 'SRP', 'Attempts', 'Confirmed By', 'Tags', 'Status'];
  if (isExtra) headers.push(extraHeader);
  const rows = orders.map((o) => {
    const tags = (Array.isArray(o.tags) ? o.tags : [])
      .map((t) => typeof t === 'string' ? t : (t?.name || t?.tag_name || t?.label || ''))
      .filter(Boolean).join('; ');
    const status = statusName[o.status_name] || (o.status_name || '');
    const cells = [
      o.external_id || '', o.tracking_no || '', formatPosTimestamp(o.inserted_at || o.date) || '',
      o.note_product || '', o.sprinter_name || '', o.sprinter_tel || '',
      o.customer_name || '', o.customer_phone || '', o.page_name || '',
      Number(o.cod || 0), Number(o.attempts || 0), o.assigning_seller_name || '',
      tags, status,
    ];
    if (isExtra) cells.push(rmoTab === 'delivering' ? (formatPosTimestamp(o.updated_at) || '') : (getRmoUndeliverableReason(o) || ''));
    return cells;
  });
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rmo-pos-orders-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  showToast('success', 'CSV exported', 'rmo-pos-orders.csv downloaded');
}

function exportTableCSV(tableId, filename) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const rows = table.querySelectorAll('tr');
  const csv = Array.from(rows).map(row =>
    Array.from(row.cells).map(cell => `"${cell.textContent.trim().replace(/"/g,'""')}"`).join(',')
  ).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  showToast('success', 'CSV exported', `${filename}.csv downloaded`);
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

function normalizeImportHeader(header) {
  return String(header || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function parseCsvText(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map(normalizeImportHeader);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((row, header, index) => {
      if (header) row[header] = values[index] || '';
      return row;
    }, {});
  });
}

function startCsvImport(type) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) importCsvFile(type, file);
  };
  input.click();
}

async function importCsvFile(type, file) {
  try {
    const rows = parseCsvText(await file.text());
    if (!rows.length) {
      showToast('warning', 'Import skipped', 'The CSV file has no data rows.');
      return;
    }

    const result = await authorizedJsonRequest(type === 'inventory' ? '/inventory/import' : '/orders/import', {
      method: 'POST',
      body: JSON.stringify({ rows }),
    });

    if (type === 'inventory') {
      await refreshInventoryFromBackend();
      navigateTo('inventory');
    } else {
      await refreshOrdersFromBackend();
        if (App.currentPage === 'view-records') renderViewRecordsOrdersTable();
    }

    const failed = Array.isArray(result.failed_rows) ? result.failed_rows.length : 0;
    showToast('success', 'Import complete', `Imported ${result.imported || 0}, failed ${failed}`);
  } catch (error) {
    showToast('error', 'Import failed', error.message || 'Could not import CSV.');
  }
}

// ─── MODALS ────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// Press Esc to close the topmost open modal (works for every .modal-overlay).
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const open = document.querySelectorAll('.modal-overlay.open');
  if (!open.length) return;
  open[open.length - 1].classList.remove('open');
});

// ─── TABS ──────────────────────────────────────────────────
function switchTab(btn, contentId) {
  const tabsParent = btn.closest('.tabs');
  if (tabsParent) tabsParent.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const contentParent = btn.closest('.page-content') || document;
  contentParent.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const target = document.getElementById(contentId);
  if (target) target.classList.add('active');

  // Remember marketing sub-tab so re-renders after save/edit don't snap back
  // to Daily Entry. Other pages don't share this prefix so they're untouched.
  if (typeof contentId === 'string' && contentId.startsWith('mkt-')) {
    lastMarketingTab = contentId;
  }
}

let lastMarketingTab = 'mkt-entries';
let marketingPosPage = 1;
let marketingPosPerPage = 20;

// Paginated POS orders listing shown in the Marketing Daily Entry tab. Sourced
// from pos_orders (DB.sheetRecordsForReport). Rows-per-page: 10/20/50/100.
function renderMarketingPosOrdersList() {
  const rows = [...(DB.sheetRecordsForReport || [])]
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const total = rows.length;
  const perPage = marketingPosPerPage;
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (marketingPosPage > pages) marketingPosPage = pages;
  const start = (marketingPosPage - 1) * perPage;
  const paged = rows.slice(start, start + perPage);
  const end = Math.min(start + perPage, total);
  return `
    <div class="table-container">
      <table>
        <thead><tr><th>Date</th><th>Order ID</th><th>Customer</th><th>Product</th><th>Page</th><th>Status</th><th style="text-align:right;">COD</th></tr></thead>
        <tbody>
          ${paged.map((o) => `<tr>
            <td>${escapeHtml(o.date || '')}</td>
            <td class="font-mono text-xs">${escapeHtml(o.id || '')}</td>
            <td>${escapeHtml(o.customer || '')}</td>
            <td>${escapeHtml(o.product || '')}</td>
            <td>${escapeHtml(o.sourceSheet || o.source_sheet || '')}</td>
            <td>${escapeHtml(o.status || '')}</td>
            <td style="text-align:right;">${marketingMoney(o.cod || 0)}</td>
          </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted)">No POS orders.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="table-pagination">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:13px;color:var(--text-muted);">Rows:</span>
        <select onchange="setMarketingPosPerPage(this.value)" style="height:30px;font-size:13px;padding:0 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface-1);color:var(--text-primary);cursor:pointer;">
          ${[10, 20, 50, 100].map((v) => `<option value="${v}"${marketingPosPerPage === v ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
        <span>${total ? start + 1 : 0}–${end} of ${total} POS orders</span>
      </div>
      <div class="pagination-buttons">
        <button class="page-btn" onclick="changeMarketingPosPage(${marketingPosPage - 1})" ${marketingPosPage <= 1 ? 'disabled' : ''}>‹</button>
        ${renderPaginationButtons(marketingPosPage, pages, 'changeMarketingPosPage')}
        <button class="page-btn" onclick="changeMarketingPosPage(${marketingPosPage + 1})" ${marketingPosPage >= pages ? 'disabled' : ''}>›</button>
      </div>
    </div>`;
}

function repaintMarketingPosOrders() {
  const wrap = document.getElementById('mkt-pos-orders-wrap');
  if (wrap) wrap.innerHTML = renderMarketingPosOrdersList();
}

function setMarketingPosPerPage(val) {
  marketingPosPerPage = Number(val) || 20;
  marketingPosPage = 1;
  repaintMarketingPosOrders();
}

function changeMarketingPosPage(page) {
  marketingPosPage = Math.max(1, page);
  repaintMarketingPosOrders();
}

function openViewRecordsTab(tabId) {
  navigateTo('view-records');
  // Wait one tick for the page to render before activating the sub-tab
  setTimeout(() => {
    const tabBtn = document.querySelector(`#records-tabs .tab-btn[onclick*="${tabId}"]`);
    if (tabBtn) tabBtn.click();
  }, 60);
}

// ─── TOAST ─────────────────────────────────────────────────
function showToast(type, title, body, options = {}) {
  const icons = {
    success: '<path d="M13 5L6 12l-3-3" stroke="currentColor" stroke-width="2"/>',
    error:   '<path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="2"/>',
    warning: '<path d="M8 2L14 13H2L8 2z" stroke="currentColor" stroke-width="1.5"/><path d="M8 6v4" stroke="currentColor" stroke-width="1.5"/>',
    info:    '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5v1" stroke="currentColor" stroke-width="1.5"/>',
  };
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 16 16" fill="none">${icons[type]||''}</svg>
    <div class="toast-text"><div class="title">${title}</div><div class="body">${body}</div></div>`;
  toast.onclick = () => toast.remove();
  container.appendChild(toast);
  const duration = Number(options.durationMs ?? options.duration ?? 4000);
  if (duration > 0) setTimeout(() => toast.remove(), duration);
  return toast;
}

// ─── SIDEBAR TOGGLE (mobile) ───────────────────────────────
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay-bg');
  sidebar?.classList.toggle('open');
  overlay?.classList.toggle('open');
}

function toggleSidebarCollapsed() {
  const shell = document.getElementById('app-shell');
  const sidebar = document.getElementById('sidebar');
  if (!shell || !sidebar) return;
  const next = !shell.classList.contains('sidebar-collapsed');
  shell.classList.toggle('sidebar-collapsed', next);
  sidebar.classList.toggle('collapsed', next);
  try { localStorage.setItem('sidebarCollapsed', next ? '1' : '0'); } catch {}
}

function applySidebarCollapsedFromStorage() {
  try {
    if (localStorage.getItem('sidebarCollapsed') === '1') {
      document.getElementById('app-shell')?.classList.add('sidebar-collapsed');
      document.getElementById('sidebar')?.classList.add('collapsed');
    }
  } catch {}
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('uiTheme', next); } catch {}
}

function applyThemeFromStorage() {
  // Dark "neon" is the default look; respect an explicit user choice if set.
  let theme = 'dark';
  try {
    const saved = localStorage.getItem('uiTheme');
    if (saved === 'dark' || saved === 'light') theme = saved;
  } catch {}
  document.documentElement.setAttribute('data-theme', theme);
}

// ─── INIT ──────────────────────────────────────────────────
async function init() {
  const loginScreen = document.getElementById('login-screen');
  const shell = document.getElementById('app-shell');
  if (!loginScreen || !shell) return;

  applyThemeFromStorage();

  // Make Chart.js legible on the dark dashboard background.
  if (window.Chart) {
    Chart.defaults.color = '#93a1bd';
    Chart.defaults.borderColor = 'rgba(148, 163, 184, 0.14)';
    Chart.defaults.font.family = "'DM Sans', sans-serif";
  }

  if (!App.user) {
    loginScreen.innerHTML = renderLogin();
    shell.style.display = 'none';
    return;
  }

  if (getApiBase() && !getAuthToken()) {
    clearExpiredSession();
    loginScreen.innerHTML = renderLogin();
    shell.style.display = 'none';
    showToast('warning', 'Sign in again', 'Your browser session needs a fresh dashboard login.');
    return;
  }

  loginScreen.innerHTML = '';
  shell.style.display = 'flex';
  applySidebarCollapsedFromStorage();
  applyThemeFromStorage();
  startPhilippineClockTicker();
  restoreBreakCountdownIfActive();
  refreshCurrentUserChip();
  navigateTo(getDefaultPageForCurrentUser());
  refreshOrderStatsFromBackend()
    .then(() => {
      if (App.currentPage === 'home') loadPage('home');
    })
    .catch(() => {});

  Promise.allSettled([
    ensureOrdersLoadedForPage(App.currentPage),
    refreshInventoryFromBackend(),
  ]).then(() => {
    if (!App.user) return;
    if (['home', 'data-report', 'inventory', 'view-records', 'rts-rate'].includes(App.currentPage)) {
      loadPage(App.currentPage);
    }
  });

  startPosOrdersAutoRefresh();
}

window.addEventListener('DOMContentLoaded', init);
