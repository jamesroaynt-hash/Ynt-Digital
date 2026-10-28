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
    await call('PUT', '/ad-spend', { date: '2026-10-01', amount: 1000 });
    await call('PUT', '/ad-spend', { date: '2026-10-02', amount: 1000 });
    const roas = await call('PUT', '/records', { user_id: ids.csr, kpi_type: 'roas', period_type: 'monthly', period_key: '2026-10', target: 3, gross_sales: 4800 });
    assert.equal(roas.data.record.actual, 2.4); // 4,800 ÷ the month's 2,000
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
    await call('PUT', '/ad-spend', { date: '2026-10-05', amount: 1000 });
    await call('PUT', '/records', { user_id: ids.csr, kpi_type: 'roas', period_type: 'monthly', period_key: '2026-10', target: 4, gross_sales: 3000 });
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
    const order = db.prepare("INSERT INTO pos_orders (external_id, shop_id, inserted_at_remote, status_name, confirmed_by_name, raw_payload, cod) VALUES (?, 's1', ?, ?, ?, '{}', 1000)");
    // inserted_at_remote is UTC; the Manila day is +8h.
    order.run('a', '2026-10-28T01:00:00', 'submitted', 'Csr Pancake');
    order.run('b', '2026-10-27T20:00:00', 'delivered', 'csr pancake2'); // 04:00 Manila on the 28th, alias spelling
    order.run('c', '2026-10-28T02:00:00', 'wait_print', 'Csr Pancake'); // awaiting print: not counted
    order.run('d', '2026-10-26T03:00:00', 'shipped', 'Csr Pancake'); // another day
    order.run('e', '2026-10-28T03:00:00', 'submitted', 'Someone Else');
    const day = await call('GET', '/records?period_type=daily&period_key=2026-10-28');
    const csrDay = day.data.people.find((p) => p.id === ids.csr);
    assert.equal(csrDay.confirmed_orders.total, 2);
    assert.equal(csrDay.confirmed_orders.linked, true);
    assert.equal(csrDay.confirmed_orders.cod, 2000); // the two counted orders' COD
    // Automatic until HR overrides it: nothing is saved.
    assert.equal(csrDay.kpis.orders.actual, 2);
    assert.equal(csrDay.kpis.orders.actual_source, 'confirmed');
    assert.equal(csrDay.kpis.orders.id, null);
    assert.equal(csrDay.kpis.roas.gross_sales, 2000);
    assert.equal(csrDay.kpis.roas.gross_source, 'confirmed');
    const month = await call('GET', '/records?period_type=monthly&period_key=2026-10');
    assert.equal(month.data.people.find((p) => p.id === ids.csr).confirmed_orders.total, 3);
    assert.equal(month.data.people.find((p) => p.id === ids.rmo).confirmed_orders, undefined);
  } finally { server.close(); }
});

test('a CSR with no linked Pancake name is flagged, not shown as zero orders', async () => {
  const { ids, server, call } = await startApp();
  try {
    const day = await call('GET', '/records?period_type=daily&period_key=2026-10-28');
    assert.deepEqual(day.data.people.find((p) => p.id === ids.csr).confirmed_orders, { total: 0, cod: 0, linked: false });
  } finally { server.close(); }
});

test("ROAS divides each CSR's gross sales by the one team ad spend; a month adds up its days", async () => {
  const { db, ids, server, call } = await startApp();
  try {
    const csr2 = Number(db.prepare("INSERT INTO users (username, password, full_name, role) VALUES ('csr2', 'x', 'CSR Two', 'CSR')").run().lastInsertRowid);
    await call('PUT', '/ad-spend', { date: '2026-10-27', amount: 3000 });
    await call('PUT', '/ad-spend', { date: '2026-10-28', amount: 4000 });
    const day = { kpi_type: 'roas', period_type: 'daily', period_key: '2026-10-28', target: 3 };
    const a = await call('PUT', '/records', { ...day, user_id: ids.csr, gross_sales: 14000 });
    const b = await call('PUT', '/records', { ...day, user_id: csr2, gross_sales: 8000 });
    assert.equal(a.data.record.actual, 3.5);
    assert.equal(b.data.record.actual, 2);
    const month = await call('PUT', '/records', { ...day, period_type: 'monthly', period_key: '2026-10', user_id: ids.csr, gross_sales: 21000 });
    assert.equal(month.data.record.ad_spend, 7000);
    assert.equal(month.data.record.actual, 3);
    // Correcting the day's ad spend moves every CSR's ROAS for that day.
    await call('PUT', '/ad-spend', { date: '2026-10-28', amount: 8000 });
    const after = await call('GET', '/records?period_type=daily&period_key=2026-10-28');
    assert.deepEqual(after.data.team_ad_spend, { total: 8000, days: 1 });
    assert.equal(after.data.people.find((p) => p.id === ids.csr).kpis.roas.actual, 1.75);
    assert.equal(after.data.people.find((p) => p.id === csr2).kpis.roas.actual, 1);
    const log = await call('GET', '/ad-spend/history?month=2026-10');
    assert.equal(log.data.history[0].old_amount, 4000);
    assert.equal(log.data.history[0].new_amount, 8000);
    // No ad spend that day: no ROAS rather than a division by zero.
    const none = await call('PUT', '/records', { ...day, period_key: '2026-10-29', user_id: ids.csr, gross_sales: 5000 });
    assert.equal(none.data.record.actual, null);
  } finally { server.close(); }
});

test('orders target = team target ÷ active CSRs; HR overrides win and clearing goes back to automatic', async () => {
  const { db, ids, server, call } = await startApp();
  try {
    db.prepare("INSERT INTO users (username, password, full_name, role) VALUES ('csr2', 'x', 'CSR Two', 'CSR')").run();
    db.prepare("INSERT INTO user_pos_links (pos_name, user_id) VALUES ('Csr Pancake', ?)").run(ids.csr);
    const order = db.prepare("INSERT INTO pos_orders (external_id, shop_id, inserted_at_remote, status_name, confirmed_by_name, raw_payload, cod) VALUES (?, 's1', '2026-10-28T01:00:00', 'submitted', 'Csr Pancake', '{}', 1500)");
    order.run('a'); order.run('b'); order.run('c');
    await call('PUT', '/team-target', { period_type: 'daily', period_key: '2026-10-28', target: 100 });
    await call('PUT', '/ad-spend', { date: '2026-10-28', amount: 1500 });
    const read = async () => (await call('GET', '/records?period_type=daily&period_key=2026-10-28')).data;
    let data = await read();
    assert.deepEqual(data.team, { orders_target: 100, csr_count: 2, share: 50 });
    let me = data.people.find((p) => p.id === ids.csr);
    assert.equal(me.kpis.orders.target, 50);
    assert.equal(me.kpis.orders.target_source, 'team');
    assert.equal(me.kpis.orders.actual, 3);
    assert.equal(me.kpis.roas.gross_sales, 4500);
    assert.equal(me.kpis.roas.actual, 3); // 4,500 ÷ 1,500
    // Override only the actual: the target stays the team share.
    const key = { user_id: ids.csr, kpi_type: 'orders', period_type: 'daily', period_key: '2026-10-28' };
    await call('PUT', '/records', { ...key, actual: 7 });
    me = (await read()).people.find((p) => p.id === ids.csr);
    assert.equal(me.kpis.orders.actual, 7);
    assert.equal(me.kpis.orders.actual_source, 'manual');
    assert.equal(me.kpis.orders.target_source, 'team');
    // Clearing it brings the confirmed count back.
    await call('PUT', '/records', { ...key, actual: '' });
    me = (await read()).people.find((p) => p.id === ids.csr);
    assert.equal(me.kpis.orders.actual, 3);
    assert.equal(me.kpis.orders.actual_source, 'confirmed');
    // Gross sales override moves ROAS.
    await call('PUT', '/records', { ...key, kpi_type: 'roas', gross_sales: 3000 });
    me = (await read()).people.find((p) => p.id === ids.csr);
    assert.equal(me.kpis.roas.actual, 2);
    assert.equal(me.kpis.roas.gross_source, 'manual');
  } finally { server.close(); }
});

test('the evaluation scores automatic KPIs too, without HR saving anything', async () => {
  const { db, ids, server, call } = await startApp();
  try {
    db.prepare("INSERT INTO user_pos_links (pos_name, user_id) VALUES ('Csr Pancake', ?)").run(ids.csr);
    const order = db.prepare("INSERT INTO pos_orders (external_id, shop_id, inserted_at_remote, status_name, confirmed_by_name, raw_payload, cod) VALUES (?, 's1', '2026-10-10T01:00:00', 'submitted', 'Csr Pancake', '{}', 1000)");
    for (let i = 0; i < 40; i += 1) order.run(`o${i}`);
    await call('PUT', '/team-target', { period_type: 'monthly', period_key: '2026-10', target: 50 }); // one CSR: share 50
    const scores = await call('GET', '/scores?period=2026-10');
    assert.equal(scores.data.rows.find((r) => r.id === ids.csr).total, 80); // 40 of 50
  } finally { server.close(); }
});

test('a half month (1–15 / 16–end) has its own records and counts only its days', async () => {
  const { db, ids, server, call } = await startApp();
  try {
    db.prepare("INSERT INTO user_pos_links (pos_name, user_id) VALUES ('Csr Pancake', ?)").run(ids.csr);
    const order = db.prepare("INSERT INTO pos_orders (external_id, shop_id, inserted_at_remote, status_name, confirmed_by_name, raw_payload, cod) VALUES (?, 's1', ?, 'submitted', 'Csr Pancake', '{}', 500)");
    order.run('a', '2026-10-03T01:00:00'); order.run('b', '2026-10-15T01:00:00'); order.run('c', '2026-10-20T01:00:00');
    await call('PUT', '/ad-spend', { date: '2026-10-10', amount: 250 });
    await call('PUT', '/ad-spend', { date: '2026-10-25', amount: 999 });
    await call('PUT', '/team-target', { period_type: 'half', period_key: '2026-10-H1', target: 4 });
    const h1 = (await call('GET', '/records?period_type=half&period_key=2026-10-H1')).data;
    const me = h1.people.find((p) => p.id === ids.csr);
    assert.equal(me.kpis.orders.actual, 2); // the 3rd and the 15th
    assert.equal(me.kpis.orders.target, 4);
    assert.equal(me.kpis.roas.gross_sales, 1000);
    assert.equal(me.kpis.roas.actual, 4); // 1,000 ÷ 250
    const h2 = (await call('GET', '/records?period_type=half&period_key=2026-10-H2')).data;
    assert.equal(h2.people.find((p) => p.id === ids.csr).kpis.orders.actual, 1);
    assert.deepEqual(h2.team_ad_spend, { total: 999, days: 1 });
    const bad = await call('GET', '/records?period_type=half&period_key=2026-10');
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});

test('orders confirmed by people who are not CSRs come back as "others"', async () => {
  const { db, ids, server, call } = await startApp();
  try {
    db.prepare("INSERT INTO user_pos_links (pos_name, user_id) VALUES ('Csr Pancake', ?)").run(ids.csr);
    db.prepare("INSERT INTO user_pos_links (pos_name, user_id) VALUES ('hr pancake', ?)").run(ids.hr);
    const order = db.prepare("INSERT INTO pos_orders (external_id, shop_id, inserted_at_remote, status_name, confirmed_by_name, raw_payload, cod) VALUES (?, 's1', '2026-10-28T01:00:00', ?, ?, '{}', ?)");
    order.run('a', 'submitted', 'Csr Pancake', 100);
    order.run('b', 'submitted', 'hr pancake', 200);
    order.run('c', 'delivered', 'hr pancake', 300);
    order.run('d', 'submitted', 'Walk In Admin', 50);
    order.run('e', 'wait_print', 'Walk In Admin', 999); // awaiting print: not counted
    const data = (await call('GET', '/records?period_type=daily&period_key=2026-10-28')).data;
    assert.equal(data.others.total, 3);
    assert.equal(data.others.cod, 550);
    assert.deepEqual(data.others.people.map((p) => [p.name, p.orders]), [['HR Person', 2], ['Walk In Admin', 1]]);
  } finally { server.close(); }
});
