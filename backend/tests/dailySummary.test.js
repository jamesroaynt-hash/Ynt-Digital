// Summary access: the super admin reads and writes; the team leads (CSR TL,
// RMO TL, Sales and Marketing TL) read only and never see the notes. Run:
// node --experimental-sqlite --test backend/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const dailySummaryRoutes = require('../routes/dailySummary');

async function startApp() {
  const db = new SqliteClient(':memory:');
  await initializeDatabaseAsync(db);
  const insert = db.prepare("INSERT INTO users (username, password, full_name, role) VALUES (?, 'x', ?, ?)");
  const ids = {
    owner: Number(insert.run('owner', 'Admin User', 'Administrator').lastInsertRowid),
    tl: Number(insert.run('tl', 'CSR Lead', 'CSR TL').lastInsertRowid),
    smtl: Number(insert.run('smtl', 'S&M Lead', 'Sales and Marketing TL').lastInsertRowid),
    csr: Number(insert.run('csr', 'CSR Person', 'CSR').lastInsertRowid),
    admin: Number(insert.run('otheradmin', 'Other Admin', 'Administrator').lastInsertRowid),
  };
  db.prepare('UPDATE users SET is_super_admin = 1 WHERE id = ?').run(ids.owner);
  db.prepare("INSERT INTO daily_summaries (summary_date, data, notes, source) VALUES ('2026-10-27', '{\"orders\":5}', 'private note', 'manual')").run();
  let actingAs = ids.owner;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: actingAs }; next(); });
  app.use('/api/summary', dailySummaryRoutes(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/summary`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  return { ids, server, call, actAs: (id) => { actingAs = id; } };
}

test('team leads read the Summary without notes, and cannot change it', async () => {
  const { ids, server, call, actAs } = await startApp();
  try {
    actAs(ids.tl);
    const day = await call('GET', '/2026-10-27');
    assert.equal(day.status, 200);
    assert.equal(day.data.notes, '');
    assert.equal(day.data.can_edit, false);
    const list = await call('GET', '/');
    assert.equal(list.status, 200);
    assert.equal((await call('PUT', '/2026-10-27/notes', { notes: 'x' })).status, 403);
    assert.equal((await call('POST', '/2026-10-27/generate')).status, 403);
    actAs(ids.smtl);
    assert.equal((await call('GET', '/2026-10-27')).status, 200);
    actAs(ids.admin);
    const adminDay = await call('GET', '/2026-10-27');
    assert.equal(adminDay.status, 200);
    assert.equal(adminDay.data.notes, '');
    assert.equal((await call('POST', '/2026-10-27/generate')).status, 403);
    actAs(ids.csr);
    assert.equal((await call('GET', '/2026-10-27')).status, 403);
    actAs(ids.owner);
    const own = await call('GET', '/2026-10-27');
    assert.equal(own.data.notes, 'private note');
    assert.equal(own.data.can_edit, true);
  } finally { server.close(); }
});
