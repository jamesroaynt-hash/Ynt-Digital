// HR records routes. Run: node --experimental-sqlite --test backend/tests/
// Uses an in-memory SQLite database with the real schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const hrRecordsRoutes = require('../routes/hrRecords');

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
  app.use('/api/hr-records', hrRecordsRoutes(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/hr-records`;
  const call = async (method, path, { as, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(as ? { 'x-test-user': as } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  return { db, ids, server, call };
}

test('only HR, Operation and the super admin reach HR records', async () => {
  const { server, call } = await startApp();
  try {
    assert.equal((await call('GET', '/people', { as: 'hr' })).status, 200);
    assert.equal((await call('GET', '/people', { as: 'ops' })).status, 200);
    assert.equal((await call('GET', '/documents', { as: 'csr' })).status, 403);
    // A plain Administrator is not HR; only the super admin is.
    assert.equal((await call('GET', '/documents', { as: 'admin' })).status, 403);
  } finally {
    server.close();
  }
});

test('documents and memos: create, filter, partial update, delete', async () => {
  const { server, call, ids } = await startApp();
  try {
    const missing = await call('POST', '/documents', { body: { doc_type: 'NDA' } });
    assert.equal(missing.status, 400);

    const contract = await call('POST', '/documents', {
      body: { user_id: ids.csr, doc_type: 'Employment Contract', status: 'Active', issue_date: '2026-01-15', expiry_date: 'not-a-date', file_url: 'https://drive.google.com/x' },
    });
    assert.equal(contract.status, 201);
    assert.equal(contract.data.row.kind, 'document');
    assert.equal(contract.data.row.expiry_date, null);

    const memo = await call('POST', '/documents', { body: { user_id: ids.csr, kind: 'memo', doc_type: 'NTE', status: 'Open' } });
    assert.equal(memo.data.row.kind, 'memo');

    const memos = await call('GET', `/documents?user_id=${ids.csr}&kind=memo`);
    assert.equal(memos.data.rows.length, 1);

    // Only the fields sent change.
    const closed = await call('PUT', `/documents/${memo.data.row.id}`, { body: { status: 'Closed' } });
    assert.equal(closed.data.row.status, 'Closed');
    assert.equal(closed.data.row.doc_type, 'NTE');

    assert.equal((await call('DELETE', `/documents/${contract.data.row.id}`)).status, 200);
    assert.equal((await call('GET', '/documents')).data.rows.length, 1);
  } finally {
    server.close();
  }
});

test('calendar returns repeating events whatever the range, one-offs only inside it', async () => {
  const { server, call } = await startApp();
  try {
    await call('POST', '/calendar', { body: { event_date: '2026-01-08', title: 'WIFI PAYMENT', amount: 1799, repeat_rule: 'monthly', category: 'Bill / Payment' } });
    await call('POST', '/calendar', { body: { event_date: '2026-10-29', title: 'Team schedule' } });
    await call('POST', '/calendar', { body: { event_date: '2026-12-01', title: 'Next year planning' } });
    const october = await call('GET', '/calendar?from=2026-10-01&to=2026-10-31');
    assert.deepEqual(october.data.rows.map((row) => row.title).sort(), ['Team schedule', 'WIFI PAYMENT']);
    assert.equal((await call('POST', '/calendar', { body: { title: 'No date' } })).status, 400);
  } finally {
    server.close();
  }
});

test('trainee progress saves as JSON; settings round-trip', async () => {
  const { server, call } = await startApp();
  try {
    const trainee = await call('POST', '/trainees', { body: { full_name: 'New Trainee', department: 'CSR', start_date: '2026-10-12' } });
    assert.equal(trainee.data.row.status, 'In Training');
    const progress = { checklist: { contract: { status: 'Signed', checked: true } }, targets: {}, readiness: {} };
    const saved = await call('PUT', `/trainees/${trainee.data.row.id}`, { body: { progress } });
    assert.deepEqual(JSON.parse(saved.data.row.progress), progress);
    assert.equal(saved.data.row.full_name, 'New Trainee');

    const tiers = [{ min: 90, amount: 1000 }];
    assert.equal((await call('PUT', '/settings/kpi_allowance_tiers', { body: { value: tiers } })).status, 200);
    assert.deepEqual((await call('GET', '/settings/kpi_allowance_tiers')).data.value, tiers);
    assert.equal((await call('GET', '/settings/anything_else')).status, 404);
  } finally {
    server.close();
  }
});
