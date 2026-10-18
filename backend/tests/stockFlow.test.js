// Stock flow routes. Run: node --experimental-sqlite --test backend/tests/
// Uses an in-memory SQLite database with the real schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const stockFlowRoutes = require('../routes/stockFlow');

const DAY = '2026-10-17';

async function startApp() {
  const db = new SqliteClient(':memory:');
  await initializeDatabaseAsync(db);
  const user = db.prepare("INSERT INTO users (username, password, full_name, role) VALUES (?, 'x', ?, ?)");
  const ids = {
    logi: Number(user.run('logi1', 'Logistics Person', 'Logistics').lastInsertRowid),
    csr: Number(user.run('csr1', 'CSR Person', 'CSR').lastInsertRowid),
  };
  const item = db.prepare("INSERT INTO inventory (item_id, name, sku, type, stock, reorder_pt) VALUES (?, ?, ?, 'Product', ?, 50)");
  item.run('P1', 'Paragis Coffee', '001', 500);
  item.run('P2', 'Dental Drops', '002', 100);
  db.prepare("INSERT INTO rts_page_sku (page_name, sku) VALUES ('Paragis Page', '001')").run();

  // Confirmed 2026-10-17 Manila = 2026-10-16T16:00 .. 2026-10-17T16:00 UTC.
  const order = db.prepare(`INSERT INTO pos_orders (external_id, shop_id, page_name, status_name, items_json, confirmed_at, tracking_no, raw_payload)
    VALUES (?, 'S1', ?, ?, ?, ?, ?, '{}')`);
  const lines = (name, qty) => JSON.stringify([{ variation_info: { name }, quantity: qty }]);
  order.run('o1', 'Paragis Page', 'shipped', lines('ParaGis Coffee', 2), '2026-10-16T17:00:00', 'T1');
  order.run('o2', 'Paragis Page', 'submitted', lines('3 PACKS PARAGIS', 1), '2026-10-17T10:00:00', 'T2');
  order.run('o3', 'Paragis Page', 'canceled', lines('ParaGis Coffee', 5), '2026-10-17T11:00:00', 'T3');
  order.run('o4', 'Dental Page', 'submitted', lines('Dental Drops', 1), '2026-10-17T12:00:00', 'T4');
  order.run('o5', 'Paragis Page', 'submitted', lines('ParaGis Coffee', 9), '2026-10-17T17:00:00', 'T5'); // next Manila day

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: ids[req.headers['x-test-user'] || 'logi'] };
    next();
  });
  app.use('/api/stock-flow', stockFlowRoutes(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/stock-flow`;
  const call = async (method, path, { as, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(as ? { 'x-test-user': as } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const stock = async (id) => Number((await db.prepare('SELECT stock FROM inventory WHERE item_id = ?').get(id)).stock);
  return { db, server, call, stock };
}

test('picking list totals the Manila day per item and never touches stock', async () => {
  const { server, call, stock } = await startApp();
  try {
    const { data } = await call('GET', `/picking?date=${DAY}`);
    assert.equal(data.orders, 3); // canceled and next-day orders left out
    const coffee = data.items.find((i) => i.item_id === 'P1');
    assert.equal(coffee.planned, 5); // 2 x 1 + 3-pack x 1
    assert.deepEqual(coffee.pages.map((p) => p.page), ['Paragis Page']);
    assert.deepEqual(data.unmapped.map((u) => u.page), ['Dental Page']);
    assert.equal(await stock('P1'), 500);
  } finally {
    server.close();
  }
});

test('stock out deducts the packed quantity once per day, and a void puts it back', async () => {
  const { server, call, stock } = await startApp();
  try {
    assert.equal((await call('POST', '/stock-out', { as: 'csr', body: { date: DAY, lines: [] } })).status, 403);

    // The Dental page is not linked yet.
    const unlinked = await call('POST', '/stock-out', { body: { date: DAY, lines: [{ item_id: 'P1', packed_qty: 5 }] } });
    assert.equal(unlinked.status, 409);
    assert.equal(unlinked.data.unmapped[0].page, 'Dental Page');
    await call('PUT', '/page-item', { body: { page_name: 'Dental Page', item_id: 'P2' } });

    // A short pack needs a reason; leaving an item off is refused.
    const noReason = await call('POST', '/stock-out', { body: { date: DAY, lines: [{ item_id: 'P1', packed_qty: 4 }, { item_id: 'P2', packed_qty: 1 }] } });
    assert.equal(noReason.status, 400);
    const missing = await call('POST', '/stock-out', { body: { date: DAY, lines: [{ item_id: 'P1', packed_qty: 5 }] } });
    assert.equal(missing.status, 400);

    const posted = await call('POST', '/stock-out', {
      body: { date: DAY, lines: [{ item_id: 'P1', packed_qty: 4, reason: 'One order on hold' }, { item_id: 'P2', packed_qty: 1 }] },
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.data.batch.lines.find((l) => l.item_id === 'P1').variance, -1);
    assert.equal(await stock('P1'), 496);
    assert.equal(await stock('P2'), 99);

    const again = await call('POST', '/stock-out', { body: { date: DAY, lines: [{ item_id: 'P1', packed_qty: 5 }, { item_id: 'P2', packed_qty: 1 }] } });
    assert.equal(again.status, 409);
    assert.equal(await stock('P1'), 496);

    assert.equal((await call('POST', `/stock-out/${DAY}/void`, { body: {} })).status, 400);
    await call('POST', `/stock-out/${DAY}/void`, { body: { reason: 'Wrong count' } });
    assert.equal(await stock('P1'), 500);
    const repost = await call('POST', '/stock-out', { body: { date: DAY, lines: [{ item_id: 'P1', packed_qty: 5 }, { item_id: 'P2', packed_qty: 1 }] } });
    assert.equal(repost.status, 201);
    assert.equal(await stock('P1'), 495);
  } finally {
    server.close();
  }
});

test('stock out cannot take more than the system holds', async () => {
  const { server, call, db, stock } = await startApp();
  try {
    db.prepare("UPDATE inventory SET stock = 3 WHERE item_id = 'P1'").run();
    const res = await call('POST', '/stock-out', {
      body: { date: DAY, acknowledge_unmapped: true, lines: [{ item_id: 'P1', packed_qty: 5 }] },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.short[0].item_id, 'P1');
    assert.equal(await stock('P1'), 3);
  } finally {
    server.close();
  }
});

test('returns: the switch folds old RTS pcs in once, then only inspected sellable pcs restock', async () => {
  const { server, call, db, stock } = await startApp();
  try {
    const scan = db.prepare("INSERT INTO scan_records (scan_ref, tracking_no, scan_type) VALUES (?, ?, 'RTS')");
    scan.run('R1', 'T1'); // 2 pcs of coffee, scanned before the switch

    assert.equal((await call('POST', '/counts', { body: { lines: [{ item_id: 'P1', counted_qty: 1 }] } })).status, 409);

    const preview = await call('GET', '/returns/start-preview');
    assert.equal(preview.data.items.find((i) => i.item_id === 'P1').rts_pcs, 2);
    const started = await call('POST', '/returns/start', { body: {} });
    assert.equal(started.status, 201);
    assert.equal(await stock('P1'), 502);
    assert.equal((await call('POST', '/returns/start', { body: {} })).status, 409);
    assert.equal(await stock('P1'), 502);

    scan.run('R2', 'T2'); // 3-pack, scanned after
    scan.run('R3', 't2'); // same parcel scanned twice
    const list = await call('GET', '/returns?status=pending');
    assert.equal(list.data.pending_count, 1);
    assert.equal(list.data.rows[0].expected_pcs, 3);
    assert.equal(list.data.rows[0].suggested_item_id, 'P1');
    assert.equal(await stock('P1'), 502); // a scan alone adds nothing

    const inspected = await call('POST', '/returns/inspect', {
      body: { tracking_no: 'T2', item_id: 'P1', expected_pcs: 3, sellable_qty: 2, damaged_qty: 1 },
    });
    assert.equal(inspected.data.status, 'restocked');
    assert.equal(await stock('P1'), 504);
    assert.equal((await call('POST', '/returns/inspect', { body: { tracking_no: 'T2', item_id: 'P1', sellable_qty: 2, damaged_qty: 0 } })).status, 409);
    assert.equal(await stock('P1'), 504);
  } finally {
    server.close();
  }
});

test('a count adjusts to the shelf with a reason, and the balance splits the movements', async () => {
  const { server, call, stock } = await startApp();
  try {
    await call('POST', '/returns/start', { body: {} });
    await call('POST', '/stock-in', { body: { item_id: 'P1', qty: 200, supplier: 'Main supplier', ref: 'DR-1' } });
    assert.equal(await stock('P1'), 700);
    await call('PUT', '/page-item', { body: { page_name: 'Dental Page', item_id: 'P2' } });
    await call('POST', '/stock-out', { body: { date: DAY, lines: [{ item_id: 'P1', packed_qty: 5 }, { item_id: 'P2', packed_qty: 1 }] } });

    const noReason = await call('POST', '/counts', { body: { lines: [{ item_id: 'P1', counted_qty: 690 }] } });
    assert.equal(noReason.status, 400);
    const counted = await call('POST', '/counts', {
      body: { lines: [{ item_id: 'P1', counted_qty: 690, reason: 'Five packs torn' }, { item_id: 'P2', counted_qty: 99 }, { item_id: 'P2', counted_qty: '' }] },
    });
    assert.equal(counted.data.counted, 2);
    assert.equal(counted.data.adjusted, 1);
    assert.equal(await stock('P1'), 690);

    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const { data } = await call('GET', `/balance?from=${today}&to=${today}`);
    const coffee = data.rows.find((r) => r.item_id === 'P1');
    assert.deepEqual(
      [coffee.opening, coffee.stock_in, coffee.stock_out, coffee.returns, coffee.adjustments, coffee.closing],
      [500, 200, 5, 0, -5, 690],
    );

    const overview = await call('GET', '/overview');
    assert.equal(overview.data.stock.find((s) => s.item_id === 'P1').last_counted, today);
  } finally {
    server.close();
  }
});
