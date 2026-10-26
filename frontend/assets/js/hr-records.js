/* ═══════════════════════════════════════════════════════════
   HR RECORDS — 201 Files, HR Calendar, Onboarding, KPI Allowance, HR Reports
   Backed by /api/hr-records (HR, Operation and the super admin only).
   Loaded before app.js; every helper it leans on (escapeHtml,
   authorizedJsonRequest, showToast, openModal, manilaToday, employeeDepartment,
   formatPHP…) is a global from app.js, read at call time.
   ═══════════════════════════════════════════════════════════ */

// ─── SHARED ────────────────────────────────────────────────
// What a complete 201 file holds. Completeness counts these documents plus the
// profile fields below, so a file with every paper but no contact number is
// not reported as done.
const HRR_REQUIRED_DOCS = [
  'Employment Contract',
  'NDA',
  'Employment Data Sheet',
  'Job Description',
  'KPI Agreement Form',
  'Consent Form',
  'Pre-employment Requirements',
];
const HRR_DOC_TYPES = [
  ...HRR_REQUIRED_DOCS,
  'Training Notification',
  'Certificate / Affidavit',
  'Other',
];
const HRR_DOC_HINTS = {
  'Employment Contract': 'Expiry tracking · renewals',
  NDA: 'Signed / unsigned status',
  'Employment Data Sheet': 'Employee master source',
  'Job Description': 'Position-linked document',
  'KPI Agreement Form': 'Performance record',
  'Consent Form': 'Acknowledgment tracking',
  'Pre-employment Requirements': 'Checklist + completeness',
  'Training Notification': 'Employee acknowledgment',
  'Certificate / Affidavit': 'Secure 201 attachment',
  Other: 'Anything else for the file',
};
const HRR_DOC_STATUSES = ['Active', 'Signed', 'Complete', 'For Review', 'Missing', 'Expired'];
const HRR_MEMO_TYPES = ['NTE', 'NOD', 'Verbal Warning', 'Written Warning', 'Final Warning', 'Suspension', 'Company Memo', 'Notice'];
const HRR_MEMO_STATUSES = ['Open', 'Answered', 'Closed'];
const HRR_PROFILE_FIELDS = [
  ['birthday', 'Birthday'],
  ['address', 'Address'],
  ['phone_number', 'Phone number'],
  ['email_address', 'Email address'],
];
// A contract inside this many days of its expiry reads as Expiring.
const HRR_EXPIRY_WARN_DAYS = 30;

const hrrState = {
  people: [],
  docs: [],
  loaded: false,
  recordsTab: 'employees',
  selectedUserId: null,
  docFilter: '',
  memoFilter: 'Open',
  search: '',
};

function hrrApi(path, options = {}) {
  const init = { ...options };
  if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
  return authorizedJsonRequest(`/hr-records${path}`, init);
}

async function hrrLoadPeople(force = false) {
  if (hrrState.people.length && !force) return hrrState.people;
  const result = await hrrApi('/people');
  // The super admin is not an employee on file, same as the tracker roster.
  hrrState.people = (result?.people || []).filter((person) => Number(person.is_super_admin) !== 1);
  return hrrState.people;
}

async function hrrLoadDocs() {
  const result = await hrrApi('/documents');
  hrrState.docs = result?.rows || [];
  return hrrState.docs;
}

function hrrPersonName(person) {
  return person?.full_name || person?.username || 'Employee';
}

function hrrPerson(userId) {
  return hrrState.people.find((person) => Number(person.id) === Number(userId)) || null;
}

function hrrActivePeople() {
  return hrrState.people.filter((person) => Number(person.is_active) === 1);
}

function hrrInitials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?';
}

function hrrFormatDate(value) {
  if (!value) return '—';
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return escapeHtml(String(value));
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function hrrDaysUntil(value) {
  if (!value) return null;
  const today = new Date(`${manilaToday()}T00:00:00`);
  const target = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target - today) / 86400000);
}

function hrrPersonOptions(selectedId, { includeInactive = false, blank = '' } = {}) {
  const people = includeInactive ? hrrState.people : hrrActivePeople();
  const options = people.map((person) => `<option value="${Number(person.id)}"${Number(person.id) === Number(selectedId) ? ' selected' : ''}>${escapeHtml(hrrPersonName(person))}${Number(person.is_active) === 1 ? '' : ' (inactive)'}</option>`);
  return `${blank ? `<option value="">${escapeHtml(blank)}</option>` : ''}${options.join('')}`;
}

function hrrOptions(values, selected) {
  return values.map((value) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(value)}</option>`).join('');
}

function hrrLink(url, label = 'Open') {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return '<span class="text-muted">—</span>';
  return `<a href="${escapeHtml(raw)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">${escapeHtml(label)}</a>`;
}

function hrrBadge(status) {
  const value = String(status || '').trim();
  const tone = {
    Active: 'success', Signed: 'success', Complete: 'success', Closed: 'gray', Answered: 'info', Done: 'success',
    'For Review': 'warning', Open: 'warning', Expiring: 'warning', Pending: 'warning', Upcoming: 'info',
    Missing: 'danger', Expired: 'danger', 'Needs Coaching': 'warning', 'Hit Target': 'success',
    Qualified: 'success', 'Not Qualified': 'danger', Released: 'gray', 'Awaiting Evaluation': 'info',
    'In Training': 'info', Graduated: 'success', Dropped: 'gray',
  }[value] || 'gray';
  return value ? `<span class="badge badge-${tone}">${escapeHtml(value)}</span>` : '<span class="text-muted">—</span>';
}

function hrrToastError(error, title = 'Could not save') {
  showToast('error', title, error?.message || 'Please try again.');
}

// ─── 201 COMPLETENESS ──────────────────────────────────────
function hrrDocsFor(userId, kind = 'document') {
  return hrrState.docs.filter((doc) => Number(doc.user_id) === Number(userId) && (doc.kind || 'document') === kind);
}

// A required document counts once it is on file and not marked Missing/Expired.
function hrrFileStatus(person) {
  const docs = hrrDocsFor(person.id);
  const onFile = HRR_REQUIRED_DOCS.filter((type) => docs.some((doc) => doc.doc_type === type
    && !['Missing', 'Expired'].includes(doc.status) && (hrrDaysUntil(doc.expiry_date) ?? 1) >= 0));
  const profile = HRR_PROFILE_FIELDS.filter(([field]) => String(person[field] || '').trim());
  const total = HRR_REQUIRED_DOCS.length + HRR_PROFILE_FIELDS.length;
  const memos = hrrDocsFor(person.id, 'memo');
  return {
    docsOnFile: onFile.length,
    missingDocs: HRR_REQUIRED_DOCS.filter((type) => !onFile.includes(type)),
    missingProfile: HRR_PROFILE_FIELDS.filter(([field]) => !String(person[field] || '').trim()).map(([, label]) => label),
    completeness: Math.round(((onFile.length + profile.length) / total) * 100),
    contract: hrrContractStatus(docs),
    openMemos: memos.filter((memo) => (memo.status || 'Open') === 'Open').length,
    memos: memos.length,
  };
}

function hrrContractStatus(docs) {
  const contracts = docs.filter((doc) => doc.doc_type === 'Employment Contract')
    .sort((a, b) => String(b.issue_date || '').localeCompare(String(a.issue_date || '')));
  const latest = contracts[0];
  if (!latest) return 'Missing';
  const days = hrrDaysUntil(latest.expiry_date);
  if (days !== null && days < 0) return 'Expired';
  if (days !== null && days <= HRR_EXPIRY_WARN_DAYS) return 'Expiring';
  return latest.status === 'For Review' ? 'For Review' : 'Active';
}

// A document's status as read today: a lapsed expiry beats whatever was typed.
function hrrEffectiveDocStatus(doc) {
  const days = hrrDaysUntil(doc.expiry_date);
  if (doc.kind === 'memo') return doc.status || 'Open';
  if (days !== null && days < 0) return 'Expired';
  if (days !== null && days <= HRR_EXPIRY_WARN_DAYS && doc.doc_type === 'Employment Contract') return 'Expiring';
  return doc.status || 'Active';
}

// ─── 201 FILES PAGE ────────────────────────────────────────
function renderHrRecordsPage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>201 Files</h1>
      <p>Employee records, documents and contracts, memos — one file per employee.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="initHrRecordsPage(true)">Refresh</button>
      <button class="btn btn-secondary btn-sm" onclick="openHrrDocModal({ kind: 'memo' })">+ New Memo</button>
      <button class="btn btn-primary btn-sm" onclick="openHrrDocModal({ kind: 'document' })">+ Add Document</button>
    </div>
  </div>
  <div class="tabs" id="hrr-tabs">
    ${[['employees', 'Employee Records'], ['documents', 'Documents & Contracts'], ['memos', 'Memos / Disciplinary']].map(([id, label]) =>
      `<button class="tab-btn${hrrState.recordsTab === id ? ' active' : ''}" onclick="setHrrRecordsTab('${id}')">${label}</button>`).join('')}
  </div>
  <div id="hrr-root"><div class="card"><div class="empty-state"><h3>Loading 201 files</h3><p>Pulling employees and documents.</p></div></div></div>
  ${renderHrrDocModal()}`;
}

async function initHrRecordsPage(force = false) {
  try {
    await Promise.all([hrrLoadPeople(force), hrrLoadDocs()]);
    hrrState.loaded = true;
  } catch (error) {
    const root = document.getElementById('hrr-root');
    if (root) root.innerHTML = `<div class="card"><div class="empty-state"><h3>Could not load 201 files</h3><p>${escapeHtml(error.message || 'error')}</p></div></div>`;
    return;
  }
  renderHrrRecordsBody();
}

function setHrrRecordsTab(tab) {
  hrrState.recordsTab = tab;
  document.querySelectorAll('#hrr-tabs .tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', ['employees', 'documents', 'memos'][i] === tab);
  });
  renderHrrRecordsBody();
}

function renderHrrRecordsBody() {
  const root = document.getElementById('hrr-root');
  if (!root || !hrrState.loaded) return;
  if (hrrState.recordsTab === 'documents') root.innerHTML = renderHrrDocumentsTab();
  else if (hrrState.recordsTab === 'memos') root.innerHTML = renderHrrMemosTab();
  else root.innerHTML = renderHrrEmployeesTab();
}

function renderHrrEmployeesTab() {
  const query = hrrState.search.trim().toLowerCase();
  const people = hrrActivePeople().filter((person) => !query
    || hrrPersonName(person).toLowerCase().includes(query)
    || employeeDepartment(person).toLowerCase().includes(query));
  const selected = hrrPerson(hrrState.selectedUserId);
  return `
  ${selected ? renderHrrProfile(selected) : ''}
  <div class="card">
    <div class="card-header">
      <div>
        <div class="card-title">Employee Records</div>
        <div class="card-subtitle">201 completeness counts the ${HRR_REQUIRED_DOCS.length} required documents plus birthday, address, phone and email. Click a row to open the file.</div>
      </div>
      <input type="search" class="form-control" style="max-width:240px;" placeholder="Search name or department" value="${escapeHtml(hrrState.search)}" oninput="hrrState.search=this.value; hrrRefreshRosterTable()">
    </div>
    <div class="card-body" id="hrr-roster-wrap">${renderHrrRosterTable(people)}</div>
  </div>`;
}

function hrrRefreshRosterTable() {
  const wrap = document.getElementById('hrr-roster-wrap');
  if (!wrap) return;
  const query = hrrState.search.trim().toLowerCase();
  wrap.innerHTML = renderHrrRosterTable(hrrActivePeople().filter((person) => !query
    || hrrPersonName(person).toLowerCase().includes(query)
    || employeeDepartment(person).toLowerCase().includes(query)));
}

function renderHrrRosterTable(people) {
  if (!people.length) return '<div class="empty-state"><h3>No employees</h3><p>Nobody matches that search.</p></div>';
  return `
  <div class="table-container"><table>
    <thead><tr><th>Employee</th><th>Department</th><th>201 Completeness</th><th>Documents</th><th>Contract</th><th>Open Memos</th></tr></thead>
    <tbody>
      ${people.map((person) => {
        const file = hrrFileStatus(person);
        const tone = file.completeness >= 90 ? 'var(--success)' : file.completeness >= 60 ? 'var(--warning)' : 'var(--danger)';
        return `<tr style="cursor:pointer;" onclick="selectHrrEmployee(${Number(person.id)})">
          <td><strong>${escapeHtml(hrrPersonName(person))}</strong></td>
          <td>${escapeHtml(employeeDepartment(person))}</td>
          <td><div class="hrr-meter"><span style="width:${file.completeness}%;background:${tone};"></span></div><span class="text-xs">${file.completeness}%</span></td>
          <td>${file.docsOnFile} / ${HRR_REQUIRED_DOCS.length}</td>
          <td>${hrrBadge(file.contract)}</td>
          <td>${file.openMemos ? `<span class="badge badge-warning">${file.openMemos}</span>` : '0'}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;
}

function selectHrrEmployee(userId) {
  hrrState.selectedUserId = Number(userId) || null;
  hrrState.profileTab = 'documents';
  renderHrrRecordsBody();
  document.getElementById('hrr-profile')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  hrrLoadProfileExtras(userId).catch(() => {});
}

function renderHrrProfile(person) {
  const file = hrrFileStatus(person);
  const tab = hrrState.profileTab || 'documents';
  const docs = hrrDocsFor(person.id);
  const memos = hrrDocsFor(person.id, 'memo');
  const tabs = [['documents', `Documents (${docs.length})`], ['memos', `Memos (${memos.length})`], ['personal', 'Personal Info'], ['work', 'Attendance & Payroll']];
  let body = '';
  if (tab === 'memos') body = renderHrrDocTable(memos, { memo: true, showEmployee: false });
  else if (tab === 'personal') body = renderHrrPersonal(person, file);
  else if (tab === 'work') body = '<div id="hrr-profile-work"><div class="empty-state"><p>Loading this cutoff…</p></div></div>';
  else {
    body = `${file.missingDocs.length ? `<div class="hrr-callout">Missing from the file: ${file.missingDocs.map((type) => `<button class="hrr-chip" onclick="openHrrDocModal({ kind: 'document', user_id: ${Number(person.id)}, doc_type: '${escapeHtml(type)}' })">+ ${escapeHtml(type)}</button>`).join(' ')}</div>` : ''}
      ${renderHrrDocTable(docs, { memo: false, showEmployee: false })}`;
  }
  return `
  <div class="card" id="hrr-profile" style="margin-bottom:20px;">
    <div class="card-header">
      <div class="hrr-person-head">
        <div class="hrr-avatar">${escapeHtml(hrrInitials(hrrPersonName(person)))}</div>
        <div>
          <div class="card-title">${escapeHtml(hrrPersonName(person))}</div>
          <div class="card-subtitle">${escapeHtml(person.role || 'No role')} · ${escapeHtml(employeeDepartment(person))} · ${Number(person.is_active) === 1 ? 'Active' : 'Inactive'}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm" onclick="openHrrDocModal({ kind: 'memo', user_id: ${Number(person.id)} })">+ Memo</button>
        <button class="btn btn-primary btn-sm" onclick="openHrrDocModal({ kind: 'document', user_id: ${Number(person.id)} })">+ Document</button>
        <button class="btn btn-secondary btn-sm" onclick="selectHrrEmployee(null)">Close</button>
      </div>
    </div>
    <div class="card-body">
      <div class="hrr-ministats">
        <div><span>201 Completeness</span><b>${file.completeness}%</b></div>
        <div><span>Documents</span><b>${file.docsOnFile} / ${HRR_REQUIRED_DOCS.length}</b></div>
        <div><span>Contract</span><b>${hrrBadge(file.contract)}</b></div>
        <div><span>Open Memos</span><b>${file.openMemos}</b></div>
      </div>
      <div class="hrr-subtabs">
        ${tabs.map(([id, label]) => `<button class="filter-pill${tab === id ? ' active' : ''}" onclick="setHrrProfileTab('${id}')">${escapeHtml(label)}</button>`).join('')}
      </div>
      ${body}
    </div>
  </div>`;
}

function setHrrProfileTab(tab) {
  hrrState.profileTab = tab;
  renderHrrRecordsBody();
  if (tab === 'work') hrrLoadProfileExtras(hrrState.selectedUserId).catch(() => {});
}

function renderHrrPersonal(person, file) {
  const dayOff = Number(person.day_off);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const rows = [
    ['Full name', hrrPersonName(person)],
    ['Username', person.username],
    ['Role', person.role],
    ['Department', employeeDepartment(person)],
    ['Birthday', person.birthday ? hrrFormatDate(person.birthday) : ''],
    ['Address', person.address],
    ['Phone number', person.phone_number],
    ['Email address', person.email_address],
    ['Facebook account', person.fb_account_name],
    ['Rest day', dayOff >= 0 && dayOff <= 6 ? days[dayOff] : ''],
    ['Account created', person.created_at ? hrrFormatDate(person.created_at) : ''],
  ];
  return `
  ${file.missingProfile.length ? `<div class="hrr-callout">Not on the account yet: ${escapeHtml(file.missingProfile.join(', '))}. These are edited on the employee's account (Users) or their own profile.</div>` : ''}
  <div class="table-container"><table>
    <tbody>${rows.map(([label, value]) => `<tr><th style="width:220px;">${escapeHtml(label)}</th><td>${value ? escapeHtml(String(value)) : '<span class="text-muted">—</span>'}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

// The Attendance & Payroll tab reads the running cutoff from the HR endpoints
// rather than keeping a copy: payroll stays computed in one place.
async function hrrLoadProfileExtras(userId) {
  const wrap = document.getElementById('hrr-profile-work');
  if (!wrap || !userId) return;
  const [from, to] = hrrCurrentCutoff();
  const [summary, leaves] = await Promise.all([
    authorizedJsonRequest(`/hr/summary?from=${from}&to=${to}&user_id=${Number(userId)}&status=all`).catch(() => null),
    authorizedJsonRequest(`/hr/leave-requests?from=2000-01-01&to=2999-12-31&user_id=${Number(userId)}&status=all`).catch(() => null),
  ]);
  const row = (summary?.summary || []).find((item) => Number(item.user?.id) === Number(userId));
  const leaveRows = (leaves?.requests || []).filter((item) => Number(item.user_id) === Number(userId));
  if (!document.getElementById('hrr-profile-work')) return;
  wrap.innerHTML = `
    <div class="hrr-ministats">
      <div><span>Cutoff</span><b>${escapeHtml(hrrFormatDate(from))} – ${escapeHtml(hrrFormatDate(to))}</b></div>
      <div><span>Days Worked</span><b>${row ? escapeHtml(String(row.days_worked)) : '—'}</b></div>
      <div><span>Gross Pay</span><b>${row ? formatPHP(row.gross_pay) : '—'}</b></div>
      <div><span>Net Pay</span><b>${row ? formatPHP(row.net_pay) : '—'}</b></div>
    </div>
    <div class="card-subtitle" style="margin:12px 0 8px;">Leave history</div>
    ${leaveRows.length ? `<div class="table-container"><table>
      <thead><tr><th>Type</th><th>From</th><th>To</th><th>Reason</th><th>Status</th></tr></thead>
      <tbody>${leaveRows.map((leave) => `<tr><td>${escapeHtml(leave.leave_type || '')}</td><td>${hrrFormatDate(leave.leave_date_from)}</td><td>${hrrFormatDate(leave.leave_date_to)}</td><td>${escapeHtml(leave.reason || '')}</td><td>${hrrBadge(String(leave.status || '').replace(/^./, (c) => c.toUpperCase()))}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty-state"><p>No leave requests on file.</p></div>'}
    <p class="text-xs text-muted" style="margin-top:10px;">Full payroll and payslips stay on HR &amp; Payroll; attendance on the Attendance Log.</p>`;
}

function hrrCurrentCutoff(today = manilaToday()) {
  const ym = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const [year, month] = ym.split('-').map(Number);
  const last = new Date(year, month, 0).getDate();
  return day <= 15 ? [`${ym}-01`, `${ym}-15`] : [`${ym}-16`, `${ym}-${String(last).padStart(2, '0')}`];
}

function renderHrrDocTable(rows, { memo = false, showEmployee = true } = {}) {
  if (!rows.length) {
    return `<div class="empty-state"><h3>${memo ? 'No memos' : 'No documents'}</h3><p>${memo ? 'Memos filed for this employee land here.' : 'Add a document and link its Google Drive file.'}</p></div>`;
  }
  return `
  <div class="table-container"><table>
    <thead><tr>${showEmployee ? '<th>Employee</th>' : ''}<th>${memo ? 'Type' : 'Document'}</th><th>Title</th><th>Status</th><th>Issue Date</th><th>${memo ? 'Due / Review' : 'Expiry / Review'}</th><th>File</th><th></th></tr></thead>
    <tbody>
      ${rows.map((doc) => {
        const days = hrrDaysUntil(doc.expiry_date);
        const dueNote = days === null ? '' : days < 0 ? ` <span class="text-xs" style="color:var(--danger);">(${Math.abs(days)}d ago)</span>` : days <= HRR_EXPIRY_WARN_DAYS ? ` <span class="text-xs" style="color:var(--warning-text);">(in ${days}d)</span>` : '';
        return `<tr>
          ${showEmployee ? `<td><a href="#" onclick="event.preventDefault(); hrrState.recordsTab='employees'; setHrrRecordsTab('employees'); selectHrrEmployee(${Number(doc.user_id)})"><strong>${escapeHtml(hrrPersonName(hrrPerson(doc.user_id)))}</strong></a></td>` : ''}
          <td>${escapeHtml(doc.doc_type || '')}</td>
          <td>${escapeHtml(doc.title || '')}${doc.remarks ? `<div class="text-xs text-muted">${escapeHtml(doc.remarks)}</div>` : ''}</td>
          <td>${hrrBadge(hrrEffectiveDocStatus(doc))}</td>
          <td>${hrrFormatDate(doc.issue_date)}</td>
          <td>${hrrFormatDate(doc.expiry_date)}${dueNote}</td>
          <td>${hrrLink(doc.file_url, 'View')}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-secondary btn-sm" onclick="openHrrDocModal({ id: ${Number(doc.id)} })">Edit</button>
            <button class="btn btn-ghost btn-sm" onclick="deleteHrrDoc(${Number(doc.id)})" title="Delete">×</button>
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;
}

function renderHrrDocumentsTab() {
  const active = hrrActivePeople();
  const docs = hrrState.docs.filter((doc) => (doc.kind || 'document') === 'document');
  const filtered = hrrState.docFilter ? docs.filter((doc) => doc.doc_type === hrrState.docFilter) : docs;
  const expiring = docs.filter((doc) => {
    const days = hrrDaysUntil(doc.expiry_date);
    return days !== null && days <= HRR_EXPIRY_WARN_DAYS;
  });
  return `
  <div class="hrr-docgrid">
    ${HRR_DOC_TYPES.filter((type) => type !== 'Other').map((type) => {
      const holders = new Set(docs.filter((doc) => doc.doc_type === type).map((doc) => Number(doc.user_id)));
      const required = HRR_REQUIRED_DOCS.includes(type);
      const onFile = active.filter((person) => holders.has(Number(person.id))).length;
      return `<button type="button" class="hrr-doc${hrrState.docFilter === type ? ' active' : ''}" onclick="hrrState.docFilter = hrrState.docFilter === '${escapeHtml(type)}' ? '' : '${escapeHtml(type)}'; renderHrrRecordsBody()">
        <span class="hrr-docname">${escapeHtml(type)}</span>
        <span class="hrr-docmeta">${escapeHtml(HRR_DOC_HINTS[type] || '')}</span>
        <span class="hrr-docmeta"><b>${onFile}</b> of ${active.length} employees${required ? '' : ' · optional'}</span>
      </button>`;
    }).join('')}
  </div>
  ${expiring.length ? `<div class="hrr-callout">${expiring.length} document${expiring.length === 1 ? '' : 's'} expired or expiring within ${HRR_EXPIRY_WARN_DAYS} days — they are on the HR Calendar too.</div>` : ''}
  <div class="card">
    <div class="card-header">
      <div>
        <div class="card-title">${hrrState.docFilter ? escapeHtml(hrrState.docFilter) : 'All documents'}</div>
        <div class="card-subtitle">Every document here is saved under the employee's 201 record. Files are linked from Google Drive.</div>
      </div>
      <select class="form-control" style="max-width:240px;" onchange="hrrState.docFilter=this.value; renderHrrRecordsBody()">
        <option value="">All document types</option>${hrrOptions(HRR_DOC_TYPES, hrrState.docFilter)}
      </select>
    </div>
    <div class="card-body">${renderHrrDocTable(filtered, { memo: false, showEmployee: true })}</div>
  </div>`;
}

function renderHrrMemosTab() {
  const memos = hrrState.docs.filter((doc) => doc.kind === 'memo');
  const filtered = hrrState.memoFilter ? memos.filter((memo) => (memo.status || 'Open') === hrrState.memoFilter) : memos;
  return `
  <div class="card">
    <div class="card-header">
      <div>
        <div class="card-title">Memos / Disciplinary</div>
        <div class="card-subtitle">NTE, NOD, warnings and company memos. Every memo also shows inside the employee's 201 file.</div>
      </div>
      <span style="display:flex;gap:6px;flex-wrap:wrap;">
        ${[['Open', 'Open'], ['Answered', 'Answered'], ['Closed', 'Closed'], ['', 'All']].map(([value, label]) => {
          const count = value ? memos.filter((memo) => (memo.status || 'Open') === value).length : memos.length;
          return `<button class="filter-pill${hrrState.memoFilter === value ? ' active' : ''}" onclick="hrrState.memoFilter='${value}'; renderHrrRecordsBody()">${label} (${count})</button>`;
        }).join('')}
      </span>
    </div>
    <div class="card-body">${renderHrrDocTable(filtered, { memo: true, showEmployee: true })}</div>
  </div>`;
}

function renderHrrDocModal() {
  return `
  <div class="modal-overlay" id="hrr-doc-modal">
    <div class="modal" style="max-width:620px;">
      <div class="modal-header">
        <div class="modal-title" id="hrr-doc-title">Document</div>
        <button class="modal-close" onclick="closeModal('hrr-doc-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <form onsubmit="saveHrrDoc(event)">
          <input type="hidden" id="hrr-doc-id">
          <input type="hidden" id="hrr-doc-kind">
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Employee</label><select id="hrr-doc-user" class="form-control" required></select></div>
            <div class="form-group"><label class="form-label" id="hrr-doc-type-label">Document Type</label><select id="hrr-doc-type" class="form-control" required></select></div>
          </div>
          <div class="form-group"><label class="form-label">Title</label><input type="text" id="hrr-doc-name" class="form-control" placeholder="e.g. Contract 2026–2027, NTE — tardiness"></div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Status</label><select id="hrr-doc-status" class="form-control"></select></div>
            <div class="form-group"><label class="form-label">Issue Date</label><input type="date" id="hrr-doc-issue" class="form-control"></div>
          </div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label" id="hrr-doc-expiry-label">Expiry / Review Date</label><input type="date" id="hrr-doc-expiry" class="form-control"></div>
            <div class="form-group"><label class="form-label">File link (Google Drive)</label><input type="url" id="hrr-doc-url" class="form-control" placeholder="https://drive.google.com/…"></div>
          </div>
          <div class="form-group"><label class="form-label">Remarks</label><textarea id="hrr-doc-remarks" class="form-control" rows="3"></textarea></div>
          <div style="display:flex;gap:8px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">Save</button>
            <button type="button" class="btn btn-secondary" onclick="closeModal('hrr-doc-modal')">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

async function openHrrDocModal(preset = {}) {
  if (!document.getElementById('hrr-doc-modal')) return;
  try { await hrrLoadPeople(); } catch (error) { hrrToastError(error, 'Could not load employees'); return; }
  const existing = preset.id ? hrrState.docs.find((doc) => Number(doc.id) === Number(preset.id)) : null;
  const doc = { ...(existing || {}), ...preset };
  const kind = doc.kind === 'memo' ? 'memo' : 'document';
  const memo = kind === 'memo';
  document.getElementById('hrr-doc-title').textContent = `${existing ? 'Edit' : 'New'} ${memo ? 'Memo' : 'Document'}`;
  document.getElementById('hrr-doc-type-label').textContent = memo ? 'Memo Type' : 'Document Type';
  document.getElementById('hrr-doc-expiry-label').textContent = memo ? 'Due / Review Date' : 'Expiry / Review Date';
  document.getElementById('hrr-doc-id').value = existing ? existing.id : '';
  document.getElementById('hrr-doc-kind').value = kind;
  document.getElementById('hrr-doc-user').innerHTML = hrrPersonOptions(doc.user_id ?? hrrState.selectedUserId, { includeInactive: !!existing, blank: 'Select employee' });
  document.getElementById('hrr-doc-type').innerHTML = hrrOptions(memo ? HRR_MEMO_TYPES : HRR_DOC_TYPES, doc.doc_type || (memo ? 'NTE' : 'Employment Contract'));
  document.getElementById('hrr-doc-status').innerHTML = hrrOptions(memo ? HRR_MEMO_STATUSES : HRR_DOC_STATUSES, doc.status || (memo ? 'Open' : 'Active'));
  document.getElementById('hrr-doc-name').value = doc.title || '';
  document.getElementById('hrr-doc-issue').value = doc.issue_date || (existing ? '' : manilaToday());
  document.getElementById('hrr-doc-expiry').value = doc.expiry_date || '';
  document.getElementById('hrr-doc-url').value = doc.file_url || '';
  document.getElementById('hrr-doc-remarks').value = doc.remarks || '';
  openModal('hrr-doc-modal');
}

async function saveHrrDoc(event) {
  event.preventDefault();
  const id = document.getElementById('hrr-doc-id').value;
  const body = {
    user_id: document.getElementById('hrr-doc-user').value,
    kind: document.getElementById('hrr-doc-kind').value,
    doc_type: document.getElementById('hrr-doc-type').value,
    title: document.getElementById('hrr-doc-name').value,
    status: document.getElementById('hrr-doc-status').value,
    issue_date: document.getElementById('hrr-doc-issue').value,
    expiry_date: document.getElementById('hrr-doc-expiry').value,
    file_url: document.getElementById('hrr-doc-url').value,
    remarks: document.getElementById('hrr-doc-remarks').value,
  };
  if (!body.user_id) { showToast('warning', 'Pick an employee', 'The document is filed under an employee.'); return; }
  try {
    await hrrApi(id ? `/documents/${id}` : '/documents', { method: id ? 'PUT' : 'POST', body });
    closeModal('hrr-doc-modal');
    showToast('success', 'Saved', `${body.doc_type} saved to the 201 file.`);
    await hrrLoadDocs();
    renderHrrRecordsBody();
  } catch (error) {
    hrrToastError(error);
  }
}

async function deleteHrrDoc(id) {
  const doc = hrrState.docs.find((row) => Number(row.id) === Number(id));
  if (!doc || !confirm(`Delete ${doc.doc_type}${doc.title ? ` — ${doc.title}` : ''} from ${hrrPersonName(hrrPerson(doc.user_id))}'s file?`)) return;
  try {
    await hrrApi(`/documents/${Number(id)}`, { method: 'DELETE' });
    await hrrLoadDocs();
    renderHrrRecordsBody();
  } catch (error) {
    hrrToastError(error, 'Could not delete');
  }
}

// ─── HR CALENDAR ───────────────────────────────────────────
const HRR_CAL_CATEGORIES = ['Payroll', 'Bill / Payment', 'HR Task', 'Birthday', 'Evaluation', 'Contract / Document', 'Schedule', 'Meeting'];
const HRR_CAL_REPEATS = [['none', 'Does not repeat'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['cutoff', 'Every payroll cutoff (15th & end)'], ['yearly', 'Yearly']];
// Sources the page derives on its own; each can be switched off.
const HRR_CAL_AUTO = [
  ['payroll', 'Payroll cutoffs'],
  ['birthdays', 'Birthdays'],
  ['leaves', 'Approved leaves'],
  ['documents', 'Contract / memo dates'],
];

const hrrCalState = { month: '', events: [], leaves: [], show: { payroll: true, birthdays: true, leaves: true, documents: true } };

function renderHrCalendarPage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>HR Calendar</h1>
      <p>Payroll, bills, deadlines, birthdays and HR tasks. Click any date to add an event.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-primary btn-sm" onclick="openHrrEventModal({})">+ Add Event</button>
    </div>
  </div>
  <div class="hrr-cal-layout">
    <div class="card" id="hrr-cal-card"><div class="empty-state"><h3>Loading calendar</h3></div></div>
    <div class="card" id="hrr-cal-upcoming"></div>
  </div>
  ${renderHrrEventModal()}`;
}

async function initHrCalendarPage() {
  if (!hrrCalState.month) hrrCalState.month = manilaToday().slice(0, 7);
  try {
    await Promise.all([hrrLoadPeople(), hrrLoadDocs()]);
  } catch {}
  await hrrLoadCalendarMonth();
}

async function hrrLoadCalendarMonth() {
  const [from, to] = hrrMonthRange(hrrCalState.month);
  // The upcoming list looks two weeks past today, which can run past the month.
  const upTo = hrrAddDays(manilaToday(), 14) > to ? hrrAddDays(manilaToday(), 14) : to;
  const [events, leaves] = await Promise.all([
    hrrApi(`/calendar?from=${from}&to=${upTo}`).catch(() => null),
    authorizedJsonRequest(`/hr/leave-requests?from=${from}&to=${upTo}&status=all`).catch(() => null),
  ]);
  hrrCalState.events = events?.rows || [];
  hrrCalState.leaves = (leaves?.requests || []).filter((leave) => leave.status === 'approved');
  renderHrrCalendar();
}

function hrrMonthRange(ym) {
  const [year, month] = ym.split('-').map(Number);
  const last = new Date(year, month, 0).getDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
}

function hrrYmd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function hrrAddDays(ymd, days) {
  const date = new Date(`${ymd}T00:00:00`);
  date.setDate(date.getDate() + days);
  return hrrYmd(date);
}

function hrrLastDayOf(ymd) {
  const [year, month] = ymd.slice(0, 7).split('-').map(Number);
  return new Date(year, month, 0).getDate();
}

// Does a stored event land on `day`? One-off events on their date; repeating
// ones on every matching date from their start onward.
function hrrEventOn(event, day) {
  const start = String(event.event_date || '');
  if (!start || day < start) return false;
  const rule = event.repeat_rule || 'none';
  if (rule === 'none') return day === start;
  const d = Number(day.slice(8, 10));
  const last = hrrLastDayOf(day);
  if (rule === 'weekly') return new Date(`${day}T00:00:00`).getDay() === new Date(`${start}T00:00:00`).getDay();
  if (rule === 'monthly') return d === Math.min(Number(start.slice(8, 10)), last);
  if (rule === 'cutoff') return d === 15 || d === last;
  if (rule === 'yearly') {
    if (day.slice(5, 7) !== start.slice(5, 7)) return false;
    return d === Math.min(Number(start.slice(8, 10)), last);
  }
  return false;
}

function hrrCalendarItemsOn(day) {
  const items = [];
  hrrCalState.events.filter((event) => hrrEventOn(event, day)).forEach((event) => {
    items.push({ id: event.id, tone: hrrCategoryTone(event.category), title: event.title, meta: [event.category, event.amount ? formatPHP(event.amount) : '', event.user_id ? hrrPersonName(hrrPerson(event.user_id)) : ''].filter(Boolean).join(' · '), status: event.status });
  });
  const show = hrrCalState.show;
  const d = Number(day.slice(8, 10));
  if (show.payroll && (d === 15 || d === hrrLastDayOf(day))) {
    items.push({ auto: true, tone: 'payroll', title: 'PAYROLL CUTOFF', meta: d === 15 ? '1st–15th' : '16th–end' });
  }
  if (show.birthdays) {
    hrrActivePeople().filter((person) => person.birthday && String(person.birthday).slice(5, 10) === day.slice(5, 10)).forEach((person) => {
      items.push({ auto: true, tone: 'birthday', title: 'EMPLOYEE BIRTHDAY', meta: hrrPersonName(person) });
    });
  }
  if (show.leaves) {
    hrrCalState.leaves.filter((leave) => leave.leave_date_from <= day && leave.leave_date_to >= day).forEach((leave) => {
      items.push({ auto: true, tone: 'leave', title: `ON LEAVE`, meta: `${leave.full_name || leave.username || ''} · ${leave.leave_type || ''}` });
    });
  }
  if (show.documents) {
    hrrState.docs.filter((doc) => doc.expiry_date === day && (doc.kind === 'memo' ? (doc.status || 'Open') === 'Open' : true)).forEach((doc) => {
      items.push({ auto: true, tone: 'document', title: doc.kind === 'memo' ? `${doc.doc_type} DUE` : `${doc.doc_type} EXPIRES`.toUpperCase(), meta: hrrPersonName(hrrPerson(doc.user_id)) });
    });
  }
  return items;
}

function hrrCategoryTone(category) {
  return { Payroll: 'payroll', 'Bill / Payment': 'bill', Birthday: 'birthday', Evaluation: 'evaluation', 'Contract / Document': 'document', Schedule: 'schedule' }[category] || 'task';
}

function renderHrrCalendar() {
  const card = document.getElementById('hrr-cal-card');
  if (!card) return;
  const ym = hrrCalState.month;
  const [year, month] = ym.split('-').map(Number);
  const first = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0).getDate();
  const today = manilaToday();
  const cells = [];
  for (let i = 0; i < first.getDay(); i += 1) cells.push('<td class="hrr-calday empty"></td>');
  for (let d = 1; d <= lastDay; d += 1) {
    const day = `${ym}-${String(d).padStart(2, '0')}`;
    const items = hrrCalendarItemsOn(day);
    cells.push(`<td class="hrr-calday${day === today ? ' today' : ''}" onclick="if(event.target===this||event.target.classList.contains('hrr-daynum'))openHrrEventModal({ event_date: '${day}' })">
      <div class="hrr-daynum">${d}</div>
      ${items.map((item) => `<div class="hrr-cal-event ${item.tone}${item.status === 'Done' ? ' done' : ''}"${item.auto ? '' : ` onclick="openHrrEventModal({ id: ${Number(item.id)} })"`} title="${escapeHtml(item.meta || '')}"><b>${escapeHtml(item.title)}</b>${item.meta ? `<span>${escapeHtml(item.meta)}</span>` : ''}</div>`).join('')}
      <button class="hrr-addcal" onclick="event.stopPropagation(); openHrrEventModal({ event_date: '${day}' })">+ Add</button>
    </td>`);
  }
  while (cells.length % 7) cells.push('<td class="hrr-calday empty"></td>');
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(`<tr>${cells.slice(i, i + 7).join('')}</tr>`);
  const label = first.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  card.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-title">${escapeHtml(label)}</div>
        <div class="card-subtitle">Payroll cutoffs, birthdays, approved leaves and contract dates fill in on their own.</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        ${HRR_CAL_AUTO.map(([key, text]) => `<label class="hrr-toggle"><input type="checkbox"${hrrCalState.show[key] ? ' checked' : ''} onchange="hrrCalState.show['${key}']=this.checked; renderHrrCalendar()"> ${escapeHtml(text)}</label>`).join('')}
        <button class="et-nav" onclick="shiftHrrCalendar(-1)" aria-label="Previous month">←</button>
        <button class="btn btn-secondary btn-sm" onclick="hrrCalState.month='${today.slice(0, 7)}'; hrrLoadCalendarMonth()">Today</button>
        <button class="et-nav" onclick="shiftHrrCalendar(1)" aria-label="Next month">→</button>
      </div>
    </div>
    <div class="card-body">
      <div class="table-scroll"><table class="hrr-calendar">
        <thead><tr>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => `<th>${day}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table></div>
    </div>`;
  renderHrrUpcoming();
}

function renderHrrUpcoming() {
  const wrap = document.getElementById('hrr-cal-upcoming');
  if (!wrap) return;
  const today = manilaToday();
  const days = Array.from({ length: 15 }, (_, i) => hrrAddDays(today, i));
  const list = days.flatMap((day) => hrrCalendarItemsOn(day).map((item) => ({ ...item, day })));
  wrap.innerHTML = `
    <div class="card-header"><div><div class="card-title">Next 2 weeks</div><div class="card-subtitle">What is coming up from today.</div></div></div>
    <div class="card-body">
      ${list.length ? list.map((item) => `<div class="hrr-upcoming-item">
        <div class="hrr-upcoming-date">${escapeHtml(new Date(`${item.day}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}</div>
        <div class="hrr-cal-event ${item.tone}"${item.auto ? '' : ` style="cursor:pointer;" onclick="openHrrEventModal({ id: ${Number(item.id)} })"`}><b>${escapeHtml(item.title)}</b>${item.meta ? `<span>${escapeHtml(item.meta)}</span>` : ''}</div>
      </div>`).join('') : '<div class="empty-state"><p>Nothing in the next two weeks.</p></div>'}
    </div>`;
}

function shiftHrrCalendar(step) {
  const [year, month] = hrrCalState.month.split('-').map(Number);
  const date = new Date(year, month - 1 + step, 1);
  hrrCalState.month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  hrrLoadCalendarMonth();
}

function renderHrrEventModal() {
  return `
  <div class="modal-overlay" id="hrr-event-modal">
    <div class="modal" style="max-width:560px;">
      <div class="modal-header">
        <div class="modal-title" id="hrr-event-title">Add HR Calendar Event</div>
        <button class="modal-close" onclick="closeModal('hrr-event-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <form onsubmit="saveHrrEvent(event)">
          <input type="hidden" id="hrr-event-id">
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Date</label><input type="date" id="hrr-event-date" class="form-control" required></div>
            <div class="form-group"><label class="form-label">Category</label><select id="hrr-event-category" class="form-control">${hrrOptions(HRR_CAL_CATEGORIES, 'HR Task')}</select></div>
          </div>
          <div class="form-group"><label class="form-label">Task / Event</label><input type="text" id="hrr-event-name" class="form-control" placeholder="e.g. Meralco bill payment" required></div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Amount (optional)</label><input type="number" min="0" step="0.01" id="hrr-event-amount" class="form-control" placeholder="0.00"></div>
            <div class="form-group"><label class="form-label">Employee (optional)</label><select id="hrr-event-user" class="form-control"></select></div>
          </div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Repeat</label><select id="hrr-event-repeat" class="form-control">${HRR_CAL_REPEATS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>
            <div class="form-group"><label class="form-label">Status</label><select id="hrr-event-status" class="form-control">${hrrOptions(['Upcoming', 'Pending', 'Done'], 'Upcoming')}</select></div>
          </div>
          <div class="form-group"><label class="form-label">Notes</label><textarea id="hrr-event-notes" class="form-control" rows="3"></textarea></div>
          <div style="display:flex;gap:8px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">Save Event</button>
            <button type="button" class="btn btn-secondary" id="hrr-event-delete" onclick="deleteHrrEvent()">Delete</button>
            <button type="button" class="btn btn-secondary" onclick="closeModal('hrr-event-modal')">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

function openHrrEventModal(preset = {}) {
  const existing = preset.id ? hrrCalState.events.find((event) => Number(event.id) === Number(preset.id)) : null;
  const event = { ...(existing || {}), ...preset };
  document.getElementById('hrr-event-title').textContent = existing ? 'Edit HR Calendar Event' : 'Add HR Calendar Event';
  document.getElementById('hrr-event-id').value = existing ? existing.id : '';
  document.getElementById('hrr-event-date').value = event.event_date || manilaToday();
  document.getElementById('hrr-event-category').value = event.category || 'HR Task';
  document.getElementById('hrr-event-name').value = event.title || '';
  document.getElementById('hrr-event-amount').value = event.amount ?? '';
  document.getElementById('hrr-event-user').innerHTML = hrrPersonOptions(event.user_id, { blank: '— Not employee-specific —' });
  document.getElementById('hrr-event-repeat').value = event.repeat_rule || 'none';
  document.getElementById('hrr-event-status').value = event.status || 'Upcoming';
  document.getElementById('hrr-event-notes').value = event.notes || '';
  document.getElementById('hrr-event-delete').style.display = existing ? '' : 'none';
  openModal('hrr-event-modal');
}

async function saveHrrEvent(event) {
  event.preventDefault();
  const id = document.getElementById('hrr-event-id').value;
  const body = {
    event_date: document.getElementById('hrr-event-date').value,
    category: document.getElementById('hrr-event-category').value,
    title: document.getElementById('hrr-event-name').value,
    amount: document.getElementById('hrr-event-amount').value,
    user_id: document.getElementById('hrr-event-user').value,
    repeat_rule: document.getElementById('hrr-event-repeat').value,
    status: document.getElementById('hrr-event-status').value,
    notes: document.getElementById('hrr-event-notes').value,
  };
  try {
    await hrrApi(id ? `/calendar/${id}` : '/calendar', { method: id ? 'PUT' : 'POST', body });
    closeModal('hrr-event-modal');
    await hrrLoadCalendarMonth();
  } catch (error) {
    hrrToastError(error);
  }
}

async function deleteHrrEvent() {
  const id = document.getElementById('hrr-event-id').value;
  if (!id || !confirm('Delete this event? A repeating event is removed from every date.')) return;
  try {
    await hrrApi(`/calendar/${id}`, { method: 'DELETE' });
    closeModal('hrr-event-modal');
    await hrrLoadCalendarMonth();
  } catch (error) {
    hrrToastError(error, 'Could not delete');
  }
}

// ─── ONBOARDING (trainees, RRM & playbooks, HR playbook) ───
const HRR_TRAINEE_DEPARTMENTS = ['CSR', 'RMO', 'Sales & Marketing', 'Logistics', 'HR', 'Operations', 'Other'];
const HRR_TRAINEE_STAGES = ['Day 0 Orientation', 'Days 1–4', 'Days 5–8', 'Days 9–14', 'Completed'];
const HRR_CHECK_STATUSES = ['Not Started', 'In Progress', 'Done', 'Signed'];
// The NEW TRAINEE checklist. Every department shares Day 0; CSR and RMO add
// the order tools. `group` is what the progress tiles count.
const HRR_CHECKLIST_COMMON = [
  { key: 'orientation', label: 'Orientation: Vision, Mission, Core Values, Org Chart', group: 'playbook' },
  { key: 'intro', label: 'Company introduction', group: 'playbook' },
  { key: 'contract', label: 'Contract signing', group: 'playbook' },
  { key: 'playbook_videos', label: 'Watch department bootcamp / playbook videos', group: 'playbook' },
  { key: 'email', label: 'Create company email', group: 'tools' },
  { key: 'facebook', label: 'Create company Facebook', group: 'tools' },
  { key: 'discord', label: 'Create company Discord', group: 'tools' },
  { key: 'erp_account', label: 'Create / request ERP employee account', group: 'tools' },
];
const HRR_CHECKLIST_EXTRA = {
  CSR: [{ key: 'pos_tools', label: 'Explore Pancake / Botcake / Meta', group: 'tools' }],
  RMO: [{ key: 'pos_tools', label: 'Explore Pancake POS and courier portals', group: 'tools' }],
  'Sales & Marketing': [{ key: 'ads_tools', label: 'Meta Business / Ads Manager access', group: 'tools' }],
};
// CSR daily training targets by stage. Actuals are typed per trainee.
const HRR_CSR_TARGETS = [
  { key: 'initial', stage: 'Initial Practice', orders: 10, calls: 20, upsells: 2, label: '10+ orders · 20+ calls · 2+ upsells' },
  { key: 'd1_4', stage: 'Days 1–4', orders: 50, calls: 50, upsells: 5, label: '50+ orders · 50–100+ calls · 5+ upsells' },
  { key: 'd5_8', stage: 'Days 5–8', orders: 100, calls: 50, upsells: 5, label: '100+ orders · 50–100+ calls · 5+ upsells' },
  { key: 'd9_14', stage: 'Days 9–14', orders: 150, calls: 50, upsells: 10, label: '150+ orders · 50–150+ calls · 10+ upsells' },
];
const HRR_READINESS = [
  { key: 'leadership', label: 'Leadership' },
  { key: 'self_manage', label: 'Self-manage' },
  { key: 'committed', label: 'Committed — no lates / absences / self-care absence' },
  { key: 'communication', label: 'Communication skills & sociability' },
  { key: 'learning', label: 'Attends learning sessions' },
];
const HRR_HR_PLAYBOOK_STARTER = [
  { title: 'Daily HR Operations', description: 'Attendance, EOD, employee checks, open issues', category: 'Daily' },
  { title: 'Weekly Owner Alignment', description: 'Challenges, improvements, priorities, carry-over', category: 'Weekly' },
  { title: 'HR Guide Questions', description: 'Daily focus, resources, challenges, solutions, support', category: 'Guide' },
  { title: 'On-Call HR Check', description: 'Performance, engagement, collaboration, training, culture, leadership', category: 'Guide' },
  { title: 'Payroll Process', description: 'Cutoff review, deductions, adjustments, validation', category: 'Payroll' },
  { title: 'Onboarding SOP', description: 'New employee / trainee checklist by department', category: 'Onboarding' },
];

const hrrOnbState = { tab: 'trainees', trainees: [], playbooks: [], selectedId: null, showClosed: false };

function hrrChecklistFor(department) {
  return [...HRR_CHECKLIST_COMMON, ...(HRR_CHECKLIST_EXTRA[department] || [])];
}

function hrrTraineeProgress(trainee) {
  if (trainee._progress) return trainee._progress;
  let parsed = {};
  try { parsed = trainee.progress ? JSON.parse(trainee.progress) : {}; } catch { parsed = {}; }
  trainee._progress = { checklist: parsed.checklist || {}, targets: parsed.targets || {}, readiness: parsed.readiness || {} };
  return trainee._progress;
}

function hrrTraineeStats(trainee) {
  const progress = hrrTraineeProgress(trainee);
  const items = hrrChecklistFor(trainee.department);
  const done = (item) => ['Done', 'Signed'].includes(progress.checklist[item.key]?.status);
  const playbook = items.filter((item) => item.group === 'playbook');
  const tools = items.filter((item) => item.group === 'tools');
  const readiness = HRR_READINESS.filter((item) => progress.readiness[item.key]?.checked).length;
  const total = items.length + HRR_READINESS.length;
  const day = trainee.start_date ? Math.max(0, Math.round((new Date(`${manilaToday()}T00:00:00`) - new Date(`${trainee.start_date}T00:00:00`)) / 86400000)) : null;
  let targetStatus = '—';
  if (trainee.department === 'CSR') {
    const results = HRR_CSR_TARGETS.map((target) => hrrTargetResult(target, progress.targets[target.key]));
    const latest = results.filter((result) => result !== 'Upcoming').pop();
    targetStatus = latest === 'Hit Target' ? 'On Track' : latest || 'Not started';
  }
  return {
    day,
    playbookDone: playbook.filter(done).length,
    playbookTotal: playbook.length,
    toolsDone: tools.filter(done).length,
    toolsTotal: tools.length,
    overall: Math.round(((items.filter(done).length + readiness) / total) * 100),
    targetStatus,
  };
}

function hrrTargetResult(target, actual) {
  if (!actual || ['orders', 'calls', 'upsells'].every((field) => actual[field] === '' || actual[field] === undefined || actual[field] === null)) return 'Upcoming';
  const hit = Number(actual.orders || 0) >= target.orders && Number(actual.calls || 0) >= target.calls && Number(actual.upsells || 0) >= target.upsells;
  return hit ? 'Hit Target' : 'Needs Coaching';
}

function renderOnboardingPage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Onboarding &amp; Playbooks</h1>
      <p>Trainee progress by department, each employee's RRM / playbook, and HR's own playbook.</p>
    </div>
    <div class="page-actions" id="hrr-onb-actions"></div>
  </div>
  <div class="tabs" id="hrr-onb-tabs">
    ${[['trainees', 'Trainee Progress'], ['rrm', 'Employee RRM & Playbook'], ['hrplaybook', 'Playbook for HR']].map(([id, label]) =>
      `<button class="tab-btn${hrrOnbState.tab === id ? ' active' : ''}" onclick="setHrrOnboardingTab('${id}')">${label}</button>`).join('')}
  </div>
  <div id="hrr-onb-root"><div class="card"><div class="empty-state"><h3>Loading</h3></div></div></div>
  ${renderHrrTraineeModal()}
  ${renderHrrPlaybookModal()}`;
}

async function initOnboardingPage() {
  try {
    const [, trainees, playbooks] = await Promise.all([
      hrrLoadPeople(),
      hrrApi('/trainees'),
      hrrApi('/playbooks'),
    ]);
    hrrOnbState.trainees = trainees?.rows || [];
    hrrOnbState.playbooks = playbooks?.rows || [];
  } catch (error) {
    const root = document.getElementById('hrr-onb-root');
    if (root) root.innerHTML = `<div class="card"><div class="empty-state"><h3>Could not load onboarding</h3><p>${escapeHtml(error.message || 'error')}</p></div></div>`;
    return;
  }
  const open = hrrOnbState.trainees.filter((trainee) => trainee.status === 'In Training');
  if (!hrrOnbState.trainees.some((trainee) => Number(trainee.id) === Number(hrrOnbState.selectedId))) {
    hrrOnbState.selectedId = (open[0] || hrrOnbState.trainees[0])?.id || null;
  }
  renderHrrOnboardingBody();
}

function setHrrOnboardingTab(tab) {
  hrrOnbState.tab = tab;
  document.querySelectorAll('#hrr-onb-tabs .tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', ['trainees', 'rrm', 'hrplaybook'][i] === tab);
  });
  renderHrrOnboardingBody();
}

function renderHrrOnboardingBody() {
  const root = document.getElementById('hrr-onb-root');
  const actions = document.getElementById('hrr-onb-actions');
  if (!root) return;
  if (hrrOnbState.tab === 'rrm') {
    if (actions) actions.innerHTML = '<button class="btn btn-primary btn-sm" onclick="openHrrPlaybookModal({ scope: \'employee\' })">+ Add RRM / Playbook</button>';
    root.innerHTML = renderHrrRrmTab();
  } else if (hrrOnbState.tab === 'hrplaybook') {
    if (actions) actions.innerHTML = '<button class="btn btn-primary btn-sm" onclick="openHrrPlaybookModal({ scope: \'hr\' })">+ Add HR Playbook Item</button>';
    root.innerHTML = renderHrrHrPlaybookTab();
  } else {
    if (actions) actions.innerHTML = '<button class="btn btn-primary btn-sm" onclick="openHrrTraineeModal({})">+ Add Trainee</button>';
    root.innerHTML = renderHrrTraineesTab();
  }
}

function renderHrrTraineesTab() {
  const visible = hrrOnbState.trainees.filter((trainee) => hrrOnbState.showClosed || trainee.status === 'In Training'
    || Number(trainee.id) === Number(hrrOnbState.selectedId));
  const trainee = hrrOnbState.trainees.find((row) => Number(row.id) === Number(hrrOnbState.selectedId));
  const picker = `
    <div class="hrr-picker">
      ${visible.map((row) => `<button class="filter-pill${Number(row.id) === Number(hrrOnbState.selectedId) ? ' active' : ''}" onclick="hrrOnbState.selectedId=${Number(row.id)}; renderHrrOnboardingBody()">${escapeHtml(row.full_name)} <span class="text-xs">· ${escapeHtml(row.department || '')}</span></button>`).join('')}
      <label class="hrr-toggle"><input type="checkbox"${hrrOnbState.showClosed ? ' checked' : ''} onchange="hrrOnbState.showClosed=this.checked; renderHrrOnboardingBody()"> Show graduated / dropped</label>
    </div>`;
  if (!trainee) {
    return `<div class="card"><div class="card-body">${picker}<div class="empty-state"><h3>No trainees yet</h3><p>Add a trainee once and HR checks their onboarding progress here.</p></div></div></div>`;
  }
  const stats = hrrTraineeStats(trainee);
  const progress = hrrTraineeProgress(trainee);
  const id = Number(trainee.id);
  const checklist = hrrChecklistFor(trainee.department);
  return `
  <div class="card" style="margin-bottom:20px;">
    <div class="card-body">
      ${picker}
      <div class="hrr-person-head" style="margin-top:14px;justify-content:space-between;flex-wrap:wrap;">
        <div class="hrr-person-head">
          <div class="hrr-avatar">${escapeHtml(hrrInitials(trainee.full_name))}</div>
          <div>
            <div class="card-title">${escapeHtml(trainee.full_name)}</div>
            <div class="card-subtitle">${escapeHtml(trainee.department || '')} trainee${stats.day !== null ? ` · Day ${stats.day}` : ''}${trainee.stage ? ` · ${escapeHtml(trainee.stage)}` : ''}${trainee.trainer ? ` · Trainer: ${escapeHtml(trainee.trainer)}` : ''}${trainee.user_id ? ` · Account: ${escapeHtml(hrrPersonName(hrrPerson(trainee.user_id)))}` : ''}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          ${hrrBadge(trainee.status)}
          <button class="btn btn-secondary btn-sm" onclick="openHrrTraineeModal({ id: ${id} })">Edit</button>
        </div>
      </div>
      <div class="hrr-ministats">
        <div><span>Overall Progress</span><b>${stats.overall}%</b></div>
        <div><span>Playbook / Orientation</span><b>${stats.playbookDone} / ${stats.playbookTotal}</b></div>
        <div><span>Tools Created</span><b>${stats.toolsDone} / ${stats.toolsTotal}</b></div>
        <div><span>Daily Target</span><b>${escapeHtml(stats.targetStatus)}</b></div>
      </div>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px;">
    <div class="card-header"><div><div class="card-title">Day 0 — Orientation &amp; Setup</div><div class="card-subtitle">Saved as you change it.</div></div></div>
    <div class="card-body"><div class="table-container"><table>
      <thead><tr><th>Checklist</th><th>Status</th><th>Link / Proof</th><th>HR Check</th></tr></thead>
      <tbody>${checklist.map((item) => {
        const entry = progress.checklist[item.key] || {};
        return `<tr>
          <td>${escapeHtml(item.label)}</td>
          <td><select class="form-control hrr-inline" onchange="setHrrTraineeField(${id}, 'checklist', '${item.key}', 'status', this.value)">${hrrOptions(HRR_CHECK_STATUSES, entry.status || 'Not Started')}</select></td>
          <td><div style="display:flex;gap:6px;align-items:center;"><input type="url" class="form-control hrr-inline" placeholder="https://…" value="${escapeHtml(entry.link || '')}" onchange="setHrrTraineeField(${id}, 'checklist', '${item.key}', 'link', this.value)">${entry.link ? hrrLink(entry.link) : ''}</div></td>
          <td><input type="checkbox"${entry.checked ? ' checked' : ''} onchange="setHrrTraineeField(${id}, 'checklist', '${item.key}', 'checked', this.checked)"></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div></div>
  </div>

  ${trainee.department === 'CSR' ? `
  <div class="card" style="margin-bottom:20px;">
    <div class="card-header"><div><div class="card-title">CSR Daily Training Targets</div><div class="card-subtitle">Type today's actuals; the result compares them with the stage target.</div></div></div>
    <div class="card-body"><div class="table-container"><table>
      <thead><tr><th>Training Stage</th><th>Target</th><th>Confirmed Orders</th><th>Customer Calls</th><th>Upsells</th><th>Result</th></tr></thead>
      <tbody>${HRR_CSR_TARGETS.map((target) => {
        const actual = progress.targets[target.key] || {};
        return `<tr>
          <td><strong>${escapeHtml(target.stage)}</strong></td>
          <td class="text-xs">${escapeHtml(target.label)}</td>
          ${['orders', 'calls', 'upsells'].map((field) => `<td><input type="number" min="0" class="form-control hrr-inline" style="max-width:100px;" value="${escapeHtml(actual[field] ?? '')}" onchange="setHrrTraineeField(${id}, 'targets', '${target.key}', '${field}', this.value)"></td>`).join('')}
          <td>${hrrBadge(hrrTargetResult(target, actual))}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div></div>
  </div>` : `
  <div class="card" style="margin-bottom:20px;"><div class="card-body"><p class="text-muted" style="margin:0;">Daily training targets are set for CSR. ${escapeHtml(trainee.department || 'This department')} can get its own once its checklist is finalized.</p></div></div>`}

  <div class="card">
    <div class="card-header"><div><div class="card-title">Trainee Behavior / Readiness</div></div></div>
    <div class="card-body"><div class="table-container"><table>
      <thead><tr><th>Criteria</th><th>HR Check</th><th>Remarks</th></tr></thead>
      <tbody>${HRR_READINESS.map((item) => {
        const entry = progress.readiness[item.key] || {};
        return `<tr>
          <td>${escapeHtml(item.label)}</td>
          <td><input type="checkbox"${entry.checked ? ' checked' : ''} onchange="setHrrTraineeField(${id}, 'readiness', '${item.key}', 'checked', this.checked)"></td>
          <td><input type="text" class="form-control hrr-inline" value="${escapeHtml(entry.remarks || '')}" onchange="setHrrTraineeField(${id}, 'readiness', '${item.key}', 'remarks', this.value)"></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div></div>
  </div>`;
}

// Every checklist / target / readiness change writes the whole progress blob
// for that trainee — small, and it keeps the server free of a schema per sheet.
async function setHrrTraineeField(traineeId, section, key, field, value) {
  const trainee = hrrOnbState.trainees.find((row) => Number(row.id) === Number(traineeId));
  if (!trainee) return;
  const progress = hrrTraineeProgress(trainee);
  const entry = progress[section][key] || (progress[section][key] = {});
  entry[field] = value;
  try {
    const result = await hrrApi(`/trainees/${Number(traineeId)}`, { method: 'PUT', body: { progress } });
    Object.assign(trainee, result.row, { _progress: progress });
    renderHrrOnboardingBody();
  } catch (error) {
    hrrToastError(error);
  }
}

function renderHrrTraineeModal() {
  return `
  <div class="modal-overlay" id="hrr-trainee-modal">
    <div class="modal" style="max-width:560px;">
      <div class="modal-header">
        <div class="modal-title" id="hrr-trainee-title">Add Trainee</div>
        <button class="modal-close" onclick="closeModal('hrr-trainee-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <p class="text-xs text-muted" style="margin-top:0;">Creates a trainee record and assigns the department's onboarding checklist.</p>
        <form onsubmit="saveHrrTrainee(event)">
          <input type="hidden" id="hrr-trainee-id">
          <div class="form-group"><label class="form-label">Trainee Name</label><input type="text" id="hrr-trainee-name" class="form-control" required></div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Department</label><select id="hrr-trainee-dept" class="form-control">${hrrOptions(HRR_TRAINEE_DEPARTMENTS, 'CSR')}</select></div>
            <div class="form-group"><label class="form-label">Start Date</label><input type="date" id="hrr-trainee-start" class="form-control"></div>
          </div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Trainer / Department Head</label><input type="text" id="hrr-trainee-trainer" class="form-control"></div>
            <div class="form-group"><label class="form-label">Training Stage</label><select id="hrr-trainee-stage" class="form-control">${hrrOptions(HRR_TRAINEE_STAGES, 'Day 0 Orientation')}</select></div>
          </div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">ERP account (once created)</label><select id="hrr-trainee-user" class="form-control"></select></div>
            <div class="form-group"><label class="form-label">Status</label><select id="hrr-trainee-status" class="form-control">${hrrOptions(['In Training', 'Graduated', 'Dropped'], 'In Training')}</select></div>
          </div>
          <div class="form-group"><label class="form-label">Remarks</label><textarea id="hrr-trainee-remarks" class="form-control" rows="2"></textarea></div>
          <div style="display:flex;gap:8px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">Save Trainee</button>
            <button type="button" class="btn btn-secondary" id="hrr-trainee-delete" onclick="deleteHrrTrainee()">Delete</button>
            <button type="button" class="btn btn-secondary" onclick="closeModal('hrr-trainee-modal')">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

function openHrrTraineeModal(preset = {}) {
  const existing = preset.id ? hrrOnbState.trainees.find((row) => Number(row.id) === Number(preset.id)) : null;
  const trainee = existing || {};
  document.getElementById('hrr-trainee-title').textContent = existing ? 'Edit Trainee' : 'Add Trainee';
  document.getElementById('hrr-trainee-id').value = existing ? existing.id : '';
  document.getElementById('hrr-trainee-name').value = trainee.full_name || '';
  document.getElementById('hrr-trainee-dept').value = trainee.department || 'CSR';
  document.getElementById('hrr-trainee-start').value = trainee.start_date || manilaToday();
  document.getElementById('hrr-trainee-trainer').value = trainee.trainer || '';
  document.getElementById('hrr-trainee-stage').value = trainee.stage || 'Day 0 Orientation';
  document.getElementById('hrr-trainee-user').innerHTML = hrrPersonOptions(trainee.user_id, { blank: '— No account yet —' });
  document.getElementById('hrr-trainee-status').value = trainee.status || 'In Training';
  document.getElementById('hrr-trainee-remarks').value = trainee.remarks || '';
  document.getElementById('hrr-trainee-delete').style.display = existing ? '' : 'none';
  openModal('hrr-trainee-modal');
}

async function saveHrrTrainee(event) {
  event.preventDefault();
  const id = document.getElementById('hrr-trainee-id').value;
  const body = {
    full_name: document.getElementById('hrr-trainee-name').value,
    department: document.getElementById('hrr-trainee-dept').value,
    start_date: document.getElementById('hrr-trainee-start').value,
    trainer: document.getElementById('hrr-trainee-trainer').value,
    stage: document.getElementById('hrr-trainee-stage').value,
    user_id: document.getElementById('hrr-trainee-user').value,
    status: document.getElementById('hrr-trainee-status').value,
    remarks: document.getElementById('hrr-trainee-remarks').value,
  };
  try {
    const result = await hrrApi(id ? `/trainees/${id}` : '/trainees', { method: id ? 'PUT' : 'POST', body });
    closeModal('hrr-trainee-modal');
    hrrOnbState.selectedId = result?.row?.id || hrrOnbState.selectedId;
    await initOnboardingPage();
  } catch (error) {
    hrrToastError(error);
  }
}

async function deleteHrrTrainee() {
  const id = document.getElementById('hrr-trainee-id').value;
  if (!id || !confirm('Delete this trainee and their whole checklist?')) return;
  try {
    await hrrApi(`/trainees/${id}`, { method: 'DELETE' });
    closeModal('hrr-trainee-modal');
    hrrOnbState.selectedId = null;
    await initOnboardingPage();
  } catch (error) {
    hrrToastError(error, 'Could not delete');
  }
}

function renderHrrRrmTab() {
  const rows = hrrOnbState.playbooks.filter((row) => row.scope === 'employee');
  return `
  <div class="card">
    <div class="card-header"><div><div class="card-title">Employee RRM &amp; Playbook</div><div class="card-subtitle">Per employee: the assigned RRM / playbook, its link, completion, and HR verification.</div></div></div>
    <div class="card-body">
      ${rows.length ? `<div class="table-container"><table>
        <thead><tr><th>Employee</th><th>Department</th><th>RRM / Playbook</th><th>Link</th><th>Progress</th><th>HR Verified</th><th></th></tr></thead>
        <tbody>${rows.map((row) => {
          const person = hrrPerson(row.user_id);
          const progress = Number(row.progress || 0);
          return `<tr>
            <td><strong>${escapeHtml(person ? hrrPersonName(person) : '—')}</strong></td>
            <td>${escapeHtml(row.department || (person ? employeeDepartment(person) : ''))}</td>
            <td>${escapeHtml(row.title)}${row.description ? `<div class="text-xs text-muted">${escapeHtml(row.description)}</div>` : ''}</td>
            <td>${hrrLink(row.link)}</td>
            <td style="min-width:150px;"><div class="hrr-meter"><span style="width:${progress}%;background:${progress >= 100 ? 'var(--success)' : 'var(--accent)'};"></span></div><span class="text-xs">${progress}%</span></td>
            <td><input type="checkbox"${Number(row.verified) ? ' checked' : ''} onchange="updateHrrPlaybook(${Number(row.id)}, { verified: this.checked })"></td>
            <td style="white-space:nowrap;"><button class="btn btn-secondary btn-sm" onclick="openHrrPlaybookModal({ id: ${Number(row.id)} })">Edit</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : '<div class="empty-state"><h3>No RRM / playbooks assigned</h3><p>Assign one per employee and track it to 100%.</p></div>'}
    </div>
  </div>`;
}

function renderHrrHrPlaybookTab() {
  const rows = hrrOnbState.playbooks.filter((row) => row.scope === 'hr');
  return `
  <div class="card">
    <div class="card-header"><div><div class="card-title">Playbook for HR</div><div class="card-subtitle">One place for HR SOPs, recurring tasks, guide questions and training references.</div></div>
      ${rows.length ? '' : '<button class="btn btn-secondary btn-sm" onclick="addHrrPlaybookStarter()">Add the starter set</button>'}
    </div>
    <div class="card-body">
      ${rows.length ? `<div class="hrr-docgrid">${rows.map((row) => `
        <div class="hrr-doc" style="cursor:default;">
          <span class="hrr-docname">${escapeHtml(row.title)}</span>
          ${row.category ? `<span class="hrr-docmeta"><span class="badge badge-gray">${escapeHtml(row.category)}</span></span>` : ''}
          <span class="hrr-docmeta">${escapeHtml(row.description || '')}</span>
          <span style="display:flex;gap:6px;margin-top:8px;">${row.link ? hrrLink(row.link) : ''}<button class="btn btn-secondary btn-sm" onclick="openHrrPlaybookModal({ id: ${Number(row.id)} })">Edit</button></span>
        </div>`).join('')}</div>` : `<div class="empty-state"><h3>Nothing here yet</h3><p>Start from the six usual items (${HRR_HR_PLAYBOOK_STARTER.map((item) => escapeHtml(item.title)).join(', ')}) or add your own.</p></div>`}
    </div>
  </div>`;
}

async function addHrrPlaybookStarter() {
  try {
    for (const item of HRR_HR_PLAYBOOK_STARTER) {
      await hrrApi('/playbooks', { method: 'POST', body: { ...item, scope: 'hr' } });
    }
    await initOnboardingPage();
  } catch (error) {
    hrrToastError(error);
  }
}

function renderHrrPlaybookModal() {
  return `
  <div class="modal-overlay" id="hrr-playbook-modal">
    <div class="modal" style="max-width:560px;">
      <div class="modal-header">
        <div class="modal-title" id="hrr-playbook-title">Playbook</div>
        <button class="modal-close" onclick="closeModal('hrr-playbook-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <form onsubmit="saveHrrPlaybook(event)">
          <input type="hidden" id="hrr-playbook-id">
          <input type="hidden" id="hrr-playbook-scope">
          <div class="form-group" id="hrr-playbook-user-wrap"><label class="form-label">Employee</label><select id="hrr-playbook-user" class="form-control"></select></div>
          <div class="form-group"><label class="form-label">Title</label><input type="text" id="hrr-playbook-name" class="form-control" placeholder="e.g. CSR Bootcamp / Playbook" required></div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label" id="hrr-playbook-cat-label">Department</label><input type="text" id="hrr-playbook-cat" class="form-control"></div>
            <div class="form-group"><label class="form-label">Link</label><input type="url" id="hrr-playbook-link" class="form-control" placeholder="https://…"></div>
          </div>
          <div class="form-group"><label class="form-label">Description</label><textarea id="hrr-playbook-desc" class="form-control" rows="2"></textarea></div>
          <div class="form-grid-2" id="hrr-playbook-progress-wrap">
            <div class="form-group"><label class="form-label">Progress (%)</label><input type="number" min="0" max="100" step="5" id="hrr-playbook-progress" class="form-control"></div>
            <div class="form-group"><label class="form-label">HR Verified</label><label class="hrr-toggle" style="margin-top:8px;"><input type="checkbox" id="hrr-playbook-verified"> Verified by HR</label></div>
          </div>
          <div style="display:flex;gap:8px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">Save</button>
            <button type="button" class="btn btn-secondary" id="hrr-playbook-delete" onclick="deleteHrrPlaybook()">Delete</button>
            <button type="button" class="btn btn-secondary" onclick="closeModal('hrr-playbook-modal')">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

function openHrrPlaybookModal(preset = {}) {
  const existing = preset.id ? hrrOnbState.playbooks.find((row) => Number(row.id) === Number(preset.id)) : null;
  const row = { ...(existing || {}), ...preset };
  const hr = row.scope === 'hr';
  document.getElementById('hrr-playbook-title').textContent = `${existing ? 'Edit' : 'Add'} ${hr ? 'HR Playbook Item' : 'RRM / Playbook'}`;
  document.getElementById('hrr-playbook-id').value = existing ? existing.id : '';
  document.getElementById('hrr-playbook-scope').value = hr ? 'hr' : 'employee';
  document.getElementById('hrr-playbook-user-wrap').style.display = hr ? 'none' : '';
  document.getElementById('hrr-playbook-progress-wrap').style.display = hr ? 'none' : '';
  document.getElementById('hrr-playbook-cat-label').textContent = hr ? 'Category' : 'Department';
  document.getElementById('hrr-playbook-user').innerHTML = hrrPersonOptions(row.user_id, { blank: 'Select employee' });
  document.getElementById('hrr-playbook-name').value = row.title || '';
  document.getElementById('hrr-playbook-cat').value = (hr ? row.category : row.department) || '';
  document.getElementById('hrr-playbook-link').value = row.link || '';
  document.getElementById('hrr-playbook-desc').value = row.description || '';
  document.getElementById('hrr-playbook-progress').value = row.progress ?? 0;
  document.getElementById('hrr-playbook-verified').checked = !!Number(row.verified);
  document.getElementById('hrr-playbook-delete').style.display = existing ? '' : 'none';
  openModal('hrr-playbook-modal');
}

async function saveHrrPlaybook(event) {
  event.preventDefault();
  const id = document.getElementById('hrr-playbook-id').value;
  const scope = document.getElementById('hrr-playbook-scope').value;
  const userId = document.getElementById('hrr-playbook-user').value;
  if (scope === 'employee' && !userId) { showToast('warning', 'Pick an employee', 'An RRM / playbook is assigned to one employee.'); return; }
  const category = document.getElementById('hrr-playbook-cat').value;
  const body = {
    scope,
    user_id: scope === 'employee' ? userId : null,
    title: document.getElementById('hrr-playbook-name').value,
    category: scope === 'hr' ? category : null,
    department: scope === 'employee' ? (category || employeeDepartment(hrrPerson(userId))) : null,
    link: document.getElementById('hrr-playbook-link').value,
    description: document.getElementById('hrr-playbook-desc').value,
    progress: document.getElementById('hrr-playbook-progress').value,
    verified: document.getElementById('hrr-playbook-verified').checked,
  };
  try {
    await hrrApi(id ? `/playbooks/${id}` : '/playbooks', { method: id ? 'PUT' : 'POST', body });
    closeModal('hrr-playbook-modal');
    await initOnboardingPage();
  } catch (error) {
    hrrToastError(error);
  }
}

async function updateHrrPlaybook(id, patch) {
  try {
    const result = await hrrApi(`/playbooks/${Number(id)}`, { method: 'PUT', body: patch });
    const index = hrrOnbState.playbooks.findIndex((row) => Number(row.id) === Number(id));
    if (index >= 0 && result?.row) hrrOnbState.playbooks[index] = result.row;
  } catch (error) {
    hrrToastError(error);
  }
}

async function deleteHrrPlaybook() {
  const id = document.getElementById('hrr-playbook-id').value;
  if (!id || !confirm('Delete this playbook item?')) return;
  try {
    await hrrApi(`/playbooks/${id}`, { method: 'DELETE' });
    closeModal('hrr-playbook-modal');
    await initOnboardingPage();
  } catch (error) {
    hrrToastError(error, 'Could not delete');
  }
}

// ─── KPI ALLOWANCE ─────────────────────────────────────────
// Tiers: the lowest score that earns each amount. The best tier a score
// reaches sets the allowance; below every tier is Not Qualified.
const HRR_DEFAULT_TIERS = [{ min: 90, amount: 1000 }, { min: 80, amount: 500 }];
const hrrKpiState = { rows: [], tiers: HRR_DEFAULT_TIERS };

// The page is Evaluation Result: each person's peer Evaluation, Compliance and
// KPI side by side with a final result. The allowance records it used to be
// sit on their own tab. Page id stays 'kpi-allowance' so role access is kept.
const hrrEvalState = { tab: 'results', period: '' };

function renderKpiAllowancePage() {
  const results = hrrEvalState.tab === 'results';
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Evaluation Result</h1>
      <p>Each employee's peer Evaluation, Compliance and KPI, and the final result.</p>
    </div>
    <div class="page-actions" id="hrr-kpi-actions" style="${results ? 'display:none;' : ''}">
      <button class="btn btn-secondary btn-sm" onclick="openModal('hrr-tier-modal')">Allowance Rules</button>
      <button class="btn btn-primary btn-sm" onclick="openHrrKpiModal({})">+ Add Allowance</button>
    </div>
  </div>
  <div class="et-tabs" id="hrr-eval-tabs">${renderHrrEvalTabs()}</div>
  <div id="hrr-eval-results" style="${results ? '' : 'display:none;'}">
    <div class="card"><div class="card-body"><div class="empty-state"><h3>Loading</h3></div></div></div>
  </div>
  <div id="hrr-kpi-section" style="${results ? 'display:none;' : ''}">
    <div class="stats-grid" id="hrr-kpi-stats"></div>
    <div class="card"><div class="card-body" id="hrr-kpi-root"><div class="empty-state"><h3>Loading</h3></div></div></div>
  </div>
  ${renderHrrKpiModal()}
  ${renderHrrTierModal()}`;
}

function renderHrrEvalTabs() {
  return [['results', 'Results'], ['allowance', 'Allowance']].map(([id, label]) =>
    `<button type="button" class="filter-pill ${hrrEvalState.tab === id ? 'active' : ''}" onclick="setHrrEvalTab('${id}')">${label}</button>`).join('');
}

function setHrrEvalTab(tab) {
  hrrEvalState.tab = tab;
  const results = tab === 'results';
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  show('hrr-eval-results', results);
  show('hrr-kpi-section', !results);
  show('hrr-kpi-actions', !results);
  const tabs = document.getElementById('hrr-eval-tabs');
  if (tabs) tabs.innerHTML = renderHrrEvalTabs();
}

function hrrCurrentHalf() {
  const today = manilaToday();
  return `${today.slice(0, 7)}-H${Number(today.slice(8, 10)) <= 15 ? 1 : 2}`;
}

function hrrEvalBadge(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return '<span class="text-muted">—</span>';
  const value = Number(score);
  const tone = value >= 90 ? 'success' : value >= 75 ? 'info' : value >= 60 ? 'warning' : 'danger';
  return `<span class="badge badge-${tone}">${value.toFixed(value % 1 ? 1 : 0)}%</span>`;
}

// Peer (Evaluation Matrix score for the half), Compliance (same half) and KPI
// (the half's month — KPI runs monthly). Final = average of the ones that have
// a score, so a missing part never drags the result down to zero. Each source
// is fetched on its own so one failing only blanks its column.
async function loadHrrEvalResults() {
  const wrap = document.getElementById('hrr-eval-results');
  if (!wrap) return;
  if (!hrrEvalState.period) hrrEvalState.period = hrrCurrentHalf();
  const period = hrrEvalState.period;
  const month = period.slice(0, 7);
  const me = Number(App.user?.id);
  const get = (path) => authorizedJsonRequest(path).catch(() => null);
  const [compliance, kpi, queue, mine] = await Promise.all([
    get(`/performance/compliance?period=${encodeURIComponent(period)}`),
    get(`/performance/kpi/scores?period=${encodeURIComponent(month)}`),
    get(`/evaluations/queue?period=${encodeURIComponent(period)}`),
    // The queue leaves out the person reading it, so their own score comes separately.
    me ? get(`/evaluations/summary/${me}?period=${encodeURIComponent(period)}`) : null,
  ]);
  if (hrrEvalState.period !== period || !document.getElementById('hrr-eval-results')) return;

  const peerOf = (result) => (result && Number(result.responses) > 0 ? Number(result.score) : null);
  const peer = new Map((queue?.data || []).map((row) => [Number(row.id), peerOf(row.result)]));
  if (me && mine?.result) peer.set(me, peerOf(mine.result));
  const kpiBy = new Map((kpi?.rows || []).map((row) => [Number(row.id), row.total ?? null]));
  const complianceBy = new Map((compliance?.rows || []).map((row) => [Number(row.id), row.overall ?? null]));
  const roster = compliance?.rows || kpi?.rows || [];
  const rows = roster.map((person) => {
    const id = Number(person.id);
    const scores = { peer: peer.get(id) ?? null, compliance: complianceBy.get(id) ?? null, kpi: kpiBy.get(id) ?? null };
    const present = Object.values(scores).filter((v) => v !== null && Number.isFinite(Number(v))).map(Number);
    const final = present.length ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 10) / 10 : null;
    return { id, name: person.name, department: person.department || 'Unassigned', ...scores, final };
  });

  const order = typeof DEPARTMENT_ORDER !== 'undefined' ? DEPARTMENT_ORDER : [];
  const rank = (name) => (order.indexOf(name) === -1 ? order.length : order.indexOf(name));
  const groups = new Map();
  rows.forEach((row) => { if (!groups.has(row.department)) groups.set(row.department, []); groups.get(row.department).push(row); });
  const grouped = [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));

  const now = new Date(`${manilaToday()}T00:00:00`);
  const options = [];
  for (let i = 0; i < 12; i += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    options.push(`${ym}-H2`, `${ym}-H1`);
  }
  const missing = [!queue && 'Peer', !compliance && 'Compliance', !kpi && 'KPI'].filter(Boolean);

  wrap.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Evaluation Result · ${escapeHtml(hrrPeriodLabel(period))}</div>
          <div class="card-subtitle">Final Result = average of Peer, Compliance and KPI (only the parts that have a score). KPI is the whole month's.</div>
        </div>
        <select class="form-control perf-select" onchange="hrrEvalState.period = this.value; loadHrrEvalResults();">
          ${options.map((value) => `<option value="${value}"${value === period ? ' selected' : ''}>${escapeHtml(hrrPeriodLabel(value))}</option>`).join('')}
        </select>
      </div>
      ${rows.length ? `<div class="table-container"><table>
        <thead><tr><th>Employee</th><th>Final Result</th><th>Peer</th><th>Compliance</th><th>KPI</th></tr></thead>
        ${grouped.map(([department, people]) => `<tbody>
          <tr class="perf-group"><td colspan="5">${escapeHtml(department)}</td></tr>
          ${people.map((p) => `<tr>
            <td><strong>${escapeHtml(p.name)}</strong></td>
            <td>${hrrEvalBadge(p.final)}</td>
            <td>${hrrEvalBadge(p.peer)}</td>
            <td>${hrrEvalBadge(p.compliance)}</td>
            <td>${hrrEvalBadge(p.kpi)}</td>
          </tr>`).join('')}
        </tbody>`).join('')}
      </table></div>` : '<div class="card-body"><div class="empty-state"><h3>No results</h3><p>Nobody to show for this period.</p></div></div>'}
      <div class="card-body"><p class="text-xs text-muted">Peer is the Evaluation Matrix score; Compliance and KPI come from Performance. — means no score yet.${missing.length ? ` Could not load: ${escapeHtml(missing.join(', '))}.` : ''}</p></div>
    </div>`;
}

async function initKpiAllowancePage() {
  loadHrrEvalResults().catch(() => {});
  try {
    const [, rows, tiers] = await Promise.all([
      hrrLoadPeople(),
      hrrApi('/kpi-allowances'),
      hrrApi('/settings/kpi_allowance_tiers'),
    ]);
    hrrKpiState.rows = rows?.rows || [];
    if (Array.isArray(tiers?.value) && tiers.value.length) hrrKpiState.tiers = tiers.value;
  } catch (error) {
    const root = document.getElementById('hrr-kpi-root');
    if (root) root.innerHTML = `<div class="empty-state"><h3>Could not load</h3><p>${escapeHtml(error.message || 'error')}</p></div>`;
    return;
  }
  renderHrrKpi();
}

function hrrTierAmount(score) {
  if (score === null || score === undefined || score === '' || !Number.isFinite(Number(score))) return null;
  const tier = [...hrrKpiState.tiers].sort((a, b) => Number(b.min) - Number(a.min)).find((row) => Number(score) >= Number(row.min));
  return tier ? Number(tier.amount) : 0;
}

function hrrPeriodLabel(period) {
  const match = String(period || '').match(/^(\d{4})-(\d{2})(?:-H([12]))?$/);
  if (!match) return period || '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  const month = date.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  if (!match[3]) return month;
  return `${month} · ${match[3] === '1' ? '1st–15th' : '16th–end'}`;
}

function hrrPeriodOptions(selected) {
  const now = new Date(`${manilaToday()}T00:00:00`);
  const options = [];
  for (let i = 0; i < 12; i += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    [ym, `${ym}-H2`, `${ym}-H1`].forEach((value) => options.push(value));
  }
  if (selected && !options.includes(selected)) options.unshift(selected);
  return options.map((value) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(hrrPeriodLabel(value))}</option>`).join('');
}

function renderHrrKpi() {
  const rows = hrrKpiState.rows;
  const stats = document.getElementById('hrr-kpi-stats');
  const due = rows.filter((row) => row.status === 'Qualified' && row.payroll_status !== 'Released');
  if (stats) {
    stats.innerHTML = [
      ['blue', 'Records', rows.length, 'allowance rows'],
      ['green', 'Qualified', rows.filter((row) => row.status === 'Qualified').length, 'met a tier'],
      ['amber', 'For Next Payroll', formatPHP(due.reduce((sum, row) => sum + Number(row.amount || 0), 0)), `${due.length} not yet released`],
      ['red', 'Awaiting Evaluation', rows.filter((row) => row.status === 'Awaiting Evaluation').length, 'no score yet'],
    ].map(([tone, label, value, meta]) => `<div class="stat-card ${tone}"><div class="stat-card-accent"></div><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(String(value))}</div><div class="stat-meta">${escapeHtml(meta)}</div></div>`).join('');
  }
  const root = document.getElementById('hrr-kpi-root');
  if (!root) return;
  root.innerHTML = rows.length ? `
    <div class="table-container"><table>
      <thead><tr><th>Employee</th><th>Period</th><th>KPI Score</th><th>Allowance</th><th>Status</th><th>Payroll</th><th>Remarks</th><th></th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <td><strong>${escapeHtml(hrrPersonName(hrrPerson(row.user_id)))}</strong></td>
        <td>${escapeHtml(hrrPeriodLabel(row.period_label))}</td>
        <td>${row.kpi_score === null || row.kpi_score === undefined ? '—' : `${Number(row.kpi_score).toFixed(1)}%`}</td>
        <td>${row.amount ? formatPHP(row.amount) : '—'}</td>
        <td>${hrrBadge(row.status)}</td>
        <td>${row.payroll_status ? hrrBadge(row.payroll_status) : '—'}</td>
        <td class="text-xs">${escapeHtml(row.remarks || '')}</td>
        <td style="white-space:nowrap;">
          ${row.status === 'Qualified' && row.payroll_status !== 'Released' ? `<button class="btn btn-secondary btn-sm" onclick="markHrrKpiReleased(${Number(row.id)})">Mark Released</button>` : ''}
          <button class="btn btn-secondary btn-sm" onclick="openHrrKpiModal({ id: ${Number(row.id)} })">Edit</button>
        </td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="text-xs text-muted" style="margin-top:10px;">The allowance is tracked here; add it to the payslip as an adjustment on HR &amp; Payroll when it is released.</p>`
    : '<div class="empty-state"><h3>No KPI allowances yet</h3><p>Add one per employee per period, or pull the score from the Evaluation Matrix.</p></div>';
}

function renderHrrKpiModal() {
  return `
  <div class="modal-overlay" id="hrr-kpi-modal">
    <div class="modal" style="max-width:560px;">
      <div class="modal-header">
        <div class="modal-title" id="hrr-kpi-title">KPI Allowance</div>
        <button class="modal-close" onclick="closeModal('hrr-kpi-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <form onsubmit="saveHrrKpi(event)">
          <input type="hidden" id="hrr-kpi-id">
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Employee</label><select id="hrr-kpi-user" class="form-control" required></select></div>
            <div class="form-group"><label class="form-label">Period</label><select id="hrr-kpi-period" class="form-control"></select></div>
          </div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">KPI Score (%)</label>
              <div style="display:flex;gap:6px;"><input type="number" min="0" max="100" step="0.1" id="hrr-kpi-score" class="form-control" oninput="hrrKpiScoreChanged()"><button type="button" class="btn btn-secondary btn-sm" onclick="pullHrrKpiScore()" title="Average of the Evaluation Matrix scores in this period">Pull</button></div>
            </div>
            <div class="form-group"><label class="form-label">Allowance (₱)</label><input type="number" min="0" step="0.01" id="hrr-kpi-amount" class="form-control"></div>
          </div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Status</label><select id="hrr-kpi-status" class="form-control">${hrrOptions(['Awaiting Evaluation', 'Qualified', 'Not Qualified'], 'Awaiting Evaluation')}</select></div>
            <div class="form-group"><label class="form-label">Payroll</label><select id="hrr-kpi-payroll" class="form-control"><option value="">—</option>${hrrOptions(['For Next Payroll', 'Released'], '')}</select></div>
          </div>
          <div class="form-group"><label class="form-label">Remarks</label><input type="text" id="hrr-kpi-remarks" class="form-control"></div>
          <div style="display:flex;gap:8px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">Save</button>
            <button type="button" class="btn btn-secondary" id="hrr-kpi-delete" onclick="deleteHrrKpi()">Delete</button>
            <button type="button" class="btn btn-secondary" onclick="closeModal('hrr-kpi-modal')">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

function openHrrKpiModal(preset = {}) {
  const existing = preset.id ? hrrKpiState.rows.find((row) => Number(row.id) === Number(preset.id)) : null;
  const row = existing || {};
  document.getElementById('hrr-kpi-title').textContent = existing ? 'Edit KPI Allowance' : 'Add KPI Allowance';
  document.getElementById('hrr-kpi-id').value = existing ? existing.id : '';
  document.getElementById('hrr-kpi-user').innerHTML = hrrPersonOptions(row.user_id, { includeInactive: !!existing, blank: 'Select employee' });
  document.getElementById('hrr-kpi-period').innerHTML = hrrPeriodOptions(row.period_label || manilaToday().slice(0, 7));
  document.getElementById('hrr-kpi-score').value = row.kpi_score ?? '';
  document.getElementById('hrr-kpi-amount').value = row.amount ?? '';
  document.getElementById('hrr-kpi-status').value = row.status || 'Awaiting Evaluation';
  document.getElementById('hrr-kpi-payroll').value = row.payroll_status || '';
  document.getElementById('hrr-kpi-remarks').value = row.remarks || '';
  document.getElementById('hrr-kpi-delete').style.display = existing ? '' : 'none';
  openModal('hrr-kpi-modal');
}

// Typing a score fills in the allowance, status and payroll from the tiers;
// HR can still overwrite any of them before saving.
function hrrKpiScoreChanged() {
  const score = document.getElementById('hrr-kpi-score').value;
  const amount = hrrTierAmount(score);
  if (amount === null) {
    document.getElementById('hrr-kpi-status').value = 'Awaiting Evaluation';
    return;
  }
  document.getElementById('hrr-kpi-amount').value = amount || '';
  document.getElementById('hrr-kpi-status').value = amount > 0 ? 'Qualified' : 'Not Qualified';
  const payroll = document.getElementById('hrr-kpi-payroll');
  if (amount > 0 && !payroll.value) payroll.value = 'For Next Payroll';
  if (!amount) payroll.value = '';
}

async function pullHrrKpiScore() {
  const userId = document.getElementById('hrr-kpi-user').value;
  const period = document.getElementById('hrr-kpi-period').value;
  if (!userId) { showToast('warning', 'Pick an employee', 'The score is read from their evaluations.'); return; }
  try {
    const history = await authorizedJsonRequest(`/evaluations/history/${Number(userId)}`);
    // A month covers both of its halves; a half is read on its own.
    const scored = (history?.data || []).filter((row) => Number(row.responses) > 0
      && (row.period === period || String(row.period).startsWith(`${period}-`)));
    if (!scored.length) { showToast('info', 'No evaluation yet', `Nobody has rated them for ${hrrPeriodLabel(period)}.`); return; }
    const average = scored.reduce((sum, row) => sum + Number(row.score || 0), 0) / scored.length;
    document.getElementById('hrr-kpi-score').value = average.toFixed(1);
    hrrKpiScoreChanged();
  } catch (error) {
    hrrToastError(error, 'Could not read evaluations');
  }
}

async function saveHrrKpi(event) {
  event.preventDefault();
  const id = document.getElementById('hrr-kpi-id').value;
  const body = {
    user_id: document.getElementById('hrr-kpi-user').value,
    period_label: document.getElementById('hrr-kpi-period').value,
    kpi_score: document.getElementById('hrr-kpi-score').value,
    amount: document.getElementById('hrr-kpi-amount').value,
    status: document.getElementById('hrr-kpi-status').value,
    payroll_status: document.getElementById('hrr-kpi-payroll').value,
    remarks: document.getElementById('hrr-kpi-remarks').value,
  };
  if (!body.user_id) { showToast('warning', 'Pick an employee', ''); return; }
  try {
    await hrrApi(id ? `/kpi-allowances/${id}` : '/kpi-allowances', { method: id ? 'PUT' : 'POST', body });
    closeModal('hrr-kpi-modal');
    await initKpiAllowancePage();
  } catch (error) {
    hrrToastError(error);
  }
}

async function markHrrKpiReleased(id) {
  try {
    await hrrApi(`/kpi-allowances/${Number(id)}`, { method: 'PUT', body: { payroll_status: 'Released' } });
    await initKpiAllowancePage();
  } catch (error) {
    hrrToastError(error);
  }
}

async function deleteHrrKpi() {
  const id = document.getElementById('hrr-kpi-id').value;
  if (!id || !confirm('Delete this KPI allowance?')) return;
  try {
    await hrrApi(`/kpi-allowances/${id}`, { method: 'DELETE' });
    closeModal('hrr-kpi-modal');
    await initKpiAllowancePage();
  } catch (error) {
    hrrToastError(error, 'Could not delete');
  }
}

function renderHrrTierModal() {
  return `
  <div class="modal-overlay" id="hrr-tier-modal">
    <div class="modal" style="max-width:460px;">
      <div class="modal-header">
        <div class="modal-title">KPI Allowance Rules</div>
        <button class="modal-close" onclick="closeModal('hrr-tier-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <p class="text-xs text-muted" style="margin-top:0;">One rule per line: the lowest KPI score that earns the amount. The best rule a score reaches applies; below every rule is Not Qualified.</p>
        <textarea id="hrr-tier-text" class="form-control" rows="5" placeholder="90 = 1000">${escapeHtml(hrrKpiState.tiers.map((tier) => `${tier.min} = ${tier.amount}`).join('\n'))}</textarea>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="btn btn-primary" style="flex:1;" onclick="saveHrrTiers()">Save Rules</button>
          <button class="btn btn-secondary" onclick="closeModal('hrr-tier-modal')">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
}

async function saveHrrTiers() {
  const lines = String(document.getElementById('hrr-tier-text').value || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const tiers = [];
  for (const line of lines) {
    const match = line.match(/^(\d+(?:\.\d+)?)\s*%?\s*[=:,→>-]+\s*₱?\s*([\d,]+(?:\.\d+)?)$/);
    if (!match) { showToast('warning', 'Check the rules', `Could not read "${line}". Use: 90 = 1000`); return; }
    tiers.push({ min: Number(match[1]), amount: Number(match[2].replace(/,/g, '')) });
  }
  try {
    await hrrApi('/settings/kpi_allowance_tiers', { method: 'PUT', body: { value: tiers } });
    hrrKpiState.tiers = tiers.length ? tiers : HRR_DEFAULT_TIERS;
    closeModal('hrr-tier-modal');
    showToast('success', 'Rules saved', 'New scores use these rules; saved rows keep their amounts.');
  } catch (error) {
    hrrToastError(error);
  }
}

// ─── HR REPORTS ────────────────────────────────────────────
const hrrReportState = { from: '', to: '' };

function renderHrReportsPage() {
  if (!hrrReportState.from) [hrrReportState.from, hrrReportState.to] = hrrCurrentCutoff();
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>HR Reports</h1>
      <p>Attendance and lates, leave, payroll, 201 completeness, memos and Standup / EOD / Self-Care compliance for one range.</p>
    </div>
    <div class="page-actions">
      <input type="date" id="hrr-rep-from" class="hr-toolbar-input" value="${hrrReportState.from}">
      <span>–</span>
      <input type="date" id="hrr-rep-to" class="hr-toolbar-input" value="${hrrReportState.to}">
      <button class="btn btn-primary btn-sm" onclick="hrrReportState.from=document.getElementById('hrr-rep-from').value; hrrReportState.to=document.getElementById('hrr-rep-to').value; initHrReportsPage()">Apply</button>
      <button class="btn btn-secondary btn-sm" onclick="window.print()">Print</button>
    </div>
  </div>
  <div id="hrr-rep-root"><div class="card"><div class="empty-state"><h3>Building the report</h3></div></div></div>`;
}

async function initHrReportsPage() {
  const { from, to } = hrrReportState;
  const root = document.getElementById('hrr-rep-root');
  const [, , summary, attendance, schedules, leaves] = await Promise.all([
    hrrLoadPeople().catch(() => []),
    hrrLoadDocs().catch(() => []),
    authorizedJsonRequest(`/hr/summary?from=${from}&to=${to}`).catch(() => null),
    authorizedJsonRequest(`/hr/attendance?from=${from}&to=${to}`).catch(() => null),
    authorizedJsonRequest(`/hr/schedules?from=${from}&to=${to}`).catch(() => null),
    authorizedJsonRequest(`/hr/leave-requests?from=${from}&to=${to}`).catch(() => null),
  ]);
  if (!root) return;
  const people = hrrActivePeople();
  const payroll = summary?.summary || [];
  const records = attendance?.records || [];
  const shifts = new Map((schedules?.schedules || []).map((row) => [`${row.user_id}|${row.schedule_date}`, row]));
  const leaveRows = leaves?.requests || [];

  // A late is a time-in past that day's scheduled shift start. Days with no
  // schedule are not judged — there is nothing to be late for.
  const toMin = (value) => { const m = String(value || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const attendanceBy = new Map();
  records.forEach((record) => {
    const entry = attendanceBy.get(Number(record.user_id)) || { days: 0, lates: 0, lateMinutes: 0, minutes: 0 };
    if (record.time_in) entry.days += 1;
    entry.minutes += Number(record.worked_minutes || 0);
    const shift = shifts.get(`${record.user_id}|${record.work_date}`);
    const start = toMin(shift?.shift_start);
    const inAt = toMin(record.time_in);
    if (start !== null && inAt !== null && inAt > start) { entry.lates += 1; entry.lateMinutes += inAt - start; }
    attendanceBy.set(Number(record.user_id), entry);
  });

  const overlapDays = (leave) => {
    const start = leave.leave_date_from > from ? leave.leave_date_from : from;
    const end = leave.leave_date_to < to ? leave.leave_date_to : to;
    return end < start ? 0 : Math.round((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000) + 1;
  };
  const leaveBy = new Map();
  leaveRows.forEach((leave) => {
    const entry = leaveBy.get(Number(leave.user_id)) || { approved: 0, pending: 0 };
    if (leave.status === 'approved') entry.approved += overlapDays(leave);
    if (leave.status === 'pending') entry.pending += overlapDays(leave);
    leaveBy.set(Number(leave.user_id), entry);
  });

  const tracker = await hrrTrackerCompliance(from, to);
  const totals = payroll.reduce((sum, row) => ({
    gross: sum.gross + Number(row.gross_pay || 0),
    advances: sum.advances + Number(row.cash_advances || 0),
    net: sum.net + Number(row.net_pay || 0),
  }), { gross: 0, advances: 0, net: 0 });
  const files = people.map((person) => ({ person, file: hrrFileStatus(person) }));
  const avgFile = files.length ? Math.round(files.reduce((sum, row) => sum + row.file.completeness, 0) / files.length) : 0;
  const lateTotal = [...attendanceBy.values()].reduce((sum, row) => sum + row.lates, 0);
  const pct = (value) => (value === null ? '—' : `${value}%`);

  root.innerHTML = `
  <div class="stats-grid">
    ${[
      ['blue', 'Payroll (Net)', formatPHP(totals.net), `${formatPHP(totals.gross)} gross · ${formatPHP(totals.advances)} advances`],
      ['amber', 'Late Incidents', lateTotal, 'time-in past the scheduled shift'],
      ['green', 'Leave Days Approved', [...leaveBy.values()].reduce((sum, row) => sum + row.approved, 0), `${[...leaveBy.values()].reduce((sum, row) => sum + row.pending, 0)} days still pending`],
      ['red', '201 Completeness', `${avgFile}%`, `${files.filter((row) => row.file.completeness < 100).length} files incomplete`],
    ].map(([tone, label, value, meta]) => `<div class="stat-card ${tone}"><div class="stat-card-accent"></div><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(String(value))}</div><div class="stat-meta">${escapeHtml(meta)}</div></div>`).join('')}
  </div>

  <div class="card" style="margin-bottom:20px;">
    <div class="card-header"><div><div class="card-title">Per employee</div><div class="card-subtitle">${escapeHtml(hrrFormatDate(from))} – ${escapeHtml(hrrFormatDate(to))}</div></div></div>
    <div class="card-body"><div class="table-container hrr-scroll"><table>
      <thead><tr><th>Employee</th><th>Department</th><th>Days In</th><th>Hours</th><th>Lates</th><th>Late Min</th><th>Leave (appr.)</th><th>Net Pay</th><th>Standup</th><th>EOD</th><th>Self-Care</th><th>201</th><th>Open Memos</th></tr></thead>
      <tbody>${files.map(({ person, file }) => {
        const att = attendanceBy.get(Number(person.id)) || { days: 0, lates: 0, lateMinutes: 0, minutes: 0 };
        const pay = payroll.find((row) => Number(row.user?.id) === Number(person.id));
        const leave = leaveBy.get(Number(person.id)) || { approved: 0 };
        const comp = tracker[Number(person.id)] || {};
        return `<tr>
          <td><strong>${escapeHtml(hrrPersonName(person))}</strong></td>
          <td>${escapeHtml(employeeDepartment(person))}</td>
          <td>${att.days}</td>
          <td>${(att.minutes / 60).toFixed(1)}</td>
          <td>${att.lates ? `<span class="badge badge-warning">${att.lates}</span>` : '0'}</td>
          <td>${att.lateMinutes}</td>
          <td>${leave.approved}</td>
          <td>${pay ? formatPHP(pay.net_pay) : '—'}</td>
          <td>${pct(comp.standup ?? null)}</td>
          <td>${pct(comp.eod ?? null)}</td>
          <td>${pct(comp.selfcare ?? null)}</td>
          <td>${file.completeness}%</td>
          <td>${file.openMemos}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <p class="text-xs text-muted" style="margin-top:10px;">Standup / EOD / Self-Care read the Employee Tracker marks (attended or late ÷ days marked, rest days left out). Lates only count days with a schedule.</p>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><div><div class="card-title">Documents needing action</div><div class="card-subtitle">Expired or expiring within ${HRR_EXPIRY_WARN_DAYS} days, and open memos past their due date.</div></div></div>
    <div class="card-body">${renderHrrDocTable(hrrState.docs.filter((doc) => {
      const days = hrrDaysUntil(doc.expiry_date);
      if (doc.kind === 'memo') return (doc.status || 'Open') === 'Open' && days !== null && days < 0;
      return days !== null && days <= HRR_EXPIRY_WARN_DAYS;
    }), { memo: false, showEmployee: true })}</div>
  </div>`;
}

// Compliance from the Employee Tracker marks saved on the server: attended (or
// late) over the days that were marked at all, rest days aside.
async function hrrTrackerCompliance(from, to) {
  const data = await authorizedJsonRequest(`/performance/tracker?from=${from}&to=${to}`).catch(() => null);
  const tally = {};
  (data?.marks || []).forEach((mark) => {
    if (!['standup', 'eod', 'selfcare'].includes(mark.metric) || !mark.state || mark.state === 'rest') return;
    const byUser = tally[mark.user_id] || (tally[mark.user_id] = {});
    const entry = byUser[mark.metric] || (byUser[mark.metric] = { good: 0, counted: 0 });
    entry.counted += 1;
    if (mark.state === 'yes' || mark.state === 'late') entry.good += 1;
  });
  const out = {};
  Object.entries(tally).forEach(([userId, metrics]) => {
    out[Number(userId)] = Object.fromEntries(Object.entries(metrics).map(([metric, { good, counted }]) => [metric, Math.round((good / counted) * 100)]));
  });
  return out;
}
