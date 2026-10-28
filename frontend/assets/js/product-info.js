/* ═══════════════════════════════════════════════════════════
   PRODUCT INFO — the Products tab on the Inventory page
   One sheet per product: product no., ingredients, supplier, a unit cost
   breakdown, selling price and the pages that sell it. Backed by
   /api/inventory/product-info; saving writes the breakdown total and the
   selling price back to the item, so the stock tables show the same money.
   Loaded before app.js; it leans on app.js globals (DB, escapeHtml,
   authorizedJsonRequest, showToast, openModal, closeModal, formatPeso,
   canManageInventoryStock, refreshInventoryFromBackend, rerenderInventoryTables)
   read at call time.
   ═══════════════════════════════════════════════════════════ */

const piState = {
  info: {},
  pages: [],
  loaded: false,
  search: '',
  editId: null,
  detailId: null,
  draft: null,
  pageSearch: '',
};

function piMoney(n) {
  const v = Number(n || 0);
  return typeof formatPeso === 'function' ? formatPeso(v) : `₱ ${v.toFixed(2)}`;
}

function piProducts() {
  const q = piState.search.trim().toLowerCase();
  return (DB.inventory || [])
    .filter((i) => i.type === 'Product')
    .filter((i) => {
      if (!q) return true;
      const info = piState.info[i.id] || {};
      return [i.name, i.sku, info.product_no, info.supplier_name, (info.pages || []).join(' ')]
        .some((v) => String(v || '').toLowerCase().includes(q));
    })
    .sort((a, b) => (b.active !== 0) - (a.active !== 0) || a.name.localeCompare(b.name));
}

// Margin from the item's own prices, which the sheet keeps in step.
function piMargin(item) {
  const cost = Number(item.cost || 0);
  const price = item.price === null || item.price === undefined ? null : Number(item.price);
  if (price === null || !price) return null;
  return { amount: price - cost, pct: ((price - cost) / price) * 100 };
}

function renderProductInfoTab() {
  return `
    <div class="pi-toolbar">
      <input type="text" class="form-control" style="max-width:320px;" placeholder="Search product, SKU, supplier or page..." value="${escapeHtml(piState.search)}" oninput="piSetSearch(this.value)">
      <span class="text-sm text-muted">Product details, costing and the pages that sell each product.</span>
    </div>
    <div id="pi-grid">${piState.loaded ? piGridHtml() : '<div class="empty-state"><h3>Loading</h3></div>'}</div>`;
}

// Two tables, active products first, so a closed product never sits in the
// middle of the ones still being sold.
function piGridHtml() {
  const products = piProducts();
  if (!products.length) {
    return `<div class="empty-state"><h3>No products</h3><p>${piState.search ? 'Nothing matches the search.' : 'Add a Product item first.'}</p></div>`;
  }
  const active = products.filter((i) => i.active !== 0);
  const inactive = products.filter((i) => i.active === 0);
  return `
    <div class="pi-section-title">Active <span class="badge badge-success">${active.length}</span></div>
    ${piTableHtml(active, 'No active products.')}
    <div class="pi-section-title">Not Active <span class="badge badge-gray">${inactive.length}</span></div>
    ${piTableHtml(inactive, 'No inactive products.')}`;
}

function piTableHtml(products, emptyText) {
  if (!products.length) {
    return `<div class="card"><div class="card-body text-sm text-muted" style="text-align:center;">${escapeHtml(emptyText)}</div></div>`;
  }
  return `<div class="table-container"><table class="pi-table">
    <thead><tr><th>Product</th><th>SKU</th><th>Product No.</th><th class="num">Stock</th><th class="num">Unit cost</th><th class="num">Selling price</th><th class="num">Margin</th><th>Supplier</th><th class="num">Pages</th></tr></thead>
    <tbody>${products.map((item) => {
      const info = piState.info[item.id] || {};
      const margin = piMargin(item);
      const pages = info.pages || [];
      const id = escapeHtml(item.id);
      return `<tr class="pi-row-link" tabindex="0" title="View details" onclick="piOpenDetail('${id}')" onkeydown="if (event.key === 'Enter') piOpenDetail('${id}')">
        <td style="font-weight:500">${escapeHtml(item.name)}</td>
        <td><span class="font-mono text-xs text-muted">${escapeHtml(item.sku || '—')}</span></td>
        <td class="font-mono text-xs">${escapeHtml(info.product_no || '—')}</td>
        <td class="num">${Number(item.stock || 0).toLocaleString()} ${escapeHtml(item.unit || '')}</td>
        <td class="num">${piMoney(item.cost)}</td>
        <td class="num">${item.price === null || item.price === undefined ? '—' : piMoney(item.price)}</td>
        <td class="num ${margin && margin.amount < 0 ? 'pi-neg' : 'pi-pos'}">${margin ? `${piMoney(margin.amount)} <span class="text-xs text-muted">${margin.pct.toFixed(0)}%</span>` : '—'}</td>
        <td>${info.supplier_name ? escapeHtml(info.supplier_name) : '<span class="text-muted">—</span>'}</td>
        <td class="num">${pages.length || '—'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

// Read-only view of one product; Edit swaps it for the editor.
function piDetailHtml(item) {
  const info = piState.info[item.id] || {};
  const margin = piMargin(item);
  const pages = info.pages || [];
  const breakdown = info.cost_breakdown || [];
  const notSet = '<span class="text-muted">Not set</span>';
  return `
    <div class="text-xs text-muted" style="margin-bottom:12px;">SKU <span class="font-mono">${escapeHtml(item.sku || '—')}</span>${item.active === 0 ? ' · <span class="badge badge-gray">Not active</span>' : ''}</div>
    <div class="pi-stats">
      <div><span>Stock</span><b>${Number(item.stock || 0).toLocaleString()} ${escapeHtml(item.unit || '')}</b></div>
      <div><span>Unit cost</span><b>${piMoney(item.cost)}</b></div>
      <div><span>Selling price</span><b>${item.price === null || item.price === undefined ? '—' : piMoney(item.price)}</b></div>
      <div><span>Margin</span><b class="${margin && margin.amount < 0 ? 'pi-neg' : 'pi-pos'}">${margin ? `${piMoney(margin.amount)} <small>${margin.pct.toFixed(0)}%</small>` : '—'}</b></div>
    </div>
    <div class="pi-detail">
      <div class="pi-row"><span class="pi-label">Product No.</span><div class="font-mono">${info.product_no ? escapeHtml(info.product_no) : notSet}</div></div>
      <div class="pi-row"><span class="pi-label">Ingredients</span><div class="pi-text">${info.ingredients ? escapeHtml(info.ingredients) : notSet}</div></div>
      <div class="pi-row"><span class="pi-label">Supplier</span><div>${info.supplier_name ? escapeHtml(info.supplier_name) : notSet}${info.supplier_link ? ` · <a href="${escapeHtml(info.supplier_link)}" target="_blank" rel="noopener noreferrer">Open link ↗</a>` : ''}</div></div>
      <div class="pi-row"><span class="pi-label">Cost breakdown</span><div>${breakdown.length
        ? `<table class="pi-cost-table">${breakdown.map((c) => `<tr><td>${escapeHtml(c.label || 'Cost')}</td><td class="num">${piMoney(c.amount)}</td></tr>`).join('')}<tr class="pi-cost-total"><td>Total unit cost</td><td class="num">${piMoney(breakdown.reduce((sum, c) => sum + Number(c.amount || 0), 0))}</td></tr></table>`
        : notSet}</div></div>
      <div class="pi-row"><span class="pi-label">Pages (${pages.length})</span><div>${pages.length ? pages.map((p) => `<span class="pi-chip">${escapeHtml(p)}</span>`).join('') : '<span class="text-muted">No pages selected</span>'}</div></div>
      ${info.notes ? `<div class="pi-row"><span class="pi-label">Notes</span><div class="pi-text">${escapeHtml(info.notes)}</div></div>` : ''}
      ${info.updated_at ? `<div class="pi-row"><span class="pi-label">Last updated</span><div class="text-sm text-muted">${escapeHtml(formatDateTime(String(info.updated_at)))}${info.updated_by_name ? ` by ${escapeHtml(info.updated_by_name)}` : ''}</div></div>` : ''}
    </div>`;
}

function piOpenDetail(itemId) {
  const item = (DB.inventory || []).find((i) => i.id === itemId);
  if (!item) return;
  piState.detailId = itemId;
  const title = document.getElementById('pi-detail-title');
  if (title) title.textContent = item.name;
  const body = document.getElementById('pi-detail-body');
  if (body) body.innerHTML = piDetailHtml(item);
  openModal('pi-detail-modal');
}

function piEditFromDetail() {
  const itemId = piState.detailId;
  closeModal('pi-detail-modal');
  if (itemId) piOpenEditor(itemId);
}

function piRenderGrid() {
  const grid = document.getElementById('pi-grid');
  if (grid) grid.innerHTML = piGridHtml();
}

function piSetSearch(value) {
  piState.search = value || '';
  piRenderGrid();
}

async function loadProductInfo() {
  try {
    const data = await authorizedJsonRequest(`/inventory/product-info?_=${Date.now()}`);
    piState.info = data?.info || {};
    piState.pages = Array.isArray(data?.pages) ? data.pages : [];
    piState.loaded = true;
    piRenderGrid();
  } catch (error) {
    const grid = document.getElementById('pi-grid');
    if (grid) grid.innerHTML = `<div class="empty-state"><h3>Could not load</h3><p>${escapeHtml(error.message || 'error')}</p></div>`;
  }
}

/* ── Editor ─────────────────────────────────────────────────── */

function piModalHtml() {
  const canEdit = canManageInventoryStock();
  const detail = `<div class="modal-overlay" id="pi-detail-modal">
    <div class="modal modal-lg">
      <div class="modal-header"><div class="modal-title" id="pi-detail-title">Product</div><button class="modal-close" onclick="closeModal('pi-detail-modal')">×</button></div>
      <div class="modal-body" id="pi-detail-body"></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('pi-detail-modal')">Close</button>
        ${canEdit ? '<button class="btn btn-primary" onclick="piEditFromDetail()">Edit</button>' : ''}
      </div>
    </div>
  </div>`;
  if (!canEdit) return detail;
  return `${detail}<div class="modal-overlay" id="pi-modal">
    <div class="modal modal-lg">
      <div class="modal-header"><div class="modal-title" id="pi-modal-title">Product information</div><button class="modal-close" onclick="closeModal('pi-modal')">×</button></div>
      <div class="modal-body" id="pi-modal-body"></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('pi-modal')">Cancel</button>
        <button class="btn btn-primary" id="pi-save" onclick="piSave()">Save</button>
      </div>
    </div>
  </div>`;
}

function piOpenEditor(itemId) {
  const item = (DB.inventory || []).find((i) => i.id === itemId);
  if (!item) return;
  const info = piState.info[itemId] || {};
  piState.editId = itemId;
  piState.pageSearch = '';
  piState.draft = {
    product_no: info.product_no || '',
    ingredients: info.ingredients || '',
    supplier_name: info.supplier_name || '',
    supplier_link: info.supplier_link || '',
    notes: info.notes || '',
    sell_price: item.price === null || item.price === undefined ? '' : item.price,
    // A product with no breakdown yet starts from its current unit cost.
    cost_breakdown: (info.cost_breakdown || []).length
      ? info.cost_breakdown.map((c) => ({ ...c }))
      : [{ label: 'Product cost', amount: Number(item.cost || 0) }],
    pages: [...(info.pages || [])],
  };
  const title = document.getElementById('pi-modal-title');
  if (title) title.textContent = `${item.name} — product information`;
  piRenderEditor();
  openModal('pi-modal');
}

function piRenderEditor() {
  const body = document.getElementById('pi-modal-body');
  const d = piState.draft;
  if (!body || !d) return;
  body.innerHTML = `
    <div class="form-grid-2">
      <div class="form-group"><label class="form-label">Product No.</label><input type="text" class="form-control" value="${escapeHtml(d.product_no)}" placeholder="e.g. FDA / registration no." oninput="piState.draft.product_no = this.value"></div>
      <div class="form-group"><label class="form-label">Supplier name</label><input type="text" class="form-control" value="${escapeHtml(d.supplier_name)}" placeholder="Supplier" oninput="piState.draft.supplier_name = this.value"></div>
    </div>
    <div class="form-group"><label class="form-label">Supplier link</label><input type="url" class="form-control" value="${escapeHtml(d.supplier_link)}" placeholder="https://…" oninput="piState.draft.supplier_link = this.value"></div>
    <div class="form-group"><label class="form-label">Ingredients</label><textarea class="form-control" rows="3" placeholder="List the ingredients" oninput="piState.draft.ingredients = this.value">${escapeHtml(d.ingredients)}</textarea></div>

    <div class="form-group">
      <label class="form-label">Unit cost breakdown</label>
      <div id="pi-costs">${piCostsHtml()}</div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="piAddCost()">+ Add cost line</button>
    </div>
    <div class="form-grid-2">
      <div class="form-group"><label class="form-label">Selling price</label><input type="number" min="0" step="0.01" class="form-control" value="${escapeHtml(String(d.sell_price))}" placeholder="0.00" oninput="piState.draft.sell_price = this.value; piRenderTotals()"></div>
      <div class="form-group"><label class="form-label">Totals</label><div class="pi-totals" id="pi-totals">${piTotalsHtml()}</div></div>
    </div>

    <div class="form-group">
      <label class="form-label">Pages selling this product <span class="text-muted" id="pi-page-count">(${d.pages.length} selected)</span></label>
      <input type="text" class="form-control" placeholder="Search pages…" style="margin-bottom:8px;" oninput="piState.pageSearch = this.value; piRenderPages()">
      <div class="pi-pages" id="pi-pages">${piPagesHtml()}</div>
    </div>
    <div class="form-group"><label class="form-label">Notes</label><textarea class="form-control" rows="2" oninput="piState.draft.notes = this.value">${escapeHtml(d.notes)}</textarea></div>`;
}

function piCostsHtml() {
  return piState.draft.cost_breakdown.map((c, i) => `<div class="pi-cost-row">
    <input type="text" class="form-control" value="${escapeHtml(c.label || '')}" placeholder="Product, packaging, label…" oninput="piState.draft.cost_breakdown[${i}].label = this.value">
    <input type="number" min="0" step="0.01" class="form-control pi-cost-amount" value="${escapeHtml(String(c.amount ?? ''))}" placeholder="0.00" oninput="piState.draft.cost_breakdown[${i}].amount = this.value; piRenderTotals()">
    <button type="button" class="btn btn-ghost btn-sm" title="Remove" onclick="piRemoveCost(${i})">×</button>
  </div>`).join('');
}

function piUnitCost() {
  return piState.draft.cost_breakdown.reduce((s, c) => s + (Number(c.amount) || 0), 0);
}

function piTotalsHtml() {
  const cost = piUnitCost();
  const price = Number(piState.draft.sell_price);
  const hasPrice = piState.draft.sell_price !== '' && Number.isFinite(price) && price > 0;
  const margin = hasPrice ? price - cost : null;
  return `<span>Total unit cost <b>${piMoney(cost)}</b></span>
    <span>Margin <b class="${margin !== null && margin < 0 ? 'pi-neg' : 'pi-pos'}">${margin === null ? '—' : `${piMoney(margin)} (${((margin / price) * 100).toFixed(0)}%)`}</b></span>`;
}

function piRenderTotals() {
  const el = document.getElementById('pi-totals');
  if (el) el.innerHTML = piTotalsHtml();
}

function piAddCost() {
  piState.draft.cost_breakdown.push({ label: '', amount: '' });
  const el = document.getElementById('pi-costs');
  if (el) el.innerHTML = piCostsHtml();
}

function piRemoveCost(index) {
  piState.draft.cost_breakdown.splice(index, 1);
  const el = document.getElementById('pi-costs');
  if (el) el.innerHTML = piCostsHtml();
  piRenderTotals();
}

function piPagesHtml() {
  const d = piState.draft;
  const all = [...new Set([...piState.pages, ...d.pages])].sort((a, b) => a.localeCompare(b));
  const q = piState.pageSearch.trim().toLowerCase();
  const shown = all.filter((p) => !q || p.toLowerCase().includes(q));
  if (!shown.length) return '<div class="text-muted text-sm">No pages found.</div>';
  return shown.map((p) => `<label class="pi-page"><input type="checkbox" ${d.pages.includes(p) ? 'checked' : ''} onchange="piTogglePage('${encodeURIComponent(p)}', this.checked)"> ${escapeHtml(p)}</label>`).join('');
}

function piRenderPages() {
  const el = document.getElementById('pi-pages');
  if (el) el.innerHTML = piPagesHtml();
}

function piTogglePage(pageEnc, checked) {
  const page = decodeURIComponent(pageEnc);
  const pages = piState.draft.pages.filter((p) => p !== page);
  if (checked) pages.push(page);
  piState.draft.pages = pages;
  const count = document.getElementById('pi-page-count');
  if (count) count.textContent = `(${pages.length} selected)`;
}

async function piSave() {
  const d = piState.draft;
  const itemId = piState.editId;
  if (!d || !itemId) return;
  const link = d.supplier_link.trim();
  if (link && !/^https?:\/\//i.test(link)) {
    showToast('error', 'Check the supplier link', 'It must start with http:// or https://');
    return;
  }
  if (d.cost_breakdown.some((c) => Number(c.amount) < 0)) {
    showToast('error', 'Check the costs', 'Cost amounts cannot be negative.');
    return;
  }
  const button = document.getElementById('pi-save');
  if (button) button.disabled = true;
  try {
    await authorizedJsonRequest(`/inventory/${encodeURIComponent(itemId)}/product-info`, {
      method: 'PUT',
      body: JSON.stringify({
        ...d,
        supplier_link: link,
        cost_breakdown: d.cost_breakdown.map((c) => ({ label: c.label, amount: Number(c.amount) || 0 })),
      }),
    });
    await Promise.all([refreshInventoryFromBackend().catch(() => {}), loadProductInfo()]);
    if (typeof rerenderInventoryTables === 'function') rerenderInventoryTables();
    closeModal('pi-modal');
    piOpenDetail(itemId);
    showToast('success', 'Product saved', (DB.inventory || []).find((i) => i.id === itemId)?.name || '');
  } catch (error) {
    showToast('error', 'Not saved', error.message || 'Request failed');
  } finally {
    if (button) button.disabled = false;
  }
}

window.renderProductInfoTab = renderProductInfoTab;
window.loadProductInfo = loadProductInfo;
// Rendered at page level: a modal inside the hidden tab could never show.
window.renderProductInfoModal = piModalHtml;
