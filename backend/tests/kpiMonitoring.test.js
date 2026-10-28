// KPI Monitoring: HR's manual CSR (orders, ROAS) and RMO (RTS) records. Run:
// node --experimental-sqlite --test backend/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const kpiMonitoringRoutes = require('../routes/kpiMonitoring');

async function startApp() {
  const db = new SqliteClient(':memory:');
  await initializeDatabaseAsync(db);
  const insert = db.prepare("INSERT INTO users (username, password, full_name, role) VALUES (?, 'x', ?, ?)");
  const ids = {
    hr: Number(insert.run('hr1', 'HR Person', 'HR').lastInsertRowid),
    csr: Number(insert.run('csr1', 'CSR Person', 'CSR').lastInsertRowid),
    rmo: Number(insert.run('rmo1', 'RMO Person', 'RMO').lastInsertRowid),
  };
  let actingAs = ids.hr;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: actingAs }; next(); });
  app.use('/api/kpi', kpiMonitoringRoutes(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/kpi`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  return { db, ids, server, call, actAs: (id) => { actingAs = id; } };
}

test('HR records CSR orders and ROAS; achievement and status follow the numbers', async () => {
  const { ids, server, call } = await startApp();
  try {
    const orders = await call('PUT', '/records', { user_id: ids.csr, kpi_type: 'orders', period_type: 'daily', period_key: '2026-10-28', target: 40, actual: 50 });
    assert.equal(orders.status, 200);
    assert.equal(orders.data.record.achievement, 125);
    assert.equal(orders.data.record.status, 'meeting');
    const roas = await call('PUT', '/records', { user_id: ids.csr, kpi_type: 'roas', period_type: 'monthly', period_key: '2026-10', target: 3, actual: 2.4 });
    assert.equal(roas.data.record.status, 'below');
    const zero = await call('PUT', '/records', { user_id: ids.csr, kpi_type: 'orders', period_type: 'monthly', period_key: '2026-10', target: 0, actual: 10 });
    assert.equal(zero.data.record.achievement, null);
    assert.equal(zero.data.record.status, 'no_target');
  } finally { server.close(); }
});

test('RMO RTS defaults to a 12% target, and lower is better', async () => {
  const { ids, server, call } = await startApp();
  try {
    const saved = await call('PUT', '/records', { user_id: ids.rmo, kpi_type: 'rts', period_type: 'monthly', period_key: '2026-10', actual: 9.5 });
    assert.equal(saved.data.record.target, 12);
    assert.equal(saved.data.record.status, 'meeting');
    await call('PUT', '/defaults', { kpi_type: 'rts', period_type: 'monthly', target: 10 });
    const later = await call('PUT', '/records', { user_id: ids.rmo, kpi_type: 'rts', period_type: 'monthly', period_key: '2026-11', actual: 11 });
    assert.equal(later.data.record.target, 10);
    assert.equal(later.data.record.status, 'above');
  } finally { server.close(); }
});

test('one record per employee, KPI and period; corrections keep an audit trail', async () => {
  const { db, ids, server, call } = await startApp();
  try {
    const key = { user_id: ids.csr, kpi_type: 'orders', period_type: 'daily', period_key: '2026-10-28' };
    await call('PUT', '/records', { ...key, target: 40, actual: 30 });
    const fixed = await call('PUT', '/records', { ...key, target: 40, actual: 35, remarks: 'Typo fixed' });
    await call('PUT', '/records', { ...key, target: 40, actual: 35, remarks: 'Typo fixed' }); // no change, no history row
    const count = await db.prepare('SELECT COUNT(*) AS n FROM kpi_records').get();
    assert.equal(Number(count.n), 1);
    const audit = await call('GET', `/records/${fixed.data.record.id}/audit`);
    assert.deepEqual(audit.data.audit.map((a) => a.action), ['create', 'update']);
    assert.equal(audit.data.audit[1].old_actual, 30);
    assert.equal(audit.data.audit[1].new_actual, 35);
    assert.equal(audit.data.audit[1].changed_by, 'HR Person');
    // Daily and monthly are separate rows.
    await call('PUT', '/records', { ...key, period_type: 'monthly', period_key: '2026-10', target: 900, actual: 800 });
    const both = await db.prepare('SELECT COUNT(*) AS n FROM kpi_records').get();
    assert.equal(Number(both.n), 2);
  } finally { server.close(); }
});

test('KPI must fit the department, and only HR may write', async () => {
  const { ids, server, call, actAs } = await startApp();
  try {
    const wrong = await call('PUT', '/records', { user_id: ids.rmo, kpi_type: 'orders', period_type: 'daily', period_key: '2026-10-28', actual: 5 });
    assert.equal(wrong.status, 400);
    const badDay = await call('PUT', '/records', { user_id: ids.csr, kpi_type: 'orders', period_type: 'daily', period_key: '2026-10', actual: 5 });
    assert.equal(badDay.status, 400);
    actAs(ids.csr);
    const denied = await call('PUT', '/records', { user_id: ids.csr, kpi_type: 'orders', period_type: 'daily', period_key: '2026-10-28', actual: 999 });
    assert.equal(denied.status, 403);
  } finally { server.close(); }
});

test('monthly scores feed the evaluation: target met = 100, averaged per person', async () => {
  const { ids, server, call } = await startApp();
  try {
    await call('PUT', '/records', { user_id: ids.csr, kpi_type: 'orders', period_type: 'monthly', period_key: '2026-10', target: 1000, actual: 1200 });
    await call('PUT', '/records', { user_id: ids.csr, kpi_type: 'roas', period_type: 'monthly', period_key: '2026-10', target: 4, actual: 3 });
    await call('PUT', '/records', { user_id: ids.rmo, kpi_type: 'rts', period_type: 'monthly', period_key: '2026-10', target: 12, actual: 15 });
    const scores = await call('GET', '/scores?period=2026-10');
    const by = new Map(scores.data.rows.map((r) => [r.id, r.total]));
    assert.equal(by.get(ids.csr), 87.5); // (100 + 75) / 2
    assert.equal(by.get(ids.rmo), 80); // 12 / 15
    const records = await call('GET', '/records?period_type=monthly&period_key=2026-10');
    assert.equal(records.data.people.length, 2); // HR is not CSR/RMO
  } finally { server.close(); }
});

test('CSR orders offer their Pancake confirmed orders, counted as CSR Records counts them', async () => {
  const { db, ids, server, call } = await startApp();
  try {
    db.prepare("INSERT INTO user_pos_links (pos_name, user_id) VALUES ('Csr Pancake', ?)").run(ids.csr);
    db.prepare("INSERT INTO staff_merge_map (alias, canonical) VALUES ('csr pancake2', 'Csr Pancake')").run();
    const order = db.prepare("INSERT INTO pos_orders (external_id, shop_id, inserted_at_remote, status_name, confirmed_by_name, raw_payload) VALUES (?, 's1', ?, ?, ?, '{}')");
    // inserted_at_remote is UTC; the Manila day is +8h.
    order.run('a', '2026-10-28T01:00:00', 'submitted', 'Csr Pancake');
    order.run('b', '2026-10-27T20:00:00', 'delivered', 'csr pancake2'); // 04:00 Manila on the 28th, alias spelling
    order.run('c', '2026-10-28T02:00:00', 'wait_print', 'Csr Pancake'); // awaiting print: not counted
    order.run('d', '2026-10-26T03:00:00', 'shipped', 'Csr Pancake'); // another day
    order.run('e', '2026-10-28T03:00:00', 'submitted', 'Someone Else');
    const day = await call('GET', '/records?period_type=daily&period_key=2026-10-28');
    const csrDay = day.data.people.find((p) => p.id === ids.csr);
    assert.deepEqual(csrDay.confirmed_orders, { total: 2, linked: true });
    assert.equal(csrDay.kpis.orders, null); // only offered, not saved
    const month = await call('GET', '/records?period_type=monthly&period_key=2026-10');
    assert.equal(month.data.people.find((p) => p.id === ids.csr).confirmed_orders.total, 3);
    assert.equal(month.data.people.find((p) => p.id === ids.rmo).confirmed_orders, undefined);
  } finally { server.close(); }
});

test('a CSR with no linked Pancake name is flagged, not shown as zero orders', async () => {
  const { ids, server, call } = await startApp();
  try {
    const day = await call('GET', '/records?period_type=daily&period_key=2026-10-28');
    assert.deepEqual(day.data.people.find((p) => p.id === ids.csr).confirmed_orders, { total: 0, linked: false });
  } finally { server.close(); }
});

test('ROAS is gross sales divided by ad spend; no spend means no ROAS', async () => {
  const { ids, server, call } = await startApp();
  try {
    const key = { user_id: ids.csr, kpi_type: 'roas', period_type: 'daily', period_key: '2026-10-28', target: 3 };
    const saved = await call('PUT', '/records', { ...key, ad_spend: 4000, gross_sales: 14200 });
    assert.equal(saved.data.record.actual, 3.55);
    assert.equal(saved.data.record.ad_spend, 4000);
    assert.equal(saved.data.record.gross_sales, 14200);
    assert.equal(saved.data.record.status, 'meeting');
    const noSpend = await call('PUT', '/records', { ...key, ad_spend: 0, gross_sales: 14200 });
    assert.equal(noSpend.data.record.actual, null);
    const audit = await call('GET', `/records/${saved.data.record.id}/audit`);
    assert.equal(audit.data.audit[1].old_ad_spend, 4000);
    assert.equal(audit.data.audit[1].new_ad_spend, 0);
  } finally { server.close(); }
});
