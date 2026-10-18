// Operations calendar (supplier order tracking). Run: node --experimental-sqlite --test backend/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const opsCalendarRoutes = require('../routes/opsCalendar');

test('logistics tracks supplier orders; other roles only read', async () => {
  const db = new SqliteClient(':memory:');
  await initializeDatabaseAsync(db);
  const insert = db.prepare("INSERT INTO users (username, password, full_name, role) VALUES (?, 'x', ?, ?)");
  const ids = {
    logi: Number(insert.run('logi1', 'Logi', 'Logistics').lastInsertRowid),
    csr: Number(insert.run('csr1', 'Csr', 'CSR').lastInsertRowid),
  };
  db.prepare("INSERT INTO inventory (item_id, name, sku, type, stock) VALUES ('P1', 'Paragis Coffee', '001', 'Product', 10)").run();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: ids[req.headers['x-test-user'] || 'logi'] }; next(); });
  app.use('/api/ops-calendar', opsCalendarRoutes(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/ops-calendar`;
  const call = async (method, path, body, as) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(as ? { 'x-test-user': as } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  try {
    const order = { event_date: '2026-10-20', order_date: '2026-10-10', po_number: 'PO-1', item_id: 'P1', qty: 1000, supplier: 'Main supplier', amount: 38000, tracking_no: 'JT123' };
    assert.equal((await call('POST', '', order, 'csr')).status, 403);
    assert.equal((await call('POST', '', { ...order, item_id: '' })).status, 400);
    const created = await call('POST', '', order);
    assert.equal(created.status, 201);
    assert.equal(created.data.row.title, 'Paragis Coffee'); // named after the product
    assert.equal(created.data.row.status, 'Ordered');
    assert.equal(created.data.row.amount, 38000);

    // A late open order still shows when looking at a later range.
    await call('POST', '', { event_date: '2026-09-15', title: 'Late labels', status: 'In Transit' });
    await call('POST', '', { event_date: '2026-09-16', title: 'Old arrived', status: 'Arrived' });
    const list = await call('GET', '?from=2026-10-01&to=2026-10-31', null, 'csr');
    assert.deepEqual(list.data.rows.map((r) => r.title).sort(), ['Late labels', 'Paragis Coffee']);

    const updated = await call('PUT', `/${created.data.row.id}`, { status: 'Arrived', qty_received: 980 });
    assert.equal(updated.data.row.status, 'Arrived');
    assert.equal(updated.data.row.qty, 1000);
    assert.equal(updated.data.row.qty_received, 980);
    assert.equal((await call('DELETE', `/${created.data.row.id}`, null, 'csr')).status, 403);
    assert.equal((await call('DELETE', `/${created.data.row.id}`)).status, 200);
  } finally {
    server.close();
  }
});
