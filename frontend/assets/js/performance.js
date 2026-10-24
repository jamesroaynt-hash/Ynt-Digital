/* ═══════════════════════════════════════════════════════════
   PERFORMANCE — the two scoring categories beside the peer Evaluation
   (which this page never reads or changes):
     Compliance (Category 2) — Attendance, Standup, EOD, Meditation /
       Self-Care and WAM, worked out from Time & Attendance and the Employee
       Tracker marks, per 15-day half or whole month.
     KPI (Category 3) — each department's KPI template with per-person
       tweaks; HR types in each person's actual number per month, or for a
       daily KPI (CSR total orders) a number every day on Daily Entry — the
       month adds those up against the target, split into a daily target.
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
  dailyDate: '',
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
  if (!perfState.dailyDate) perfState.dailyDate = today;
  renderPerfTabs();
  await perfLoadTab();
}

function renderPerfTabs() {
  const wrap = document.getElementById('perf-tabs');
  if (!wrap) return;
  const tabs = [['compliance', 'Compliance'], ['kpi', 'KPI'], ['daily', 'Daily Entry'], ['setup', 'KPI Setup']];
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
  if (perfState.tab === 'daily') return perfLoadDaily();
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

// Department header line for whole-department KPIs: team sum vs team target.
function perfTeamLine(teams, department, { day = false } = {}) {
  const mine = (teams || []).filter((t) => t.department === department);
  if (!mine.length) return '';
  return mine.map((t) => `<span class="perf-team">${escapeHtml(t.label)}: <strong>${t.total}</strong> / ${t.target}${t.unit ? ` ${escapeHtml(t.unit)}` : ''}
    ${day ? ` · today ${t.day}` : ''} ${perfScoreBadge(t.score)}</span>`).join('');
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
async function perfLoadKpi() {
  let data;
  try {
    data = await authorizedJsonRequest(`/performance/kpi/scores?period=${encodeURIComponent(perfState.kpiMonth)}`);
  } catch (error) {
    perfError(error);
    return;
  }
  if (perfState.tab !== 'kpi') return;
  const options = perfRecentMonths(12).map((ym) => `<option value="${ym}" ${ym === data.period ? 'selected' : ''}>${escapeHtml(perfMonthLabel(ym))}</option>`).join('');
  const groups = perfGroupByDepartment((data.rows || []).filter((r) => r.kpis.length));
  const unit = (k, value) => (value === null || value === undefined ? '' : `${value}${k.unit ? ` ${escapeHtml(k.unit)}` : ''}`);
  perfBody(`
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">KPI · Category 3</div>
          <div class="card-subtitle">Type each person's actual number for the month; it saves when you leave the box. Daily KPIs add up from Daily Entry. Reaching the target = 100% (capped). "Lower is better" KPIs score 100% at or under target. The total is weighted by each KPI's weight.</div>
        </div>
        <select class="form-control perf-select" onchange="perfState.kpiMonth = this.value; perfLoadKpi();">${options}</select>
      </div>
      ${groups.length ? `<div class="table-container"><table class="perf-kpi-table">
        <thead><tr><th>Employee</th><th>KPI</th><th>Target</th><th>Actual</th><th>Score</th><th>Total</th></tr></thead>
        ${groups.map(([department, people]) => `<tbody>
          <tr class="perf-group"><td colspan="6">${escapeHtml(department)} ${perfTeamLine(data.teams, department)}</td></tr>
          ${people.map((p) => p.kpis.map((k, index) => `<tr${index === 0 ? ' class="perf-person-start"' : ''}>
            ${index === 0 ? `<td rowspan="${p.kpis.length}"><strong>${escapeHtml(p.name)}</strong></td>` : ''}
            <td>${escapeHtml(k.label)}${k.personal ? ' <span class="badge badge-gray">personal</span>' : ''}${k.direction === 'lower' ? ' <span class="text-xs text-muted">(lower is better)</span>' : ''}</td>
            <td>${unit(k, k.target)}${k.team_target != null ? ` <span class="text-xs text-muted">of ${k.team_target}</span>` : ''}</td>
            <td>${k.entry === 'daily'
              ? `<strong>${k.actual ?? 0}</strong> <span class="text-xs text-muted" title="Summed from Daily Entry">· ${k.days_entered} day${k.days_entered === 1 ? '' : 's'} entered · ${k.daily_target}/day</span>`
              : `<input class="form-control perf-actual" type="number" step="any" inputmode="decimal" value="${k.actual ?? ''}"
              aria-label="${escapeHtml(`${p.name} — ${k.label} actual`)}"
              onchange="perfSaveActual(${Number(p.id)}, ${Number(k.item_id)}, this.value)">`}</td>
            <td>${perfScoreBadge(k.score)}</td>
            ${index === 0 ? `<td rowspan="${p.kpis.length}">${perfScoreBadge(p.total)}</td>` : ''}
          </tr>`).join('')).join('')}
        </tbody>`).join('')}
      </table></div>` : `<div class="empty-state"><h3>No KPIs yet</h3><p>Add each department's KPIs on the KPI Setup tab.</p>
        <button class="btn btn-primary btn-sm" onclick="perfSetTab('setup')">Open KPI Setup</button></div>`}
    </div>`);
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

// ─── Daily Entry (daily KPIs, e.g. CSR total orders) ─────────
async function perfLoadDaily() {
  let data;
  try {
    data = await authorizedJsonRequest(`/performance/kpi/daily?date=${encodeURIComponent(perfState.dailyDate)}`);
  } catch (error) {
    perfError(error);
    return;
  }
  if (perfState.tab !== 'daily') return;
  const groups = perfGroupByDepartment(data.rows || []);
  const label = new Date(`${data.date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  perfBody(`
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Daily Entry · ${escapeHtml(label)}</div>
          <div class="card-subtitle">Type each person's number for the day (e.g. total orders); it saves when you leave the box. Daily target = monthly target ÷ the person's scheduled days this month.</div>
        </div>
        <div class="perf-date-nav">
          <button class="et-nav" type="button" onclick="perfShiftDaily(-1)" aria-label="Previous day">←</button>
          <input class="form-control" type="date" value="${data.date}" onchange="if (this.value) { perfState.dailyDate = this.value; perfLoadDaily(); }">
          <button class="et-nav" type="button" onclick="perfShiftDaily(1)" aria-label="Next day">→</button>
        </div>
      </div>
      ${groups.length ? `<div class="table-container"><table class="perf-kpi-table">
        <thead><tr><th>Employee</th><th>KPI</th><th>Daily target</th><th>This day</th><th>Month so far</th></tr></thead>
        ${groups.map(([department, people]) => `<tbody>
          <tr class="perf-group"><td colspan="5">${escapeHtml(department)} ${perfTeamLine(data.teams, department, { day: true })}</td></tr>
          ${people.map((p) => p.kpis.map((k, index) => {
            const hit = k.value === null ? '' : (k.direction === 'lower' ? k.value <= k.daily_target : k.value >= k.daily_target) ? 'perf-hit' : 'perf-miss';
            return `<tr${index === 0 ? ' class="perf-person-start"' : ''}>
            ${index === 0 ? `<td rowspan="${p.kpis.length}"><strong>${escapeHtml(p.name)}</strong></td>` : ''}
            <td>${escapeHtml(k.label)}</td>
            <td>${k.daily_target}${k.unit ? ` ${escapeHtml(k.unit)}` : ''}</td>
            <td><input class="form-control perf-actual ${hit}" type="number" step="any" inputmode="decimal" value="${k.value ?? ''}"
              aria-label="${escapeHtml(`${p.name} — ${k.label} on ${data.date}`)}"
              onchange="perfSaveDaily(${Number(p.id)}, ${Number(k.item_id)}, this.value)"></td>
            <td>${k.month_total} / ${k.target}${k.unit ? ` ${escapeHtml(k.unit)}` : ''} <span class="text-xs text-muted">· ${k.days_entered} of ${k.work_days} days</span></td>
          </tr>`;
          }).join('')).join('')}
        </tbody>`).join('')}
      </table></div>` : `<div class="empty-state"><h3>No daily KPIs yet</h3><p>On KPI Setup, add a KPI (e.g. CSR "Total orders") and set it to <strong>Daily entry</strong>.</p>
        <button class="btn btn-primary btn-sm" onclick="perfSetTab('setup')">Open KPI Setup</button></div>`}
    </div>`);
}

function perfShiftDaily(direction) {
  const date = new Date(`${perfState.dailyDate}T00:00:00`);
  date.setDate(date.getDate() + direction);
  perfState.dailyDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  perfLoadDaily();
}

async function perfSaveDaily(userId, itemId, value) {
  try {
    await authorizedJsonRequest('/performance/kpi/daily', {
      method: 'PUT',
      body: JSON.stringify({ date: perfState.dailyDate, user_id: userId, item_id: itemId, value: value === '' ? null : Number(value) }),
    });
    perfLoadDaily();
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
      <option value="daily" ${item.entry === 'daily' ? 'selected' : ''}>Daily entry</option>
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
        <div class="card-subtitle">Each department's KPIs apply to everyone in it. The target is monthly. "Whole-department target" shares it out over the people in the department (e.g. CSR's monthly orders ÷ the CSRs). "Daily entry" KPIs are typed in every day on Daily Entry, with each person's share split per scheduled day. Below, adjust one person: switch a KPI off for them, give them their own target, or add a personal KPI.</div>
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
