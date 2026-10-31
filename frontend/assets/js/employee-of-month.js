/* ═══════════════════════════════════════════════════════════
   EMPLOYEE OF THE MONTH — a tab beside the peer Evaluation on the Monthly
   Evaluation page (which this file never reads or changes). Everybody votes
   once a month for one colleague, in the month's last five days, answering
   the four questions of the paper form; a ballot can be changed until voting
   closes. The tally and the answers are HR's, Operation's and the super
   admin's only; voter names are the super admin's only.
   Backed by /api/employee-of-month. Loaded before app.js; it leans on app.js
   globals (escapeHtml, authorizedJsonRequest, showToast) read at call time.
   ═══════════════════════════════════════════════════════════ */

const EOTM_QUESTIONS = [
  ['why_chosen', (m) => 'Why did you choose this employee as your Employee of the Month?'],
  ['qualities', (m) => `What qualities or contributions of this employee stood out to you during ${m}?`],
  ['achievement', (m) => 'What specific achievement, action, or contribution did you observe from this employee?'],
  ['why_deserving', (m) => 'Why do you think this employee is deserving of the Employee of the Month recognition?'],
];

const eotmState = {
  tab: 'evaluation',
  current: null,
  results: null,
  resultsMonth: '',
  openNominee: null,
};

// Month name alone ("October") for the questions.
function eotmMonthName(label) {
  return String(label || '').split(' ')[0] || 'this month';
}

async function initEotmTab() {
  try {
    eotmState.current = await authorizedJsonRequest(`/employee-of-month/current?_=${Date.now()}`);
  } catch (error) {
    eotmState.current = null;
  }
  if (eotmState.current?.can_see_results) await eotmLoadResults();
  renderEotmTabs();
  // The page re-renders with the Evaluation side showing; put the tab back.
  if (eotmTabVisible()) eotmSetTab(eotmState.tab);
}

async function eotmLoadResults() {
  try {
    const query = eotmState.resultsMonth ? `month=${encodeURIComponent(eotmState.resultsMonth)}&` : '';
    eotmState.results = await authorizedJsonRequest(`/employee-of-month/results?${query}_=${Date.now()}`);
    eotmState.resultsMonth = eotmState.results.month;
  } catch (error) {
    eotmState.results = null;
    showToast('error', 'Employee of the Month', error.message || 'Could not load the results.');
  }
}

// The tab only shows while voting is open — or always, for those who read
// the results.
function eotmTabVisible() {
  const cur = eotmState.current;
  return !!cur && (cur.window?.open || cur.can_see_results);
}

function renderEotmTabs() {
  const wrap = document.getElementById('eval-page-tabs');
  if (!wrap) return;
  if (!eotmTabVisible()) {
    wrap.style.display = 'none';
    eotmSetTab('evaluation');
    return;
  }
  wrap.style.display = '';
  const tabs = [['evaluation', 'Evaluation'], ['eotm', 'Employee of the Month']];
  wrap.innerHTML = tabs.map(([id, label]) =>
    `<button class="filter-pill ${eotmState.tab === id ? 'active' : ''}" type="button" onclick="eotmSetTab('${id}')">${label}</button>`).join('');
}

function eotmSetTab(tab) {
  eotmState.tab = tab;
  const main = document.getElementById('eval-tab-main');
  const eotm = document.getElementById('eval-tab-eotm');
  if (main) main.style.display = tab === 'evaluation' ? '' : 'none';
  if (eotm) eotm.style.display = tab === 'eotm' ? '' : 'none';
  document.querySelectorAll('#eval-page-tabs .filter-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('onclick') === `eotmSetTab('${tab}')`);
  });
  if (tab === 'eotm') renderEotmBody();
}

function renderEotmBody() {
  const wrap = document.getElementById('eval-tab-eotm');
  if (!wrap) return;
  const cur = eotmState.current;
  if (!cur) {
    wrap.innerHTML = '<div class="card"><div class="empty-state"><h3>Could not load</h3><p>Refresh to try again.</p></div></div>';
    return;
  }
  wrap.innerHTML = `${renderEotmForm(cur)}${cur.can_see_results ? renderEotmResults() : ''}`;
}

function renderEotmForm(cur) {
  const w = cur.window;
  const header = `
    <div class="card-header">
      <div>
        <div class="card-title">Employee of the Month (${escapeHtml(eotmMonthName(w.label).toUpperCase())})</div>
        <div class="card-subtitle">This voting form recognizes the employee who has shown outstanding performance, commitment, teamwork, good attitude, initiative and valuable contribution throughout ${escapeHtml(w.label)}.</div>
      </div>
    </div>`;
  if (!w.open) {
    return `<div class="card" style="margin-bottom:20px;">${header}
      <div class="card-body"><div class="empty-state"><h3>Voting is closed</h3>
      <p>Voting for ${escapeHtml(w.label)} opens ${escapeHtml(w.opens_on)} and closes ${escapeHtml(w.closes_on)}${w.days_until_open ? ` — ${w.days_until_open} day${w.days_until_open === 1 ? '' : 's'} to go` : ''}.</p></div></div></div>`;
  }
  const mine = cur.mine || {};
  const month = eotmMonthName(w.label);
  const options = (cur.roster || []).map((p) =>
    `<option value="${p.id}" ${Number(mine.nominee_id) === p.id ? 'selected' : ''}>${escapeHtml(p.name)}${p.role ? ` — ${escapeHtml(p.role)}` : ''}</option>`).join('');
  return `<div class="card" style="margin-bottom:20px;">${header}
    <div class="card-body">
      <div class="text-muted" style="font-size:var(--fs-small);margin-bottom:16px;">🔒 All responses are confidential and will only be reviewed by HR. Please vote honestly and fairly. Voting closes ${escapeHtml(w.closes_on)}.${cur.mine ? ' You already voted — you can change your vote until then.' : ''}</div>
      <div class="form-group">
        <label class="form-label">Who do you believe deserves to be the Employee of the Month for ${escapeHtml(w.label)}? <span class="required">*</span></label>
        <select class="form-control" id="eotm-nominee">
          <option value="">Select an employee</option>
          ${options}
        </select>
      </div>
      ${EOTM_QUESTIONS.map(([field, question]) => `
      <div class="form-group">
        <label class="form-label">${escapeHtml(question(month))} <span class="required">*</span></label>
        <textarea class="form-control" id="eotm-${field}" rows="3" maxlength="2000" placeholder="Your answer">${escapeHtml(mine[field] || '')}</textarea>
      </div>`).join('')}
      <div style="display:flex;justify-content:flex-end;">
        <button class="btn btn-primary" id="eotm-submit" type="button" onclick="submitEotmVote()">${cur.mine ? 'Update Vote' : 'Submit Vote'}</button>
      </div>
    </div>
  </div>`;
}

async function submitEotmVote() {
  const payload = { nominee_id: Number(document.getElementById('eotm-nominee')?.value || 0) };
  if (!payload.nominee_id) return showToast('error', 'Pick an employee', 'Choose who you are voting for.');
  for (const [field] of EOTM_QUESTIONS) {
    payload[field] = String(document.getElementById(`eotm-${field}`)?.value || '').trim();
    if (!payload[field]) return showToast('error', 'Answer every question', 'All questions are required.');
  }
  const btn = document.getElementById('eotm-submit');
  if (btn) btn.disabled = true;
  try {
    const result = await authorizedJsonRequest('/employee-of-month/vote', { method: 'POST', body: JSON.stringify(payload) });
    eotmState.current.mine = result.mine;
    showToast('success', 'Vote saved', 'Thank you for voting.');
    if (eotmState.current.can_see_results) await eotmLoadResults();
    renderEotmBody();
  } catch (error) {
    showToast('error', 'Vote not saved', error.message || 'Could not save your vote.');
    if (btn) btn.disabled = false;
  }
}

async function changeEotmResultsMonth(month) {
  eotmState.resultsMonth = month;
  eotmState.openNominee = null;
  await eotmLoadResults();
  renderEotmBody();
}

function toggleEotmNominee(id) {
  eotmState.openNominee = eotmState.openNominee === id ? null : id;
  renderEotmBody();
}

function renderEotmResults() {
  const r = eotmState.results;
  if (!r) {
    return '<div class="card"><div class="empty-state"><h3>Results unavailable</h3><p>Refresh to try again.</p></div></div>';
  }
  const top = r.results[0]?.votes || 0;
  const monthSelect = `<select class="form-control" style="width:auto;" onchange="changeEotmResultsMonth(this.value)">
    ${r.months.map((m) => `<option value="${m.month}" ${m.month === r.month ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}
  </select>`;
  const rows = r.results.map((entry) => {
    const pct = r.total_votes ? Math.round((entry.votes / r.total_votes) * 100) : 0;
    const open = eotmState.openNominee === entry.nominee_id;
    const leader = entry.votes === top && top > 0;
    return `
      <tr style="cursor:pointer;" onclick="toggleEotmNominee(${entry.nominee_id})" title="Show the answers">
        <td><strong>${escapeHtml(entry.name)}</strong>${leader ? ' <span class="badge badge-success">Top</span>' : ''}</td>
        <td><strong>${entry.votes}</strong></td>
        <td style="min-width:160px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="flex:1;height:8px;border-radius:4px;background:var(--surface-2,rgba(255,255,255,0.08));overflow:hidden;"><span style="display:block;height:100%;width:${pct}%;background:var(--primary);"></span></div>
            <span class="text-muted" style="font-size:var(--fs-small);">${pct}%</span>
          </div>
        </td>
        <td class="text-muted">${open ? '▲' : '▼'}</td>
      </tr>
      ${open ? `<tr><td colspan="4" style="padding:0 12px 16px;">${entry.ballots.map((b, i) => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-top:10px;">
          <div style="font-size:var(--fs-small);color:var(--text-muted);margin-bottom:8px;">${b.voter ? `From ${escapeHtml(b.voter)}` : `Vote ${i + 1}`}</div>
          ${EOTM_QUESTIONS.map(([field, question]) => `
            <div style="margin-bottom:8px;">
              <div style="font-size:var(--fs-small);font-weight:600;color:var(--text-muted);">${escapeHtml(question(eotmMonthName(r.label)))}</div>
              <div style="white-space:pre-wrap;">${escapeHtml(b[field])}</div>
            </div>`).join('')}
        </div>`).join('')}</td></tr>` : ''}`;
  }).join('');
  return `<div class="card">
    <div class="card-header">
      <div>
        <div class="card-title">Results — ${escapeHtml(r.label)}</div>
        <div class="card-subtitle">${r.total_votes} vote${r.total_votes === 1 ? '' : 's'} cast. Click a name to read the answers.${r.shows_voters ? '' : ' Voters stay anonymous.'}</div>
      </div>
      ${monthSelect}
    </div>
    <div class="card-body" style="padding:0;">
      ${r.results.length ? `<table class="no-cards">
        <thead><tr><th>Employee</th><th>Votes</th><th>Share</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty-state"><h3>No votes yet</h3><p>Votes appear here as they come in.</p></div>'}
    </div>
  </div>`;
}

window.initEotmTab = initEotmTab;
