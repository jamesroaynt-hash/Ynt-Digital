/* ═══════════════════════════════════════════════════════════
   YNT DIGITAL MARKETING — Shared App JavaScript
   ═══════════════════════════════════════════════════════════ */

// ─── STATE ─────────────────────────────────────────────────
const App = {
  user: JSON.parse(localStorage.getItem('ynt_user') || 'null'),
  currentPage: 'home',
};
const ROLE_OPTIONS = ['Trainee', 'RMO', 'CSR', 'Logistics', 'Sales and Marketing'];
const NAV_ACCESS = {
  Administrator: ['home', 'sales', 'csr', 'inventory', 'expenses', 'daily-pickup', 'rts-scanning', 'scanning', 'view-records', 'damage-sheets', 'manage-users', 'api-connections'],
  Trainee: ['home', 'sales', 'csr', 'view-records'],
  CSR: ['home', 'sales', 'csr', 'view-records', 'manage-users'],
  RMO: ['home', 'sales', 'inventory', 'expenses', 'api-connections'],
  Logistics: ['home', 'sales', 'inventory', 'expenses', 'api-connections'],
  'Sales and Marketing': ['home', 'sales', 'inventory', 'expenses', 'api-connections'],
};
let managedUsers = [];
const INTEGRATION_STORAGE_KEY = 'ynt_integrations';
const CSR_STORAGE_KEY = 'ynt_csr_daily_records';
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
let authMode = 'login';
let salesBarChart = null;
let salesDonutChart = null;

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
    sales: renderSales,
    csr: renderCSR,
    inventory: renderInventory,
    expenses: renderExpenses,
    'daily-pickup': renderDailyPickup,
    'rts-scanning': renderRTSScanning,
    scanning: renderScanning,
    'view-records': renderViewRecords,
    'damage-sheets': renderDamageSheets,
    'manage-users': renderManageUsers,
    'api-connections': renderApiConnections,
  };

  const fn = renderFns[page];
  if (fn) {
    document.getElementById('main-page-content').innerHTML = fn();
    initPage(page);
  }
}

const pageNames = {
  home: 'Home',
  sales: 'Sales Dashboard',
  csr: 'CSR Daily Records',
  inventory: 'Inventory',
  expenses: 'Expenses',
  'daily-pickup': 'Daily Pickup',
  'rts-scanning': 'RTS Scanning',
  scanning: 'Scanning',
  'view-records': 'View Records',
  'damage-sheets': 'Damage Sheets',
  'manage-users': 'Account',
  'api-connections': 'API Connections',
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
    throw new Error(data?.error || data?.message || 'Request failed');
  }

  return data;
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
  localStorage.removeItem('ynt_user');
  localStorage.removeItem('ynt_token');
  App.user = null;
  location.reload();
}

// ─── DUMMY DATA ────────────────────────────────────────────
const DB = {
  orders: generateOrders(80),
  csrRecords: loadCsrRecords(),
  inventory: generateInventory(),
  expenses: generateExpenses(30),
  dailyPickups: generatePickups(20),
  scanRecords: generateScanRecords(40),
  customers: generateCustomers(20),
};

function generateOrders(n) {
  const statuses = ['Shipped', 'Delivered', 'Returned', 'Returning', 'Pending'];
  const products = ['YNT Serum Glow', 'Hydra Cream', 'Vitamin C Drops', 'Retinol Boost', 'Toner Mist'];
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
    { id: 'P001', name: 'YNT Serum Glow 30ml', type: 'Product', sku: 'SKU-001', stock: 156, reorder: 200, unit: 'pcs', cost: 120, price: 599 },
    { id: 'P002', name: 'Hydra Cream 50g', type: 'Product', sku: 'SKU-002', stock: 230, reorder: 200, unit: 'pcs', cost: 95, price: 450 },
    { id: 'P003', name: 'Vitamin C Drops 15ml', type: 'Product', sku: 'SKU-003', stock: 88, reorder: 200, unit: 'pcs', cost: 75, price: 399 },
    { id: 'P004', name: 'Retinol Boost Serum', type: 'Product', sku: 'SKU-004', stock: 312, reorder: 200, unit: 'pcs', cost: 140, price: 699 },
    { id: 'P005', name: 'Toner Mist 100ml', type: 'Product', sku: 'SKU-005', stock: 45, reorder: 200, unit: 'pcs', cost: 60, price: 299 },
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
  const products = ['YNT Serum Glow 30ml', 'Hydra Cream 50g', 'Vitamin C Drops', 'Retinol Boost', 'Toner Mist'];
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

function getCurrentCsrName() {
  if (App.user?.name) return App.user.name;
  if (App.user?.username) return App.user.username;
  return 'CSR Member';
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

function loadCsrRecords() {
  try {
    const saved = JSON.parse(localStorage.getItem(CSR_STORAGE_KEY) || '[]');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}

  const seeded = generateCsrRecords();
  localStorage.setItem(CSR_STORAGE_KEY, JSON.stringify(seeded));
  return seeded;
}

function saveCsrRecords() {
  localStorage.setItem(CSR_STORAGE_KEY, JSON.stringify(DB.csrRecords));
}

function getDefaultIntegrationState() {
  return {
    pancake: {
      enabled: false,
      syncMode: 'webhook_only',
      webhookSecret: '',
      baseUrl: '',
      userAccessToken: '',
      pageId: '',
      pageAccessToken: '',
      notes: '',
      lastSavedAt: null,
      lastCollectedAt: null,
      lastCollectionSummary: '',
    },
    googleSheets: {
      enabled: false,
      syncMode: 'manual',
      spreadsheetId: '',
      sheetName: 'Orders',
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
      pancake: {
        ...fallback.pancake,
        ...(saved.pancake || {}),
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

function getPancakeWebhookUrl() {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return `${location.origin}/api/public/integrations/pancake/webhook`;
  }
  return 'http://localhost:3001/api/public/integrations/pancake/webhook';
}

function getPancakePublicApiBase() {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return `${location.origin}/api/public/integrations/pancake`;
  }
  return 'http://localhost:3001/api/public/integrations/pancake';
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

// ─── RENDER: LOGIN ─────────────────────────────────────────
function renderLogin() {
  return `
  <div class="login-page" id="login-page">
    <div class="login-panel">
      <div class="brand">
        <div class="brand-logo">Y</div>
        <div class="brand-text">
          <div class="name">YNT Dashboard</div>
          <div class="sub">Digital Marketing</div>
        </div>
      </div>
      <div class="login-welcome">
        <h2>Welcome back</h2>
        <p id="auth-helper-copy">Sign in with your registered username and password. Only admin can create new accounts.</p>
      </div>
      <form onsubmit="handleAuthSubmit(event)">
        <div class="form-group">
          <label class="form-label">Username <span class="required">*</span></label>
          <input type="text" id="username" class="form-control" placeholder="Enter username" autocomplete="username">
        </div>
        <div class="form-group">
          <label class="form-label">Password <span class="required">*</span></label>
          <input type="password" id="password" class="form-control" placeholder="Enter password" autocomplete="current-password">
        </div>
        <div style="margin-bottom:20px; font-size:12px; color:var(--text-muted)">
          LAN mode: admin creates named accounts first, then each team member logs in using that account.
        </div>
        <button type="submit" class="btn btn-primary w-full btn-lg"><span id="auth-submit-label">Sign In</span></button>
      </form>
    </div>
    <div class="login-visual">
      <div class="login-visual-bg"></div>
      <h3>Your Business,<br>Fully Managed</h3>
      <p>Track sales, inventory, shipments, and more — all in one internal dashboard built for YNT Digital Marketing.</p>
      <div class="login-stats-preview">
        <div class="login-stat-chip"><span class="val">₱2.4M</span><span class="lbl">Monthly Sales</span></div>
        <div class="login-stat-chip"><span class="val">1,842</span><span class="lbl">Orders</span></div>
        <div class="login-stat-chip"><span class="val">98.2%</span><span class="lbl">Delivered</span></div>
      </div>
    </div>
  </div>`;
}

function renderApiConnections() {
  const state = getIntegrationState();
  const settings = state.pancake;
  const googleSettings = state.googleSheets;
  const webhookUrl = getPancakeWebhookUrl();
  const statusTone = settings.enabled ? 'success' : 'warning';
  const statusText = settings.enabled ? 'Connected' : 'Setup Needed';
  const googleStatusTone = googleSettings.enabled ? 'success' : 'warning';
  const googleStatusText = googleSettings.enabled ? 'Ready' : 'Setup Needed';
  const savedAt = settings.lastSavedAt ? new Date(settings.lastSavedAt).toLocaleString() : 'Not saved yet';
  const collectedAt = settings.lastCollectedAt ? new Date(settings.lastCollectedAt).toLocaleString() : 'No API collection yet';
  const googleSavedAt = googleSettings.lastSavedAt ? new Date(googleSettings.lastSavedAt).toLocaleString() : 'Not saved yet';
  const googleCollectedAt = googleSettings.lastCollectedAt ? new Date(googleSettings.lastCollectedAt).toLocaleString() : 'No sheet sync yet';

  return `
  <div class="page-header">
    <div class="page-title">
      <h1>API Connections</h1>
      <p>Manage Pancake webhook delivery and automate Google Sheets imports into the dashboard database.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary" onclick="fetchPancakePages()">
        Get Pages
      </button>
      <button class="btn btn-secondary" onclick="collectPancakeApiData()">
        Collect API Data
      </button>
      <button class="btn btn-secondary" onclick="copyWebhookUrl()">
        Copy Webhook URL
      </button>
      <button class="btn btn-primary" onclick="savePancakeConnection()">
        Save Connection
      </button>
      <button class="btn btn-secondary" onclick="collectGoogleSheetsData()">
        Sync Google Sheets
      </button>
    </div>
  </div>

  <div class="stats-grid" style="margin-bottom:24px;">
    <div class="stat-card blue">
      <div class="stat-card-accent"></div>
      <div class="stat-label">Provider</div>
      <div class="stat-value" style="font-size:22px;">Pancake</div>
      <div class="stat-meta">Webhook + API collection</div>
    </div>
    <div class="stat-card ${statusTone === 'success' ? 'green' : 'amber'}">
      <div class="stat-card-accent"></div>
      <div class="stat-label">Connection Status</div>
      <div class="stat-value" style="font-size:22px;">${statusText}</div>
      <div class="stat-meta">${settings.enabled ? 'Webhook and API config can be used' : 'Enable and save the connection first'}</div>
    </div>
    <div class="stat-card navy">
      <div class="stat-card-accent"></div>
      <div class="stat-label">Last API Collection</div>
      <div class="stat-value" style="font-size:18px;">${collectedAt}</div>
      <div class="stat-meta">${escapeHtml(settings.lastCollectionSummary || 'Ready to collect conversations, customers, posts, tags, users, and messages.')}</div>
    </div>
    <div class="stat-card ${googleStatusTone === 'success' ? 'green' : 'amber'}">
      <div class="stat-card-accent"></div>
      <div class="stat-label">Google Sheets Sync</div>
      <div class="stat-value" style="font-size:18px;">${googleCollectedAt}</div>
      <div class="stat-meta">${escapeHtml(googleSettings.lastCollectionSummary || `${googleStatusText}. Orders sheet will sync into SQLite.`)}</div>
    </div>
  </div>

  <div class="integration-layout">
    <section class="card integration-card">
      <div class="card-header">
        <div>
          <div class="card-title">Pancake Webhook Setup</div>
          <div class="card-subtitle">Use this when Pancake pushes orders or stock updates into the dashboard.</div>
        </div>
      </div>
      <div class="card-body integration-body">
        <div class="integration-toggle">
          <div>
            <div class="integration-toggle-title">Enable Pancake connection</div>
            <div class="integration-toggle-copy">Turn this on when your Pancake webhook and page API credentials are ready.</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="pancake-enabled" ${settings.enabled ? 'checked' : ''}>
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="form-grid two-col">
          <div class="form-group">
            <label class="form-label">User Access Token</label>
            <input type="text" class="form-control mono-input" id="pancake-user-access-token" placeholder="Pancake account access_token" value="${escapeHtml(settings.userAccessToken)}">
            <div class="field-help">Used for <code>GET /pages</code> and generating a page access token.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Page ID</label>
            <input type="text" class="form-control mono-input" id="pancake-page-id" placeholder="Selected Pancake page_id" value="${escapeHtml(settings.pageId)}">
            <div class="field-help">Pick the page you want this dashboard to collect from.</div>
          </div>
        </div>

        <div class="form-grid two-col">
          <div class="form-group">
            <label class="form-label">Page Access Token</label>
            <input type="text" class="form-control mono-input" id="pancake-page-access-token" placeholder="Generated page_access_token" value="${escapeHtml(settings.pageAccessToken)}">
            <div class="field-help">Optional if already generated in Pancake. If blank, the collector will try to generate it from the user token.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Webhook URL</label>
            <div class="integration-inline">
              <input type="text" class="form-control mono-input" id="pancake-webhook-url" value="${escapeHtml(webhookUrl)}" readonly>
              <button class="btn btn-secondary" type="button" onclick="copyWebhookUrl()">Copy</button>
            </div>
            <div class="field-help">Paste this URL into Pancake's webhook destination field.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Sync Mode</label>
            <select class="form-control" id="pancake-sync-mode">
              <option value="webhook_only" ${settings.syncMode === 'webhook_only' ? 'selected' : ''}>Webhook only</option>
              <option value="webhook_plus_manual" ${settings.syncMode === 'webhook_plus_manual' ? 'selected' : ''}>Webhook + manual retry</option>
              <option value="manual_backup" ${settings.syncMode === 'manual_backup' ? 'selected' : ''}>Manual backup only</option>
            </select>
            <div class="field-help">Recommended for your current setup: <strong>Webhook only</strong>.</div>
          </div>
        </div>

        <div class="form-grid two-col">
          <div class="form-group">
            <label class="form-label">Webhook Secret</label>
            <input type="text" class="form-control mono-input" id="pancake-webhook-secret" placeholder="example: ynt-pancake-secret-2026" value="${escapeHtml(settings.webhookSecret)}">
            <div class="field-help">Use the same secret in Pancake and in this dashboard to validate incoming payloads.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Pancake Base URL <span style="color:var(--text-muted); font-weight:400;">optional</span></label>
            <input type="text" class="form-control mono-input" id="pancake-base-url" placeholder="https://pos.pancake.ph" value="${escapeHtml(settings.baseUrl)}">
            <div class="field-help">Optional reference only. Not required for webhook mode.</div>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Internal Notes</label>
          <textarea class="form-control" id="pancake-notes" rows="4" placeholder="Example: Pancake sends orders + inventory updates. Verified in production store.">${escapeHtml(settings.notes)}</textarea>
        </div>

        <div class="integration-actions">
          <button class="btn btn-primary" type="button" onclick="savePancakeConnection()">Save Connection</button>
          <button class="btn btn-secondary" type="button" onclick="sendWebhookTest()">Send Test Webhook</button>
        </div>
      </div>
    </section>

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
            <input type="text" class="form-control mono-input" id="google-sheets-sheet-name" placeholder="Orders, Team A, Team B" value="${escapeHtml(googleSettings.sheetName)}">
            <div class="field-help">Enter one or more Google Sheets tab names separated by commas. Each imported order keeps its source sheet name.</div>
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
              <option value="manual" ${googleSettings.syncMode === 'manual' ? 'selected' : ''}>Manual only</option>
              <option value="automatic" ${googleSettings.syncMode === 'automatic' ? 'selected' : ''}>Automatic every few minutes</option>
            </select>
            <div class="field-help">Automatic mode runs in the backend on a repeating timer.</div>
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

    <aside class="integration-stack">
      <section class="card integration-card">
        <div class="card-header">
          <div>
            <div class="card-title">Collection Checklist</div>
            <div class="card-subtitle">Quick setup using the Pancake API doc you shared.</div>
          </div>
        </div>
        <div class="card-body integration-body">
          <div class="check-list">
            <div class="check-item"><span>1</span> Paste your Pancake <code>access_token</code> from Personal Settings.</div>
            <div class="check-item"><span>2</span> Click <strong>Get Pages</strong> to confirm the account token works.</div>
            <div class="check-item"><span>3</span> Save the target <code>page_id</code>.</div>
            <div class="check-item"><span>4</span> Let the collector generate <code>page_access_token</code>, or paste one manually.</div>
            <div class="check-item"><span>5</span> Click <strong>Collect API Data</strong> to store page data locally.</div>
          </div>
        </div>
      </section>

      <section class="card integration-card">
        <div class="card-header">
          <div>
            <div class="card-title">Collection Scope</div>
            <div class="card-subtitle">Current collector uses the endpoints present in your Pancake OpenAPI file.</div>
          </div>
        </div>
        <div class="card-body integration-body">
          <pre class="code-block">${escapeHtml(JSON.stringify({
            resources: ['conversations', 'customers', 'posts', 'tags', 'users', 'messages'],
            routes: [
              'GET /pages',
              'POST /pages/{page_id}/generate_page_access_token',
              'GET /pages/{page_id}/conversations',
              'GET /pages/{page_id}/page_customers',
              'GET /pages/{page_id}/posts',
              'GET /pages/{page_id}/tags',
              'GET /pages/{page_id}/users',
              'GET /pages/{page_id}/conversations/{conversation_id}/messages'
            ]
          }, null, 2))}</pre>
        </div>
      </section>
    </aside>
  </div>
  `;
}

function getPancakeSamplePayload() {
  return {
    orders: [
      {
        id: 'pc-order-1001',
        order_ref: 'PC-1001',
        tracking_no: 'JT123456789PH',
        customer_name: 'Maria Santos',
        customer_phone: '09171234567',
        product_name: 'YNT Serum Glow 30ml',
        quantity: 2,
        cod_amount: 1198,
        status: 'shipping',
        shipping_provider: 'J&T Express',
        created_at: new Date().toISOString(),
      },
    ],
    inventory: [
      {
        id: 'pc-item-001',
        sku: 'SKU-001',
        product_name: 'YNT Serum Glow 30ml',
        type: 'Product',
        stock: 148,
        reorder_pt: 200,
        cost_price: 120,
        sell_price: 599,
      },
    ],
  };
}

// ─── RENDER: HOME ──────────────────────────────────────────
function renderHome() {
  const quickActions = getHomeQuickActions();
  const total = DB.orders.length;
  const delivered = DB.orders.filter(o => o.status === 'Delivered').length;
  const totalCOD = DB.orders.reduce((s, o) => s + o.cod, 0);

  const galleryItems = [
    { title: 'YNT Serum Glow', desc: 'Best Seller — Anti-aging formula', color: '#eff6ff' },
    { title: 'Hydra Cream 50g', desc: 'Deep moisture restoration', color: '#ecfdf5' },
    { title: 'Vitamin C Drops', desc: 'Brightening treatment serum', color: '#fffbeb' },
    { title: 'Retinol Boost', desc: 'Youth renewal technology', color: '#fdf2f8' },
    { title: 'Toner Mist', desc: 'Hydrating refresh spray', color: '#f0f9ff' },
    { title: 'YNT Bundle Kit', desc: 'Complete skincare routine', color: '#faf5ff' },
  ];

  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Welcome back, ${App.user?.name?.split(' ')[0] || 'User'} 👋</h1>
      <p>Here's what's happening at YNT Digital Marketing today.</p>
    </div>
    <div class="page-actions">
      <span class="text-sm text-muted">${new Date().toLocaleDateString('en-PH', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</span>
    </div>
  </div>

  <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 28px;">
    <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">Total Orders</div><div class="stat-value">${total}</div><div class="stat-meta"><span class="stat-badge up">↑ 12%</span> vs last month</div></div>
    <div class="stat-card green"><div class="stat-card-accent"></div><div class="stat-label">Delivered</div><div class="stat-value">${delivered}</div><div class="stat-meta"><span class="stat-badge up">↑ 8%</span> delivery rate</div></div>
    <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">COD Revenue</div><div class="stat-value">₱${totalCOD.toLocaleString()}</div><div class="stat-meta"><span class="stat-badge up">↑ 15%</span> this week</div></div>
    <div class="stat-card red"><div class="stat-card-accent"></div><div class="stat-label">Low Stock Items</div><div class="stat-value">${DB.inventory.filter(i => i.stock < i.reorder).length}</div><div class="stat-meta"><span class="stat-badge down">↓ needs reorder</span></div></div>
  </div>

  <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px;">
    <div class="card">
      <div class="card-header"><div><div class="card-title">Order Status Overview</div><div class="card-subtitle">Last 30 days</div></div></div>
      <div class="card-body" style="padding: 16px;">
        <canvas id="home-donut-chart" height="200"></canvas>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div><div class="card-title">Quick Actions</div><div class="card-subtitle">Shortcuts based on your role</div></div></div>
      <div class="card-body">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          ${quickActions.map(([icon, label, page]) => `
            <button onclick="navigateTo('${page}')" class="btn btn-secondary" style="justify-content:flex-start; padding:14px; height:auto; flex-direction:column; align-items:flex-start; gap:6px;">
              <span style="font-size:20px">${icon}</span>
              <span style="font-size:13px; font-weight:500; color:var(--text-primary)">${label}</span>
            </button>
          `).join('')}
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <div><div class="card-title">Product Gallery</div><div class="card-subtitle">YNT Digital Marketing product line</div></div>
      <button class="btn btn-ghost btn-sm" onclick="navigateTo('inventory')">View Inventory →</button>
    </div>
    <div class="card-body">
      <div class="gallery-grid">
        ${galleryItems.map((item, i) => `
          <div class="gallery-item">
            <div class="gallery-img" style="background:${item.color}; display:flex; align-items:center; justify-content:center;">
              <div style="font-size:48px; opacity:0.6">${['✨','💧','🍋','⭐','💦','🎁'][i]}</div>
            </div>
            <div class="gallery-info">
              <h4>${item.title}</h4>
              <p>${item.desc}</p>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  </div>`;
}

function getUserRoleBadgeClass(role) {
  if (normalizeRoleName(role) === 'Administrator') return 'badge-purple';
  if (role === 'CSR') return 'badge-info';
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

function renderManageUsers() {
  const ownAccountSection = renderOwnAccountSection();
  if (!isAdminUser()) {
    return `
    <div class="page-header">
      <div class="page-title">
        <h1>Account</h1>
        <p>View and update your own account details.</p>
      </div>
    </div>
    ${ownAccountSection}`;
  }

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
          <div class="card-title" style="margin-bottom:4px;">Admin-only controls</div>
          <div class="card-subtitle">Only administrators can edit or delete user accounts from this screen.</div>
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
  const shipped = DB.orders.filter((o) => o.status === 'Shipped').length;
  const delivered = DB.orders.filter((o) => o.status === 'Delivered').length;
  const returned = DB.orders.filter((o) => o.status === 'Returned').length;
  const returning = DB.orders.filter((o) => o.status === 'Returning').length;
  const totalCOD = DB.orders.reduce((sum, o) => sum + o.cod, 0);
  return `
  <div class="page-header">
    <div class="page-title"><h1>Sales Dashboard</h1><p>Track orders, deliveries, and revenue metrics.</p></div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="exportTableCSV('sales-table', 'sales-records')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8M5 7l3 3 3-3M2 12h12"/></svg>
        Export CSV
      </button>
    </div>
  </div>

  <div class="stats-grid" style="grid-template-columns: repeat(5, 1fr);" id="sales-summary-cards">
    <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">Shipped</div><div class="stat-value">0</div><div class="stat-meta">Awaiting delivery</div></div>
    <div class="stat-card green"><div class="stat-card-accent"></div><div class="stat-label">Delivered</div><div class="stat-value">${delivered}</div><div class="stat-meta"><span class="stat-badge up">✓ Completed</span></div></div>
    <div class="stat-card red"><div class="stat-card-accent"></div><div class="stat-label">Returned</div><div class="stat-value">${returned}</div><div class="stat-meta">Received back</div></div>
    <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">Returning</div><div class="stat-value">${returning}</div><div class="stat-meta">In transit back</div></div>
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
        <button class="filter-pill ${salesFilter === 'daily' ? 'active' : ''}" onclick="setSalesFilter('daily',this)">Daily</button>
        <button class="filter-pill ${salesFilter === 'weekly' ? 'active' : ''}" onclick="setSalesFilter('weekly',this)">Weekly</button>
        <button class="filter-pill ${salesFilter === 'monthly' ? 'active' : ''}" onclick="setSalesFilter('monthly',this)">Month</button>
        <button class="filter-pill ${salesFilter === 'yearly' ? 'active' : ''}" onclick="setSalesFilter('yearly',this)">Year</button>
        <button class="filter-pill ${salesFilter === 'custom' ? 'active' : ''}" onclick="setSalesFilter('custom',this)">Custom</button>
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
          <th>Order ID</th><th>Date</th><th>Customer</th><th>Product</th>
          <th>Qty</th><th>COD</th><th>Courier</th><th>Status</th>
        </tr></thead>
        <tbody id="sales-tbody"></tbody>
      </table>
    </div>
    <div class="table-pagination" id="sales-pagination"></div>
  </div>`;
}

// ─── RENDER: INVENTORY ──────────────────────────────────────
function renderCSR() {
  const today = new Date().toISOString().split('T')[0];

  return `
  <div class="page-header">
    <div class="page-title"><h1>CSR Daily Records</h1><p>Admins can view all CSR entries. CSR users only see and edit their own sales records.</p></div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="exportTableCSV('csr-records-table', 'csr-daily-records')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8M5 7l3 3 3-3M2 12h12"/></svg>
        Export CSV
      </button>
    </div>
  </div>

  <div class="split-layout" style="margin-bottom:20px;">
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Daily Record Input</div><div class="card-subtitle">CSR name follows the current login automatically.</div></div>
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

        <div class="form-group">
          <label class="form-label">Page Name <span class="required">*</span></label>
          <select class="form-control" id="csr-page-name">
            <option value="">Select page...</option>
            ${CSR_PAGE_OPTIONS.map((page) => `<option value="${page}">${page}</option>`).join('')}
          </select>
        </div>

        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Customer Name <span class="required">*</span></label>
            <input type="text" class="form-control" id="csr-customer-name" placeholder="Enter customer name">
          </div>
          <div class="form-group">
            <label class="form-label">Cellphone Number <span class="required">*</span></label>
            <input type="text" class="form-control font-mono" id="csr-cellphone-number" placeholder="09XXXXXXXXX">
          </div>
        </div>

        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Type of Sales <span class="required">*</span></label>
            <select class="form-control" id="csr-sales-type">
              <option value="">Select sales type...</option>
              ${CSR_SALES_TYPES.map((type) => `<option value="${type}">${type}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Status <span class="required">*</span></label>
            <select class="form-control" id="csr-status">
              <option value="">Select status...</option>
              ${CSR_STATUS_OPTIONS.map((status) => `<option value="${status}">${status}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Price <span class="required">*</span></label>
            <div class="input-group">
              <span class="input-addon">₱</span>
              <input type="number" class="form-control" id="csr-price" placeholder="0.00" min="0" step="0.01">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Tracking Number</label>
            <input type="text" class="form-control font-mono" id="csr-tracking-number" placeholder="Tracking number">
          </div>
        </div>

        <div class="flex gap-3">
          <button class="btn btn-primary" id="csr-save-btn" onclick="saveCSRRecord()">${getCSRPrimaryButtonLabel()}</button>
          <button class="btn btn-secondary" id="csr-reset-btn" onclick="resetCSRForm()">Reset</button>
        </div>
      </div>
    </div>

    <div class="summary-stack">
      <div id="csr-summary"></div>
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">Status Pie Graph</div><div class="card-subtitle">Based on the currently filtered table records.</div></div>
        </div>
        <div class="card-body chart-panel">
          <canvas id="csr-status-pie-chart" height="260"></canvas>
        </div>
      </div>
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
    </div>
    <div style="overflow-x:auto;">
      <table id="csr-records-table">
        <thead><tr>
          <th>Date</th><th>Name CSR</th><th>Page Name</th><th>Customer</th><th>Cellphone</th>
          <th>Type of Sales</th><th>Status</th><th>Price</th><th>Tracking Number</th><th>Actions</th>
        </tr></thead>
        <tbody id="csr-tbody"></tbody>
      </table>
    </div>
    <div class="table-pagination" id="csr-pagination"></div>
  </div>`;
}

function renderInventory() {
  const lowStock = DB.inventory.filter(i => i.stock < i.reorder);

  return `
  <div class="page-header">
    <div class="page-title"><h1>Inventory</h1><p>Manage products, supplies, and stock levels.</p></div>
    <div class="page-actions">
      <button class="btn btn-secondary" onclick="openModal('stocks-modal')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>
        Stocks Update
      </button>
      <button class="btn btn-primary" onclick="openModal('add-inventory-modal')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>
        Add Item
      </button>
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
    <button class="tab-btn active" onclick="switchTab(this,'tab-products')">Products</button>
    <button class="tab-btn" onclick="switchTab(this,'tab-supplies')">Supplies</button>
    <button class="tab-btn" onclick="switchTab(this,'tab-all')">All Items</button>
  </div>

  <div id="tab-products" class="tab-content active">
    <div class="table-container">
      ${renderInventoryTable(DB.inventory.filter(i => i.type === 'Product'))}
    </div>
  </div>
  <div id="tab-supplies" class="tab-content">
    <div class="table-container">
      ${renderInventoryTable(DB.inventory.filter(i => i.type === 'Supply'))}
    </div>
  </div>
  <div id="tab-all" class="tab-content">
    <div class="table-container">
      ${renderInventoryTable(DB.inventory)}
    </div>
  </div>

  <!-- Add/Edit Inventory Modal -->
  <div class="modal-overlay" id="add-inventory-modal">
    <div class="modal">
      <div class="modal-header"><div class="modal-title">Add Inventory Item</div><button class="modal-close" onclick="closeModal('add-inventory-modal')">×</button></div>
      <div class="modal-body">
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Item Name <span class="required">*</span></label><input type="text" class="form-control" id="inv-name" placeholder="Product name"></div>
          <div class="form-group"><label class="form-label">SKU</label><input type="text" class="form-control" id="inv-sku" placeholder="SKU-XXX"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Type <span class="required">*</span></label>
            <select class="form-control" id="inv-type"><option>Product</option><option>Supply</option></select></div>
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
  </div>

  <!-- Stocks Update Modal -->
  <div class="modal-overlay" id="stocks-modal">
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
  </div>`;
}

function renderInventoryTable(items) {
  return `
    <table>
      <thead><tr><th>SKU</th><th>Item Name</th><th>Type</th><th>Stock</th><th>Level</th><th>Reorder Pt.</th><th>Unit Cost</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        ${items.map(item => {
          const pct = Math.min(100, (item.stock / (item.reorder * 1.5)) * 100);
          const statusClass = item.stock >= item.reorder ? 'stock-ok' : item.stock >= item.reorder * 0.5 ? 'stock-low' : 'stock-crit';
          const badge = item.stock >= item.reorder ? 'badge-success' : item.stock >= item.reorder * 0.5 ? 'badge-warning' : 'badge-danger';
          const badgeText = item.stock >= item.reorder ? 'OK' : item.stock >= item.reorder * 0.5 ? 'Low' : 'Critical';
          return `<tr>
            <td><span class="font-mono text-xs text-muted">${item.sku}</span></td>
            <td><div style="font-weight:500">${item.name}</div></td>
            <td><span class="badge ${item.type==='Product'?'badge-info':'badge-gray'}">${item.type}</span></td>
            <td><strong>${item.stock}</strong> ${item.unit}</td>
            <td>
              <div class="stock-indicator ${statusClass}" style="min-width:100px">
                <div class="stock-bar"><div class="stock-bar-fill" style="width:${pct}%"></div></div>
                <span class="text-xs" style="width:30px">${Math.round(pct)}%</span>
              </div>
            </td>
            <td>${item.reorder} ${item.unit}</td>
            <td>₱${item.cost}</td>
            <td><span class="badge ${badge}">${badgeText}</span></td>
            <td>
              <div class="flex gap-2">
                <button class="btn btn-ghost btn-sm" onclick="openModal('stocks-modal')">Restock</button>
              </div>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
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
    </div>
  </div>

  <div style="display:grid; grid-template-columns:400px 1fr; gap:20px; align-items:start;">
    <div class="card" style="position:sticky; top:80px;">
      <div class="card-header"><div class="card-title">Log New Expense</div></div>
      <div class="card-body">
        <div class="form-group"><label class="form-label">Date <span class="required">*</span></label><input type="date" class="form-control" id="exp-date" value="${new Date().toISOString().split('T')[0]}"></div>
        <div class="form-group"><label class="form-label">Category <span class="required">*</span></label>
          <select class="form-control" id="exp-cat">
            <option value="">Select category...</option>
            <option>Load</option><option>Utility</option><option>Product Supplies</option><option>Others</option>
          </select>
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
        <div class="form-group"><label class="form-label">Noted By</label><input type="text" class="form-control" id="exp-noted" value="${App.user?.name || ''}"></div>
        <div class="form-group">
          <label class="form-label">Total Amount</label>
          <div class="input-group">
            <span class="input-addon">₱</span>
            <input type="text" class="form-control" id="exp-total" placeholder="0.00" readonly style="background:var(--surface-3); font-weight:600; font-size:16px;">
          </div>
        </div>
        <button class="btn btn-primary w-full" onclick="saveExpense()">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H5L2 6v7a1 1 0 001 1h10a1 1 0 001-1V3a1 1 0 00-1-1zM11 14v-4H5v4"/><path d="M5 2v4h5V2"/></svg>
          Save Expense
        </button>
      </div>
    </div>

    <div>
      <div class="stats-grid" style="grid-template-columns:1fr 1fr 1fr; margin-bottom:16px;">
        <div class="stat-card red"><div class="stat-card-accent"></div><div class="stat-label">Total Expenses</div><div class="stat-value" style="font-size:20px;">₱${totalExp.toLocaleString()}</div></div>
        <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">This Month</div><div class="stat-value" style="font-size:20px;">₱${monthTotal.toLocaleString()}</div></div>
        <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">Records</div><div class="stat-value">${DB.expenses.length}</div></div>
      </div>

      <div class="table-container">
        <div class="table-toolbar">
          <div class="table-search">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
            <input type="text" placeholder="Search expenses..." id="exp-search" oninput="filterExpTable()">
          </div>
          <div class="table-filters">
            ${['All','Load','Utility','Product Supplies','Others'].map((c,i) => 
              `<button class="filter-pill ${i===0?'active':''}" onclick="setExpCatFilter('${c}',this)">${c}</button>`
            ).join('')}
          </div>
        </div>
        <table id="expenses-table">
          <thead><tr><th>ID</th><th>Date</th><th>Category</th><th>Item</th><th>Qty</th><th>Price</th><th>Total</th><th>Noted By</th></tr></thead>
          <tbody id="exp-tbody">
            ${DB.expenses.map(e => `<tr>
              <td class="font-mono text-xs text-muted">${e.id}</td>
              <td>${e.date}</td>
              <td><span class="badge ${catBadge(e.category)}">${e.category}</span></td>
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
  </div>`;
}

function catBadge(cat) {
  return { Load: 'badge-info', Utility: 'badge-warning', 'Product Supplies': 'badge-purple', Others: 'badge-gray' }[cat] || 'badge-gray';
}

// ─── RENDER: DAILY PICKUP ──────────────────────────────────
function renderDailyPickup() {
  return `
  <div class="page-header">
    <div class="page-title"><h1>Daily Pickup</h1><p>Log daily product pickups for delivery dispatch.</p></div>
  </div>

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
  </div>`;
}

// ─── RENDER: SCANNING ──────────────────────────────────────
function renderScanning() {
  return renderScanPage('scanning', 'Scanning', 'Standard');
}

function renderRTSScanning() {
  return renderScanPage('rts-scanning', 'RTS Scanning', 'RTS');
}

function renderScanPage(pageId, pageTitle, scanType) {
  const records = DB.scanRecords.filter(r => scanType === 'RTS' ? r.type === 'RTS' : r.type !== 'RTS');
  return `
  <div class="page-header">
    <div class="page-title"><h1>${pageTitle}</h1><p>Scan tracking numbers to retrieve order information.</p></div>
    <div class="page-actions">
      <button class="btn btn-secondary" onclick="navigateTo('damage-sheets')">📋 Damage Sheets</button>
      <button class="btn btn-ghost" onclick="navigateTo('view-records')">View All Records →</button>
    </div>
  </div>

  <div style="max-width:700px;">
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
    </div>

    <div class="card">
      <div class="card-header">
        <div><div class="card-title">${scanType === 'RTS' ? 'RTS' : 'Scan'} Records</div><div class="card-subtitle">${records.length} records</div></div>
        <button class="btn btn-ghost btn-sm" onclick="navigateTo('view-records')">View All →</button>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr><th>Tracking No.</th><th>Customer</th><th>Date</th><th>Status</th><th>Courier</th></tr></thead>
          <tbody>
            ${records.slice(0,10).map(r => `<tr>
              <td class="font-mono text-xs">${r.tracking}</td>
              <td style="font-weight:500">${r.customer}</td>
              <td>${r.date}</td>
              <td>${statusBadge(r.status)}</td>
              <td class="text-secondary">${r.courier}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

function statusBadge(status) {
  const map = {
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
    'FOR RETURN': 'badge-warning',
    'FOR MONITORING': 'badge-warning',
    'DASHBOARD CANCELLED': 'badge-danger',
    'CANCELLED': 'badge-danger',
  };
  return `<span class="badge ${map[status]||'badge-gray'}">${status}</span>`;
}

// ─── RENDER: VIEW RECORDS ──────────────────────────────────
function renderViewRecords() {
  const productOptions = ['all', ...new Set(DB.orders.map((order) => order.product))];
  return `
  <div class="page-header">
    <div class="page-title"><h1>View Records</h1><p>Unified records from all modules.</p></div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="exportTableCSV('records-table','ynt-records')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8M5 7l3 3 3-3M2 12h12"/></svg>
        Export CSV
      </button>
    </div>
  </div>

  <div class="tabs" id="records-tabs">
    <button class="tab-btn active" onclick="switchTab(this,'rec-orders')">Orders (${DB.orders.length})</button>
    <button class="tab-btn" onclick="switchTab(this,'rec-csr')">CSR Records (${DB.csrRecords.length})</button>
    <button class="tab-btn" onclick="switchTab(this,'rec-expenses')">Expenses (${DB.expenses.length})</button>
    <button class="tab-btn" onclick="switchTab(this,'rec-pickups')">Daily Pickups (${DB.dailyPickups.length})</button>
    <button class="tab-btn" onclick="switchTab(this,'rec-scans')">Scan Records (${DB.scanRecords.length})</button>
  </div>

  <div id="rec-orders" class="tab-content active">
    <div class="table-container">
      <div class="table-toolbar">
        <div class="table-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
          <input type="text" placeholder="Search orders..." id="rec-orders-search" value="${escapeHtml(recordsSearch)}" oninput="filterViewRecordsTable()">
        </div>
        <div class="records-toolbar-group">
          <select class="form-control records-product-filter" id="rec-orders-product" onchange="filterRecordsByProduct()">
            ${productOptions.map((product) => `<option value="${escapeHtml(product)}" ${recordsProductFilter === product ? 'selected' : ''}>${product === 'all' ? 'All Products' : escapeHtml(product)}</option>`).join('')}
          </select>
        </div>
        <div class="table-filters" id="rec-orders-status-filters">
          ${['All','Shipped','Delivered','Returned','Returning','Pending'].map((s,i) =>
            `<button class="filter-pill ${recordsStatusFilter === s || (!recordsStatusFilter && i===0) ? 'active' : ''}" onclick="setRecordsStatusFilter('${s}',this)">${s}</button>`
          ).join('')}
        </div>
        <div class="table-filters" id="rec-orders-date-filters">
          ${[
            ['all', 'All'],
            ['today', 'Today'],
            ['yesterday', 'Yesterday'],
            ['month', 'Month'],
            ['year', 'Year'],
            ['custom', 'Custom'],
          ].map(([value, label]) =>
            `<button class="filter-pill ${recordsDateFilter === value ? 'active' : ''}" onclick="setRecordsDateFilter('${value}',this)">${label}</button>`
          ).join('')}
        </div>
        <div class="custom-range ${recordsDateFilter === 'custom' ? '' : 'hidden'}" id="rec-orders-custom-range">
          <input type="date" class="form-control" id="rec-orders-date-from" value="${recordsDateFrom}">
          <input type="date" class="form-control" id="rec-orders-date-to" value="${recordsDateTo}">
          <button class="btn btn-secondary btn-sm" onclick="applyRecordsCustomDateRange()">Apply</button>
        </div>
      </div>
      <table id="records-table">
        <thead><tr><th>Order ID</th><th>Date</th><th>Customer</th><th>Product</th><th>Qty</th><th>COD</th><th>Courier</th><th>Status</th></tr></thead>
        <tbody id="rec-orders-tbody">
          ${DB.orders.map(o => `<tr data-status="${o.status}">
            <td class="font-mono text-xs text-muted">${o.id}</td>
            <td>${o.date}</td>
            <td style="font-weight:500">${o.customer}</td>
            <td>${o.product}</td>
            <td>${o.qty}</td>
            <td>₱${o.cod.toLocaleString()}</td>
            <td>${o.courier}</td>
            <td>${statusBadge(o.status)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="table-pagination" id="records-pagination"><span>Showing ${DB.orders.length} orders</span></div>
    </div>
  </div>

  <div id="rec-csr" class="tab-content">
    <div class="table-container">
      <table><thead><tr><th>Date</th><th>Name CSR</th><th>Page Name</th><th>Customer</th><th>Type of Sales</th><th>Status</th><th>Price</th><th>Tracking Number</th></tr></thead>
        <tbody>${DB.csrRecords.map((record) => `<tr>
          <td>${record.date}</td>
          <td style="font-weight:500">${record.csrName}</td>
          <td>${record.pageName}</td>
          <td>${record.customerName}</td>
          <td><span class="badge badge-info">${record.salesType}</span></td>
          <td>${statusBadge(record.status)}</td>
          <td>₱${Number(record.price || 0).toLocaleString()}</td>
          <td class="font-mono text-xs">${record.trackingNumber}</td>
        </tr>`).join('')}</tbody>
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

  <div id="rec-scans" class="tab-content">
    <div class="table-container">
      <table><thead><tr><th>Tracking</th><th>Customer</th><th>Phone</th><th>Date</th><th>Status</th><th>Courier</th><th>Type</th></tr></thead>
        <tbody>${DB.scanRecords.map(r => `<tr>
          <td class="font-mono text-xs">${r.tracking}</td>
          <td style="font-weight:500">${r.customer}</td>
          <td class="font-mono text-sm">${r.phone}</td>
          <td>${r.date}</td><td>${statusBadge(r.status)}</td><td>${r.courier}</td>
          <td><span class="badge ${r.type==='RTS'?'badge-danger':'badge-info'}">${r.type}</span></td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </div>`;
}

// ─── RENDER: DAMAGE SHEETS ─────────────────────────────────
function renderDamageSheets() {
  const damaged = DB.orders.filter(o => o.status === 'Returned').slice(0, 8);
  const today = new Date().toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });

  return `
  <div class="page-header">
    <div class="page-title"><h1>Damage Sheets</h1><p>View and print damage/return reports.</p></div>
    <div class="page-actions">
      <button class="btn btn-secondary" onclick="window.print()">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="6" width="10" height="8" rx="1"/><path d="M3 6V4a1 1 0 011-1h8a1 1 0 011 1v2M6 10h4M6 12h2"/><circle cx="11" cy="8" r="0.5" fill="currentColor"/></svg>
        Print Sheet
      </button>
    </div>
  </div>

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
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">Order ID</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">Tracking No.</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">Customer</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">Product</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">Date</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">COD Amt</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); border:1px solid var(--border);">Damage Notes</th>
        </tr>
      </thead>
      <tbody>
        ${damaged.map((o, i) => `
          <tr style="${i%2===1?'background:var(--surface-2);':''}">
            <td style="padding:10px 12px; border:1px solid var(--border); font-size:13px; color:var(--text-muted);">${i+1}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-family:'DM Mono',monospace; font-size:12px;">${o.id}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-family:'DM Mono',monospace; font-size:12px;">${o.tracking}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-weight:500; font-size:13px;">${o.customer}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-size:13px;">${o.product}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-size:13px;">${o.date}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-weight:600; font-size:13px;">₱${o.cod.toLocaleString()}</td>
            <td style="padding:10px 12px; border:1px solid var(--border); font-size:13px; color:var(--text-muted);"></td>
          </tr>
        `).join('')}
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
const chartRefs = {};
let csrPage = 1;
let csrFilter = 'daily';
let csrSearch = '';
let csrDateFrom = '';
let csrDateTo = '';
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
  return normalizeText(value) === 'admin' ? 'Administrator' : value;
}

function isAdminUser() {
  return normalizeText(normalizeRoleName(App.user?.role)) === 'administrator';
}

function getAccessiblePagesForCurrentUser() {
  if (!App.user) return [];
  const role = normalizeRoleName(App.user.role);
  return NAV_ACCESS[role] || ['home', 'sales'];
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

  const hasOperations = ['daily-pickup', 'rts-scanning', 'scanning'].some((page) => accessiblePages.has(page));
  const hasReports = ['view-records', 'damage-sheets'].some((page) => accessiblePages.has(page));
  const hasSystem = ['manage-users', 'api-connections'].some((page) => accessiblePages.has(page));

  const operationsLabel = document.getElementById('nav-section-operations');
  const reportsLabel = document.getElementById('nav-section-reports');
  const systemLabel = document.getElementById('nav-section-system');

  if (operationsLabel) operationsLabel.style.display = hasOperations ? 'block' : 'none';
  if (reportsLabel) reportsLabel.style.display = hasReports ? 'block' : 'none';
  if (systemLabel) systemLabel.style.display = hasSystem ? 'block' : 'none';
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
  return role === 'CSR' || role === 'Trainee';
}

function getHomeQuickActions() {
  if (isCSRLikeUser()) {
    return [
      ['🏠', 'Home', 'home'],
      ['📊', 'Sales Dashboard', 'sales'],
    ];
  }

  return [
    ['📦', 'New Pickup', 'daily-pickup'],
    ['🔍', 'Scan Package', 'scanning'],
    ['↩️', 'RTS Scan', 'rts-scanning'],
    ['📊', 'View Sales', 'sales'],
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

  if (!isAdminUser()) {
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

  if (csrSearch) {
    const query = csrSearch.toLowerCase();
    data = data.filter((record) =>
      record.csrName.toLowerCase().includes(query)
      || record.pageName.toLowerCase().includes(query)
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
  const delivered = records.filter((record) => record.status === 'DELIVERED').length;
  const cancelled = records.filter((record) => record.status.includes('CANCELLED')).length;
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
    <td>${record.customerName}</td>
    <td class="font-mono text-xs">${record.cellphoneNumber}</td>
    <td><span class="badge badge-info">${record.salesType}</span></td>
    <td>${statusBadge(record.status)}</td>
    <td>₱${Number(record.price || 0).toLocaleString()}</td>
    <td class="font-mono text-xs">${record.trackingNumber}</td>
    <td>${canManageCSRRecord(record) ? `<div class="flex gap-2"><button class="btn btn-ghost btn-sm" onclick="editCSRRecord('${record.id}')">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteCSRRecord('${record.id}')">Delete</button></div>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text-muted)">No CSR records found for the selected range.</td></tr>';

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
  renderCSRChart(records);
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

function resetCSRForm() {
  editingCSRRecordId = '';
  const today = new Date().toISOString().split('T')[0];
  const defaults = {
    'csr-date': today,
    'csr-name': getCurrentCsrName(),
    'csr-page-name': '',
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

  editingCSRRecordId = record.id;

  const fieldMap = {
    'csr-date': record.date,
    'csr-name': record.csrName,
    'csr-page-name': record.pageName,
    'csr-customer-name': record.customerName,
    'csr-cellphone-number': record.cellphoneNumber,
    'csr-sales-type': record.salesType,
    'csr-status': record.status,
    'csr-price': record.price,
    'csr-tracking-number': record.trackingNumber,
  };

  Object.entries(fieldMap).forEach(([id, value]) => {
    const input = document.getElementById(id);
    if (input) input.value = value ?? '';
  });

  refreshCSRFormActions();
  document.getElementById('csr-date')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function deleteCSRRecord(recordId) {
  const recordIndex = DB.csrRecords.findIndex((item) => item.id === recordId);
  if (recordIndex === -1) {
    showToast('error', 'Record not found', 'The selected CSR record could not be found.');
    return;
  }

  const record = DB.csrRecords[recordIndex];
  if (!canManageCSRRecord(record)) {
    showToast('error', 'Access denied', 'You can only delete your own CSR daily records.');
    return;
  }

  if (!confirm(`Delete CSR record for ${record.customerName}?`)) return;

  DB.csrRecords.splice(recordIndex, 1);
  saveCsrRecords();

  if (editingCSRRecordId === recordId) {
    resetCSRForm();
  }

  renderCSRTable();
  showToast('success', 'CSR record deleted', `${record.customerName} • ${record.pageName}`);
}

function saveCSRRecord() {
  const record = {
    id: editingCSRRecordId || `CSR-${String(DB.csrRecords.length + 1).padStart(4, '0')}`,
    date: document.getElementById('csr-date')?.value || '',
    csrName: (document.getElementById('csr-name')?.value || getCurrentCsrName()).trim(),
    pageName: (document.getElementById('csr-page-name')?.value || '').trim(),
    customerName: (document.getElementById('csr-customer-name')?.value || '').trim(),
    cellphoneNumber: (document.getElementById('csr-cellphone-number')?.value || '').trim(),
    salesType: (document.getElementById('csr-sales-type')?.value || '').trim(),
    status: (document.getElementById('csr-status')?.value || '').trim(),
    price: parseFloat(document.getElementById('csr-price')?.value || '0'),
    trackingNumber: (document.getElementById('csr-tracking-number')?.value || '').trim(),
  };

  if (!record.date || !record.pageName || !record.customerName || !record.cellphoneNumber || !record.salesType || !record.status || record.price <= 0) {
    showToast('error', 'Incomplete CSR record', 'Please fill in all required CSR daily record fields.');
    return;
  }

  if (!isAdminUser()) {
    record.csrName = getCurrentCsrName();
  }

  if (editingCSRRecordId) {
    const existingIndex = DB.csrRecords.findIndex((item) => item.id === editingCSRRecordId);
    if (existingIndex === -1) {
      showToast('error', 'Record not found', 'The selected CSR record no longer exists.');
      resetCSRForm();
      renderCSRTable();
      return;
    }

    if (!canManageCSRRecord(DB.csrRecords[existingIndex])) {
      showToast('error', 'Access denied', 'You can only edit your own CSR daily records.');
      return;
    }

    DB.csrRecords[existingIndex] = { ...DB.csrRecords[existingIndex], ...record };
  } else {
    DB.csrRecords.unshift(record);
  }
  saveCsrRecords();
  const successMessage = editingCSRRecordId ? 'CSR record updated' : 'CSR record saved';
  resetCSRForm();
  renderCSRTable();
  showToast('success', successMessage, `${record.customerName} • ${record.pageName} • ₱${record.price.toLocaleString()}`);
  return;
  showToast('success', 'CSR record saved', `${record.customerName} • ${record.pageName} • ₱${record.price.toLocaleString()}`);
}

function initCharts(page) {
  if (typeof Chart === 'undefined') return;

  Chart.defaults.font.family = "'DM Sans', sans-serif";
  Chart.defaults.color = '#94a3b8';

  if (page === 'home') {
    const statusCounts = {};
    DB.orders.forEach(o => { statusCounts[o.status] = (statusCounts[o.status]||0) + 1; });
    new Chart(document.getElementById('home-donut-chart'), {
      type: 'doughnut',
      data: {
        labels: Object.keys(statusCounts),
        datasets: [{ data: Object.values(statusCounts), backgroundColor: ['#3b82f6','#10b981','#ef4444','#f59e0b','#6b7280'], borderWidth: 0 }]
      },
      options: { responsive:true, maintainAspectRatio:true, plugins: { legend: { position:'right' } }, cutout: '65%' }
    });
  }

  if (page === 'sales') {
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

  if (page === 'sales') {
    const today = new Date().toISOString().split('T')[0];
    const salesDateFromInput = document.getElementById('sales-date-from');
    const salesDateToInput = document.getElementById('sales-date-to');
    if (salesDateFromInput && !salesDateFromInput.value) salesDateFromInput.value = today;
    if (salesDateToInput && !salesDateToInput.value) salesDateToInput.value = today;
    renderSalesTable();
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
  }

  if (page === 'view-records') {
    renderViewRecordsOrdersTable();
  }

  if (page === 'manage-users') {
    if (isAdminUser()) loadManagedUsers();
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

function openManageUserEditor(userId) {
  if (!isAdminUser()) {
    showToast('warning', 'Admin only', 'Only administrators can edit accounts.');
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
    ? 'Admin can create new accounts and assign positions here.'
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
  if (!isAdminUser()) {
    showToast('warning', 'Admin only', 'Only administrators can create accounts.');
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
      },
      getAuthToken(),
    );
    showToast('success', 'Account updated', 'Your account details were updated.');
    loadPage('manage-users');
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
    if (!isAdminUser()) {
      navigateTo('home');
      return;
    }
    await loadManagedUsers();
  } catch (error) {
    showToast('error', 'Update failed', error.message || 'Could not update account.');
  }
}

async function deleteManagedUser(userId) {
  if (!isAdminUser()) {
    showToast('warning', 'Admin only', 'Only administrators can delete accounts.');
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
let salesFilter = 'daily';
let salesSearch = '';
let salesDateFrom = '';
let salesDateTo = '';
let recordsPage = 1;
let recordsSearch = '';
let recordsStatusFilter = 'All';
let recordsProductFilter = 'all';
let recordsDateFilter = 'all';
let recordsDateFrom = '';
let recordsDateTo = '';

function renderSalesSummaryCards(data) {
  const summary = document.getElementById('sales-summary-cards');
  if (!summary) return;

  const shipped = data.filter((order) => order.status === 'Shipped').length;
  const delivered = data.filter((order) => order.status === 'Delivered').length;
  const returned = data.filter((order) => order.status === 'Returned').length;
  const returning = data.filter((order) => order.status === 'Returning').length;
  const totalCOD = data.reduce((sum, order) => sum + Number(order.cod || 0), 0);

  summary.innerHTML = `
    <div class="stat-card blue"><div class="stat-card-accent"></div><div class="stat-label">Shipped</div><div class="stat-value">${shipped}</div><div class="stat-meta">Awaiting delivery</div></div>
    <div class="stat-card green"><div class="stat-card-accent"></div><div class="stat-label">Delivered</div><div class="stat-value">${delivered}</div><div class="stat-meta">Filtered results</div></div>
    <div class="stat-card red"><div class="stat-card-accent"></div><div class="stat-label">Returned</div><div class="stat-value">${returned}</div><div class="stat-meta">Received back</div></div>
    <div class="stat-card amber"><div class="stat-card-accent"></div><div class="stat-label">Returning</div><div class="stat-value">${returning}</div><div class="stat-meta">In transit back</div></div>
    <div class="stat-card purple"><div class="stat-card-accent"></div><div class="stat-label">COD Amount</div><div class="stat-value" style="font-size:20px;">PHP ${totalCOD.toLocaleString()}</div><div class="stat-meta">Total collected</div></div>`;
}

function renderSalesTable() {
  const perPage = parseInt(document.getElementById('sales-per-page')?.value || '10');
  const tbody = document.getElementById('sales-tbody');
  if (!tbody) return;

  let data = [...DB.orders];
  const today = normalizeDateString(new Date());
  if (salesFilter === 'daily') {
    data = data.filter((order) => order.date === today);
  } else if (salesFilter === 'weekly') {
    const week = getDateDaysAgo(6);
    data = data.filter((order) => new Date(order.date) >= week);
  } else if (salesFilter === 'monthly') {
    data = data.filter((order) => order.date.startsWith(today.slice(0, 7)));
  } else if (salesFilter === 'yearly') {
    data = data.filter((order) => order.date.startsWith(today.slice(0, 4)));
  } else if (salesFilter === 'custom') {
    if (salesDateFrom) data = data.filter((order) => order.date >= salesDateFrom);
    if (salesDateTo) data = data.filter((order) => order.date <= salesDateTo);
  }

  // Search
  if (salesSearch) {
    const q = salesSearch.toLowerCase();
    data = data.filter(o =>
      o.id.toLowerCase().includes(q) ||
      o.customer.toLowerCase().includes(q) ||
      o.product.toLowerCase().includes(q) ||
      o.tracking.toLowerCase().includes(q)
    );
  }

  renderSalesSummaryCards(data);

  const total = data.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const sliced = data.slice((salesPage - 1) * perPage, salesPage * perPage);

  tbody.innerHTML = sliced.map(o => `<tr>
    <td class="font-mono text-xs text-muted">${o.id}</td>
    <td>${o.date}</td>
    <td style="font-weight:500">${o.customer}</td>
    <td>${o.product}</td>
    <td>${o.qty}</td>
    <td>₱${o.cod.toLocaleString()}</td>
    <td>${o.courier}</td>
    <td>${statusBadge(o.status)}</td>
  </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-muted)">No records found</td></tr>';

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
  let total = [...DB.orders];
  const today = normalizeDateString(new Date());
  if (salesFilter === 'daily') {
    total = total.filter((order) => order.date === today);
  } else if (salesFilter === 'weekly') {
    const week = getDateDaysAgo(6);
    total = total.filter((order) => new Date(order.date) >= week);
  } else if (salesFilter === 'monthly') {
    total = total.filter((order) => order.date.startsWith(today.slice(0, 7)));
  } else if (salesFilter === 'yearly') {
    total = total.filter((order) => order.date.startsWith(today.slice(0, 4)));
  } else if (salesFilter === 'custom') {
    if (salesDateFrom) total = total.filter((order) => order.date >= salesDateFrom);
    if (salesDateTo) total = total.filter((order) => order.date <= salesDateTo);
  }
  if (salesSearch) {
    const q = salesSearch.toLowerCase();
    total = total.filter((order) =>
      order.id.toLowerCase().includes(q) ||
      order.customer.toLowerCase().includes(q) ||
      order.product.toLowerCase().includes(q) ||
      order.tracking.toLowerCase().includes(q)
    );
  }
  const pages = Math.max(1, Math.ceil(total.length / perPage));
  if (p < 1 || p > pages) return;
  salesPage = p;
  renderSalesTable();
}

function setSalesFilter(filter, btn) {
  salesFilter = filter; salesPage = 1;
  document.querySelectorAll('#sales-filter-group .filter-pill').forEach((pill) => pill.classList.remove('active'));
  btn.classList.add('active');
  const customRange = document.getElementById('sales-custom-range');
  if (customRange) customRange.classList.toggle('hidden', filter !== 'custom');
  if (filter !== 'custom') renderSalesTable();
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

function getFilteredViewRecordOrders() {
  let data = [...DB.orders];
  const today = normalizeDateString(new Date());

  if (recordsStatusFilter !== 'All') {
    data = data.filter((order) => order.status === recordsStatusFilter);
  }

  if (recordsProductFilter !== 'all') {
    data = data.filter((order) => order.product === recordsProductFilter);
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
      || order.product.toLowerCase().includes(query)
      || order.courier.toLowerCase().includes(query)
      || order.status.toLowerCase().includes(query)
      || order.tracking.toLowerCase().includes(query)
    );
  }

  return data.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

function renderViewRecordsOrdersTable() {
  const tbody = document.getElementById('rec-orders-tbody');
  if (!tbody) return;

  const perPage = 10;
  const records = getFilteredViewRecordOrders();
  const pages = Math.max(1, Math.ceil(records.length / perPage));
  if (recordsPage > pages) recordsPage = pages;
  const sliced = records.slice((recordsPage - 1) * perPage, recordsPage * perPage);

  tbody.innerHTML = sliced.map((order) => `<tr data-status="${order.status}">
    <td class="font-mono text-xs text-muted">${order.id}</td>
    <td>${order.date}</td>
    <td style="font-weight:500">${order.customer}</td>
    <td>${order.product}</td>
    <td>${order.qty}</td>
    <td>₱${order.cod.toLocaleString()}</td>
    <td>${order.courier}</td>
    <td>${statusBadge(order.status)}</td>
  </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-muted)">No records found for the selected filters.</td></tr>';

  const pagination = document.getElementById('records-pagination');
  if (pagination) {
    const start = records.length ? ((recordsPage - 1) * perPage) + 1 : 0;
    const end = Math.min(recordsPage * perPage, records.length);
    pagination.innerHTML = `
      <span>${start}-${end} of ${records.length} orders</span>
      <div class="pagination-buttons">
        <button class="page-btn" onclick="changeRecordsPage(${recordsPage - 1})" ${recordsPage <= 1 ? 'disabled' : ''}>‹</button>
        ${Array.from({ length: Math.min(pages, 5) }, (_, index) => `<button class="page-btn ${index + 1 === recordsPage ? 'active' : ''}" onclick="changeRecordsPage(${index + 1})">${index + 1}</button>`).join('')}
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

function filterViewRecordsTable() {
  recordsSearch = document.getElementById('rec-orders-search')?.value || '';
  recordsPage = 1;
  renderViewRecordsOrdersTable();
}

function filterRecordsByProduct() {
  recordsProductFilter = document.getElementById('rec-orders-product')?.value || 'all';
  recordsPage = 1;
  renderViewRecordsOrdersTable();
}

function setRecordsStatusFilter(status, btn) {
  recordsStatusFilter = status;
  recordsPage = 1;
  document.querySelectorAll('#rec-orders-status-filters .filter-pill').forEach((pill) => pill.classList.remove('active'));
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
}

function applyRecordsCustomDateRange() {
  recordsDateFrom = document.getElementById('rec-orders-date-from')?.value || '';
  recordsDateTo = document.getElementById('rec-orders-date-to')?.value || '';
  recordsPage = 1;
  renderViewRecordsOrdersTable();
}

// ─── SCAN ──────────────────────────────────────────────────
function performScan(pageId, scanType) {
  const input = document.getElementById(`scan-input-${pageId}`);
  const tracking = input?.value?.trim();
  if (!tracking) { showToast('warning', 'No input', 'Please enter a tracking number'); return; }

  const resultEl = document.getElementById(`scan-result-${pageId}`);

  // Look up in existing records
  let found = DB.scanRecords.find(r => r.tracking.toLowerCase() === tracking.toLowerCase());

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

  // Add to scan records
  const newRecord = {
    id: `SCN-${String(DB.scanRecords.length + 1).padStart(4, '0')}`,
    ...found,
    type: scanType,
    date: new Date().toISOString().split('T')[0],
  };
  DB.scanRecords.unshift(newRecord);

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
        <div class="scan-field"><div class="scan-field-label">Attempt Date</div><div class="scan-field-value">${new Date().toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' })}</div></div>
        <div class="scan-field"><div class="scan-field-label">Order Status</div><div class="scan-field-value">${statusBadge(found.status)}</div></div>
        <div class="scan-field"><div class="scan-field-label">Courier</div><div class="scan-field-value">${found.courier}</div></div>
      </div>
    </div>`;

  showToast('success', 'Scan recorded', `${tracking} — ${found.customer}`);
  input.value = '';
  input.focus();
}

// ─── EXPENSE HELPERS ───────────────────────────────────────
function calcExpTotal() {
  const qty = parseFloat(document.getElementById('exp-qty')?.value || 0);
  const price = parseFloat(document.getElementById('exp-price')?.value || 0);
  const total = qty * price;
  const el = document.getElementById('exp-total');
  if (el) el.value = total > 0 ? total.toFixed(2) : '';
}

function saveExpense() {
  const date = document.getElementById('exp-date')?.value;
  const category = document.getElementById('exp-cat')?.value;
  const item = document.getElementById('exp-item')?.value;
  const qty = parseInt(document.getElementById('exp-qty')?.value || 0);
  const price = parseFloat(document.getElementById('exp-price')?.value || 0);
  const noted = document.getElementById('exp-noted')?.value || App.user?.name || '';

  if (!date || !category || !item || qty < 1 || price <= 0) {
    showToast('error', 'Validation failed', 'Please fill in all required fields.');
    return;
  }

  const newExp = {
    id: `EXP-${String(DB.expenses.length + 1).padStart(4, '0')}`,
    date, category, item, qty, price, total: qty * price, noted,
  };

  DB.expenses.unshift(newExp);

  const tbody = document.getElementById('exp-tbody');
  if (tbody) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="font-mono text-xs text-muted">${newExp.id}</td>
      <td>${newExp.date}</td>
      <td><span class="badge ${catBadge(newExp.category)}">${newExp.category}</span></td>
      <td>${newExp.item}</td>
      <td>${newExp.qty}</td>
      <td>₱${newExp.price.toLocaleString()}</td>
      <td><strong>₱${newExp.total.toLocaleString()}</strong></td>
      <td>${newExp.noted}</td>`;
    tbody.insertBefore(row, tbody.firstChild);
  }

  ['exp-item','exp-qty','exp-price','exp-total'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = id === 'exp-qty' ? '1' : '';
  });

  showToast('success', 'Expense saved', `${item} — ₱${(qty*price).toLocaleString()}`);
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
function saveInventoryItem() {
  const name = document.getElementById('inv-name')?.value;
  const sku = document.getElementById('inv-sku')?.value;
  const type = document.getElementById('inv-type')?.value;
  const unit = document.getElementById('inv-unit')?.value || 'pcs';
  const stock = parseInt(document.getElementById('inv-stock')?.value || 0);
  const cost = parseFloat(document.getElementById('inv-cost')?.value || 0);

  if (!name) { showToast('error', 'Name required', 'Please enter item name'); return; }

  const newItem = {
    id: `P${String(DB.inventory.length + 1).padStart(3,'0')}`,
    name, sku: sku || `SKU-${String(DB.inventory.length+1).padStart(3,'0')}`,
    type, unit, stock, cost, price: null,
    reorder: type === 'Product' ? 200 : 15,
  };

  DB.inventory.push(newItem);
  closeModal('add-inventory-modal');
  showToast('success', 'Item added', name);
  navigateTo('inventory');
}

function updateStock() {
  const itemId = document.getElementById('stocks-item')?.value;
  const action = document.getElementById('stocks-action')?.value;
  const qty = parseInt(document.getElementById('stocks-qty')?.value || 0);

  const item = DB.inventory.find(i => i.id === itemId);
  if (!item || qty < 0) { showToast('error', 'Invalid input', 'Please check your inputs'); return; }

  if (action === 'add') item.stock += qty;
  else if (action === 'remove') item.stock = Math.max(0, item.stock - qty);
  else item.stock = qty;

  closeModal('stocks-modal');
  showToast('success', 'Stock updated', `${item.name} — ${item.stock} ${item.unit}`);
  navigateTo('inventory');
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
function collectPancakeFormState() {
  const previous = getIntegrationState().pancake;
  return {
    enabled: Boolean(document.getElementById('pancake-enabled')?.checked),
    syncMode: document.getElementById('pancake-sync-mode')?.value || 'webhook_only',
    webhookSecret: (document.getElementById('pancake-webhook-secret')?.value || '').trim(),
    baseUrl: (document.getElementById('pancake-base-url')?.value || '').trim(),
    userAccessToken: (document.getElementById('pancake-user-access-token')?.value || '').trim(),
    pageId: (document.getElementById('pancake-page-id')?.value || '').trim(),
    pageAccessToken: (document.getElementById('pancake-page-access-token')?.value || '').trim(),
    notes: (document.getElementById('pancake-notes')?.value || '').trim(),
    lastSavedAt: new Date().toISOString(),
    lastCollectedAt: previous.lastCollectedAt || null,
    lastCollectionSummary: previous.lastCollectionSummary || '',
  };
}

function collectGoogleSheetsFormState() {
  const previous = getIntegrationState().googleSheets;
  return {
    enabled: Boolean(document.getElementById('google-sheets-enabled')?.checked),
    syncMode: document.getElementById('google-sheets-sync-mode')?.value || 'manual',
    spreadsheetId: (document.getElementById('google-sheets-spreadsheet-id')?.value || '').trim(),
    sheetName: (document.getElementById('google-sheets-sheet-name')?.value || '').trim() || 'Orders',
    serviceAccountEmail: (document.getElementById('google-sheets-service-account-email')?.value || '').trim(),
    privateKey: document.getElementById('google-sheets-private-key')?.value || '',
    syncIntervalMinutes: (document.getElementById('google-sheets-sync-interval-minutes')?.value || '5').trim(),
    notes: (document.getElementById('google-sheets-notes')?.value || '').trim(),
    lastSavedAt: new Date().toISOString(),
    lastCollectedAt: previous.lastCollectedAt || null,
    lastCollectionSummary: previous.lastCollectionSummary || '',
  };
}

async function syncPancakeConfigToBackend(settings) {
  const response = await fetch(`${getPancakePublicApiBase()}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: settings.enabled,
      base_url: settings.baseUrl,
      user_access_token: settings.userAccessToken,
      page_id: settings.pageId,
      page_access_token: settings.pageAccessToken,
      webhook_secret: settings.webhookSecret,
      sync_mode: settings.syncMode,
      notes: settings.notes,
    }),
  });

  if (!response.ok) {
    throw new Error(`Config sync failed with status ${response.status}`);
  }

  return response.json();
}

async function syncGoogleSheetsConfigToBackend(settings) {
  const response = await fetch(`${getGoogleSheetsPublicApiBase()}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: settings.enabled,
      spreadsheet_id: settings.spreadsheetId,
      sheet_name: settings.sheetName,
      service_account_email: settings.serviceAccountEmail,
      private_key: settings.privateKey,
      sync_mode: settings.syncMode,
      sync_interval_ms: Math.max(1, Number(settings.syncIntervalMinutes || 5)) * 60 * 1000,
      notes: settings.notes,
    }),
  });

  if (!response.ok) {
    throw new Error(`Config sync failed with status ${response.status}`);
  }

  return response.json();
}

function savePancakeConnection() {
  const state = getIntegrationState();
  state.pancake = collectPancakeFormState();

  saveIntegrationState(state);
  syncPancakeConfigToBackend(state.pancake)
    .then(() => {
      showToast('success', 'Connection saved', 'Pancake webhook and API settings were saved to the dashboard.');
      navigateTo('api-connections');
    })
    .catch(() => {
      showToast('warning', 'Saved locally only', 'The browser settings were saved, but the backend config endpoint was not reachable.');
      navigateTo('api-connections');
    });
}

function saveGoogleSheetsConnection() {
  const state = getIntegrationState();
  state.googleSheets = collectGoogleSheetsFormState();

  saveIntegrationState(state);
  syncGoogleSheetsConfigToBackend(state.googleSheets)
    .then(() => {
      showToast('success', 'Google Sheets saved', 'The spreadsheet connection was saved to the dashboard backend.');
      navigateTo('api-connections');
    })
    .catch(() => {
      showToast('warning', 'Saved locally only', 'The browser settings were saved, but the backend Google Sheets config endpoint was not reachable.');
      navigateTo('api-connections');
    });
}

async function copyWebhookUrl() {
  const url = getPancakeWebhookUrl();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const input = document.getElementById('pancake-webhook-url');
      input?.select();
      document.execCommand('copy');
    }
    showToast('success', 'Webhook URL copied', url);
  } catch {
    showToast('warning', 'Copy failed', 'Please copy the webhook URL manually.');
  }
}

async function sendWebhookTest() {
  const webhookUrl = getPancakeWebhookUrl();
  const secret = (document.getElementById('pancake-webhook-secret')?.value || '').trim();
  const payload = getPancakeSamplePayload();

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'x-webhook-secret': secret } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook test failed with status ${response.status}`);
    }

    showToast('success', 'Webhook test sent', 'Sample Pancake payload was accepted by the backend webhook endpoint.');
  } catch (error) {
    showToast(
      'warning',
      'Backend not reachable',
      `The test payload could not be delivered. Start the backend on ${getExpectedDashboardUrl()} to test the webhook endpoint.`
    );
    console.warn(error);
  }
}

async function fetchPancakePages() {
  const state = getIntegrationState();
  state.pancake = collectPancakeFormState();
  saveIntegrationState(state);

  if (!state.pancake.userAccessToken) {
    showToast('warning', 'User token required', 'Enter the Pancake user access token first.');
    return;
  }

  try {
    const response = await fetch(`${getPancakePublicApiBase()}/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_access_token: state.pancake.userAccessToken }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || `Status ${response.status}`);

    const pages = Array.isArray(data.pages) ? data.pages : [];
    if (!pages.length) {
      showToast('warning', 'No pages returned', 'The token worked, but Pancake did not return any pages.');
      return;
    }

    const firstPage = pages[0];
    const pageInput = document.getElementById('pancake-page-id');
    if (pageInput) pageInput.value = firstPage.id || '';
    showToast('success', 'Pages loaded', `Found ${pages.length} page(s). Filled page_id with ${firstPage.name || firstPage.id}.`);
  } catch (error) {
    showToast('error', 'Get Pages failed', error.message || 'Could not load pages from Pancake.');
  }
}

async function collectPancakeApiData() {
  const state = getIntegrationState();
  state.pancake = collectPancakeFormState();
  saveIntegrationState(state);

  if (!state.pancake.pageId) {
    showToast('warning', 'Page ID required', 'Enter or fetch a Pancake page_id first.');
    return;
  }

  try {
    const response = await fetch(`${getPancakePublicApiBase()}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_access_token: state.pancake.userAccessToken,
        page_id: state.pancake.pageId,
        page_access_token: state.pancake.pageAccessToken,
        resources: ['conversations', 'customers', 'posts', 'tags', 'users', 'messages'],
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || `Status ${response.status}`);

    const collectedResources = Object.entries(data.resources || {}).map(([name, details]) => `${name}:${details.count}`).join(', ');
    const refreshed = getIntegrationState();
    refreshed.pancake = {
      ...state.pancake,
      lastCollectedAt: new Date().toISOString(),
      lastCollectionSummary: collectedResources || 'Collection completed',
    };
    saveIntegrationState(refreshed);

    const returnedToken = data.page_access_token || data.pageAccessToken;
    const tokenInput = document.getElementById('pancake-page-access-token');
    if (returnedToken && tokenInput) tokenInput.value = returnedToken;

    showToast('success', 'Collection complete', collectedResources || 'Pancake data was collected and stored.');
    navigateTo('api-connections');
  } catch (error) {
    showToast('error', 'Collection failed', error.message || 'Could not collect Pancake API data.');
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

    const response = await fetch(`${getGoogleSheetsPublicApiBase()}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spreadsheet_id: state.googleSheets.spreadsheetId,
        sheet_name: state.googleSheets.sheetName,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || `Status ${response.status}`);

    const refreshed = getIntegrationState();
    const sheetSummary = Array.isArray(data.sheets) && data.sheets.length
      ? data.sheets.map((sheet) => `${sheet.sheet_name}: +${sheet.imported}/~${sheet.updated}`).join(', ')
      : '';
    refreshed.googleSheets = {
      ...state.googleSheets,
      lastCollectedAt: new Date().toISOString(),
      lastCollectionSummary: `Imported ${data.imported || 0}, updated ${data.updated || 0}, failed ${Array.isArray(data.failed_rows) ? data.failed_rows.length : 0}${sheetSummary ? ` (${sheetSummary})` : ''}`,
    };
    saveIntegrationState(refreshed);

    showToast('success', 'Google Sheets synced', refreshed.googleSheets.lastCollectionSummary);
    navigateTo('api-connections');
  } catch (error) {
    showToast('error', 'Google Sheets sync failed', error.message || 'Could not collect data from Google Sheets.');
  }
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

// ─── MODALS ────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// ─── TABS ──────────────────────────────────────────────────
function switchTab(btn, contentId) {
  const tabsParent = btn.closest('.tabs');
  if (tabsParent) tabsParent.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const contentParent = btn.closest('.page-content') || document;
  contentParent.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const target = document.getElementById(contentId);
  if (target) target.classList.add('active');
}

// ─── TOAST ─────────────────────────────────────────────────
function showToast(type, title, body) {
  const icons = {
    success: '<path d="M13 5L6 12l-3-3" stroke="currentColor" stroke-width="2"/>',
    error:   '<path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="2"/>',
    warning: '<path d="M8 2L14 13H2L8 2z" stroke="currentColor" stroke-width="1.5"/><path d="M8 6v4" stroke="currentColor" stroke-width="1.5"/>',
    info:    '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5v1" stroke="currentColor" stroke-width="1.5"/>',
  };
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 16 16" fill="none">${icons[type]||''}</svg>
    <div class="toast-text"><div class="title">${title}</div><div class="body">${body}</div></div>`;
  toast.onclick = () => toast.remove();
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ─── SIDEBAR TOGGLE (mobile) ───────────────────────────────
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay-bg');
  sidebar?.classList.toggle('open');
  overlay?.classList.toggle('open');
}

// ─── INIT ──────────────────────────────────────────────────
function init() {
  const loginScreen = document.getElementById('login-screen');
  const shell = document.getElementById('app-shell');
  if (!loginScreen || !shell) return;

  if (!App.user) {
    loginScreen.innerHTML = renderLogin();
    shell.style.display = 'none';
    return;
  }

  loginScreen.innerHTML = '';
  shell.style.display = 'flex';
  refreshCurrentUserChip();

  navigateTo('home');
}

window.addEventListener('DOMContentLoaded', init);
