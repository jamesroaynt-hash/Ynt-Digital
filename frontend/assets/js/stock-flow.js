/* ═══════════════════════════════════════════════════════════
   STOCK FLOW — the daily inventory cycle for Logistics
   Today · Picking & Stock Out · Stock In · Returns · Stock Count · Balance
   Backed by /api/stock-flow. Building a picking list never touches stock;
   stock goes down once per day when what was actually packed is posted, up
   when supplies are received or an opened return is restocked, and a shelf
   count adjusts it with the variance kept.
   Loaded before app.js; it leans on app.js globals (escapeHtml,
   authorizedJsonRequest, showToast, formatDateTime, manilaToday,
   canManageInventoryStock, refreshInventoryFromBackend) read at call time.
   ═══════════════════════════════════════════════════════════ */

const SF_TABS = [
  { id: 'today', label: 'Today' },
  { id: 'picking', label: 'Picking & Stock Out' },
  { id: 'stock-in', label: 'Stock In' },
  { id: 'returns', label: 'Returns' },
  { id: 'count', label: 'Stock Count' },
  { id: 'balance', label: 'Balance' },
];

const SF_MOVEMENT_LABEL = {
  stock_in: 'Stock in',
  stock_out: 'Stock out',
  stock_out_void: 'Stock out voided',
  return: 'Return restocked',
  count: 'Count adjustment',
  rts_fold: 'Old RTS pcs folded in',
};

const sfState = {
  tab: 'today',
  items: [],
  overview: null,
  pickingDate: '',
  picking: null,
  packed: {},
  reasons: {},
  returns: null,
  returnsPreview: null,
  returnsFilter: 'pending',
  counts: null,
  countDate: '',
  countInputs: {},
  balanceFrom: '',
  balanceTo: '',
  balance: null,
  stockInLogs: null,
};

function sfApi(path, options = {}) {
  const init = { ...options };
  if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
  return authorizedJsonRequest(`/stock-flow${path}`, init);
}

function sfCanWrite() {
  return typeof canManageInventoryStock === 'function' && canManageInventoryStock();
}

function sfAddDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function sfDateLabel(day) {
  if (!day) return '';
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function sfNum(n) {
  return Number(n || 0).toLocaleString();
}

function sfSigned(n) {
  const v = Number(n || 0);
  if (!v) return '<span class="text-muted">0</span>';
  return `<span class="${v > 0 ? 'sf-pos' : 'sf-neg'}">${v > 0 ? '+' : '−'}${Math.abs(v).toLocaleString()}</span>`;
}

function sfEmpty(title, body = '') {
  return `<div class="empty-state"><h3>${escapeHtml(title)}</h3>${body ? `<p>${body}</p>` : ''}</div>`;
}

function sfItemOptions(selected, { placeholder = 'Select item…', productsOnly = false } = {}) {
  const items = sfState.items.filter((i) => i.active !== 0 && (!productsOnly || i.type === 'Product'));
  return `<option value="">${escapeHtml(placeholder)}</option>${items.map((i) => `<option value="${escapeHtml(i.id)}"${i.id === selected ? ' selected' : ''}>${escapeHtml(i.name)}${i.sku ? ` (${escapeHtml(i.sku)})` : ''}</option>`).join('')}`;
}

/* ── Page shell ─────────────────────────────────────────────── */

function renderStockFlowPage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Stock Flow</h1>
      <p>Stock in → picking list → stock out of what was packed → inspected returns → shelf count. Every change is logged.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="navigateTo('inventory')">Open Inventory</button>
    </div>
  </div>
  <div class="tabs sf-tabs" id="sf-tabs">
    ${SF_TABS.map((t) => `<button class="tab-btn${t.id === sfState.tab ? ' active' : ''}" data-sf-tab="${t.id}" onclick="sfSwitchTab('${t.id}')">${t.label}</button>`).join('')}
  </div>
  <div id="sf-root">${sfEmpty('Loading')}</div>`;
}

async function initStockFlowPage() {
  try {
    await refreshInventoryFromBackend();
  } catch { /* the tab shows its own error */ }
  sfState.items = Array.isArray(DB.inventory) ? DB.inventory : [];
  sfSwitchTab(sfState.tab);
}

function sfSwitchTab(tab) {
  sfState.tab = tab;
  document.querySelectorAll('#sf-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.sfTab === tab));
  const root = document.getElementById('sf-root');
  if (root) root.innerHTML = sfEmpty('Loading');
  const loaders = {
    today: sfLoadToday,
    picking: sfLoadPicking,
    'stock-in': sfLoadStockIn,
    returns: sfLoadReturns,
    count: sfLoadCount,
    balance: sfLoadBalance,
  };
  (loaders[tab] || sfLoadToday)().catch((error) => {
    const el = document.getElementById('sf-root');
    if (el && sfState.tab === tab) el.innerHTML = sfEmpty('Could not load', escapeHtml(error.message || 'error'));
  });
}

function sfRoot(html) {
  const root = document.getElementById('sf-root');
  if (root) root.innerHTML = html;
}

/* ── Today ──────────────────────────────────────────────────── */

async function sfLoadToday() {
  sfState.overview = await sfApi('/overview');
  if (sfState.tab === 'today') sfRenderToday();
}

function sfStep(n, title, state, body, action) {
  const tone = { done: 'success', todo: 'warning', off: 'gray', alert: 'danger' }[state] || 'gray';
  const label = { done: 'Done', todo: 'To do', off: 'Not set up', alert: 'Check' }[state] || '';
  return `<div class="sf-step sf-step-${state}">
    <div class="sf-step-head"><span class="sf-step-num">${n}</span><b>${escapeHtml(title)}</b><span class="badge badge-${tone}">${label}</span></div>
    <div class="sf-step-body">${body}</div>
    ${action ? `<div class="sf-step-action">${action}</div>` : ''}
  </div>`;
}

function sfRenderToday() {
  const o = sfState.overview;
  if (!o) return;
  const pickDate = sfDateLabel(o.picking.date);
  const unmapped = o.picking.unmapped || [];
  const outDone = o.stock_out.status === 'posted';
  const returns = o.returns || {};
  const stock = o.stock || [];
  const products = stock.filter((s) => s.type === 'Product');
  const fast = [...products].filter((s) => s.avg_daily_out > 0).sort((a, b) => b.avg_daily_out - a.avg_daily_out);
  const dueCount = (fast.length ? fast : products).filter((s) => s.days_since_count === null || s.days_since_count >= 7);
  const reorder = stock.filter((s) => s.low || (s.days_cover !== null && s.days_cover < 7));

  const steps = [
    sfStep(1, `Picking list — ${pickDate}`, unmapped.length ? 'alert' : (o.picking.orders ? 'done' : 'off'),
      `${sfNum(o.picking.orders)} confirmed orders · <b>${sfNum(o.picking.pcs)} pcs</b> across ${sfNum(o.picking.items)} item(s).${unmapped.length ? `<br><span class="sf-neg">${unmapped.length} page(s) not linked to an item: ${unmapped.map((u) => escapeHtml(u.page)).join(', ')}.</span>` : ''}`,
      `<button class="btn btn-secondary btn-sm" onclick="sfOpenPicking('${o.picking.date}')">Open picking list</button>`),
    sfStep(2, `Stock out — ${pickDate}`, outDone ? 'done' : (o.picking.orders ? 'todo' : 'off'),
      outDone ? `Posted: <b>${sfNum(o.stock_out.packed_pcs)} pcs</b> deducted.` : o.stock_out.status === 'voided' ? 'Voided — post it again after correcting.' : 'Not posted yet. Post the quantity that was actually packed and handed to the courier.',
      outDone ? '' : `<button class="btn btn-primary btn-sm" onclick="sfOpenPicking('${o.picking.date}')">Record stock out</button>`),
    sfStep(3, 'Returns to inspect', !returns.started ? 'off' : returns.pending_count ? 'todo' : 'done',
      !returns.started
        ? 'RTS scans are still added to Total Stock unopened. Switch on inspected returns so only sellable pcs go back.'
        : returns.pending_count
          ? `<b>${sfNum(returns.pending_count)} parcel(s)</b> · ${sfNum(returns.pending_pcs)} pcs waiting${returns.oldest_pending ? ` (oldest ${escapeHtml(returns.oldest_pending)})` : ''}.`
          : 'Every scanned return has been inspected.',
      `<button class="btn btn-secondary btn-sm" onclick="sfSwitchTab('returns')">${returns.started ? 'Inspect returns' : 'Set up'}</button>`),
    sfStep(4, 'Weekly shelf count', dueCount.length ? 'todo' : 'done',
      dueCount.length
        ? `${dueCount.length} item(s) not counted in the last 7 days${fast.length ? ' — fastest movers first' : ''}: ${dueCount.slice(0, 5).map((s) => escapeHtml(s.name)).join(', ')}${dueCount.length > 5 ? '…' : ''}.`
        : 'Every product was counted this week.',
      `<button class="btn btn-secondary btn-sm" onclick="sfSwitchTab('count')">Count stock</button>`),
  ];

  const statusBadge = (s) => {
    if (s.low) return '<span class="badge badge-danger">Below reorder</span>';
    if (s.days_cover !== null && s.days_cover < 7) return '<span class="badge badge-warning">Reorder soon</span>';
    return '<span class="badge badge-success">OK</span>';
  };

  sfRoot(`
    <div class="sf-steps">${steps.join('')}</div>
    ${reorder.length ? `<div class="alert alert-warning" style="margin-top:16px;"><div><strong>Replenish:</strong> ${reorder.map((s) => `${escapeHtml(s.name)} (${sfNum(s.stock)} left${s.days_cover !== null ? `, ~${s.days_cover} day(s)` : ''})`).join(' · ')}</div></div>` : ''}
    <div class="card" style="margin-top:16px;">
      <div class="card-header"><div><div class="card-title">Stock health</div><div class="card-subtitle">Days of cover = stock ÷ average daily stock out over the last 14 days of posted stock outs.</div></div></div>
      <div class="table-container"><table>
        <thead><tr><th>Item</th><th>SKU</th><th class="num">Stock</th><th class="num">Reorder pt</th><th class="num">Avg out / day</th><th class="num">Days of cover</th><th>Last counted</th><th>Status</th></tr></thead>
        <tbody>${stock.length ? stock.map((s) => `<tr>
          <td style="font-weight:500">${escapeHtml(s.name)}</td>
          <td><span class="font-mono text-xs text-muted">${escapeHtml(s.sku || '—')}</span></td>
          <td class="num"><b>${sfNum(s.stock)}</b> ${escapeHtml(s.unit || '')}</td>
          <td class="num">${sfNum(s.reorder_pt)}</td>
          <td class="num">${s.avg_daily_out ? s.avg_daily_out : '—'}</td>
          <td class="num">${s.days_cover === null ? '—' : sfNum(s.days_cover)}</td>
          <td>${s.last_counted ? `${escapeHtml(s.last_counted)} <span class="text-xs text-muted">(${s.days_since_count}d)</span>` : '<span class="text-xs text-muted">Never</span>'}</td>
          <td>${statusBadge(s)}</td>
        </tr>`).join('') : `<tr><td colspan="8">${sfEmpty('No inventory items yet')}</td></tr>`}</tbody>
      </table></div>
    </div>`);
}

/* ── Picking & stock out ────────────────────────────────────── */

function sfOpenPicking(day) {
  sfState.pickingDate = day;
  sfSwitchTab('picking');
}

async function sfLoadPicking() {
  if (!sfState.pickingDate) sfState.pickingDate = sfAddDays(manilaToday(), -1);
  const data = await sfApi(`/picking?date=${encodeURIComponent(sfState.pickingDate)}`);
  sfState.picking = data;
  sfState.packed = {};
  sfState.reasons = {};
  data.items.forEach((i) => { sfState.packed[i.item_id] = i.planned; });
  if (sfState.tab === 'picking') sfRenderPicking();
}

function sfChangePickingDate(value) {
  sfState.pickingDate = value || sfAddDays(manilaToday(), -1);
  sfSwitchTab('picking');
}

function sfRenderPicking() {
  const p = sfState.picking;
  const canWrite = sfCanWrite();
  const head = `
    <div class="card-header sf-toolbar">
      <div><div class="card-title">Picking list — ${escapeHtml(sfDateLabel(p.date))}</div>
        <div class="card-subtitle">Orders confirmed that day (Manila time), minus cancelled ones, totalled per item. Building the list never touches stock.</div></div>
      <div class="sf-toolbar-actions">
        <input type="date" class="form-control" value="${escapeHtml(p.date)}" max="${escapeHtml(manilaToday())}" onchange="sfChangePickingDate(this.value)">
        <button class="btn btn-secondary btn-sm" onclick="sfPrintPicking()" ${p.items.length || p.unmapped.length ? '' : 'disabled'}>Print</button>
      </div>
    </div>`;

  const stats = `<div class="hrr-ministats sf-ministats">
    <div><span>Orders</span><b>${sfNum(p.orders)}</b></div>
    <div><span>Total pcs</span><b>${sfNum(p.pcs)}</b></div>
    <div><span>Items</span><b>${sfNum(p.items.length)}</b></div>
    <div><span>Unlinked pages</span><b class="${p.unmapped.length ? 'sf-neg' : ''}">${sfNum(p.unmapped.length)}</b></div>
  </div>`;

  const unmapped = p.unmapped.length ? `
    <div class="alert alert-warning" style="margin:14px 0 0;"><div>
      <strong>Link these pages to an item.</strong> Their pcs are not on the list below, so they would not be deducted. The link is saved for every day (and for returns).
      <div class="sf-unmapped">${p.unmapped.map((u) => `<div class="sf-unmapped-row">
        <span><b>${escapeHtml(u.page)}</b> · ${sfNum(u.orders)} orders · ${sfNum(u.pcs)} pcs</span>
        ${canWrite ? `<select class="form-control" onchange="sfLinkPage('${encodeURIComponent(u.page)}', this.value)">${sfItemOptions('', { placeholder: 'Link to item…', productsOnly: true })}</select>` : ''}
      </div>`).join('')}</div>
    </div></div>` : '';

  let body;
  if (p.batch && p.batch.status === 'posted') {
    body = sfRenderPostedBatch(p.batch, canWrite);
  } else {
    body = sfRenderStockOutForm(p, canWrite);
  }

  sfRoot(`<div class="card">${head}<div class="card-body">${stats}${unmapped}</div>${body}</div>`);
}

function sfPagesChips(pages) {
  return (pages || []).map((pg) => `<span class="sf-chip">${escapeHtml(pg.page)} · ${sfNum(pg.pcs)}</span>`).join(' ');
}

function sfRenderStockOutForm(p, canWrite) {
  if (!p.items.length) {
    return `<div class="card-body">${sfEmpty('Nothing to pick', p.unmapped.length ? 'Link the pages above to items first.' : 'No confirmed orders on this day.')}</div>`;
  }
  const voided = p.batch && p.batch.status === 'voided'
    ? `<div class="alert alert-info" style="margin:0 16px 12px;"><div>The stock out for this day was voided by ${escapeHtml(p.batch.voided_by_name || 'someone')}: ${escapeHtml(p.batch.void_reason || '')}. Post it again below.</div></div>`
    : '';
  const rows = p.items.map((i) => {
    const packed = sfState.packed[i.item_id];
    const differs = Number(packed) !== Number(i.planned);
    const after = i.stock - Number(packed || 0);
    return `<tr>
      <td style="font-weight:500">${escapeHtml(i.name)}<div class="text-xs text-muted font-mono">${escapeHtml(i.sku || '')}</div></td>
      <td>${sfPagesChips(i.pages)}</td>
      <td class="num">${sfNum(i.orders)}</td>
      <td class="num"><b>${sfNum(i.planned)}</b></td>
      <td class="num">${canWrite ? `<input type="number" min="0" step="1" class="form-control sf-qty" value="${escapeHtml(String(packed ?? ''))}" oninput="sfSetPacked('${escapeHtml(i.item_id)}', this.value)">` : sfNum(packed)}</td>
      <td class="num" id="sf-var-${escapeHtml(i.item_id)}">${sfSigned(Number(packed || 0) - i.planned)}</td>
      <td>${canWrite ? `<input type="text" class="form-control sf-reason${differs ? ' sf-required' : ''}" id="sf-reason-${escapeHtml(i.item_id)}" placeholder="${differs ? 'Why the difference? (required)' : 'Only if packed ≠ planned'}" value="${escapeHtml(sfState.reasons[i.item_id] || '')}" oninput="sfState.reasons['${escapeHtml(i.item_id)}'] = this.value">` : ''}</td>
      <td class="num" id="sf-after-${escapeHtml(i.item_id)}"><span class="${after < 0 ? 'sf-neg' : ''}">${sfNum(i.stock)} → <b>${sfNum(after)}</b></span></td>
    </tr>`;
  }).join('');
  const totalPlanned = p.items.reduce((s, i) => s + i.planned, 0);
  return `${voided}
    <div class="table-container"><table>
      <thead><tr><th>Item</th><th>Pages</th><th class="num">Orders</th><th class="num">Planned</th><th class="num">Packed</th><th class="num">Diff</th><th>Reason</th><th class="num">Stock after</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="3" style="text-align:right;font-weight:600">Total</td><td class="num"><b>${sfNum(totalPlanned)}</b></td><td class="num"><b id="sf-total-packed">${sfNum(Object.values(sfState.packed).reduce((s, v) => s + Number(v || 0), 0))}</b></td><td colspan="3"></td></tr></tfoot>
    </table></div>
    ${canWrite ? `<div class="sf-postbar">
      <span class="text-muted text-sm">Enter what actually left the warehouse. Cancelled, out-of-stock or unpacked orders are a difference with a reason — not a silent over-deduction. Posting is once per day.</span>
      <button class="btn btn-primary" id="sf-post-out" onclick="sfPostStockOut()">Post stock out</button>
    </div>` : '<div class="card-body text-muted text-sm">Only Administrators and Logistics can post a stock out.</div>'}`;
}

function sfRenderPostedBatch(batch, canWrite) {
  const lines = batch.lines.map((l) => `<tr>
    <td style="font-weight:500">${escapeHtml(l.name || l.item_id)}<div class="text-xs text-muted font-mono">${escapeHtml(l.sku || '')}</div></td>
    <td>${sfPagesChips(l.pages)}</td>
    <td class="num">${sfNum(l.planned_qty)}</td>
    <td class="num"><b>${sfNum(l.packed_qty)}</b></td>
    <td class="num">${sfSigned(l.variance)}</td>
    <td>${escapeHtml(l.reason || '')}</td>
  </tr>`).join('');
  return `
    <div class="alert alert-success" style="margin:0 16px 12px;"><div>
      <strong>Posted.</strong> ${sfNum(batch.packed_pcs)} pcs deducted by ${escapeHtml(batch.posted_by_name || '—')} on ${escapeHtml(formatDateTime(String(batch.posted_at || '')))}.
      ${batch.planned_pcs !== batch.packed_pcs ? ` Planned ${sfNum(batch.planned_pcs)}, packed ${sfNum(batch.packed_pcs)}.` : ''}
      ${batch.unmapped && batch.unmapped.length ? `<br>Posted without ${batch.unmapped.length} unlinked page(s): ${batch.unmapped.map((u) => `${escapeHtml(u.page)} (${sfNum(u.pcs)} pcs)`).join(', ')}.` : ''}
    </div></div>
    <div class="table-container"><table>
      <thead><tr><th>Item</th><th>Pages</th><th class="num">Planned</th><th class="num">Packed</th><th class="num">Diff</th><th>Reason</th></tr></thead>
      <tbody>${lines}</tbody>
    </table></div>
    ${canWrite ? `<div class="sf-postbar"><span class="text-muted text-sm">Wrong numbers? Voiding puts the stock back so the day can be posted again.</span><button class="btn btn-secondary" onclick="sfVoidStockOut('${escapeHtml(batch.out_date)}')">Void stock out</button></div>` : ''}`;
}

function sfSetPacked(itemId, value) {
  const item = sfState.picking?.items.find((i) => i.item_id === itemId);
  if (!item) return;
  const n = value === '' ? '' : Math.max(0, Math.trunc(Number(value) || 0));
  sfState.packed[itemId] = n;
  const packed = Number(n || 0);
  const diff = document.getElementById(`sf-var-${itemId}`);
  if (diff) diff.innerHTML = sfSigned(packed - item.planned);
  const after = document.getElementById(`sf-after-${itemId}`);
  if (after) after.innerHTML = `<span class="${item.stock - packed < 0 ? 'sf-neg' : ''}">${sfNum(item.stock)} → <b>${sfNum(item.stock - packed)}</b></span>`;
  const reason = document.getElementById(`sf-reason-${itemId}`);
  if (reason) {
    const differs = packed !== item.planned;
    reason.classList.toggle('sf-required', differs);
    reason.placeholder = differs ? 'Why the difference? (required)' : 'Only if packed ≠ planned';
  }
  const total = document.getElementById('sf-total-packed');
  if (total) total.textContent = sfNum(Object.values(sfState.packed).reduce((s, v) => s + Number(v || 0), 0));
}

async function sfLinkPage(pageEnc, itemId) {
  if (!itemId) return;
  const page = decodeURIComponent(pageEnc);
  try {
    await sfApi('/page-item', { method: 'PUT', body: { page_name: page, item_id: itemId } });
    showToast('success', 'Page linked', page);
    await sfLoadPicking();
  } catch (error) {
    showToast('error', 'Could not link', error.message || 'Request failed');
  }
}

async function sfPostStockOut() {
  const p = sfState.picking;
  if (!p) return;
  const lines = p.items.map((i) => ({
    item_id: i.item_id,
    packed_qty: sfState.packed[i.item_id] === '' ? null : Number(sfState.packed[i.item_id]),
    reason: (sfState.reasons[i.item_id] || '').trim(),
    name: i.name,
    planned: i.planned,
    stock: i.stock,
  }));
  const blank = lines.find((l) => l.packed_qty === null || Number.isNaN(l.packed_qty));
  if (blank) { showToast('error', 'Packed quantity missing', `Enter what was packed for ${blank.name} (0 if nothing).`); return; }
  const noReason = lines.find((l) => l.packed_qty !== l.planned && !l.reason);
  if (noReason) { showToast('error', 'Reason needed', `${noReason.name}: packed ${noReason.packed_qty}, planned ${noReason.planned}.`); return; }
  const short = lines.filter((l) => l.packed_qty > l.stock);
  if (short.length) {
    showToast('error', 'Not enough stock in the system', `${short.map((l) => `${l.name} has ${l.stock}`).join(', ')}. Record the stock in or do a count first.`);
    return;
  }
  const total = lines.reduce((s, l) => s + l.packed_qty, 0);
  const unmappedNote = p.unmapped.length
    ? `\n\n${p.unmapped.length} page(s) are not linked (${p.unmapped.reduce((s, u) => s + u.pcs, 0)} pcs) and will NOT be deducted.`
    : '';
  if (!confirm(`Deduct ${total.toLocaleString()} pcs from stock for ${sfDateLabel(p.date)}?\n\nThis can be posted once per day.${unmappedNote}`)) return;
  const button = document.getElementById('sf-post-out');
  if (button) button.disabled = true;
  try {
    await sfApi('/stock-out', {
      method: 'POST',
      body: {
        date: p.date,
        acknowledge_unmapped: p.unmapped.length > 0,
        lines: lines.map(({ item_id, packed_qty, reason }) => ({ item_id, packed_qty, reason })),
      },
    });
    showToast('success', 'Stock out posted', `${total.toLocaleString()} pcs deducted for ${sfDateLabel(p.date)}.`);
    await sfLoadPicking();
  } catch (error) {
    showToast('error', 'Not posted', error.message || 'Request failed');
    if (button) button.disabled = false;
  }
}

async function sfVoidStockOut(day) {
  const reason = window.prompt(`Void the stock out for ${sfDateLabel(day)}? The packed pcs are added back to stock.\n\nReason:`);
  if (reason === null) return;
  if (!reason.trim()) { showToast('error', 'Reason needed', 'Say why the stock out is being voided.'); return; }
  try {
    await sfApi(`/stock-out/${encodeURIComponent(day)}/void`, { method: 'POST', body: { reason: reason.trim() } });
    showToast('success', 'Stock out voided', 'The stock was put back.');
    await sfLoadPicking();
  } catch (error) {
    showToast('error', 'Could not void', error.message || 'Request failed');
  }
}

function sfPrintPicking() {
  const p = sfState.picking;
  if (!p) return;
  const popup = window.open('', '_blank');
  if (!popup) { showToast('warning', 'Pop-up blocked', 'Allow pop-ups to print the picking list.'); return; }
  const rows = p.items.map((i) => `
    <tr class="item"><td><b>${escapeHtml(i.name)}</b> <small>${escapeHtml(i.sku || '')}</small></td><td class="n">${i.orders}</td><td class="n"><b>${i.planned}</b></td><td class="box"></td></tr>
    ${i.pages.map((pg) => `<tr class="page"><td>&nbsp;&nbsp;↳ ${escapeHtml(pg.page)}</td><td class="n">${pg.orders}</td><td class="n">${pg.pcs}</td><td></td></tr>`).join('')}`).join('');
  const unmapped = p.unmapped.length ? `<h3>Not linked to an item</h3><table>${p.unmapped.map((u) => `<tr><td>${escapeHtml(u.page)}</td><td class="n">${u.orders} orders</td><td class="n">${u.pcs} pcs</td></tr>`).join('')}</table>` : '';
  popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Picking list ${escapeHtml(p.date)}</title>
    <style>body{font:13px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 14px;color:#555}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}
    .n{text-align:right}.box{width:90px;border:1px solid #999}.page td{color:#555;font-size:12px}th{background:#f3f3f3}
    .sign{margin-top:32px;display:flex;gap:48px}.sign div{border-top:1px solid #333;padding-top:4px;width:200px}</style></head><body>
    <h1>Picking list — ${escapeHtml(sfDateLabel(p.date))}</h1>
    <p>${p.orders} orders · ${p.pcs} pcs. Write the packed quantity in the box; the stock out is posted from the packed numbers.</p>
    <table><thead><tr><th>Item / page</th><th class="n">Orders</th><th class="n">Pcs</th><th>Packed</th></tr></thead><tbody>${rows}</tbody></table>
    ${unmapped}
    <div class="sign"><div>Picked by</div><div>Checked by</div></div>
    <script>window.onload=function(){window.print()}<\/script></body></html>`);
  popup.document.close();
}

/* ── Stock in ───────────────────────────────────────────────── */

async function sfLoadStockIn() {
  const logs = await authorizedJsonRequest(`/inventory/logs?limit=500&_=${Date.now()}`);
  sfState.stockInLogs = (Array.isArray(logs) ? logs : []).filter((l) => l.movement === 'stock_in');
  if (sfState.tab === 'stock-in') sfRenderStockIn();
}

function sfRenderStockIn() {
  const canWrite = sfCanWrite();
  const logs = sfState.stockInLogs || [];
  sfRoot(`
    <div class="sf-grid">
      <div class="card">
        <div class="card-header"><div><div class="card-title">Receive supplies</div><div class="card-subtitle">Count what arrived and enter the actual quantity — not what the delivery receipt says.</div></div></div>
        <div class="card-body">
          ${canWrite ? `
          <div class="form-group"><label class="form-label">Item <span class="required">*</span></label><select class="form-control" id="sf-in-item">${sfItemOptions('')}</select></div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Quantity received <span class="required">*</span></label><input type="number" min="1" step="1" class="form-control" id="sf-in-qty" placeholder="0"></div>
            <div class="form-group"><label class="form-label">Received on</label><input type="date" class="form-control" id="sf-in-date" value="${escapeHtml(manilaToday())}" max="${escapeHtml(manilaToday())}"></div>
          </div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Supplier</label><input type="text" class="form-control" id="sf-in-supplier" placeholder="Supplier name"></div>
            <div class="form-group"><label class="form-label">DR / Invoice no.</label><input type="text" class="form-control" id="sf-in-ref" placeholder="DR-0001"></div>
          </div>
          <div class="form-group"><label class="form-label">Notes</label><input type="text" class="form-control" id="sf-in-notes" placeholder="Short count, damaged on arrival…"></div>
          <button class="btn btn-primary" id="sf-in-save" onclick="sfSaveStockIn()">Add to stock</button>` : '<p class="text-muted">Only Administrators and Logistics can receive stock.</p>'}
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div><div class="card-title">Recent stock in</div><div class="card-subtitle">Supplies received through this form.</div></div></div>
        <div class="table-container"><table>
          <thead><tr><th>When</th><th>Item</th><th class="num">Qty</th><th>Ref</th><th>Notes</th><th>By</th></tr></thead>
          <tbody>${logs.length ? logs.slice(0, 50).map((l) => `<tr>
            <td style="white-space:nowrap">${escapeHtml(formatDateTime(String(l.created_at || '')))}</td>
            <td style="font-weight:500">${escapeHtml(l.item_name || l.item_id)}</td>
            <td class="num sf-pos">+${sfNum(l.qty_after - l.qty_before)}</td>
            <td class="font-mono text-xs">${escapeHtml(l.ref || '')}</td>
            <td class="text-sm">${escapeHtml(l.notes || '')}</td>
            <td>${escapeHtml(l.created_by_name || '')}</td>
          </tr>`).join('') : `<tr><td colspan="6">${sfEmpty('No supplies received yet')}</td></tr>`}</tbody>
        </table></div>
      </div>
    </div>`);
}

async function sfSaveStockIn() {
  const itemId = document.getElementById('sf-in-item')?.value;
  const qty = Math.trunc(Number(document.getElementById('sf-in-qty')?.value || 0));
  if (!itemId) { showToast('error', 'Pick an item', 'Choose what was received.'); return; }
  if (qty <= 0) { showToast('error', 'Quantity needed', 'Enter the quantity you counted.'); return; }
  const item = sfState.items.find((i) => i.id === itemId);
  const button = document.getElementById('sf-in-save');
  if (button) button.disabled = true;
  try {
    const result = await sfApi('/stock-in', {
      method: 'POST',
      body: {
        item_id: itemId,
        qty,
        received_date: document.getElementById('sf-in-date')?.value,
        supplier: document.getElementById('sf-in-supplier')?.value,
        ref: document.getElementById('sf-in-ref')?.value,
        notes: document.getElementById('sf-in-notes')?.value,
      },
    });
    showToast('success', 'Stock added', `${item?.name || itemId}: ${result.before} → ${result.after}`);
    await refreshInventoryFromBackend().catch(() => {});
    sfState.items = DB.inventory || sfState.items;
    await sfLoadStockIn();
  } catch (error) {
    showToast('error', 'Not saved', error.message || 'Request failed');
    if (button) button.disabled = false;
  }
}

/* ── Returns ────────────────────────────────────────────────── */

async function sfLoadReturns() {
  const data = await sfApi('/returns');
  sfState.returns = data;
  sfState.returnsPreview = data.started ? null : await sfApi('/returns/start-preview');
  if (sfState.tab === 'returns') sfRenderReturns();
}

function sfRenderReturns() {
  const data = sfState.returns;
  const canWrite = sfCanWrite();
  if (!data.started) {
    const preview = sfState.returnsPreview || { items: [] };
    const total = preview.items.reduce((s, i) => s + i.rts_pcs, 0);
    sfRoot(`
      <div class="card">
        <div class="card-header"><div><div class="card-title">Switch on inspected returns</div>
          <div class="card-subtitle">Today every RTS scan is added to Total Stock the moment it is scanned, before anyone opens the parcel.</div></div></div>
        <div class="card-body sf-prose">
          <p>After the switch, a scanned parcel waits here until someone opens it and records how many pcs can be sold again. Only those go back into stock; damaged or missing pcs are recorded but never counted.</p>
          <p>The RTS pcs already scanned (${sfNum(total)} pcs) are folded into stock once, so <b>Total Stock on the Inventory page stays where it is</b>. Do a shelf count afterwards to correct anything that was never really sellable.</p>
        </div>
        <div class="table-container"><table>
          <thead><tr><th>Item</th><th>SKU</th><th class="num">Stock now</th><th class="num">Old RTS pcs</th><th class="num">Stock after</th></tr></thead>
          <tbody>${preview.items.length ? preview.items.map((i) => `<tr>
            <td style="font-weight:500">${escapeHtml(i.name)}</td><td class="font-mono text-xs">${escapeHtml(i.sku || '')}</td>
            <td class="num">${sfNum(i.stock)}</td><td class="num sf-pos">+${sfNum(i.rts_pcs)}</td><td class="num"><b>${sfNum(i.stock + i.rts_pcs)}</b></td>
          </tr>`).join('') : `<tr><td colspan="5">${sfEmpty('No old RTS pcs matched to an item')}</td></tr>`}</tbody>
        </table></div>
        ${canWrite ? `<div class="sf-postbar"><span class="text-muted text-sm">One time only. RTS scans up to #${sfNum(preview.max_scan_id)} are folded in; every later scan waits for inspection.</span><button class="btn btn-primary" id="sf-returns-start" onclick="sfStartReturns()">Switch on</button></div>` : ''}
      </div>`);
    return;
  }

  const filter = sfState.returnsFilter;
  const rows = data.rows.filter((r) => (filter === 'pending' ? !r.inspection : filter === 'done' ? !!r.inspection : true));
  const statusBadge = (ins) => {
    const tone = { restocked: 'success', damaged: 'danger', missing: 'warning' }[ins.status] || 'gray';
    return `<span class="badge badge-${tone}">${escapeHtml(ins.status)}</span>`;
  };
  const body = rows.map((r) => {
    const key = escapeHtml(encodeURIComponent(r.tracking_no));
    if (r.inspection) {
      const item = sfState.items.find((i) => i.id === r.inspection.item_id);
      return `<tr>
        <td style="white-space:nowrap">${escapeHtml(r.scan_date || '')}</td><td class="font-mono text-xs">${escapeHtml(r.tracking_no)}</td>
        <td>${escapeHtml(r.page || '—')}<div class="text-xs text-muted">${escapeHtml(r.product || '')}</div></td>
        <td class="num">${sfNum(r.expected_pcs)}</td>
        <td>${escapeHtml(item?.name || r.inspection.item_id || '—')}</td>
        <td class="num">${sfNum(r.inspection.sellable_qty)}</td><td class="num">${sfNum(r.inspection.damaged_qty)}</td>
        <td class="text-sm">${statusBadge(r.inspection)} ${escapeHtml(r.inspection.notes || '')}<div class="text-xs text-muted">${escapeHtml(r.inspection.inspected_by_name || '')}</div></td>
        <td></td>
      </tr>`;
    }
    return `<tr>
      <td style="white-space:nowrap">${escapeHtml(r.scan_date || '')}</td><td class="font-mono text-xs">${escapeHtml(r.tracking_no)}</td>
      <td>${escapeHtml(r.page || '—')}<div class="text-xs text-muted">${escapeHtml(r.product || '')}</div></td>
      <td class="num"><b>${sfNum(r.expected_pcs)}</b></td>
      <td>${canWrite ? `<select class="form-control sf-item-select" id="sf-ret-item-${key}">${sfItemOptions(r.suggested_item_id || '', { productsOnly: true })}</select>` : '—'}</td>
      <td class="num">${canWrite ? `<input type="number" min="0" class="form-control sf-qty" id="sf-ret-ok-${key}" value="${r.expected_pcs}">` : ''}</td>
      <td class="num">${canWrite ? `<input type="number" min="0" class="form-control sf-qty" id="sf-ret-bad-${key}" value="0">` : ''}</td>
      <td>${canWrite ? `<input type="text" class="form-control" id="sf-ret-notes-${key}" placeholder="Opened, seal broken…">` : ''}</td>
      <td>${canWrite ? `<button class="btn btn-primary btn-sm" onclick="sfInspect('${key}', ${r.expected_pcs})">Save</button>` : ''}</td>
    </tr>`;
  }).join('');
  sfRoot(`
    <div class="card">
      <div class="card-header sf-toolbar">
        <div><div class="card-title">Returned parcels</div><div class="card-subtitle">Open each parcel, then record the sellable pcs (added back to stock) and the damaged pcs (not added).</div></div>
        <div class="sf-toolbar-actions">
          ${['pending', 'done', 'all'].map((f) => `<button class="btn btn-sm ${filter === f ? 'btn-primary' : 'btn-secondary'}" onclick="sfFilterReturns('${f}')">${{ pending: `To inspect (${data.pending_count})`, done: 'Inspected', all: 'All' }[f]}</button>`).join('')}
        </div>
      </div>
      <div class="table-container hrr-scroll"><table>
        <thead><tr><th>Scanned</th><th>Tracking</th><th>Page / product</th><th class="num">Expected</th><th>Item</th><th class="num">Sellable</th><th class="num">Damaged</th><th>Notes</th><th></th></tr></thead>
        <tbody>${body || `<tr><td colspan="9">${sfEmpty(filter === 'pending' ? 'Nothing waiting' : 'No parcels yet', filter === 'pending' ? 'Every scanned return has been inspected.' : '')}</td></tr>`}</tbody>
      </table></div>
    </div>`);
}

function sfFilterReturns(filter) {
  sfState.returnsFilter = filter;
  sfRenderReturns();
}

async function sfStartReturns() {
  const preview = sfState.returnsPreview || { items: [] };
  const total = preview.items.reduce((s, i) => s + i.rts_pcs, 0);
  if (!confirm(`Switch on inspected returns?\n\n${total.toLocaleString()} old RTS pcs are folded into stock once. From now on only inspected, sellable pcs go back into stock.\n\nThis cannot be undone.`)) return;
  const button = document.getElementById('sf-returns-start');
  if (button) button.disabled = true;
  try {
    await sfApi('/returns/start', { method: 'POST', body: {} });
    DB.stockFlowStatus = { returns_started: true, pending_by_item: {} };
    showToast('success', 'Inspected returns on', 'New RTS scans now wait for inspection.');
    await refreshInventoryFromBackend().catch(() => {});
    sfState.items = DB.inventory || sfState.items;
    await sfLoadReturns();
  } catch (error) {
    showToast('error', 'Not switched on', error.message || 'Request failed');
    if (button) button.disabled = false;
  }
}

async function sfInspect(key, expected) {
  const tracking = decodeURIComponent(key);
  const itemId = document.getElementById(`sf-ret-item-${key}`)?.value || '';
  const sellable = Math.trunc(Number(document.getElementById(`sf-ret-ok-${key}`)?.value || 0));
  const damaged = Math.trunc(Number(document.getElementById(`sf-ret-bad-${key}`)?.value || 0));
  const notes = document.getElementById(`sf-ret-notes-${key}`)?.value || '';
  if (sellable < 0 || damaged < 0) { showToast('error', 'Check the numbers', 'Sellable and damaged cannot be negative.'); return; }
  if (sellable > 0 && !itemId) { showToast('error', 'Pick an item', 'Choose which item the sellable pcs go back into.'); return; }
  if (sellable + damaged !== expected && !notes.trim()) {
    showToast('error', 'Note needed', `Expected ${expected} pcs but recorded ${sellable + damaged}. Note what was in the parcel.`);
    return;
  }
  try {
    const result = await sfApi('/returns/inspect', {
      method: 'POST',
      body: { tracking_no: tracking, item_id: itemId, expected_pcs: expected, sellable_qty: sellable, damaged_qty: damaged, notes },
    });
    showToast('success', `Parcel ${result.status}`, sellable ? `${sellable} pcs back in stock.` : 'Nothing added to stock.');
    await sfLoadReturns();
  } catch (error) {
    showToast('error', 'Not saved', error.message || 'Request failed');
  }
}

/* ── Stock count ────────────────────────────────────────────── */

async function sfLoadCount() {
  const [overview, counts, status] = await Promise.all([sfApi('/overview'), sfApi('/counts?limit=100'), sfApi('/status')]);
  sfState.overview = overview;
  sfState.counts = counts.counts || [];
  sfState.returnsStarted = !!status.returns_started;
  if (!sfState.countDate) sfState.countDate = manilaToday();
  if (sfState.tab === 'count') sfRenderCount();
}

function sfRenderCount() {
  const canWrite = sfCanWrite();
  if (!sfState.returnsStarted) {
    sfRoot(`<div class="card"><div class="card-body">${sfEmpty('Switch on inspected returns first', 'Until then Total Stock on the Inventory page adds every RTS scan on top of stock, so a shelf count has nothing reliable to compare against. <a href="#" onclick="sfSwitchTab(\'returns\');return false;">Go to Returns</a>')}</div></div>`);
    return;
  }
  // Fastest movers first: the weekly count starts where errors pile up fastest.
  const stock = [...(sfState.overview?.stock || [])].sort((a, b) => (b.avg_daily_out - a.avg_daily_out) || a.name.localeCompare(b.name));
  const rows = stock.map((s) => {
    const input = sfState.countInputs[s.item_id] || {};
    const counted = input.counted;
    const variance = counted === undefined || counted === '' ? null : Number(counted) - s.stock;
    const due = s.days_since_count === null || s.days_since_count >= 7;
    return `<tr>
      <td style="font-weight:500">${escapeHtml(s.name)}<div class="text-xs text-muted font-mono">${escapeHtml(s.sku || '')}</div></td>
      <td class="num">${s.avg_daily_out || '—'}</td>
      <td>${s.last_counted ? escapeHtml(s.last_counted) : '<span class="text-muted">Never</span>'} ${due ? '<span class="badge badge-warning">Due</span>' : ''}</td>
      <td class="num"><b>${sfNum(s.stock)}</b></td>
      <td class="num">${canWrite ? `<input type="number" min="0" class="form-control sf-qty" value="${escapeHtml(String(counted ?? ''))}" placeholder="—" oninput="sfSetCount('${escapeHtml(s.item_id)}', this.value)">` : ''}</td>
      <td class="num" id="sf-cvar-${escapeHtml(s.item_id)}">${variance === null ? '' : sfSigned(variance)}</td>
      <td>${canWrite ? `<input type="text" class="form-control sf-reason${variance ? ' sf-required' : ''}" id="sf-creason-${escapeHtml(s.item_id)}" value="${escapeHtml(input.reason || '')}" placeholder="${variance ? 'Why the difference? (required)' : ''}" oninput="sfSetCountReason('${escapeHtml(s.item_id)}', this.value)">` : ''}</td>
    </tr>`;
  }).join('');
  const history = (sfState.counts || []).slice(0, 40).map((c) => `<tr>
    <td>${escapeHtml(c.count_date)}</td><td style="font-weight:500">${escapeHtml(c.name || c.item_id)}</td>
    <td class="num">${sfNum(c.expected_qty)}</td><td class="num">${sfNum(c.counted_qty)}</td><td class="num">${sfSigned(c.variance)}</td>
    <td class="text-sm">${escapeHtml(c.reason || '')}</td><td>${escapeHtml(c.counted_by_name || '')}</td>
  </tr>`).join('');
  sfRoot(`
    <div class="card">
      <div class="card-header sf-toolbar">
        <div><div class="card-title">Shelf count</div><div class="card-subtitle">Count what is physically on the shelf. Leave an item blank to skip it. A difference adjusts stock to the count and needs a reason.</div></div>
        <div class="sf-toolbar-actions"><input type="date" class="form-control" value="${escapeHtml(sfState.countDate)}" max="${escapeHtml(manilaToday())}" onchange="sfState.countDate = this.value"></div>
      </div>
      <div class="table-container"><table>
        <thead><tr><th>Item</th><th class="num">Avg out / day</th><th>Last counted</th><th class="num">System</th><th class="num">Counted</th><th class="num">Diff</th><th>Reason</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7">${sfEmpty('No items')}</td></tr>`}</tbody>
      </table></div>
      ${canWrite ? `<div class="sf-postbar"><span class="text-muted text-sm">Investigate a difference before you post it — a wrong count becomes the new stock.</span><button class="btn btn-primary" id="sf-count-save" onclick="sfPostCount()">Post count</button></div>` : ''}
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-header"><div><div class="card-title">Count history</div></div></div>
      <div class="table-container"><table>
        <thead><tr><th>Date</th><th>Item</th><th class="num">System</th><th class="num">Counted</th><th class="num">Diff</th><th>Reason</th><th>By</th></tr></thead>
        <tbody>${history || `<tr><td colspan="7">${sfEmpty('No counts yet')}</td></tr>`}</tbody>
      </table></div>
    </div>`);
}

function sfSetCount(itemId, value) {
  const entry = sfState.countInputs[itemId] || {};
  entry.counted = value === '' ? '' : Math.max(0, Math.trunc(Number(value) || 0));
  sfState.countInputs[itemId] = entry;
  const s = sfState.overview?.stock.find((x) => x.item_id === itemId);
  const variance = entry.counted === '' || !s ? null : entry.counted - s.stock;
  const cell = document.getElementById(`sf-cvar-${itemId}`);
  if (cell) cell.innerHTML = variance === null ? '' : sfSigned(variance);
  const reason = document.getElementById(`sf-creason-${itemId}`);
  if (reason) {
    reason.classList.toggle('sf-required', !!variance);
    reason.placeholder = variance ? 'Why the difference? (required)' : '';
  }
}

function sfSetCountReason(itemId, value) {
  const entry = sfState.countInputs[itemId] || {};
  entry.reason = value;
  sfState.countInputs[itemId] = entry;
}

async function sfPostCount() {
  const stock = sfState.overview?.stock || [];
  const lines = stock
    .map((s) => ({ s, input: sfState.countInputs[s.item_id] || {} }))
    .filter(({ input }) => input.counted !== undefined && input.counted !== '')
    .map(({ s, input }) => ({ item_id: s.item_id, name: s.name, counted_qty: input.counted, reason: (input.reason || '').trim(), variance: input.counted - s.stock }));
  if (!lines.length) { showToast('error', 'Nothing counted', 'Enter at least one counted quantity.'); return; }
  const missing = lines.find((l) => l.variance && !l.reason);
  if (missing) { showToast('error', 'Reason needed', `${missing.name}: difference of ${missing.variance}.`); return; }
  const adjusting = lines.filter((l) => l.variance);
  if (!confirm(`Post the count for ${lines.length} item(s)?${adjusting.length ? `\n\n${adjusting.length} will be adjusted:\n${adjusting.map((l) => `• ${l.name}: ${l.variance > 0 ? '+' : ''}${l.variance}`).join('\n')}` : '\n\nNo differences.'}`)) return;
  const button = document.getElementById('sf-count-save');
  if (button) button.disabled = true;
  try {
    const result = await sfApi('/counts', { method: 'POST', body: { date: sfState.countDate, lines: lines.map(({ item_id, counted_qty, reason }) => ({ item_id, counted_qty, reason })) } });
    showToast('success', 'Count posted', `${result.counted} counted, ${result.adjusted} adjusted.`);
    sfState.countInputs = {};
    await refreshInventoryFromBackend().catch(() => {});
    sfState.items = DB.inventory || sfState.items;
    await sfLoadCount();
  } catch (error) {
    showToast('error', 'Not posted', error.message || 'Request failed');
    if (button) button.disabled = false;
  }
}

/* ── Balance ────────────────────────────────────────────────── */

async function sfLoadBalance() {
  if (!sfState.balanceTo) sfState.balanceTo = manilaToday();
  if (!sfState.balanceFrom) sfState.balanceFrom = sfState.balanceTo;
  sfState.balance = await sfApi(`/balance?from=${encodeURIComponent(sfState.balanceFrom)}&to=${encodeURIComponent(sfState.balanceTo)}`);
  if (sfState.tab === 'balance') sfRenderBalance();
}

function sfSetBalanceRange(preset) {
  const today = manilaToday();
  const ranges = {
    today: [today, today],
    yesterday: [sfAddDays(today, -1), sfAddDays(today, -1)],
    week: [sfAddDays(today, -6), today],
    month: [`${today.slice(0, 8)}01`, today],
  };
  if (ranges[preset]) [sfState.balanceFrom, sfState.balanceTo] = ranges[preset];
  else {
    sfState.balanceFrom = document.getElementById('sf-bal-from')?.value || today;
    sfState.balanceTo = document.getElementById('sf-bal-to')?.value || today;
    if (sfState.balanceFrom > sfState.balanceTo) [sfState.balanceFrom, sfState.balanceTo] = [sfState.balanceTo, sfState.balanceFrom];
  }
  sfSwitchTab('balance');
}

function sfRenderBalance() {
  const b = sfState.balance;
  const rows = (b.rows || []).filter((r) => r.active !== 0 || r.opening || r.closing);
  const total = (key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);
  const body = rows.map((r) => {
    const moved = r.stock_in || r.stock_out || r.returns || r.adjustments || r.manual;
    return `<tr${moved ? '' : ' class="sf-quiet"'}>
      <td style="font-weight:500">${escapeHtml(r.name)}<div class="text-xs text-muted font-mono">${escapeHtml(r.sku || '')}</div></td>
      <td class="num">${sfNum(r.opening)}</td>
      <td class="num">${r.stock_in ? `<span class="sf-pos">+${sfNum(r.stock_in)}</span>` : '—'}</td>
      <td class="num">${r.stock_out ? `<span class="sf-neg">−${sfNum(r.stock_out)}</span>` : '—'}</td>
      <td class="num">${r.returns ? `<span class="sf-pos">+${sfNum(r.returns)}</span>` : '—'}</td>
      <td class="num">${r.adjustments ? sfSigned(r.adjustments) : '—'}</td>
      <td class="num">${r.manual ? sfSigned(r.manual) : '—'}</td>
      <td class="num"><b>${sfNum(r.closing)}</b></td>
    </tr>`;
  }).join('');
  const label = b.from === b.to ? sfDateLabel(b.from) : `${sfDateLabel(b.from)} – ${sfDateLabel(b.to)}`;
  sfRoot(`
    <div class="card">
      <div class="card-header sf-toolbar">
        <div><div class="card-title">Stock balance — ${escapeHtml(label)}</div>
          <div class="card-subtitle">Opening + stock in − stock out + returns ± adjustments = expected closing. The shelf count should match the closing.</div></div>
        <div class="sf-toolbar-actions">
          ${[['today', 'Today'], ['yesterday', 'Yesterday'], ['week', '7 days'], ['month', 'This month']].map(([k, l]) => `<button class="btn btn-secondary btn-sm" onclick="sfSetBalanceRange('${k}')">${l}</button>`).join('')}
          <input type="date" class="form-control" id="sf-bal-from" value="${escapeHtml(b.from)}">
          <input type="date" class="form-control" id="sf-bal-to" value="${escapeHtml(b.to)}">
          <button class="btn btn-primary btn-sm" onclick="sfSetBalanceRange('custom')">Apply</button>
        </div>
      </div>
      <div class="table-container"><table>
        <thead><tr><th>Item</th><th class="num">Opening</th><th class="num">Stock in</th><th class="num">Stock out</th><th class="num">Returns</th><th class="num" title="Shelf counts and the one-time RTS fold">Adjustments</th><th class="num" title="Edits from the Inventory page (Stocks Update / Edit Item)">Manual</th><th class="num">Closing</th></tr></thead>
        <tbody>${body || `<tr><td colspan="8">${sfEmpty('No items')}</td></tr>`}</tbody>
        ${rows.length ? `<tfoot><tr style="font-weight:700">
          <td>Total</td><td class="num">${sfNum(total('opening'))}</td><td class="num">+${sfNum(total('stock_in'))}</td><td class="num">−${sfNum(total('stock_out'))}</td>
          <td class="num">+${sfNum(total('returns'))}</td><td class="num">${sfSigned(total('adjustments'))}</td><td class="num">${sfSigned(total('manual'))}</td><td class="num">${sfNum(total('closing'))}</td>
        </tr></tfoot>` : ''}
      </table></div>
      <div class="card-body text-sm text-muted">Manual changes come from the Stocks Update and Edit Item buttons on the Inventory page. Use Stock In, Stock Out and Stock Count here instead so every change has a reason and a reference.</div>
    </div>`);
}

window.renderStockFlowPage = renderStockFlowPage;
window.initStockFlowPage = initStockFlowPage;
window.sfMovementLabel = (movement) => SF_MOVEMENT_LABEL[movement] || null;
