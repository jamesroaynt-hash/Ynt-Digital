/* ═══════════════════════════════════════════════════════════
   OPERATIONS CALENDAR — incoming orders from suppliers
   Each supplier order sits on the month grid on its expected arrival date
   and moves Ordered → Paid → In Transit → Arrived (or Delayed / Cancelled).
   Same layout as the HR Calendar; an order list below tracks them all.
   Backed by /api/ops-calendar. Everyone with the page reads it;
   Administrator, Logistics and Operation edit it.
   Loaded before app.js; it leans on app.js globals (DB, App, escapeHtml,
   authorizedJsonRequest, showToast, openModal, closeModal, manilaToday,
   formatPHP, refreshInventoryFromBackend) read at call time. Styles reuse
   the HR Calendar's hrr-cal* classes.
   ═══════════════════════════════════════════════════════════ */

const OC_STATUSES = ['Ordered', 'Paid', 'In Transit', 'Arrived', 'Delayed', 'Cancelled'];
const OC_OPEN = ['Ordered', 'Paid', 'In Transit', 'Delayed'];
const OC_TONE = {
  Ordered: 'oc-ordered',
  Paid: 'oc-paid',
  'In Transit': 'oc-transit',
  Arrived: 'oc-arrived',
  Delayed: 'oc-delayed',
  Cancelled: 'oc-cancelled',
};
const OC_BADGE = { Ordered: 'info', Paid: 'info', 'In Transit': 'warning', Arrived: 'success', Delayed: 'danger', Cancelled: 'gray' };

const ocState = { month: '', events: [], filter: 'all', listFilter: 'open' };

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

function ocDateLabel(day) {
  return day ? new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}

function ocIsOverdue(order) {
  return OC_OPEN.includes(order.status) && order.event_date < manilaToday();
}

function ocOrderName(order) {
  return order.title || order.item_name || 'Supplier order';
}

function ocEventMeta(order) {
  return [
    order.qty ? `${Number(order.qty).toLocaleString()} ${order.item_unit || 'pcs'}` : '',
    order.supplier || '',
    order.po_number ? `PO ${order.po_number}` : '',
    order.status,
  ].filter(Boolean).join(' · ');
}

function ocEventClass(order) {
  const done = order.status === 'Cancelled' ? ' done' : '';
  return `hrr-cal-event ${OC_TONE[order.status] || 'oc-ordered'}${done}${ocIsOverdue(order) ? ' oc-overdue' : ''}`;
}

function ocStatusBadge(order) {
  return `<span class="badge badge-${OC_BADGE[order.status] || 'gray'}">${escapeHtml(order.status)}</span>${ocIsOverdue(order) ? ' <span class="badge badge-danger">Overdue</span>' : ''}`;
}

function renderOpsCalendarPage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Supplier Order Calendar</h1>
      <p>Track incoming orders from suppliers by their expected arrival date. Click a date to add an order.</p>
    </div>
    <div class="page-actions">
      ${ocCanEdit() ? '<button class="btn btn-primary btn-sm" onclick="openOcEventModal({})">+ Add Supplier Order</button>' : ''}
    </div>
  </div>
  <div class="hrr-cal-layout">
    <div class="card" id="oc-cal-card"><div class="empty-state"><h3>Loading calendar</h3></div></div>
    <div class="card" id="oc-cal-upcoming"></div>
  </div>
  <div class="card" id="oc-orders" style="margin-top:20px;"></div>
  ${renderOcEventModal()}`;
}

async function initOpsCalendarPage() {
  if (!ocState.month) ocState.month = manilaToday().slice(0, 7);
  if (!(DB.inventory || []).length) await refreshInventoryFromBackend().catch(() => {});
  await ocLoadMonth();
}

// The whole order book is small, so it loads at once: the calendar shows the
// month, the side panel what is due, and the list every order.
async function ocLoadMonth() {
  try {
    const data = await authorizedJsonRequest(`/ops-calendar?_=${Date.now()}`);
    ocState.events = Array.isArray(data?.rows) ? data.rows : [];
  } catch (error) {
    const card = document.getElementById('oc-cal-card');
    if (card) card.innerHTML = `<div class="empty-state"><h3>Could not load</h3><p>${escapeHtml(error.message || 'error')}</p></div>`;
    return;
  }
  renderOcCalendar();
  renderOcOrders();
}

function ocItemsOn(day) {
  return ocState.events
    .filter((order) => order.event_date === day)
    .filter((order) => ocState.filter === 'all' || order.status === ocState.filter);
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
        return `<div class="${ocEventClass(item)}" style="cursor:pointer;" onclick="openOcEventModal({ id: ${Number(item.id)} })" title="${escapeHtml(meta)}"><b>${escapeHtml(ocOrderName(item))}</b>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}</div>`;
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
        <div class="card-subtitle">Orders on their expected arrival date · red outline = overdue.</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <select class="form-control" style="width:150px;" onchange="ocState.filter=this.value; renderOcCalendar()">
          <option value="all">All statuses</option>
          ${OC_STATUSES.map((s) => `<option value="${escapeHtml(s)}"${ocState.filter === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('')}
        </select>
        <button class="et-nav" onclick="shiftOcCalendar(-1)" aria-label="Previous month">←</button>
        <button class="btn btn-secondary btn-sm" onclick="ocState.month='${today.slice(0, 7)}'; renderOcCalendar()">Today</button>
        <button class="et-nav" onclick="shiftOcCalendar(1)" aria-label="Next month">→</button>
      </div>
    </div>
    <div class="card-body">
      <div class="oc-legend">${OC_STATUSES.map((s) => `<span class="hrr-cal-event ${OC_TONE[s]}${s === 'Cancelled' ? ' done' : ''}"><b>${escapeHtml(s)}</b></span>`).join('')}</div>
      <div class="table-scroll"><table class="hrr-calendar">
        <thead><tr>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => `<th>${day}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table></div>
    </div>`;
  renderOcUpcoming();
}

// Open orders due within `daysAhead`, overdue ones first.
function ocUpcoming(daysAhead = 14) {
  const until = ocAddDays(manilaToday(), daysAhead);
  return ocState.events
    .filter((order) => OC_OPEN.includes(order.status) && order.event_date <= until)
    .sort((a, b) => a.event_date.localeCompare(b.event_date))
    .map((order) => ({ ...order, day: order.event_date }));
}

function renderOcUpcoming() {
  const wrap = document.getElementById('oc-cal-upcoming');
  if (!wrap) return;
  const list = ocUpcoming();
  wrap.innerHTML = `
    <div class="card-header"><div><div class="card-title">Arriving soon</div><div class="card-subtitle">Open orders due in the next 2 weeks, and any overdue.</div></div></div>
    <div class="card-body">
      ${list.length ? list.map((item) => `<div class="hrr-upcoming-item">
        <div class="hrr-upcoming-date${ocIsOverdue(item) ? ' oc-late' : ''}">${escapeHtml(new Date(`${item.day}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}${ocIsOverdue(item) ? '<br>Overdue' : ''}</div>
        <div class="${ocEventClass(item)}" style="cursor:pointer;" onclick="openOcEventModal({ id: ${Number(item.id)} })"><b>${escapeHtml(ocOrderName(item))}</b><span>${escapeHtml(ocEventMeta(item))}</span></div>
      </div>`).join('') : '<div class="empty-state"><p>No open orders due in the next two weeks.</p></div>'}
    </div>`;
}

function shiftOcCalendar(step) {
  const [year, month] = ocState.month.split('-').map(Number);
  const date = new Date(year, month - 1 + step, 1);
  ocState.month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  renderOcCalendar();
}

/* ── Order list ─────────────────────────────────────────────── */

function renderOcOrders() {
  const wrap = document.getElementById('oc-orders');
  if (!wrap) return;
  const filter = ocState.listFilter;
  const orders = ocState.events
    .filter((o) => (filter === 'open' ? OC_OPEN.includes(o.status) : filter === 'arrived' ? o.status === 'Arrived' : true))
    .sort((a, b) => (filter === 'open' ? a.event_date.localeCompare(b.event_date) : b.event_date.localeCompare(a.event_date)));
  const open = ocState.events.filter((o) => OC_OPEN.includes(o.status));
  const openValue = open.reduce((s, o) => s + Number(o.amount || 0), 0);
  wrap.innerHTML = `
    <div class="card-header" style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;">
      <div><div class="card-title">Supplier orders</div><div class="card-subtitle">${open.length} open · ${formatPHP(openValue)} on order · ${ocState.events.filter(ocIsOverdue).length} overdue</div></div>
      <div style="display:flex;gap:6px;">
        ${[['open', 'Open'], ['arrived', 'Arrived'], ['all', 'All']].map(([k, l]) => `<button class="btn btn-sm ${filter === k ? 'btn-primary' : 'btn-secondary'}" onclick="ocState.listFilter='${k}'; renderOcOrders()">${l}</button>`).join('')}
      </div>
    </div>
    <div class="table-container"><table class="oc-table">
      <thead><tr><th>PO No.</th><th>Supplier</th><th>Product</th><th class="num">Ordered</th><th class="num">Received</th><th>Order date</th><th>Expected</th><th class="num">Amount</th><th>Tracking</th><th>Status</th></tr></thead>
      <tbody>${orders.length ? orders.map((o) => `<tr class="pi-row-link" tabindex="0" onclick="openOcEventModal({ id: ${Number(o.id)} })" onkeydown="if (event.key === 'Enter') openOcEventModal({ id: ${Number(o.id)} })">
        <td class="font-mono text-xs">${escapeHtml(o.po_number || '—')}</td>
        <td>${escapeHtml(o.supplier || '—')}</td>
        <td style="font-weight:500">${escapeHtml(ocOrderName(o))}</td>
        <td class="num">${o.qty ? Number(o.qty).toLocaleString() : '—'}</td>
        <td class="num">${o.qty_received === null || o.qty_received === undefined ? '—' : `<span class="${o.qty && o.qty_received < o.qty ? 'oc-short' : ''}">${Number(o.qty_received).toLocaleString()}</span>`}</td>
        <td>${escapeHtml(o.order_date ? ocDateLabel(o.order_date) : '—')}</td>
        <td${ocIsOverdue(o) ? ' class="oc-late"' : ''}>${escapeHtml(ocDateLabel(o.event_date))}</td>
        <td class="num">${o.amount ? formatPHP(o.amount) : '—'}</td>
        <td class="text-xs">${escapeHtml([o.courier, o.tracking_no].filter(Boolean).join(' · ') || '—')}</td>
        <td>${ocStatusBadge(o)}</td>
      </tr>`).join('') : `<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted)">${filter === 'open' ? 'No open orders.' : 'No orders yet.'}</td></tr>`}</tbody>
    </table></div>`;
}

/* ── Add / edit ─────────────────────────────────────────────── */

function renderOcEventModal() {
  return `
  <div class="modal-overlay" id="oc-event-modal">
    <div class="modal" style="max-width:640px;">
      <div class="modal-header">
        <div class="modal-title" id="oc-event-title">Add Supplier Order</div>
        <button class="modal-close" onclick="closeModal('oc-event-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <form onsubmit="saveOcEvent(event)">
          <input type="hidden" id="oc-event-id">
          <fieldset id="oc-event-fields" style="border:0;padding:0;margin:0;">
            <div class="form-grid-2">
              <div class="form-group"><label class="form-label">Product</label><select id="oc-event-item" class="form-control" onchange="ocSyncTitle()"></select></div>
              <div class="form-group"><label class="form-label">Status</label><select id="oc-event-status" class="form-control">${OC_STATUSES.map((s) => `<option>${escapeHtml(s)}</option>`).join('')}</select></div>
            </div>
            <div class="form-group"><label class="form-label">Order title</label><input type="text" id="oc-event-name" class="form-control" placeholder="Defaults to the product name"></div>
            <div class="form-grid-2">
              <div class="form-group"><label class="form-label">Supplier</label><input type="text" id="oc-event-supplier" class="form-control" placeholder="Supplier name"></div>
              <div class="form-group"><label class="form-label">PO / Order No.</label><input type="text" id="oc-event-po" class="form-control" placeholder="PO-0001"></div>
            </div>
            <div class="form-grid-2">
              <div class="form-group"><label class="form-label">Order date</label><input type="date" id="oc-event-order-date" class="form-control"></div>
              <div class="form-group"><label class="form-label">Expected arrival <span class="required">*</span></label><input type="date" id="oc-event-date" class="form-control" required></div>
            </div>
            <div class="form-grid-2">
              <div class="form-group"><label class="form-label">Qty ordered</label><input type="number" min="0" step="1" id="oc-event-qty" class="form-control" placeholder="0"></div>
              <div class="form-group"><label class="form-label">Qty received</label><input type="number" min="0" step="1" id="oc-event-received" class="form-control" placeholder="Fill in when it arrives"></div>
            </div>
            <div class="form-grid-2">
              <div class="form-group"><label class="form-label">Total amount (₱)</label><input type="number" min="0" step="0.01" id="oc-event-amount" class="form-control" placeholder="0.00"></div>
              <div class="form-group"><label class="form-label">Arrival time (optional)</label><input type="time" id="oc-event-time" class="form-control"></div>
            </div>
            <div class="form-grid-2">
              <div class="form-group"><label class="form-label">Courier / forwarder</label><input type="text" id="oc-event-courier" class="form-control" placeholder="e.g. LBC, J&amp;T, own truck"></div>
              <div class="form-group"><label class="form-label">Tracking no.</label><input type="text" id="oc-event-tracking" class="form-control" placeholder="Tracking / waybill no."></div>
            </div>
            <div class="form-group"><label class="form-label">Notes</label><textarea id="oc-event-notes" class="form-control" rows="3" placeholder="Payment terms, contact person, DR number…"></textarea></div>
          </fieldset>
          <div class="text-xs text-muted" id="oc-event-by" style="margin-bottom:10px;"></div>
          <div style="display:flex;gap:8px;" id="oc-event-actions">
            <button type="submit" class="btn btn-primary" style="flex:1;">Save Order</button>
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
  return `<option value="">— Select product —</option>${items.map((i) => `<option value="${escapeHtml(i.id)}"${i.id === selected ? ' selected' : ''}>${escapeHtml(i.name)}${i.sku ? ` (${escapeHtml(i.sku)})` : ''}</option>`).join('')}`;
}

// The title follows the product until someone types their own.
function ocSyncTitle() {
  const title = document.getElementById('oc-event-name');
  const select = document.getElementById('oc-event-item');
  if (!title || !select || (title.value && title.dataset.auto !== '1')) return;
  const item = (DB.inventory || []).find((i) => i.id === select.value);
  title.value = item ? item.name : '';
  title.dataset.auto = '1';
}

function openOcEventModal(preset = {}) {
  const existing = preset.id ? ocState.events.find((e) => Number(e.id) === Number(preset.id)) : null;
  const canEdit = ocCanEdit();
  if (!existing && !canEdit) return;
  const order = { ...(existing || {}), ...preset };
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value ?? ''; };
  document.getElementById('oc-event-title').textContent = existing ? (canEdit ? 'Edit Supplier Order' : 'Supplier Order') : 'Add Supplier Order';
  set('oc-event-id', existing ? existing.id : '');
  document.getElementById('oc-event-item').innerHTML = ocItemOptions(order.item_id || '');
  set('oc-event-status', order.status || 'Ordered');
  set('oc-event-name', order.title || '');
  document.getElementById('oc-event-name').dataset.auto = existing ? '' : '1';
  set('oc-event-supplier', order.supplier);
  set('oc-event-po', order.po_number);
  set('oc-event-order-date', order.order_date || (existing ? '' : manilaToday()));
  set('oc-event-date', order.event_date || manilaToday());
  set('oc-event-qty', order.qty);
  set('oc-event-received', order.qty_received);
  set('oc-event-amount', order.amount);
  set('oc-event-time', order.event_time);
  set('oc-event-courier', order.courier);
  set('oc-event-tracking', order.tracking_no);
  set('oc-event-notes', order.notes);
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
    item_id: get('oc-event-item'),
    status: get('oc-event-status'),
    title: get('oc-event-name'),
    supplier: get('oc-event-supplier'),
    po_number: get('oc-event-po'),
    order_date: get('oc-event-order-date'),
    event_date: get('oc-event-date'),
    qty: get('oc-event-qty'),
    qty_received: get('oc-event-received'),
    amount: get('oc-event-amount'),
    event_time: get('oc-event-time'),
    courier: get('oc-event-courier'),
    tracking_no: get('oc-event-tracking'),
    notes: get('oc-event-notes'),
  };
  if (!body.item_id && !body.title.trim()) {
    showToast('error', 'Product needed', 'Pick a product or give the order a title.');
    return;
  }
  if (body.status === 'Arrived' && body.qty && body.qty_received === '') {
    showToast('warning', 'Qty received?', 'Enter how many arrived so short deliveries show up.');
    return;
  }
  try {
    await authorizedJsonRequest(id ? `/ops-calendar/${id}` : '/ops-calendar', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    closeModal('oc-event-modal');
    showToast('success', 'Order saved', body.title || '');
    await ocLoadMonth();
  } catch (error) {
    showToast('error', 'Not saved', error.message || 'Request failed');
  }
}

async function deleteOcEvent() {
  const id = document.getElementById('oc-event-id').value;
  if (!id || !confirm('Delete this supplier order?')) return;
  try {
    await authorizedJsonRequest(`/ops-calendar/${id}`, { method: 'DELETE' });
    closeModal('oc-event-modal');
    await ocLoadMonth();
  } catch (error) {
    showToast('error', 'Could not delete', error.message || 'Request failed');
  }
}

// For the Stock dashboard's "Incoming orders" card.
async function loadOpsUpcoming(daysAhead = 14) {
  const data = await authorizedJsonRequest(`/ops-calendar?_=${Date.now()}`);
  ocState.events = Array.isArray(data?.rows) ? data.rows : [];
  return ocUpcoming(daysAhead);
}

window.renderOpsCalendarPage = renderOpsCalendarPage;
window.initOpsCalendarPage = initOpsCalendarPage;
window.loadOpsUpcoming = loadOpsUpcoming;
window.ocEventMeta = ocEventMeta;
window.ocEventClass = ocEventClass;
window.ocOrderName = ocOrderName;
