// Tool links route. Run: node --experimental-sqlite --test backend/tests/
// Uses an in-memory SQLite database with the real schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const toolLinksRoutes = require('../routes/toolLinks');

async function startApp() {
  const db = new SqliteClient(':memory:');
  await initializeDatabaseAsync(db);
  const insert = db.prepare("INSERT INTO users (username, password, full_name, role, is_super_admin) VALUES (?, 'x', ?, ?, ?)");
  const ids = {
    super: Number(insert.run('super1', 'Super', 'Administrator', 1).lastInsertRowid),
    admin: Number(insert.run('admin2', 'Other Admin', 'Administrator', 0).lastInsertRowid),
    csr: Number(insert.run('csr1', 'CSR Person', 'CSR', 0).lastInsertRowid),
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: ids[req.headers['x-test-user'] || 'csr'] };
    next();
  });
  app.use('/api/tool-links', toolLinksRoutes(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/tool-links`;
  const call = async (as, method = 'GET', path = '', body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-test-user': as, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  return { server, call };
}

test('only the super admin adds and removes; everyone reads', async () => {
  const { server, call } = await startApp();
  try {
    assert.equal((await call('admin', 'POST', '', { name: 'X', url: 'https://x.com' })).status, 403);
    assert.equal((await call('csr', 'POST', '', { name: 'X', url: 'https://x.com' })).status, 403);

    const added = await call('super', 'POST', '', { name: 'Pancake', url: 'pos.pancake.vn', icon: '🥞' });
    assert.equal(added.status, 201);
    assert.equal(added.data.rows[0].url, 'https://pos.pancake.vn/');

    const read = await call('csr');
    assert.equal(read.status, 200);
    assert.deepEqual(read.data.rows.map((r) => r.name), ['Pancake']);

    const id = read.data.rows[0].id;
    assert.equal((await call('csr', 'DELETE', `/${id}`)).status, 403);
    assert.equal((await call('super', 'DELETE', `/${id}`)).data.rows.length, 0);
  } finally {
    server.close();
  }
});

test('links must be http(s)', async () => {
  const { server, call } = await startApp();
  try {
    assert.equal((await call('super', 'POST', '', { name: 'Bad', url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await call('super', 'POST', '', { name: '', url: 'https://x.com' })).status, 400);
    assert.equal(toolLinksRoutes.cleanUrl('ftp://x.com'), null);
  } finally {
    server.close();
  }
});
