// Inventory Products tab (product information). Run: node --experimental-sqlite --test backend/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const inventoryRoutes = require('../routes/inventory');

test('product info saves the sheet and writes the unit cost and price back to the item', async () => {
  const db = new SqliteClient(':memory:');
  await initializeDatabaseAsync(db);
  db.prepare("INSERT INTO inventory (item_id, name, sku, type, stock, cost_price) VALUES ('P1', 'Paragis Coffee', '001', 'Product', 10, 40)").run();
  db.prepare(`INSERT INTO pos_orders (external_id, shop_id, page_name, raw_payload) VALUES ('o1', 'S1', 'Paragis Page', '{}')`).run();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1, role: req.headers['x-role'] || 'Logistics' }; next(); });
  app.use('/api/inventory', inventoryRoutes(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/inventory`;
  const call = async (method, path, body, role) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(role ? { 'x-role': role } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  try {
    const sheet = {
      product_no: 'FDA-123', ingredients: 'Coffee, ginseng', supplier_name: 'Main Supplier', supplier_link: 'https://example.com',
      cost_breakdown: [{ label: 'Product', amount: 35.5 }, { label: 'Packaging', amount: 4.5 }, { label: '', amount: 0 }],
      sell_price: 99, pages: ['Paragis Page', 'Paragis Page', 'Second Page'],
    };
    assert.equal((await call('PUT', '/P1/product-info', sheet, 'CSR')).status, 403);
    assert.equal((await call('PUT', '/P1/product-info', { ...sheet, supplier_link: 'javascript:alert(1)' })).status, 400);
    const saved = await call('PUT', '/P1/product-info', sheet);
    assert.equal(saved.data.unit_cost, 40);

    const item = await db.prepare("SELECT cost_price, sell_price FROM inventory WHERE item_id = 'P1'").get();
    assert.deepEqual([item.cost_price, item.sell_price], [40, 99]);

    const { data } = await call('GET', '/product-info', null, 'CSR');
    assert.equal(data.info.P1.cost_breakdown.length, 2);
    assert.deepEqual(data.info.P1.pages, ['Paragis Page', 'Second Page']);
    assert.ok(data.pages.includes('Paragis Page'));
  } finally {
    server.close();
  }
});
