// Virtual Office route. Run: node --experimental-sqlite --test backend/tests/
// Uses an in-memory SQLite database with the real schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const virtualOfficeRoutes = require('../routes/virtualOffice');

const { officeStatus } = virtualOfficeRoutes;

async function startApp() {
  const db = new SqliteClient(':memory:');
  await initializeDatabaseAsync(db);
  const insert = db.prepare("INSERT INTO users (username, password, full_name, role) VALUES (?, 'x', ?, ?)");
  const ids = {
    hr: Number(insert.run('hr1', 'HR Person', 'HR').lastInsertRowid),
    ops: Number(insert.run('ops1', 'Ops Person', 'Operation').lastInsertRowid),
    csr: Number(insert.run('csr1', 'CSR Person', 'CSR').lastInsertRowid),
    admin: Number(insert.run('admin2', 'Other Admin', 'Administrator').lastInsertRowid),
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: ids[req.headers['x-test-user'] || 'hr'] };
    next();
  });
  app.use('/api/virtual-office', virtualOfficeRoutes(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/virtual-office`;
  const call = async (as) => {
    const res = await fetch(base, { headers: as ? { 'x-test-user': as } : {} });
    return { status: res.status, data: await res.json() };
  };
  return { db, ids, server, call };
}

test('only HR and the super admin open the Virtual Office', async () => {
  const { server, call } = await startApp();
  try {
    assert.equal((await call('hr')).status, 200);
    assert.equal((await call('ops')).status, 403);
    assert.equal((await call('csr')).status, 403);
    assert.equal((await call('admin')).status, 403);
  } finally {
    server.close();
  }
});

test('the roster carries everyone active with today\'s status', async () => {
  const { db, ids, server, call } = await startApp();
  try {
    const first = await call('hr');
    db.prepare('INSERT INTO attendance_records (user_id, work_date, time_in, break_out) VALUES (?, ?, ?, ?)')
      .run(ids.csr, first.data.date, '08:00', '12:05');
    const { data } = await call('hr');
    const csr = data.people.find((p) => p.id === ids.csr);
    const ops = data.people.find((p) => p.id === ids.ops);
    assert.deepEqual([csr.status, csr.since, csr.role], ['lunch', '12:05', 'CSR']);
    assert.equal(ops.status, 'not_in');
  } finally {
    server.close();
  }
});

test('status follows the punches', () => {
  assert.deepEqual(officeStatus(null), { status: 'not_in', since: null });
  assert.deepEqual(officeStatus({ time_in: '08:00' }), { status: 'working', since: '08:00' });
  assert.deepEqual(officeStatus({ time_in: '08:00', break_out: '12:00' }), { status: 'lunch', since: '12:00' });
  assert.deepEqual(officeStatus({ time_in: '08:00', break_out: '12:00', break_in: '13:00' }), { status: 'working', since: '13:00' });
  assert.deepEqual(officeStatus({ time_in: '08:00', break_out: '12:00', break_in: '13:00', break2_out: '15:00' }), { status: 'break', since: '15:00' });
  assert.deepEqual(officeStatus({ time_in: '08:00', break2_out: '10:00', break2_in: '10:15', break_out: '12:00', break_in: '13:00', time_out: '17:00' }), { status: 'left', since: '17:00' });
});
