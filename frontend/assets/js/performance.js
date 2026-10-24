/* ═══════════════════════════════════════════════════════════
   PERFORMANCE — the two scoring categories beside the peer Evaluation
   (which this page never reads or changes):
     Compliance (Category 2) — Attendance, Standup, EOD, Meditation /
       Self-Care and WAM, worked out from Time & Attendance and the Employee
       Tracker marks, per 15-day half or whole month.
     KPI (Category 3) — the month's target per department KPI (e.g. CSR
       confirmed orders), shared out over the people in it; each person's
       daily % and monthly % from the numbers HR types in on Employee
       Tracker → Confirmed Orders. Monthly-number KPIs (e.g. ROAS) get one
       number a month. KPI Setup holds the KPI list and per-person tweaks.
   Backed by /api/performance. HR, Operation and the super admin only.
   Loaded before app.js; it leans on app.js globals (escapeHtml,
   authorizedJsonRequest, showToast, manilaToday, DEPARTMENT_ORDER) read at
   call time.
   ═══════════════════════════════════════════════════════════ */

const PERF_METRIC_LABELS = {
  attendance: 'Attendance',
  standup: 'Standup',
  eod: 'EOD',
  selfcare: 'Meditation',
  wam: 'WAM',
};

const perfState = {
  tab: 'compliance',
  compliancePeriod: '',
  kpiMonth: '',
  kpiDate: '',
  setupDepartment: '',
  setup: null,
};

function renderPerformancePage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Performance</h1>
      <p>Compliance and KPI scores, kept separate from the peer Evaluation.</p>
    </div>
  </div>
  <div class="et-tabs perf-tabs" id="perf-tabs"></div>
  <div id="perf-body"><div class="card"><div class="empty-state"><h3>Loading</h3></div></div></div>`;
}

async function initPerformancePage() {
  const today = manilaToday();
  if (!perfState.compliancePeriod) perfState.compliancePeriod = `${today.slice(0, 7)}-H${Number(today.slice(8, 10)) <= 15 ? 1 : 2}`;
  if (!perfState.kpiMonth) perfState.kpiMonth = today.slice(0, 7);
  if (!perfState.kpiDate) perfState.kpiDate = today;
  renderPerfTabs();
  await perfLoadTab();
}

function renderPerfTabs() {
  const wrap = document.getElementById('perf-tabs');
  if (!wrap) return;
  const tabs = [['compliance', 'Compliance'], ['kpi', 'KPI'], ['setup', 'KPI Setup']];
  wrap.innerHTML = tabs.map(([id, label]) =>
    `<button class="filter-pill ${perfState.tab === id ? 'active' : ''}" type="button" onclick="perfSetTab('${id}')">${label}</button>`).join('');
}

function perfSetTab(tab) {
  perfState.tab = tab;
  renderPerfTabs();
  return perfLoadTab();
}

function perfLoadTab() {
  if (perfState.tab === 'kpi') return perfLoadKpi();
  if (perfState.tab === 'setup') return perfLoadSetup();
  return perfLoadCompliance();
}

function perfBody(html) {
  const body = document.getElementById('perf-body');
  if (body) body.innerHTML = html;
}

function perfError(error) {
  perfBody(`<div class="card"><div class="empty-state"><h3>Could not load</h3><p>${escapeHtml(error.message || 'error')}</p></div></div>`);
}

// ─── shared bits ────────────────────────────────────────────
function perfMonthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function perfRecentMonths(count = 12) {
  const [y, m] = manilaToday().slice(0, 7).split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(y, m - 1 - i, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
}

function perfScoreBadge(score) {
  if (score === null || score === undefined) return '<span class="text-muted">—</span>';
  const tone = score >= 90 ? 'success' : score >= 75 ? 'info' : score >= 60 ? 'warning' : 'danger';
  return `<span class="badge badge-${tone}">${Number(score).toFixed(score % 1 ? 1 : 0)}%</span>`;
}

// People split into departments in the tracker's order.
function perfGroupByDepartment(rows) {
  const order = typeof DEPARTMENT_ORDER !== 'undefined' ? DEPARTMENT_ORDER : [];
  const groups = new Map();
  rows.forEach((row) => {
    if (!groups.has(row.department)) groups.set(row.department, []);
    groups.get(row.department).push(row);
  });
  const rank = (name) => (order.indexOf(name) === -1 ? order.length : order.indexOf(name));
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

// ─── Compliance (Category 2) ────────────────────────────────
async function perfLoadCompliance() {
  let data;
  try {
    data = await authorizedJsonRequest(`/performance/compliance?period=${encodeURIComponent(perfState.compliancePeriod)}`);
  } catch (error) {
    perfError(error);
    return;
  }
  if (perfState.tab !== 'compliance') return;
  const options = perfRecentMonths(6).flatMap((ym) => [
    [`${ym}-H2`, `${perfMonthLabel(ym)} · 16th–end`],
    [`${ym}-H1`, `${perfMonthLabel(ym)} · 1st–15th`],
    [ym, `${perfMonthLabel(ym)} · whole month`],
  ]).map(([value, label]) => `<option value="${value}" ${value === data.period ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
  const metrics = data.metrics || Object.keys(PERF_METRIC_LABELS);
  const cell = (m) => `<td title="${m.counted} day${m.counted === 1 ? '' : 's'} counted">${perfScoreBadge(m.score)}</td>`;
  const groups = perfGroupByDepartment(data.rows || []);
  perfBody(`
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Compliance · Category 2</div>
          <div class="card-subtitle">On time / attended = 100%, late = 50%, absent / not done = 0%. Rest days, approved leave and unmarked days don't count. Overall is the average of the items that have days.</div>
        </div>
        <select class="form-control perf-select" onchange="perfState.compliancePeriod = this.value; perfLoadCompliance();">${options}</select>
      </div>
      <div class="table-container"><table>
        <thead><tr><th>Employee</th>${metrics.map((m) => `<th>${escapeHtml(PERF_METRIC_LABELS[m] || m)}</th>`).join('')}<th>Overall</th></tr></thead>
        ${groups.map(([department, people]) => `<tbody>
          <tr class="perf-group"><td colspan="${metrics.length + 2}">${escapeHtml(department)}</td></tr>
          ${people.map((p) => `<tr>
            <td><strong>${escapeHtml(p.name)}</strong></td>
            ${metrics.map((m) => cell(p.metrics[m] || { score: null, counted: 0 })).join('')}
            <td>${perfScoreBadge(p.overall)}</td>
          </tr>`).join('')}
        </tbody>`).join('')}
      </table></div>
      <div class="card-body"><p class="text-xs text-muted">Attendance compares Time &amp; Attendance with the Schedule (no schedule that day = not counted). Standup, EOD, Meditation and WAM come from the Employee Tracker marks.</p></div>
    </div>`);
}

// ─── KPI (Category 3) ───────────────────────────────────────
// One date drives the tab: its month is the target being set and summed, the
// day itself is the daily % column.
async function perfLoadKpi() {
  const date = perfState.kpiDate;
  const month = date.slice(0, 7);
  let daily;
  let monthly;
  try {
    [daily, monthly] = await Promise.all([
      authorizedJsonRequest(`/performance/kpi/daily?date=${encodeURIComponent(date)}`),
      authorizedJsonRequest(`/performance/kpi/scores?period=${encodeURIComponent(month)}`),
    ]);
  } catch (error) {
    perfError(error);
    return;
  }
  if (perfState.tab !== 'kpi') return;
  perfState.kpiMonth = month;
  const monthName = perfMonthLabel(month);
  const dayName = new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const n = (value) => (value === null || value === undefined ? '—' : Math.round(Number(value) * 100) / 100);
  const departments = perfGroupByDepartment((daily.targets || []).map((t) => ({ ...t, department: t.department || '—' })));

  const teamTable = (t) => {
    const members = (daily.rows || []).filter((r) => r.kpis.some((k) => k.item_id === t.item_id));
    const team = (daily.teams || []).find((x) => x.item_id === t.item_id);
    const unit = t.unit ? ` ${escapeHtml(t.unit)}` : '';
    return `
      <div class="perf-target-row">
        <label class="perf-target-label" for="perf-target-${t.item_id}">${escapeHtml(t.label)} · ${escapeHtml(monthName)} target</label>
        <input class="form-control perf-target-input" id="perf-target-${t.item_id}" type="number" min="0" step="any" value="${n(t.target) === '—' ? '' : n(t.target)}"
          onchange="perfSaveMonthTarget(${Number(t.item_id)}, this.value)">
        <span class="text-muted">${t.split
          ? `÷ ${t.members} ${t.members === 1 ? 'person' : 'people'} = <strong>${t.members ? n(t.target / t.members) : 0}</strong>${unit} each`
          : 'per person'}</span>
      </div>
      ${members.length ? `<div class="table-container"><table class="perf-kpi-table">
        <thead><tr>
          <th>Employee</th><th>Monthly target</th><th>Daily target</th>
          <th>${escapeHtml(dayName)}</th><th>Daily %</th>
          <th>This month</th><th>Monthly %</th>
        </tr></thead>
        <tbody>
          ${members.map((p) => {
            const k = p.kpis.find((x) => x.item_id === t.item_id);
            return `<tr>
              <td><strong>${escapeHtml(p.name)}</strong></td>
              <td>${n(k.target)}${unit}</td>
              <td>${n(k.daily_target)}${unit}</td>
              <td>${k.value === null ? '<span class="text-muted">—</span>' : `${n(k.value)}${unit}`}</td>
              <td>${perfScoreBadge(k.daily_pct)}</td>
              <td>${n(k.month_total)}${unit} <span class="text-xs text-muted">· ${k.days_entered} of ${k.work_days} days</span></td>
              <td>${perfScoreBadge(k.monthly_pct)}</td>
            </tr>`;
          }).join('')}
        </tbody>
        ${team && t.split ? `<tfoot><tr>
          <td><strong>Team</strong></td>
          <td><strong>${n(team.target)}</strong>${unit}</td>
          <td>${n(team.daily_target)}${unit}</td>
          <td>${n(team.day)}${unit}</td>
          <td>${perfScoreBadge(team.daily_pct)}</td>
          <td><strong>${n(team.total)}</strong>${unit}</td>
          <td>${perfScoreBadge(team.monthly_pct)}</td>
        </tr></tfoot>` : ''}
      </table></div>` : '<p class="text-xs text-muted">Nobody has this KPI yet.</p>'}`;
  };

  // Monthly-number KPIs (e.g. ROAS): one number per person per month.
  const monthlyRows = (monthly.rows || [])
    .map((r) => ({ ...r, kpis: r.kpis.filter((k) => k.entry !== 'daily') }))
    .filter((r) => r.kpis.length);
  const monthlyGroups = perfGroupByDepartment(monthlyRows);

  perfBody(`
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">KPI · Category 3</div>
          <div class="card-subtitle">Set the month's target; it is shared out over the people in the department. Daily target = each person's share ÷ their scheduled days. The numbers come from Employee Tracker → Confirmed Orders. Over 100% = above target.</div>
        </div>
        <div class="perf-date-nav">
          <button class="et-nav" type="button" onclick="perfShiftKpiDate(-1)" aria-label="Previous day">←</button>
          <input class="form-control" type="date" value="${date}" aria-label="Day" onchange="if (this.value) { perfState.kpiDate = this.value; perfLoadKpi(); }">
          <button class="et-nav" type="button" onclick="perfShiftKpiDate(1)" aria-label="Next day">→</button>
        </div>
      </div>
      <div class="card-body">
        ${departments.length ? departments.map(([department, targets]) => `
          <h4 class="perf-h">${escapeHtml(department)}</h4>
          ${targets.map(teamTable).join('')}`).join('') : `<div class="empty-state"><h3>No KPI yet</h3>
            <p>On KPI Setup, add the CSR KPI (e.g. "Confirmed orders") with <strong>Whole-department target</strong> and <strong>Daily — from Employee Tracker → Confirmed Orders</strong>.</p>
            <button class="btn btn-primary btn-sm" onclick="perfSetTab('setup')">Open KPI Setup</button></div>`}
      </div>
    </div>
    ${monthlyGroups.length ? `<div class="card" style="margin-top:20px;">
      <div class="card-header"><div>
        <div class="card-title">Monthly-number KPIs · ${escapeHtml(monthName)}</div>
        <div class="card-subtitle">One number per person for the month (e.g. ROAS); it saves when you leave the box.</div>
      </div></div>
      <div class="table-container"><table class="perf-kpi-table">
        <thead><tr><th>Employee</th><th>KPI</th><th>Target</th><th>Actual</th><th>Score</th></tr></thead>
        ${monthlyGroups.map(([department, people]) => `<tbody>
          <tr class="perf-group"><td colspan="5">${escapeHtml(department)}</td></tr>
          ${people.map((p) => p.kpis.map((k, index) => `<tr${index === 0 ? ' class="perf-person-start"' : ''}>
            ${index === 0 ? `<td rowspan="${p.kpis.length}"><strong>${escapeHtml(p.name)}</strong></td>` : ''}
            <td>${escapeHtml(k.label)}${k.direction === 'lower' ? ' <span class="text-xs text-muted">(lower is better)</span>' : ''}</td>
            <td>${n(k.target)}${k.unit ? ` ${escapeHtml(k.unit)}` : ''}</td>
            <td><input class="form-control perf-actual" type="number" step="any" inputmode="decimal" value="${k.actual ?? ''}"
              aria-label="${escapeHtml(`${p.name} — ${k.label} actual`)}"
              onchange="perfSaveActual(${Number(p.id)}, ${Number(k.item_id)}, this.value)"></td>
            <td>${perfScoreBadge(k.score)}</td>
          </tr>`).join('')).join('')}
        </tbody>`).join('')}
      </table></div>
    </div>` : ''}`);
}

function perfShiftKpiDate(direction) {
  const date = new Date(`${perfState.kpiDate}T00:00:00`);
  date.setDate(date.getDate() + direction);
  perfState.kpiDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  perfLoadKpi();
}

async function perfSaveMonthTarget(itemId, value) {
  try {
    await authorizedJsonRequest('/performance/kpi/period-target', {
      method: 'PUT',
      body: JSON.stringify({ item_id: itemId, period: perfState.kpiDate.slice(0, 7), target: value === '' ? null : Number(value) }),
    });
    showToast('success', 'Target saved', `${perfMonthLabel(perfState.kpiDate.slice(0, 7))}`);
    perfLoadKpi();
  } catch (error) {
    showToast('error', 'Not saved', error.message);
  }
}

async function perfSaveActual(userId, itemId, value) {
  try {
    await authorizedJsonRequest('/performance/kpi/results', {
      method: 'PUT',
      body: JSON.stringify({ period: perfState.kpiMonth, user_id: userId, item_id: itemId, actual: value === '' ? null : Number(value) }),
    });
    perfLoadKpi();
  } catch (error) {
    showToast('error', 'Not saved', error.message);
  }
}

// ─── KPI Setup ──────────────────────────────────────────────
async function perfLoadSetup() {
  try {
    perfState.setup = await authorizedJsonRequest('/performance/kpi/setup');
  } catch (error) {
    perfError(error);
    return;
  }
  if (perfState.tab !== 'setup') return;
  const departments = perfState.setup.departments || [];
  if (!departments.includes(perfState.setupDepartment)) perfState.setupDepartment = departments.includes('CSR') ? 'CSR' : departments[0];
  renderPerfSetup();
}

function perfItemFields(prefix, item = {}) {
  return `
    <input class="form-control perf-f-label" id="${prefix}-label" placeholder="KPI name, e.g. ROAS" value="${escapeHtml(item.label || '')}" maxlength="200">
    <input class="form-control perf-f-num" id="${prefix}-target" type="number" step="any" placeholder="Target" value="${item.target ?? ''}">
    <input class="form-control perf-f-unit" id="${prefix}-unit" placeholder="Unit (×, %, pcs)" value="${escapeHtml(item.unit || '')}" maxlength="40">
    <select class="form-control perf-f-dir" id="${prefix}-direction">
      <option value="higher" ${item.direction !== 'lower' ? 'selected' : ''}>Higher is better</option>
      <option value="lower" ${item.direction === 'lower' ? 'selected' : ''}>Lower is better</option>
    </select>
    <input class="form-control perf-f-num" id="${prefix}-weight" type="number" step="any" min="0" placeholder="Weight" title="Weight" value="${item.weight ?? 1}">
    ${prefix.startsWith('perf-new-') || item.user_id ? '' : `<select class="form-control perf-f-dir" id="${prefix}-split" title="Whose target is it?">
      <option value="each" ${item.split ? '' : 'selected'}>Target per person</option>
      <option value="team" ${item.split ? 'selected' : ''}>Whole-department target (split)</option>
    </select>`}
    <select class="form-control perf-f-dir" id="${prefix}-entry" title="Monthly target; daily entry splits it per day">
      <option value="monthly" ${item.entry !== 'daily' ? 'selected' : ''}>Monthly number</option>
      <option value="orders" ${item.source === 'orders' ? 'selected' : ''}>Daily — from Employee Tracker → Confirmed Orders</option>
    </select>`;
}

function perfReadItem(prefix) {
  const val = (field) => document.getElementById(`${prefix}-${field}`)?.value ?? '';
  return { label: val('label').trim(), target: val('target'), unit: val('unit').trim(), direction: val('direction'), weight: val('weight'), entry: val('entry'), split: val('split') };
}

function renderPerfSetup() {
  const setup = perfState.setup;
  const department = perfState.setupDepartment;
  const deptItems = setup.items.filter((i) => i.department === department && !i.user_id);
  const people = setup.people.filter((p) => p.department === department);
  const override = (userId, itemId) => setup.overrides.find((o) => o.user_id === userId && o.item_id === itemId);
  const pills = setup.departments.map((d) =>
    `<button class="filter-pill ${d === department ? 'active' : ''}" type="button" onclick="perfState.setupDepartment = this.dataset.d; renderPerfSetup();" data-d="${escapeHtml(d)}">${escapeHtml(d)}</button>`).join('');

  perfBody(`
    <div class="card">
      <div class="card-header"><div>
        <div class="card-title">KPI Setup</div>
        <div class="card-subtitle">Each department's KPIs apply to everyone in it. The target here is the default; the KPI tab sets each month's own target. "Whole-department target" shares it out over the people in the department (e.g. CSR's monthly orders ÷ the CSRs). "From Employee Tracker → Confirmed Orders" reads the numbers HR types there every day. Below, adjust one person: switch a KPI off for them, give them their own target, or add a personal KPI.</div>
      </div></div>
      <div class="card-body">
        <div class="et-tabs">${pills}</div>
        <h4 class="perf-h">${escapeHtml(department)} KPIs</h4>
        ${deptItems.length ? deptItems.map((item) => `
          <form class="perf-item-row" onsubmit="event.preventDefault(); perfUpdateItem(${item.id});">
            ${perfItemFields(`perf-item-${item.id}`, item)}
            <button class="btn btn-secondary btn-sm" type="submit">Save</button>
            <button class="btn btn-secondary btn-sm" type="button" onclick="perfRemoveItem(${item.id})">Remove</button>
          </form>`).join('') : '<p class="text-xs text-muted">No KPIs for this department yet.</p>'}
        <form class="perf-item-row perf-add-row" onsubmit="event.preventDefault(); perfAddItem({ department: perfState.setupDepartment }, 'perf-new');">
          ${perfItemFields('perf-new')}
          <button class="btn btn-primary btn-sm" type="submit">Add KPI</button>
        </form>

        <h4 class="perf-h">Per person</h4>
        ${people.length ? people.map((p) => {
          const personal = setup.items.filter((i) => i.user_id === p.id);
          return `
          <div class="perf-person">
            <div class="perf-person-name">${escapeHtml(p.name)} <span class="text-xs text-muted">${escapeHtml(p.role)}</span></div>
            ${deptItems.map((item) => {
              const o = override(p.id, item.id);
              return `<div class="perf-ov-row">
                <label class="perf-ov-use"><input type="checkbox" ${o?.hidden ? '' : 'checked'} onchange="perfSetOverride(${p.id}, ${item.id}, !this.checked, this.closest('.perf-ov-row').querySelector('input[type=number]').value)"> ${escapeHtml(item.label)}</label>
                <input class="form-control perf-f-num" type="number" step="any" placeholder="${item.target}" title="Own target (blank = department target ${item.target})" value="${o?.target ?? ''}"
                  onchange="perfSetOverride(${p.id}, ${item.id}, !this.closest('.perf-ov-row').querySelector('input[type=checkbox]').checked, this.value)">
              </div>`;
            }).join('')}
            ${personal.map((item) => `
              <form class="perf-item-row" onsubmit="event.preventDefault(); perfUpdateItem(${item.id});">
                ${perfItemFields(`perf-item-${item.id}`, item)}
                <button class="btn btn-secondary btn-sm" type="submit">Save</button>
                <button class="btn btn-secondary btn-sm" type="button" onclick="perfRemoveItem(${item.id})">Remove</button>
              </form>`).join('')}
            <details class="perf-add-personal"><summary>+ Personal KPI</summary>
              <form class="perf-item-row" onsubmit="event.preventDefault(); perfAddItem({ user_id: ${p.id} }, 'perf-new-${p.id}');">
                ${perfItemFields(`perf-new-${p.id}`)}
                <button class="btn btn-primary btn-sm" type="submit">Add</button>
              </form>
            </details>
          </div>`;
        }).join('') : '<p class="text-xs text-muted">Nobody is in this department.</p>'}
      </div>
    </div>`);
}

async function perfAddItem(owner, prefix) {
  const item = perfReadItem(prefix);
  if (!item.label) { document.getElementById(`${prefix}-label`)?.focus(); return; }
  try {
    await authorizedJsonRequest('/performance/kpi/items', { method: 'POST', body: JSON.stringify({ ...owner, ...item }) });
    showToast('success', 'KPI added', item.label);
    perfLoadSetup();
  } catch (error) {
    showToast('error', 'Could not add KPI', error.message);
  }
}

async function perfUpdateItem(id) {
  const item = perfReadItem(`perf-item-${id}`);
  try {
    await authorizedJsonRequest(`/performance/kpi/items/${id}`, { method: 'PUT', body: JSON.stringify(item) });
    showToast('success', 'KPI saved', item.label);
    perfLoadSetup();
  } catch (error) {
    showToast('error', 'Could not save KPI', error.message);
  }
}

async function perfRemoveItem(id) {
  if (!confirm('Remove this KPI? Numbers already entered for past months are kept.')) return;
  try {
    await authorizedJsonRequest(`/performance/kpi/items/${id}`, { method: 'DELETE' });
    perfLoadSetup();
  } catch (error) {
    showToast('error', 'Could not remove KPI', error.message);
  }
}

async function perfSetOverride(userId, itemId, hidden, target) {
  try {
    await authorizedJsonRequest('/performance/kpi/overrides', {
      method: 'PUT',
      body: JSON.stringify({ user_id: userId, item_id: itemId, hidden, target: target === '' ? null : Number(target) }),
    });
    const setup = perfState.setup;
    setup.overrides = setup.overrides.filter((o) => !(o.user_id === userId && o.item_id === itemId));
    if (hidden || target !== '') setup.overrides.push({ user_id: userId, item_id: itemId, hidden, target: target === '' ? null : Number(target) });
  } catch (error) {
    showToast('error', 'Not saved', error.message);
  }
}

window.renderPerformancePage = renderPerformancePage;
window.initPerformancePage = initPerformancePage;
