/* ═══════════════════════════════════════════════════════════
   EMPLOYEE OF THE MONTH — a tab beside the peer Evaluation on the Monthly
   Evaluation page (which this file never reads or changes). Everybody votes
   once a month for one colleague, in the month's last five days, answering
   the form's questions; a ballot can be changed until voting closes. HR,
   Operation and the Administrators edit the questions and the month being
   voted on. The tally and the answers are HR's, Operation's and the super
   admin's only; voter names are the super admin's only.
   Backed by /api/employee-of-month. Loaded before app.js; it leans on app.js
   globals (escapeHtml, authorizedJsonRequest, showToast) read at call time.
   ═══════════════════════════════════════════════════════════ */

const eotmState = {
  tab: 'evaluation',
  current: null,
  results: null,
  resultsMonth: '',
  openNominee: null,
  // The form editor's rows mid-edit, or null while it is closed.
  editing: null,
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
// the results or edit the form.
function eotmTabVisible() {
  const cur = eotmState.current;
  return !!cur && (cur.window?.open || cur.can_see_results || cur.can_edit_form);
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
  wrap.innerHTML = `${eotmState.editing ? renderEotmEditor() : renderEotmForm(cur)}${cur.can_see_results ? renderEotmResults() : ''}`;
}

function renderEotmForm(cur) {
  const w = cur.window;
  const header = `
    <div class="card-header">
      <div>
        <div class="card-title">Employee of the Month (${escapeHtml(eotmMonthName(w.label).toUpperCase())})</div>
        <div class="card-subtitle">This voting form recognizes the employee who has shown outstanding performance, commitment, teamwork, good attitude, initiative and valuable contribution throughout ${escapeHtml(w.label)}.</div>
      </div>
      ${cur.can_edit_form ? '<button class="btn btn-secondary btn-sm" type="button" onclick="openEotmEditor()">Edit Form</button>' : ''}
    </div>`;
  if (!w.open) {
    return `<div class="card" style="margin-bottom:20px;">${header}
      <div class="card-body"><div class="empty-state"><h3>Voting is closed</h3>
      <p>Voting for ${escapeHtml(w.label)} opens ${escapeHtml(w.opens_on)} and closes ${escapeHtml(w.closes_on)}${w.days_until_open ? ` — ${w.days_until_open} day${w.days_until_open === 1 ? '' : 's'} to go` : ''}.</p></div></div></div>`;
  }
  const mine = cur.mine || {};
  // A ballot sent under different questions only pre-fills where they match.
  const prior = (question, i) => {
    const a = mine.answers?.[i];
    return a && a.question === question ? a.answer : '';
  };
  const options = (cur.roster || []).map((p) =>
    `<option value="${p.id}" ${Number(mine.nominee_id) === p.id ? 'selected' : ''}>${escapeHtml(p.name)}${p.role ? ` — ${escapeHtml(p.role)}` : ''}</option>`).join('');
  return `<div class="card" style="margin-bottom:20px;">${header}
    <div class="card-body">
      <div class="text-muted" style="font-size:var(--fs-small);margin-bottom:16px;">🔒 All responses are confidential and will only be reviewed by HR. Please vote honestly and fairly. Voting closes ${escapeHtml(w.closes_on)}.${cur.mine ? ' You already voted — you can change your vote until then.' : ''}</div>
      <div class="form-group">
        <label class="form-label">${escapeHtml(cur.form.nominee_question)} <span class="required">*</span></label>
        <select class="form-control" id="eotm-nominee">
          <option value="">Select an employee</option>
          ${options}
        </select>
      </div>
      ${cur.form.questions.map((question, i) => `
      <div class="form-group">
        <label class="form-label">${escapeHtml(question)} <span class="required">*</span></label>
        <textarea class="form-control" id="eotm-answer-${i}" rows="3" maxlength="2000" placeholder="Your answer">${escapeHtml(prior(question, i))}</textarea>
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
  payload.answers = eotmState.current.form.questions.map((_, i) => String(document.getElementById(`eotm-answer-${i}`)?.value || '').trim());
  if (payload.answers.some((a) => !a)) return showToast('error', 'Answer every question', 'All questions are required.');
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
          ${b.answers.map((a) => `
            <div style="margin-bottom:8px;">
              <div style="font-size:var(--fs-small);font-weight:600;color:var(--text-muted);">${escapeHtml(a.question)}</div>
              <div style="white-space:pre-wrap;">${escapeHtml(a.answer)}</div>
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

// ─── Form editor (HR, Operation, Administrators) ───────────────
// Questions can carry {month}, which reads as the month being voted on.

function openEotmEditor() {
  const f = eotmState.current?.form_settings;
  if (!f) return;
  eotmState.editing = { month: f.month || '', nominee_question: f.nominee_question, questions: [...f.questions] };
  renderEotmBody();
}

function closeEotmEditor() {
  eotmState.editing = null;
  renderEotmBody();
}

// Keep what was typed before redrawing the rows.
function eotmReadEditor() {
  const e = eotmState.editing;
  e.month = document.getElementById('eotm-edit-month')?.value || '';
  e.nominee_question = document.getElementById('eotm-edit-nominee')?.value || '';
  e.questions = e.questions.map((q, i) => document.getElementById(`eotm-edit-q-${i}`)?.value ?? q);
}

function addEotmQuestion() {
  eotmReadEditor();
  eotmState.editing.questions.push('');
  renderEotmBody();
}

function removeEotmQuestion(index) {
  eotmReadEditor();
  eotmState.editing.questions.splice(index, 1);
  renderEotmBody();
}

function moveEotmQuestion(index, step) {
  eotmReadEditor();
  const q = eotmState.editing.questions;
  const to = index + step;
  if (to < 0 || to >= q.length) return;
  [q[index], q[to]] = [q[to], q[index]];
  renderEotmBody();
}

function renderEotmEditor() {
  const e = eotmState.editing;
  return `<div class="card" style="margin-bottom:20px;">
    <div class="card-header">
      <div>
        <div class="card-title">Edit Employee of the Month Form</div>
        <div class="card-subtitle">Type {month} in a question to show the month being voted on. Votes already sent keep the questions they answered.</div>
      </div>
    </div>
    <div class="card-body">
      <div class="form-group">
        <label class="form-label">Month being voted on</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <input type="month" class="form-control" id="eotm-edit-month" value="${escapeHtml(e.month)}" style="width:auto;">
          <button class="btn btn-ghost btn-sm" type="button" onclick="document.getElementById('eotm-edit-month').value=''">Use running month</button>
        </div>
        <div class="text-muted" style="font-size:var(--fs-small);margin-top:4px;">Empty follows the calendar month. Voting still opens only in the last five days of the month.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Employee question</label>
        <input type="text" class="form-control" id="eotm-edit-nominee" maxlength="500" value="${escapeHtml(e.nominee_question)}">
      </div>
      ${e.questions.map((q, i) => `
      <div class="form-group">
        <label class="form-label">Question ${i + 1}</label>
        <div style="display:flex;gap:6px;align-items:flex-start;">
          <textarea class="form-control" id="eotm-edit-q-${i}" rows="2" maxlength="500">${escapeHtml(q)}</textarea>
          <button class="btn btn-ghost btn-sm" type="button" onclick="moveEotmQuestion(${i}, -1)" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="moveEotmQuestion(${i}, 1)" ${i === e.questions.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="removeEotmQuestion(${i})" ${e.questions.length <= 1 ? 'disabled' : ''} title="Remove">✕</button>
        </div>
      </div>`).join('')}
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm" type="button" onclick="addEotmQuestion()" ${e.questions.length >= 10 ? 'disabled' : ''}>+ Add question</button>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-secondary" type="button" onclick="closeEotmEditor()">Cancel</button>
          <button class="btn btn-primary" id="eotm-edit-save" type="button" onclick="saveEotmForm()">Save Form</button>
        </div>
      </div>
    </div>
  </div>`;
}

async function saveEotmForm() {
  eotmReadEditor();
  const e = eotmState.editing;
  const payload = {
    month: e.month,
    nominee_question: e.nominee_question.trim(),
    questions: e.questions.map((q) => q.trim()).filter(Boolean),
  };
  if (!payload.nominee_question) return showToast('error', 'Employee question needed', 'Type the question for picking the employee.');
  if (!payload.questions.length) return showToast('error', 'Add a question', 'Keep at least one question.');
  const btn = document.getElementById('eotm-edit-save');
  if (btn) btn.disabled = true;
  try {
    await authorizedJsonRequest('/employee-of-month/settings', { method: 'PUT', body: JSON.stringify(payload) });
    eotmState.editing = null;
    eotmState.resultsMonth = '';
    showToast('success', 'Form saved', 'The Employee of the Month form is updated.');
    await initEotmTab();
  } catch (error) {
    showToast('error', 'Form not saved', error.message || 'Could not save the form.');
    if (btn) btn.disabled = false;
  }
}

window.initEotmTab = initEotmTab;
