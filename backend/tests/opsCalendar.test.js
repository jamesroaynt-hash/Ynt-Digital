// Operations calendar routes. Run: node --experimental-sqlite --test backend/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const opsCalendarRoutes = require('../routes/opsCalendar');

test('logistics schedules deliveries; other roles only read', async () => {
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
    const delivery = { event_date: '2026-10-20', event_time: '09:30', category: 'Supplier Delivery', title: 'Coffee restock', item_id: 'P1', qty: 500, supplier: 'Main supplier' };
    assert.equal((await call('POST', '', delivery, 'csr')).status, 403);
    assert.equal((await call('POST', '', { ...delivery, title: '' })).status, 400);
    const created = await call('POST', '', delivery);
    assert.equal(created.status, 201);
    assert.equal(created.data.row.item_name, 'Paragis Coffee');
    assert.equal(created.data.row.status, 'Scheduled');
    await call('POST', '', { event_date: '2026-09-01', title: 'Weekly courier pickup', category: 'Courier Pickup', repeat_rule: 'weekly' });
    await call('POST', '', { event_date: '2026-12-01', title: 'Out of range' });

    const list = await call('GET', '?from=2026-10-01&to=2026-10-31', null, 'csr');
    assert.deepEqual(list.data.rows.map((r) => r.title).sort(), ['Coffee restock', 'Weekly courier pickup']);

    const updated = await call('PUT', `/${created.data.row.id}`, { status: 'Delivered' });
    assert.equal(updated.data.row.status, 'Delivered');
    assert.equal(updated.data.row.qty, 500);
    assert.equal((await call('DELETE', `/${created.data.row.id}`, null, 'csr')).status, 403);
    assert.equal((await call('DELETE', `/${created.data.row.id}`)).status, 200);
  } finally {
    server.close();
  }
});
