/* ═══════════════════════════════════════════════════════════
   OPERATIONS CALENDAR — delivery schedules (Operations → Calendar)
   Supplier deliveries, courier pickups, stock counts, restock orders and
   payments on a month grid, the same layout as the HR Calendar. Backed by
   /api/ops-calendar. Everyone with the page reads it; Administrator,
   Logistics and Operation edit it.
   Loaded before app.js; it leans on app.js globals (DB, App, escapeHtml,
   authorizedJsonRequest, showToast, openModal, closeModal, manilaToday,
   refreshInventoryFromBackend) read at call time. Styles reuse the HR
   Calendar's hrr-cal* classes.
   ═══════════════════════════════════════════════════════════ */

const OC_CATEGORIES = ['Supplier Delivery', 'Courier Pickup', 'Stock Count', 'Restock Order', 'Payment', 'Other'];
const OC_STATUSES = ['Scheduled', 'Delivered', 'Delayed', 'Cancelled'];
const OC_REPEATS = [['none', 'Does not repeat'], ['weekly', 'Every week'], ['monthly', 'Every month']];
const OC_TONE = {
  'Supplier Delivery': 'oc-delivery',
  'Courier Pickup': 'oc-pickup',
  'Stock Count': 'oc-count',
  'Restock Order': 'oc-restock',
  Payment: 'oc-payment',
  Other: 'oc-other',
};

const ocState = { month: '', events: [], filter: 'all' };

function ocCanEdit() {
  const role = String(App.user?.role || '').trim().toLowerCase();
  return !!App.user?.is_super_admin || ['administrator', 'logistics', 'operation', 'operations'].includes(role);
}

function ocYmd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function ocAddDays(ymd, days) {
  const date = new Date(`${ymd}T00:00:00`);
  date.setDate(date.getDate() + days);
  return ocYmd(date);
}

function ocMonthRange(ym) {
  const [year, month] = ym.split('-').map(Number);
  const last = new Date(year, month, 0).getDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
}

// One-off events land on their date; repeating ones on every matching date
// from their start onward.
function ocEventOn(event, day) {
  const start = String(event.event_date || '');
  if (!start || day < start) return false;
  const rule = event.repeat_rule || 'none';
  if (rule === 'none') return day === start;
  if (rule === 'weekly') return new Date(`${day}T00:00:00`).getDay() === new Date(`${start}T00:00:00`).getDay();
  if (rule === 'monthly') {
    const [year, month] = day.slice(0, 7).split('-').map(Number);
    const last = new Date(year, month, 0).getDate();
    return Number(day.slice(8, 10)) === Math.min(Number(start.slice(8, 10)), last);
  }
  return false;
}

function ocItemsOn(day) {
  return ocState.events
    .filter((event) => ocEventOn(event, day))
    .filter((event) => ocState.filter === 'all' || event.category === ocState.filter);
}

function ocEventMeta(event) {
  return [
    event.event_time ? ocTimeLabel(event.event_time) : '',
    event.item_name ? `${event.item_name}${event.qty ? ` × ${Number(event.qty).toLocaleString()}` : ''}` : (event.qty ? `${Number(event.qty).toLocaleString()} pcs` : ''),
    event.supplier || '',
    event.status !== 'Scheduled' ? event.status : '',
  ].filter(Boolean).join(' · ');
}

function ocTimeLabel(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function ocEventClass(event) {
  const status = event.status === 'Delivered' || event.status === 'Cancelled' ? ' done' : event.status === 'Delayed' ? ' oc-delayed' : '';
  return `hrr-cal-event ${OC_TONE[event.category] || 'oc-other'}${status}`;
}

function renderOpsCalendarPage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Operations Calendar</h1>
      <p>Delivery schedules — supplier deliveries, courier pickups, stock counts and restock orders. Click a date to add one.</p>
    </div>
    <div class="page-actions">
      ${ocCanEdit() ? '<button class="btn btn-primary btn-sm" onclick="openOcEventModal({})">+ Add Schedule</button>' : ''}
    </div>
  </div>
  <div class="hrr-cal-layout">
    <div class="card" id="oc-cal-card"><div class="empty-state"><h3>Loading calendar</h3></div></div>
    <div class="card" id="oc-cal-upcoming"></div>
  </div>
  ${renderOcEventModal()}`;
}

async function initOpsCalendarPage() {
  if (!ocState.month) ocState.month = manilaToday().slice(0, 7);
  if (!(DB.inventory || []).length) await refreshInventoryFromBackend().catch(() => {});
  await ocLoadMonth();
}

async function ocLoadMonth() {
  const [from, to] = ocMonthRange(ocState.month);
  const ahead = ocAddDays(manilaToday(), 14);
  try {
    const data = await authorizedJsonRequest(`/ops-calendar?from=${from}&to=${ahead > to ? ahead : to}`);
    ocState.events = Array.isArray(data?.rows) ? data.rows : [];
  } catch (error) {
    const card = document.getElementById('oc-cal-card');
    if (card) card.innerHTML = `<div class="empty-state"><h3>Could not load</h3><p>${escapeHtml(error.message || 'error')}</p></div>`;
    return;
  }
  renderOcCalendar();
}

function renderOcCalendar() {
  const card = document.getElementById('oc-cal-card');
  if (!card) return;
  const canEdit = ocCanEdit();
  const ym = ocState.month;
  const [year, month] = ym.split('-').map(Number);
  const first = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0).getDate();
  const today = manilaToday();
  const cells = [];
  for (let i = 0; i < first.getDay(); i += 1) cells.push('<td class="hrr-calday empty"></td>');
  for (let d = 1; d <= lastDay; d += 1) {
    const day = `${ym}-${String(d).padStart(2, '0')}`;
    const items = ocItemsOn(day);
    cells.push(`<td class="hrr-calday${day === today ? ' today' : ''}"${canEdit ? ` onclick="if(event.target===this||event.target.classList.contains('hrr-daynum'))openOcEventModal({ event_date: '${day}' })"` : ''}>
      <div class="hrr-daynum">${d}</div>
      ${items.map((item) => {
        const meta = ocEventMeta(item);
        return `<div class="${ocEventClass(item)}" style="cursor:pointer;" onclick="openOcEventModal({ id: ${Number(item.id)} })" title="${escapeHtml(meta)}"><b>${escapeHtml(item.title)}</b>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}</div>`;
      }).join('')}
      ${canEdit ? `<button class="hrr-addcal" onclick="event.stopPropagation(); openOcEventModal({ event_date: '${day}' })">+ Add</button>` : ''}
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
        <div class="card-subtitle">Struck through = delivered or cancelled · red outline = delayed.</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <select class="form-control" style="width:150px;" onchange="ocState.filter=this.value; renderOcCalendar()">
          <option value="all">All types</option>
          ${OC_CATEGORIES.map((c) => `<option value="${escapeHtml(c)}"${ocState.filter === c ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
        <button class="et-nav" onclick="shiftOcCalendar(-1)" aria-label="Previous month">←</button>
        <button class="btn btn-secondary btn-sm" onclick="ocState.month='${today.slice(0, 7)}'; ocLoadMonth()">Today</button>
        <button class="et-nav" onclick="shiftOcCalendar(1)" aria-label="Next month">→</button>
      </div>
    </div>
    <div class="card-body">
      <div class="oc-legend">${OC_CATEGORIES.map((c) => `<span class="hrr-cal-event ${OC_TONE[c]}"><b>${escapeHtml(c)}</b></span>`).join('')}</div>
      <div class="table-scroll"><table class="hrr-calendar">
        <thead><tr>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => `<th>${day}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table></div>
    </div>`;
  renderOcUpcoming();
}

// Next two weeks from today, open schedules only.
function ocUpcoming(daysAhead = 14) {
  const today = manilaToday();
  const days = Array.from({ length: daysAhead + 1 }, (_, i) => ocAddDays(today, i));
  return days.flatMap((day) => ocState.events
    .filter((event) => ocEventOn(event, day) && event.status !== 'Cancelled' && event.status !== 'Delivered')
    .map((event) => ({ ...event, day })));
}

function renderOcUpcoming() {
  const wrap = document.getElementById('oc-cal-upcoming');
  if (!wrap) return;
  const list = ocUpcoming();
  wrap.innerHTML = `
    <div class="card-header"><div><div class="card-title">Next 2 weeks</div><div class="card-subtitle">Open schedules from today.</div></div></div>
    <div class="card-body">
      ${list.length ? list.map((item) => `<div class="hrr-upcoming-item">
        <div class="hrr-upcoming-date">${escapeHtml(new Date(`${item.day}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}</div>
        <div class="${ocEventClass(item)}" style="cursor:pointer;" onclick="openOcEventModal({ id: ${Number(item.id)} })"><b>${escapeHtml(item.title)}</b>${ocEventMeta(item) ? `<span>${escapeHtml(ocEventMeta(item))}</span>` : ''}</div>
      </div>`).join('') : '<div class="empty-state"><p>Nothing scheduled in the next two weeks.</p></div>'}
    </div>`;
}

function shiftOcCalendar(step) {
  const [year, month] = ocState.month.split('-').map(Number);
  const date = new Date(year, month - 1 + step, 1);
  ocState.month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  ocLoadMonth();
}

/* ── Add / edit ─────────────────────────────────────────────── */

function renderOcEventModal() {
  return `
  <div class="modal-overlay" id="oc-event-modal">
    <div class="modal" style="max-width:600px;">
      <div class="modal-header">
        <div class="modal-title" id="oc-event-title">Add Schedule</div>
        <button class="modal-close" onclick="closeModal('oc-event-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <form onsubmit="saveOcEvent(event)">
          <input type="hidden" id="oc-event-id">
          <fieldset id="oc-event-fields" style="border:0;padding:0;margin:0;">
            <div class="form-grid-2">
              <div class="form-group"><label class="form-label">Date</label><input type="date" id="oc-event-date" class="form-control" required></div>
              <div class="form-group"><label class="form-label">Time (optional)</label><input type="time" id="oc-event-time" class="form-control"></div>
            </div>
            <div class="form-grid-2">
              <div class="form-group"><label class="form-label">Type</label><select id="oc-event-category" class="form-control">${OC_CATEGORIES.map((c) => `<option>${escapeHtml(c)}</option>`).join('')}</select></div>
              <div class="form-group"><label class="form-label">Status</label><select id="oc-event-status" class="form-control">${OC_STATUSES.map((s) => `<option>${escapeHtml(s)}</option>`).join('')}</select></div>
            </div>
            <div class="form-group"><label class="form-label">Title</label><input type="text" id="oc-event-name" class="form-control" placeholder="e.g. Paragis Coffee delivery" required></div>
            <div class="form-grid-2">
              <div class="form-group"><label class="form-label">Product (optional)</label><select id="oc-event-item" class="form-control"></select></div>
              <div class="form-group"><label class="form-label">Quantity (optional)</label><input type="number" min="1" step="1" id="oc-event-qty" class="form-control" placeholder="0"></div>
            </div>
            <div class="form-grid-2">
              <div class="form-group"><label class="form-label">Supplier / courier</label><input type="text" id="oc-event-supplier" class="form-control" placeholder="Supplier or courier name"></div>
              <div class="form-group"><label class="form-label">Repeat</label><select id="oc-event-repeat" class="form-control">${OC_REPEATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
            </div>
            <div class="form-group"><label class="form-label">Notes</label><textarea id="oc-event-notes" class="form-control" rows="3" placeholder="DR number, contact person, instructions…"></textarea></div>
          </fieldset>
          <div class="text-xs text-muted" id="oc-event-by" style="margin-bottom:10px;"></div>
          <div style="display:flex;gap:8px;" id="oc-event-actions">
            <button type="submit" class="btn btn-primary" style="flex:1;">Save Schedule</button>
            <button type="button" class="btn btn-secondary" id="oc-event-delete" onclick="deleteOcEvent()">Delete</button>
            <button type="button" class="btn btn-secondary" onclick="closeModal('oc-event-modal')">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

function ocItemOptions(selected) {
  const items = (DB.inventory || []).filter((i) => i.active !== 0 || i.id === selected);
  return `<option value="">— None —</option>${items.map((i) => `<option value="${escapeHtml(i.id)}"${i.id === selected ? ' selected' : ''}>${escapeHtml(i.name)}${i.sku ? ` (${escapeHtml(i.sku)})` : ''}</option>`).join('')}`;
}

function openOcEventModal(preset = {}) {
  const existing = preset.id ? ocState.events.find((e) => Number(e.id) === Number(preset.id)) : null;
  const canEdit = ocCanEdit();
  if (!existing && !canEdit) return;
  const event = { ...(existing || {}), ...preset };
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  document.getElementById('oc-event-title').textContent = existing ? (canEdit ? 'Edit Schedule' : 'Schedule') : 'Add Schedule';
  set('oc-event-id', existing ? existing.id : '');
  set('oc-event-date', event.event_date || manilaToday());
  set('oc-event-time', event.event_time || '');
  set('oc-event-category', event.category || 'Supplier Delivery');
  set('oc-event-status', event.status || 'Scheduled');
  set('oc-event-name', event.title || '');
  document.getElementById('oc-event-item').innerHTML = ocItemOptions(event.item_id || '');
  set('oc-event-qty', event.qty ?? '');
  set('oc-event-supplier', event.supplier || '');
  set('oc-event-repeat', event.repeat_rule || 'none');
  set('oc-event-notes', event.notes || '');
  document.getElementById('oc-event-fields').disabled = !canEdit;
  document.getElementById('oc-event-actions').style.display = canEdit ? 'flex' : 'none';
  document.getElementById('oc-event-delete').style.display = existing ? '' : 'none';
  document.getElementById('oc-event-by').textContent = existing?.created_by_name ? `Added by ${existing.created_by_name}` : '';
  openModal('oc-event-modal');
}

async function saveOcEvent(e) {
  e.preventDefault();
  const id = document.getElementById('oc-event-id').value;
  const get = (key) => document.getElementById(key)?.value || '';
  const body = {
    event_date: get('oc-event-date'),
    event_time: get('oc-event-time'),
    category: get('oc-event-category'),
    status: get('oc-event-status'),
    title: get('oc-event-name'),
    item_id: get('oc-event-item'),
    qty: get('oc-event-qty'),
    supplier: get('oc-event-supplier'),
    repeat_rule: get('oc-event-repeat'),
    notes: get('oc-event-notes'),
  };
  try {
    await authorizedJsonRequest(id ? `/ops-calendar/${id}` : '/ops-calendar', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    closeModal('oc-event-modal');
    showToast('success', 'Schedule saved', body.title);
    await ocLoadMonth();
  } catch (error) {
    showToast('error', 'Not saved', error.message || 'Request failed');
  }
}

async function deleteOcEvent() {
  const id = document.getElementById('oc-event-id').value;
  if (!id || !confirm('Delete this schedule? A repeating one is removed from every date.')) return;
  try {
    await authorizedJsonRequest(`/ops-calendar/${id}`, { method: 'DELETE' });
    closeModal('oc-event-modal');
    await ocLoadMonth();
  } catch (error) {
    showToast('error', 'Could not delete', error.message || 'Request failed');
  }
}

// For the Stock dashboard's "Upcoming deliveries" card.
async function loadOpsUpcoming(daysAhead = 14) {
  const today = manilaToday();
  const data = await authorizedJsonRequest(`/ops-calendar?from=${today}&to=${ocAddDays(today, daysAhead)}`);
  ocState.events = Array.isArray(data?.rows) ? data.rows : [];
  return ocUpcoming(daysAhead);
}

window.renderOpsCalendarPage = renderOpsCalendarPage;
window.initOpsCalendarPage = initOpsCalendarPage;
window.loadOpsUpcoming = loadOpsUpcoming;
window.ocEventMeta = ocEventMeta;
window.ocEventClass = ocEventClass;
