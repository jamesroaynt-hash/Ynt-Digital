// Day off is effective-dated like the daily rate: a change applies from its
// date, and earlier dates keep the day off they had. Run:
// node --experimental-sqlite --test backend/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const hrRoutes = require('../routes/hr');
const performanceRoutes = require('../routes/performance');
const { dayOffOnDate } = require('../services/dayOffHistory');

async function startApp() {
  const db = new SqliteClient(':memory:');
  await initializeDatabaseAsync(db);
  const insert = db.prepare("INSERT INTO users (username, password, full_name, role, daily_rate, day_off) VALUES (?, 'x', ?, ?, ?, ?)");
  const ids = {
    hr: Number(insert.run('hr1', 'HR Person', 'HR', 0, -1).lastInsertRowid),
    // Day off Sunday from the start.
    csr: Number(insert.run('csr1', 'CSR Person', 'CSR', 800, 0).lastInsertRowid),
  };
  // Seed history the way the startup backfill does for accounts made before it.
  db.prepare("INSERT INTO user_day_off_history (user_id, day_off, effective_from) VALUES (?, ?, '1970-01-01')").run(ids.csr, 0);
  db.prepare("INSERT INTO user_rate_history (user_id, daily_rate, effective_from) VALUES (?, 800, '1970-01-01')").run(ids.csr);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: ids.hr }; next(); });
  app.use('/api/hr', hrRoutes(db));
  app.use('/api/performance', performanceRoutes(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  return { db, ids, server, call };
}

test('dayOffOnDate reads the row in force on each date', () => {
  const rows = [{ day_off: 0, effective_from: '1970-01-01' }, { day_off: 1, effective_from: '2026-03-02' }];
  assert.equal(dayOffOnDate(rows, '2026-03-01', 5), 0);
  assert.equal(dayOffOnDate(rows, '2026-03-02', 5), 1);
  assert.equal(dayOffOnDate([], '2026-03-02', 5), 5);
  assert.equal(dayOffOnDate([], '2026-03-02', null), -1);
});

test('changing the day off only moves dates from its effective date', async () => {
  const { db, ids, server, call } = await startApp();
  try {
    // Sunday → Monday from Mon 2 Mar 2026.
    const saved = await call('PATCH', `/hr/users/${ids.csr}/rate`, { daily_rate: 800, day_off: 1, effective_from: '2026-03-02' });
    assert.equal(saved.status, 200);

    // Attendance: Sun 1 Mar is still the old day off; Sun 8 Mar is not; Mon 9 Mar is.
    const days = (await call('GET', '/performance/tracker/attendance?from=2026-03-01&to=2026-03-09')).data.days
      .filter((d) => d.user_id === ids.csr);
    const byDate = Object.fromEntries(days.map((d) => [d.work_date, d.status]));
    assert.equal(byDate['2026-03-01'], 'dayoff');
    assert.equal(byDate['2026-03-02'], 'dayoff');
    assert.equal(byDate['2026-03-08'], undefined);
    assert.equal(byDate['2026-03-09'], 'dayoff');

    // Payroll: worked Sun 1 Mar (old day off → rest day) and Sun 8 Mar (regular day now).
    const punch = db.prepare("INSERT INTO attendance_records (user_id, work_date, time_in, break_out, break_in, time_out) VALUES (?, ?, '08:00', '12:00', '13:00', '17:00')");
    punch.run(ids.csr, '2026-03-01');
    punch.run(ids.csr, '2026-03-08');
    const summary = (await call('GET', '/hr/summary?from=2026-03-01&to=2026-03-08')).data.summary.find((s) => Number(s.user.id) === ids.csr);
    assert.equal(summary.rest_days_worked, 1);

    // The work-hours list carries each row's own day off.
    const records = (await call('GET', `/hr/attendance?from=2026-03-01&to=2026-03-08&user_id=${ids.csr}`)).data.records;
    const dayOffOf = Object.fromEntries(records.filter((r) => Number(r.user_id) === ids.csr).map((r) => [r.work_date, r.day_off]));
    assert.equal(dayOffOf['2026-03-01'], 0);
    assert.equal(dayOffOf['2026-03-08'], 1);

    // Recording an old rate at a past date with the day off left alone must not
    // stamp today's day off over history.
    await call('PATCH', `/hr/users/${ids.csr}/rate`, { daily_rate: 700, day_off: 1, effective_from: '2026-01-01' });
    const history = (await call('GET', `/hr/users/${ids.csr}/rate-history`)).data;
    assert.deepEqual(history.day_off_history.map((r) => [r.effective_from, r.day_off]), [['1970-01-01', 0], ['2026-03-02', 1]]);
  } finally {
    server.close();
  }
});
