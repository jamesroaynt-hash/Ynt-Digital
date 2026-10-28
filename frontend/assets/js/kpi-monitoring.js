/* ═══════════════════════════════════════════════════════════
   KPI MONITORING — HR's manual KPI records for CSR and RMO.
     CSR: the numbers fill in by themselves and HR clicks any of them to
       override it (clearing an override goes back to automatic):
         orders target = team orders target ÷ active CSRs
         orders actual = their Pancake confirmed orders
         gross sales   = the COD total of those orders
         ROAS          = gross sales ÷ the CSR team's ad spend (one amount a
                         day for all CSRs; a month is the sum of its days)
     RMO: RTS rate (meeting target when actual ≤ target; default 12%).
   Daily and monthly records are separate. HR types every target and actual;
   only a CSR's Pancake confirmed orders (counted as CSR Records counts them)
   are offered as the orders actual, which HR accepts by saving. ROAS and RTS
   are never fetched. Achievement and
   status come back from /api/kpi-monitoring, worked out from the numbers.
   The monthly records are the evaluation's KPI part (Evaluation Result).
   HR, Operation and the super admin only. Loaded before app.js; it leans on
   app.js globals (escapeHtml, authorizedJsonRequest, showToast, manilaToday,
   openModal, closeModal) read at call time.
   ═══════════════════════════════════════════════════════════ */

const KPIM_LABELS = { orders: 'Number of Orders', roas: 'ROAS', rts: 'RTS Rate' };
const KPIM_BY_DEPARTMENT = { CSR: ['orders', 'roas'], RMO: ['rts'] };
const KPIM_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const kpimState = {
  periodType: 'monthly',
  day: '',
  month: '',
  department: 'all',
  search: '',
  data: null,
  history: { userId: 0, name: '', periodType: 'monthly' },
};

function kpimApi(path, options = {}) {
  return authorizedJsonRequest(`/kpi-monitoring${path}`, {
    ...options,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
}

function kpimPeriodKey() {
  return kpimState.periodType === 'daily' ? kpimState.day : kpimState.month;
}

function kpimPeriodLabel(periodType = kpimState.periodType, key = kpimPeriodKey()) {
  if (!key) return '';
  if (periodType === 'daily') {
    return new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  const [y, m] = key.split('-').map(Number);
  return `${KPIM_MONTHS[m - 1]} ${y}`;
}

// Numbers in each KPI's own unit: orders whole, ROAS as 2.40x, RTS as 9.5%.
function kpimValue(kpiType, value) {
  if (value === null || value === undefined) return '<span class="er-dash">—</span>';
  const n = Number(value);
  if (kpiType === 'roas') return `${n.toFixed(2)}x`;
  if (kpiType === 'rts') return `${Math.round(n * 100) / 100}%`;
  return Math.round(n).toLocaleString();
}

function kpimStatus(record) {
  if (!record || record.status === 'no_data') return '<span class="er-dash">—</span>';
  const map = {
    meeting: ['badge-success', 'Meeting target'],
    below: ['badge-danger', 'Below target'],
    above: ['badge-danger', 'Above target'],
    no_target: ['badge-gray', 'No target'],
  };
  const [cls, label] = map[record.status] || ['badge-gray', record.status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function kpimAchievement(record) {
  if (!record || record.achievement === null || record.achievement === undefined) return '<span class="er-dash">—</span>';
  return `<b class="er-num">${record.achievement}%</b>`;
}

function kpimWhen(value) {
  if (!value) return '';
  // SQLite stores UTC as "YYYY-MM-DD HH:MM:SS"; Postgres sends ISO.
  const raw = String(value).includes('T') ? String(value) : `${String(value).replace(' ', 'T')}Z`;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function kpimUpdated(records) {
  const latest = records.filter((r) => r && r.updated_at).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  if (!latest) return '<span class="er-dash">—</span>';
  return `<span class="text-xs text-muted">${escapeHtml(latest.updated_by || '—')}<br>${escapeHtml(kpimWhen(latest.updated_at))}</span>`;
}

// ─── Page ───────────────────────────────────────────────────
function renderKpiMonitoringPage() {
  return `
  <div class="er-hero">
    <div class="er-hero-text">
      <div class="er-eyebrow">Performance · KPI</div>
      <h1 class="er-title">KPI Monitoring</h1>
      <p class="er-lede">CSR: Number of Orders and ROAS. RMO: RTS rate. HR enters every target and actual; achievement and status are worked out automatically. Monthly results are the KPI part of Evaluation Result.</p>
    </div>
    <div class="er-hero-side">
      <div class="page-actions">
        <button class="btn btn-secondary" type="button" onclick="kpimOpenDefaults()">Default targets</button>
        <button class="btn btn-primary" type="button" onclick="kpimOpenEntry()">+ Enter KPI</button>
      </div>
    </div>
  </div>
  <div id="kpim-cards" class="er-cards"></div>
  <div class="er-panel">
    <div class="er-toolbar">
      <div class="er-pills">
        <button type="button" class="er-pill kpim-ptype ${kpimState.periodType === 'daily' ? 'active' : ''}" data-ptype="daily" onclick="kpimSetPeriodType('daily')">Daily</button>
        <button type="button" class="er-pill kpim-ptype ${kpimState.periodType === 'monthly' ? 'active' : ''}" data-ptype="monthly" onclick="kpimSetPeriodType('monthly')">Monthly</button>
        <span id="kpim-period-controls" class="er-tools"></span>
      </div>
      <div class="er-tools">
        <div class="er-pills" id="kpim-dept-pills"></div>
        <label class="er-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
          <input type="search" placeholder="Search employee" value="${escapeHtml(kpimState.search)}" oninput="kpimState.search = this.value; kpimRenderTables();">
        </label>
      </div>
    </div>
    <div id="kpim-tables"><div class="empty-state"><h3>Loading</h3></div></div>
  </div>
  ${renderKpimEntryModal()}
  ${renderKpimDefaultsModal()}
  ${renderKpimHistoryModal()}`;
}

async function initKpiMonitoringPage() {
  const today = manilaToday();
  if (!kpimState.day) kpimState.day = today;
  if (!kpimState.month) kpimState.month = today.slice(0, 7);
  kpimRenderPeriodControls();
  kpimRenderDeptPills();
  await kpimLoad();
}

function kpimRenderPeriodControls() {
  const wrap = document.getElementById('kpim-period-controls');
  if (!wrap) return;
  document.querySelectorAll('.kpim-ptype').forEach((b) => b.classList.toggle('active', b.dataset.ptype === kpimState.periodType));
  if (kpimState.periodType === 'daily') {
    wrap.innerHTML = `<input class="form-control kpim-control" type="date" value="${kpimState.day}" aria-label="Day"
      onchange="if (this.value) { kpimState.day = this.value; kpimLoad(); }">`;
    return;
  }
  const [y, m] = kpimState.month.split('-').map(Number);
  const nowYear = Number(manilaToday().slice(0, 4));
  const years = [];
  for (let year = nowYear + 1; year >= nowYear - 4; year -= 1) years.push(year);
  wrap.innerHTML = `
    <select class="form-control kpim-control" aria-label="Month" onchange="kpimSetMonth(this.value, null)">
      ${KPIM_MONTHS.map((name, i) => `<option value="${i + 1}" ${i + 1 === m ? 'selected' : ''}>${name}</option>`).join('')}
    </select>
    <select class="form-control kpim-control" aria-label="Year" onchange="kpimSetMonth(null, this.value)">
      ${years.map((year) => `<option value="${year}" ${year === y ? 'selected' : ''}>${year}</option>`).join('')}
    </select>`;
}

function kpimSetPeriodType(periodType) {
  kpimState.periodType = periodType;
  kpimRenderPeriodControls();
  kpimLoad();
}

function kpimSetMonth(month, year) {
  const [y, m] = kpimState.month.split('-').map(Number);
  const nextMonth = month ? Number(month) : m;
  const nextYear = year ? Number(year) : y;
  kpimState.month = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
  kpimLoad();
}

function kpimRenderDeptPills() {
  const wrap = document.getElementById('kpim-dept-pills');
  if (!wrap) return;
  wrap.innerHTML = [['all', 'All'], ['CSR', 'CSR'], ['RMO', 'RMO']].map(([value, label]) =>
    `<button type="button" class="er-pill ${kpimState.department === value ? 'active' : ''}" onclick="kpimState.department = '${value}'; kpimRenderDeptPills(); kpimRenderTables();">${label}</button>`).join('');
}

async function kpimLoad() {
  const key = kpimPeriodKey();
  const type = kpimState.periodType;
  try {
    const data = await kpimApi(`/records?period_type=${type}&period_key=${encodeURIComponent(key)}`);
    if (kpimState.periodType !== type || kpimPeriodKey() !== key) return;
    kpimState.data = data;
  } catch (error) {
    const tables = document.getElementById('kpim-tables');
    if (tables) tables.innerHTML = `<div class="empty-state"><h3>Could not load KPI</h3><p>${escapeHtml(error.message || '')}</p></div>`;
    return;
  }
  kpimRenderCards();
  kpimRenderTables();
}

// ─── Summary cards ──────────────────────────────────────────
function kpimRenderCards() {
  const wrap = document.getElementById('kpim-cards');
  const people = kpimState.data?.people || [];
  if (!wrap) return;
  const of = (type) => people.map((p) => p.kpis?.[type]).filter(Boolean);
  const orders = of('orders').filter((r) => typeof r.achievement === 'number');
  const avg = orders.length ? Math.round((orders.reduce((s, r) => s + r.achievement, 0) / orders.length) * 10) / 10 : null;
  const met = (type) => of(type).filter((r) => r.status === 'meeting').length;
  const scored = (type) => of(type).filter((r) => r.status === 'meeting' || r.status === 'below' || r.status === 'above').length;
  const csr = people.filter((p) => p.department === 'CSR').length;
  const rmo = people.filter((p) => p.department === 'RMO').length;
  const card = (label, value, meta, bar) => `
    <div class="er-card">
      <div class="er-card-label">${label}</div>
      <div class="er-big">${value}</div>
      ${bar === null || bar === undefined ? '' : `<span class="er-bar"><i style="width:${Math.max(0, Math.min(100, bar))}%;background:var(--er-top)"></i></span>`}
      <div class="er-card-meta">${meta}</div>
    </div>`;
  const metCard = (label, type, total) => {
    const n = scored(type);
    return card(label, n ? `${met(type)}<small>/ ${n}</small>` : '—', n ? `meeting target · ${total - n} not entered` : `nothing entered for ${escapeHtml(kpimPeriodLabel())}`, n ? (met(type) / n) * 100 : null);
  };
  wrap.innerHTML = [
    card('CSR order achievement', avg === null ? '—' : `${avg}<small>%</small>`, orders.length ? `average of ${orders.length} CSR${orders.length === 1 ? '' : 's'} with a target` : 'no order targets yet', avg),
    metCard('CSR ROAS on target', 'roas', csr),
    metCard('RMO RTS on target', 'rts', rmo),
    card('Edited by HR', `${people.reduce((s, p) => s + Object.values(p.kpis || {}).filter((k) => k && k.id).length, 0)}<small>/ ${csr * 2 + rmo}</small>`, `records changed by hand · ${escapeHtml(kpimPeriodLabel())}`, null),
  ].join('');
}

function kpimPeso(value) {
  return `₱\u00a0${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Above the CSR table: the team's orders target (shared out over the active
// CSRs) and the team's ad spend (typed per day; a month adds its days up).
function kpimTeamBar() {
  const data = kpimState.data || {};
  const spend = data.team_ad_spend || { total: null, days: 0 };
  const team = data.team || { orders_target: null, csr_count: 0, share: null };
  const daily = kpimState.periodType === 'daily';
  const share = team.orders_target === null
    ? '<span class="text-xs text-muted">Set it to share it out.</span>'
    : `<span class="text-xs text-muted">÷ ${team.csr_count} CSR${team.csr_count === 1 ? '' : 's'} = <b>${team.share === null ? '—' : team.share.toLocaleString()}</b> each</span>`;
  const spendField = daily
    ? `<input class="form-control kpim-money" id="kpim-team-spend" type="number" min="0" step="any" inputmode="decimal" placeholder="₱"
        value="${spend.total ?? ''}" onchange="kpimSaveTeamSpend(this.value)" aria-label="CSR team ad spend">
       <span class="text-xs text-muted">shared by every CSR</span>`
    : `<b class="er-num">${spend.total === null ? '—' : kpimPeso(spend.total)}</b>
       <span class="text-xs text-muted">${spend.days ? `sum of ${spend.days} day${spend.days === 1 ? '' : 's'}` : 'type each day on the Daily view'}</span>`;
  return `<div class="kpim-spend-bar">
    <div class="kpim-bar-item">
      <label for="kpim-team-target"><b>Team orders target</b></label>
      <input class="form-control kpim-money" id="kpim-team-target" type="number" min="0" step="1" inputmode="numeric"
        value="${team.orders_target ?? ''}" onchange="kpimSaveTeamTarget(this.value)" aria-label="Team orders target">
      ${share}
    </div>
    <div class="kpim-bar-item">
      <label${daily ? ' for="kpim-team-spend"' : ''}><b>CSR team ad spend</b></label>
      ${spendField}
    </div>
  </div>`;
}

async function kpimSaveTeamTarget(value) {
  try {
    await kpimApi('/team-target', { method: 'PUT', body: { period_type: kpimState.periodType, period_key: kpimPeriodKey(), target: value } });
    kpimEntryCache.clear();
    showToast('success', 'Team orders target saved', kpimPeriodLabel());
    await kpimLoad();
  } catch (error) {
    showToast('error', 'Not saved', error.message);
  }
}

async function kpimSaveTeamSpend(value) {
  try {
    await kpimApi('/ad-spend', { method: 'PUT', body: { date: kpimState.day, amount: value } });
    kpimEntryCache.clear();
    showToast('success', 'Team ad spend saved', kpimPeriodLabel('daily', kpimState.day));
    await kpimLoad(); // every CSR's ROAS for the day follows it
  } catch (error) {
    showToast('error', 'Not saved', error.message);
  }
}

const KPIM_SOURCE_LABELS = { team: 'team share', confirmed: 'confirmed', default: 'default', manual: 'edited' };

// A value in the CSR table. It reads like the rest of the row; clicking it
// opens a box to override it. Enter or leaving the box saves; an empty box
// clears the override so the automatic value comes back; Esc cancels.
function kpimCell(person, kpiType, field, value, source, unit) {
  const shown = unit === 'peso' ? (value === null || value === undefined ? '<span class="er-dash">—</span>' : kpimPeso(value)) : kpimValue(unit, value);
  const tag = source ? `<span class="kpim-src${source === 'manual' ? ' edited' : ''}">${KPIM_SOURCE_LABELS[source] || source}</span>` : '';
  return `<button type="button" class="kpim-cell" title="Click to edit"
    onclick="kpimEditCell(this, ${Number(person.id)}, '${kpiType}', '${field}')">${shown}${tag}</button>`;
}

function kpimEditCell(button, userId, kpiType, field) {
  const person = (kpimState.data?.people || []).find((p) => p.id === userId);
  const record = person?.kpis?.[kpiType];
  if (!record) return;
  const current = field === 'gross_sales' ? record.gross_sales : record[field];
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = kpiType === 'orders' ? '1' : 'any';
  input.inputMode = kpiType === 'orders' ? 'numeric' : 'decimal';
  input.className = 'form-control kpim-money';
  input.value = current ?? '';
  input.setAttribute('aria-label', `${person.name} — ${field.replace('_', ' ')}`);
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save && input.value !== String(current ?? '')) kpimSaveCell(userId, kpiType, field, input.value);
    else kpimRenderTables();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  button.replaceWith(input);
  input.focus();
  input.select();
}

async function kpimSaveCell(userId, kpiType, field, value) {
  const body = { department: 'CSR', user_id: userId, kpi_type: kpiType, period_type: kpimState.periodType, period_key: kpimPeriodKey(), [field]: value };
  try {
    const { record } = await kpimApi('/records', { method: 'PUT', body });
    const person = (kpimState.data?.people || []).find((p) => p.id === userId);
    if (person) person.kpis[kpiType] = record;
    kpimEntryCache.clear();
    if (value === '') showToast('success', 'Back to automatic', '');
  } catch (error) {
    showToast('error', 'Not saved', error.message);
  }
  kpimRenderCards();
  kpimRenderTables();
}

// The CSR table's last row: sums for the counts and money, the average ROAS
// target, and the team's ROAS (all gross sales ÷ the team ad spend). Uses the
// rows on screen, so a search narrows the totals too.
function kpimCsrTotals(csr) {
  const sum = (pick) => {
    const values = csr.map(pick).filter((v) => typeof v === 'number');
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const targets = csr.map((p) => p.kpis.roas.target).filter((v) => typeof v === 'number');
  const avgTarget = targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : null;
  const gross = sum((p) => p.kpis.roas.gross_sales);
  const spend = kpimState.data?.team_ad_spend?.total ?? null;
  const teamRoas = gross !== null && spend > 0 ? Math.round((gross / spend) * 100) / 100 : null;
  return `<tfoot><tr class="kpim-total">
    <td><b>Total</b><div class="kpim-src">${csr.length} CSR${csr.length === 1 ? '' : 's'}</div></td>
    <td><span class="kpim-plain">${kpimValue('orders', sum((p) => p.kpis.orders.target))}</span></td>
    <td><span class="kpim-plain">${kpimValue('orders', sum((p) => p.kpis.orders.actual))}</span></td>
    <td><span class="kpim-plain">${kpimValue('roas', avgTarget)}</span><div class="kpim-src">average</div></td>
    <td><span class="kpim-plain">${gross === null ? '<span class="er-dash">—</span>' : kpimPeso(gross)}</span></td>
    <td><span class="kpim-plain">${kpimValue('roas', teamRoas)}</span><div class="kpim-src">team · gross ÷ ad spend</div></td>
    <td></td>
  </tr></tfoot>`;
}

// ─── Tables ─────────────────────────────────────────────────
function kpimRenderTables() {
  const wrap = document.getElementById('kpim-tables');
  if (!wrap || !kpimState.data) return;
  const q = kpimState.search.trim().toLowerCase();
  const people = (kpimState.data.people || []).filter((p) => !q || p.name.toLowerCase().includes(q));
  const showCsr = kpimState.department !== 'RMO';
  const showRmo = kpimState.department !== 'CSR';
  const csr = people.filter((p) => p.department === 'CSR');
  const rmo = people.filter((p) => p.department === 'RMO');
  const period = escapeHtml(kpimPeriodLabel());
  const person = (p) => (typeof perfPerson === 'function' ? perfPerson(p.name) : escapeHtml(p.name));
  const remarks = (records) => records.filter((r) => r && r.remarks)
    .map((r) => `<div class="kpim-remark"><b>${escapeHtml(KPIM_LABELS[r.kpi_type])}:</b> ${escapeHtml(r.remarks)}</div>`).join('') || '<span class="er-dash">—</span>';
  const actions = (p, types) => `
    <div class="kpim-actions">
      ${types.map((t) => `<button type="button" class="btn btn-secondary btn-sm" onclick="kpimOpenEntry(${p.id}, '${t}')">${types.length > 1 ? escapeHtml(t === 'orders' ? 'Orders' : 'ROAS') : 'Edit'}</button>`).join('')}
      <button type="button" class="btn btn-ghost btn-sm" onclick="kpimOpenHistory(${p.id})">History</button>
    </div>`;
  const empty = (dept) => `<tr><td colspan="7" class="text-muted">${q ? 'No one matches the search.' : `No active ${dept} employees.`}</td></tr>`;

  const csrTable = `
    <div class="er-group-row kpim-section"><span class="er-group-name">CSR · Number of Orders and ROAS</span><span class="er-count">${csr.length}</span><span class="er-group-avg">${period} · click a number to edit it</span></div>
    ${kpimTeamBar()}
    <div class="table-container er-table-wrap"><table class="er-table kpim-table kpim-csr">
      <thead><tr>
        <th>Employee</th><th>Orders target</th><th>Orders actual</th>
        <th>ROAS target</th><th>Gross sales</th><th>ROAS actual</th><th>Last update</th>
      </tr></thead>
      <tbody>${csr.length ? csr.map((p) => {
        const o = p.kpis.orders;
        const r = p.kpis.roas;
        const unlinked = p.confirmed_orders && !p.confirmed_orders.linked;
        return `<tr>
          <td><button type="button" class="kpim-name" onclick="kpimOpenHistory(${p.id})" title="KPI history">${person(p)}</button>
            ${unlinked ? '<div class="kpim-src" title="Link the Pancake name on Integrations → POS Users">no Pancake name linked</div>' : ''}</td>
          <td>${kpimCell(p, 'orders', 'target', o.target, o.target_source, 'orders')}</td>
          <td>${kpimCell(p, 'orders', 'actual', o.actual, o.actual_source, 'orders')}</td>
          <td>${kpimCell(p, 'roas', 'target', r.target, r.target_source, 'roas')}</td>
          <td>${kpimCell(p, 'roas', 'gross_sales', r.gross_sales, r.gross_source === 'confirmed' ? 'confirmed' : r.gross_source, 'peso')}</td>
          <td><span class="kpim-plain">${kpimValue('roas', r.actual)}</span></td>
          <td>${kpimUpdated([o, r])}</td>
        </tr>`;
      }).join('') : empty('CSR')}</tbody>
      ${csr.length ? kpimCsrTotals(csr) : ''}
    </table></div>`;

  const rmoTable = `
    <div class="er-group-row kpim-section kpim-section-rmo"><span class="er-group-name">RMO · RTS Rate</span><span class="er-count">${rmo.length}</span><span class="er-group-avg">${period} · lower is better</span></div>
    <div class="table-container er-table-wrap"><table class="er-table kpim-table">
      <thead><tr><th>Employee</th><th>RTS target</th><th>RTS actual</th><th>Status</th><th>Remarks</th><th>Last update</th><th></th></tr></thead>
      <tbody>${rmo.length ? rmo.map((p) => {
        const r = p.kpis.rts;
        return `<tr>
          <td>${person(p)}</td>
          <td>${kpimValue('rts', r?.target)}</td>
          <td>${kpimValue('rts', r?.actual)}</td>
          <td>${kpimStatus(r)}</td>
          <td>${remarks([r])}</td>
          <td>${kpimUpdated([r])}</td>
          <td>${actions(p, ['rts'])}</td>
        </tr>`;
      }).join('') : empty('RMO')}</tbody>
    </table></div>`;

  wrap.innerHTML = `${showCsr ? csrTable : ''}${showRmo ? rmoTable : ''}`;
}

// ─── Enter / edit ───────────────────────────────────────────
function renderKpimEntryModal() {
  return `
  <div class="modal-overlay" id="kpim-entry-modal">
    <div class="modal" style="max-width:520px;">
      <div class="modal-header">
        <div class="modal-title">Enter KPI</div>
        <button class="modal-close" onclick="closeModal('kpim-entry-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label" for="kpim-f-dept">Department</label>
            <select class="form-control" id="kpim-f-dept" onchange="kpimEntryDeptChanged()"><option value="CSR">CSR</option><option value="RMO">RMO</option></select></div>
          <div class="form-group"><label class="form-label" for="kpim-f-user">Employee</label>
            <select class="form-control" id="kpim-f-user" onchange="kpimEntryFill()"></select></div>
          <div class="form-group"><label class="form-label" for="kpim-f-kpi">KPI</label>
            <select class="form-control" id="kpim-f-kpi" onchange="kpimEntryKpiChanged()"></select></div>
          <div class="form-group"><label class="form-label" for="kpim-f-ptype">Reporting period</label>
            <select class="form-control" id="kpim-f-ptype" onchange="kpimEntryPeriodChanged()"><option value="daily">Daily</option><option value="monthly">Monthly</option></select></div>
          <div class="form-group" style="grid-column:1 / -1;"><label class="form-label" for="kpim-f-period" id="kpim-f-period-label">Day</label>
            <input class="form-control" id="kpim-f-period" type="date" onchange="kpimEntryFill()"></div>
          <div class="form-group"><label class="form-label" for="kpim-f-target" id="kpim-f-target-label">Target</label>
            <input class="form-control" id="kpim-f-target" type="number" min="0" step="any" inputmode="decimal"></div>
          <div class="form-group"><label class="form-label" for="kpim-f-actual" id="kpim-f-actual-label">Actual</label>
            <input class="form-control" id="kpim-f-actual" type="number" min="0" step="any" inputmode="decimal"></div>
          <div class="form-group kpim-f-roas"><label class="form-label">CSR team ad spend</label>
            <div class="kpim-f-static" id="kpim-f-spend">—</div></div>
          <div class="form-group kpim-f-roas"><label class="form-label" for="kpim-f-sales">Gross sales (₱)</label>
            <input class="form-control" id="kpim-f-sales" type="number" min="0" step="any" inputmode="decimal" oninput="kpimEntryRoasPreview()"></div>
          <div id="kpim-f-confirmed" style="grid-column:1 / -1;"></div>
          <div class="form-group" style="grid-column:1 / -1;"><label class="form-label" for="kpim-f-remarks">Remarks</label>
            <textarea class="form-control" id="kpim-f-remarks" rows="2" maxlength="1000"></textarea></div>
        </div>
        <p class="text-xs text-muted" id="kpim-f-hint" style="margin:0 0 12px;"></p>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-primary" style="flex:1;" id="kpim-f-save" onclick="kpimSaveEntry()">Save</button>
          <button class="btn btn-secondary" onclick="closeModal('kpim-entry-modal')">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
}

const kpimEntryCache = new Map(); // "type|key" → records response

async function kpimRecordsFor(periodType, key) {
  const cacheKey = `${periodType}|${key}`;
  if (kpimState.data && kpimState.periodType === periodType && kpimPeriodKey() === key) return kpimState.data;
  if (!kpimEntryCache.has(cacheKey)) kpimEntryCache.set(cacheKey, await kpimApi(`/records?period_type=${periodType}&period_key=${encodeURIComponent(key)}`));
  return kpimEntryCache.get(cacheKey);
}

function kpimOpenEntry(userId, kpiType) {
  const people = kpimState.data?.people || [];
  const person = people.find((p) => p.id === userId);
  const dept = person?.department || (kpimState.department === 'RMO' ? 'RMO' : 'CSR');
  document.getElementById('kpim-f-dept').value = dept;
  document.getElementById('kpim-f-ptype').value = kpimState.periodType;
  kpimEntryDeptChanged({ userId, kpiType, keepPeriod: false });
  openModal('kpim-entry-modal');
}

function kpimEntryDeptChanged(options = {}) {
  const dept = document.getElementById('kpim-f-dept').value;
  const people = (kpimState.data?.people || []).filter((p) => p.department === dept);
  const userSelect = document.getElementById('kpim-f-user');
  userSelect.innerHTML = people.length
    ? people.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')
    : '<option value="">No active employees</option>';
  if (options.userId && people.some((p) => p.id === options.userId)) userSelect.value = String(options.userId);
  const kpiSelect = document.getElementById('kpim-f-kpi');
  kpiSelect.innerHTML = KPIM_BY_DEPARTMENT[dept].map((k) => `<option value="${k}">${KPIM_LABELS[k]}</option>`).join('');
  if (options.kpiType && KPIM_BY_DEPARTMENT[dept].includes(options.kpiType)) kpiSelect.value = options.kpiType;
  kpimEntryPeriodChanged(options.keepPeriod !== false);
}

function kpimEntryPeriodChanged(keep = true) {
  const type = document.getElementById('kpim-f-ptype').value;
  const input = document.getElementById('kpim-f-period');
  const current = input.value;
  input.type = type === 'daily' ? 'date' : 'month';
  document.getElementById('kpim-f-period-label').textContent = type === 'daily' ? 'Day' : 'Month';
  const fallback = type === 'daily' ? kpimState.day : kpimState.month;
  const fits = type === 'daily' ? /^\d{4}-\d{2}-\d{2}$/.test(current) : /^\d{4}-\d{2}$/.test(current);
  input.value = keep && fits ? current : fallback;
  kpimEntryKpiChanged();
}

function kpimEntryKpiChanged() {
  const kpi = document.getElementById('kpim-f-kpi').value;
  const unit = { orders: 'orders', roas: 'ROAS, e.g. 3.5', rts: 'RTS %' }[kpi];
  document.getElementById('kpim-f-target-label').textContent = `Target (${unit})`;
  document.getElementById('kpim-f-actual-label').textContent = `Actual (${unit})`;
  const actual = document.getElementById('kpim-f-actual');
  actual.step = kpi === 'orders' ? '1' : 'any';
  actual.inputMode = kpi === 'orders' ? 'numeric' : 'decimal';
  document.getElementById('kpim-f-target').max = kpi === 'rts' ? '100' : '';
  actual.max = kpi === 'rts' ? '100' : '';
  // ROAS is gross sales ÷ ad spend: the actual box shows the result only.
  const roas = kpi === 'roas';
  document.querySelectorAll('.kpim-f-roas').forEach((el) => { el.style.display = roas ? '' : 'none'; });
  actual.readOnly = roas;
  if (roas) document.getElementById('kpim-f-actual-label').textContent = 'ROAS actual (gross sales ÷ ad spend)';
  kpimEntryFill();
}

function kpimEntryRoasPreview() {
  if (document.getElementById('kpim-f-kpi').value !== 'roas') return;
  const spend = Number(document.getElementById('kpim-f-spend').dataset.amount || 0);
  const salesRaw = document.getElementById('kpim-f-sales').value;
  document.getElementById('kpim-f-actual').value = spend > 0 && salesRaw !== '' ? Math.round((Number(salesRaw) / spend) * 100) / 100 : '';
}

// Fill target, actual and remarks from what is already saved for this
// employee, KPI and period, so saving again corrects the same record.
async function kpimEntryFill() {
  const userId = Number(document.getElementById('kpim-f-user').value);
  const kpi = document.getElementById('kpim-f-kpi').value;
  const type = document.getElementById('kpim-f-ptype').value;
  const key = document.getElementById('kpim-f-period').value;
  const hint = document.getElementById('kpim-f-hint');
  if (!userId || !key) return;
  let data;
  try {
    data = await kpimRecordsFor(type, key);
  } catch (error) {
    hint.textContent = error.message || 'Could not load the saved numbers.';
    return;
  }
  if (Number(document.getElementById('kpim-f-user').value) !== userId || document.getElementById('kpim-f-period').value !== key) return;
  const person = data.people?.find((p) => p.id === userId);
  const record = person?.kpis?.[kpi] || null;
  // The boxes hold only what HR set by hand; the automatic value shows as the
  // greyed placeholder, so leaving a box empty keeps it automatic.
  const saved = record?.saved || {};
  const auto = (value, source) => (source && source !== 'manual' && value !== null && value !== undefined ? String(value) : '');
  const targetBox = document.getElementById('kpim-f-target');
  targetBox.value = saved.target ?? '';
  targetBox.placeholder = auto(record?.target, record?.target_source);
  const actualBox = document.getElementById('kpim-f-actual');
  actualBox.value = kpi === 'roas' ? (record?.actual ?? '') : (saved.actual ?? '');
  actualBox.placeholder = kpi === 'roas' ? '' : auto(record?.actual, record?.actual_source);
  const spendBox = document.getElementById('kpim-f-spend');
  const spend = data.team_ad_spend?.total ?? null;
  spendBox.dataset.amount = spend ?? '';
  spendBox.textContent = spend === null ? 'None yet — type it on the Daily view' : kpimPeso(spend);
  const salesBox = document.getElementById('kpim-f-sales');
  salesBox.value = saved.gross_sales ?? '';
  salesBox.placeholder = auto(record?.gross_sales, record?.gross_source);
  const slot = document.getElementById('kpim-f-confirmed');
  slot.innerHTML = kpi !== 'rts' && person?.confirmed_orders && !person.confirmed_orders.linked
    ? '<span class="text-xs text-muted">No Pancake name is linked to this account — link it on Integrations → POS Users to fill orders and gross sales automatically.</span>'
    : (kpi !== 'rts' ? '<span class="text-xs text-muted">Leave a box empty to keep the automatic value shown in grey.</span>' : '');
  document.getElementById('kpim-f-remarks').value = record?.remarks || '';
  hint.textContent = record?.id
    ? `Editing the saved record — last changed by ${record.updated_by || '—'} ${kpimWhen(record.updated_at)}. The previous numbers stay in History.`
    : 'Nothing set by hand yet.';
}

async function kpimSaveEntry() {
  const body = {
    department: document.getElementById('kpim-f-dept').value,
    user_id: Number(document.getElementById('kpim-f-user').value),
    kpi_type: document.getElementById('kpim-f-kpi').value,
    period_type: document.getElementById('kpim-f-ptype').value,
    period_key: document.getElementById('kpim-f-period').value,
    target: document.getElementById('kpim-f-target').value,
    actual: document.getElementById('kpim-f-actual').value,
    remarks: document.getElementById('kpim-f-remarks').value,
  };
  if (body.kpi_type === 'roas') {
    body.gross_sales = document.getElementById('kpim-f-sales').value;
    delete body.actual; // worked out by the server
  }
  if (!body.user_id) { showToast('warning', 'Pick an employee', ''); return; }
  const button = document.getElementById('kpim-f-save');
  button.disabled = true;
  try {
    await kpimApi('/records', { method: 'PUT', body });
    kpimEntryCache.clear();
    showToast('success', 'KPI saved', `${KPIM_LABELS[body.kpi_type]} · ${kpimPeriodLabel(body.period_type, body.period_key)}`);
    closeModal('kpim-entry-modal');
    await kpimLoad();
  } catch (error) {
    showToast('error', 'Not saved', error.message);
  } finally {
    button.disabled = false;
  }
}

// ─── Default targets ────────────────────────────────────────
function renderKpimDefaultsModal() {
  const row = (kpi, unit) => `
    <tr><td>${KPIM_LABELS[kpi]}</td>
      ${['daily', 'monthly'].map((p) => `<td><input class="form-control" type="number" min="0" step="any" inputmode="decimal" id="kpim-d-${kpi}-${p}" aria-label="${KPIM_LABELS[kpi]} ${p} default (${unit})"></td>`).join('')}
    </tr>`;
  return `
  <div class="modal-overlay" id="kpim-defaults-modal">
    <div class="modal" style="max-width:520px;">
      <div class="modal-header">
        <div class="modal-title">Default targets</div>
        <button class="modal-close" onclick="closeModal('kpim-defaults-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <p class="text-xs text-muted" style="margin-top:0;">Filled in when a KPI is saved without a target. Existing records keep their own target. RTS is a percentage; leave a box empty for no default.</p>
        <div class="table-container er-table-wrap"><table class="er-table no-cards">
          <thead><tr><th>KPI</th><th>Daily</th><th>Monthly</th></tr></thead>
          <tbody>${row('orders', 'orders')}${row('roas', 'ROAS')}${row('rts', '%')}</tbody>
        </table></div>
        <div style="display:flex;gap:8px;margin-top:14px;">
          <button class="btn btn-primary" style="flex:1;" onclick="kpimSaveDefaults()">Save defaults</button>
          <button class="btn btn-secondary" onclick="closeModal('kpim-defaults-modal')">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
}

async function kpimOpenDefaults() {
  try {
    const { defaults } = await kpimApi('/defaults');
    Object.entries(defaults).forEach(([key, value]) => {
      const el = document.getElementById(`kpim-d-${key.replace('|', '-')}`);
      if (el) el.value = value ?? '';
    });
    openModal('kpim-defaults-modal');
  } catch (error) {
    showToast('error', 'Could not load defaults', error.message);
  }
}

async function kpimSaveDefaults() {
  try {
    for (const kpi of ['orders', 'roas', 'rts']) {
      for (const p of ['daily', 'monthly']) {
        const value = document.getElementById(`kpim-d-${kpi}-${p}`).value;
        await kpimApi('/defaults', { method: 'PUT', body: { kpi_type: kpi, period_type: p, target: value } });
      }
    }
    kpimEntryCache.clear();
    showToast('success', 'Defaults saved', '');
    closeModal('kpim-defaults-modal');
    kpimLoad();
  } catch (error) {
    showToast('error', 'Not saved', error.message);
  }
}

// ─── History ────────────────────────────────────────────────
function renderKpimHistoryModal() {
  return `
  <div class="modal-overlay" id="kpim-history-modal">
    <div class="modal" style="max-width:860px;">
      <div class="modal-header">
        <div class="modal-title" id="kpim-h-title">KPI history</div>
        <button class="modal-close" onclick="closeModal('kpim-history-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="er-pills" style="margin-bottom:12px;">
          <button type="button" class="er-pill kpim-h-ptype" data-ptype="monthly" onclick="kpimHistoryPeriod('monthly')">Monthly</button>
          <button type="button" class="er-pill kpim-h-ptype" data-ptype="daily" onclick="kpimHistoryPeriod('daily')">Daily</button>
        </div>
        <div id="kpim-h-body"><div class="empty-state"><h3>Loading</h3></div></div>
      </div>
    </div>
  </div>`;
}

function kpimOpenHistory(userId) {
  const person = (kpimState.data?.people || []).find((p) => p.id === userId);
  kpimState.history = { userId, name: person?.name || '', periodType: kpimState.periodType };
  document.getElementById('kpim-h-title').textContent = `KPI history · ${kpimState.history.name}`;
  openModal('kpim-history-modal');
  kpimLoadHistory();
}

function kpimHistoryPeriod(periodType) {
  kpimState.history.periodType = periodType;
  kpimLoadHistory();
}

async function kpimLoadHistory() {
  const { userId, periodType } = kpimState.history;
  document.querySelectorAll('.kpim-h-ptype').forEach((b) => b.classList.toggle('active', b.dataset.ptype === periodType));
  const body = document.getElementById('kpim-h-body');
  let records;
  try {
    ({ records } = await kpimApi(`/records/history?user_id=${userId}&period_type=${periodType}`));
  } catch (error) {
    body.innerHTML = `<div class="empty-state"><h3>Could not load history</h3><p>${escapeHtml(error.message || '')}</p></div>`;
    return;
  }
  if (kpimState.history.userId !== userId || kpimState.history.periodType !== periodType) return;
  body.innerHTML = records.length ? `
    <div class="table-container er-table-wrap"><table class="er-table kpim-table">
      <thead><tr><th>Period</th><th>KPI</th><th>Target</th><th>Actual</th><th>Result</th><th>Remarks</th><th>Last update</th><th></th></tr></thead>
      <tbody>${records.map((r) => `
        <tr>
          <td>${escapeHtml(kpimPeriodLabel(r.period_type, r.period_key))}</td>
          <td>${KPIM_LABELS[r.kpi_type]}</td>
          <td>${kpimValue(r.kpi_type, r.target)}</td>
          <td>${kpimValue(r.kpi_type, r.actual)}</td>
          <td>${r.kpi_type === 'orders' ? `${kpimAchievement(r)} ` : ''}${kpimStatus(r)}</td>
          <td>${r.remarks ? escapeHtml(r.remarks) : '<span class="er-dash">—</span>'}</td>
          <td>${kpimUpdated([r])}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" onclick="kpimToggleAudit(${r.id}, this)">Changes</button></td>
        </tr>
        <tr class="kpim-audit-row" id="kpim-audit-${r.id}" hidden><td colspan="8"></td></tr>`).join('')}
      </tbody>
    </table></div>` : `<div class="empty-state"><h3>No ${periodType} records yet</h3></div>`;
}

async function kpimToggleAudit(recordId, button) {
  const row = document.getElementById(`kpim-audit-${recordId}`);
  if (!row) return;
  if (!row.hidden) { row.hidden = true; button.textContent = 'Changes'; return; }
  row.hidden = false;
  button.textContent = 'Hide';
  const cell = row.querySelector('td');
  cell.innerHTML = '<span class="text-muted">Loading…</span>';
  try {
    const { audit } = await kpimApi(`/records/${recordId}/audit`);
    cell.innerHTML = `<ol class="kpim-audit">${audit.map((a) => {
      const num = (v) => (v === null || v === undefined ? '—' : v);
      const change = a.action === 'create'
        ? `Created: target ${num(a.new_target)}, actual ${num(a.new_actual)}${a.new_ad_spend !== null && a.new_ad_spend !== undefined ? `, ad spend ${num(a.new_ad_spend)}, gross sales ${num(a.new_gross_sales)}` : ''}${a.new_remarks ? ` · “${escapeHtml(a.new_remarks)}”` : ''}`
        : `Changed: target ${num(a.old_target)} → ${num(a.new_target)}, actual ${num(a.old_actual)} → ${num(a.new_actual)}${(a.old_ad_spend ?? a.new_ad_spend ?? a.old_gross_sales ?? a.new_gross_sales) !== null && (a.old_ad_spend ?? a.new_ad_spend ?? a.old_gross_sales ?? a.new_gross_sales) !== undefined ? `, ad spend ${num(a.old_ad_spend)} → ${num(a.new_ad_spend)}, gross sales ${num(a.old_gross_sales)} → ${num(a.new_gross_sales)}` : ''}${a.old_remarks !== a.new_remarks ? ` · remarks “${escapeHtml(a.old_remarks || '—')}” → “${escapeHtml(a.new_remarks || '—')}”` : ''}`;
      return `<li>${change} <span class="text-muted">— ${escapeHtml(a.changed_by || '—')}, ${escapeHtml(kpimWhen(a.changed_at))}</span></li>`;
    }).join('')}</ol>`;
  } catch (error) {
    cell.innerHTML = `<span class="text-muted">${escapeHtml(error.message || 'Could not load changes')}</span>`;
  }
}
