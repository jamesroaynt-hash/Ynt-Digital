// Performance: the Employee Tracker's Attendance tab and Compliance read the
// same days. Run: node --experimental-sqlite --test backend/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const performanceRoutes = require('../routes/performance');

async function startApp() {
  const db = new SqliteClient(':memory:');
  await initializeDatabaseAsync(db);
  const insert = db.prepare("INSERT INTO users (username, password, full_name, role) VALUES (?, 'x', ?, ?)");
  const ids = {
    hr: Number(insert.run('hr1', 'HR Person', 'HR').lastInsertRowid),
    csr: Number(insert.run('csr1', 'CSR Person', 'CSR').lastInsertRowid),
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: ids[req.headers['x-test-user'] || 'hr'] };
    next();
  });
  app.use('/api/performance', performanceRoutes(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/performance`;
  const get = async (path, as) => {
    const res = await fetch(`${base}${path}`, { headers: as ? { 'x-test-user': as } : {} });
    return { status: res.status, data: await res.json() };
  };
  return { db, ids, server, get };
}

test('attendance days: on time, late, no time-in, leave and a rest-day punch', async () => {
  const { db, ids, server, get } = await startApp();
  try {
    const shift = db.prepare('INSERT INTO user_schedules (user_id, schedule_date, shift_start) VALUES (?, ?, ?)');
    const punch = db.prepare('INSERT INTO attendance_records (user_id, work_date, time_in, time_out) VALUES (?, ?, ?, ?)');
    shift.run(ids.csr, '2026-01-05', '08:00');
    punch.run(ids.csr, '2026-01-05', '07:55', '17:00');
    shift.run(ids.csr, '2026-01-06', '08:00');
    punch.run(ids.csr, '2026-01-06', '08:20', null);
    shift.run(ids.csr, '2026-01-07', '08:00');
    shift.run(ids.csr, '2026-01-08', '08:00');
    db.prepare("INSERT INTO leave_requests (user_id, leave_date_from, leave_date_to, status) VALUES (?, ?, ?, 'approved')")
      .run(ids.csr, '2026-01-08', '2026-01-08');
    // Jan 9/10 have no Schedule row: judged against the standard 8:00 start.
    punch.run(ids.csr, '2026-01-09', '07:59', '17:00');
    punch.run(ids.csr, '2026-01-10', '08:01', '17:00');
    // Day off = Sunday. Jan 4 has nothing; Jan 11 has a shift row but no punch.
    db.prepare('UPDATE users SET day_off = 0 WHERE id = ?').run(ids.csr);
    shift.run(ids.csr, '2026-01-11', '08:00');

    const { status, data } = await get('/tracker/attendance?from=2026-01-04&to=2026-01-11');
    assert.equal(status, 200);
    const byDate = Object.fromEntries(data.days.filter((d) => d.user_id === ids.csr).map((d) => [d.work_date, d]));
    assert.equal(byDate['2026-01-05'].status, 'yes');
    assert.equal(byDate['2026-01-05'].time_out, '17:00');
    assert.equal(byDate['2026-01-06'].status, 'late');
    assert.equal(byDate['2026-01-07'].status, 'no');
    assert.equal(byDate['2026-01-08'].status, 'leave');
    assert.equal(byDate['2026-01-09'].status, 'yes');
    assert.equal(byDate['2026-01-10'].status, 'late');
    assert.equal(byDate['2026-01-10'].shift_start, '08:00');
    assert.equal(byDate['2026-01-04'].status, 'dayoff');
    assert.equal(byDate['2026-01-11'].status, 'dayoff');
    assert.equal((await get('/tracker/attendance?from=2026-01-01&to=2026-12-31')).status, 400);

    // Compliance scores the same days: (1 + ½ + 0 + 1 + ½) / 5; leave and day off left out.
    const compliance = await get('/compliance?period=2026-01-H1');
    const row = compliance.data.rows.find((r) => r.id === ids.csr);
    assert.equal(row.metrics.attendance.counted, 5);
    assert.equal(row.metrics.attendance.score, 60);

    assert.equal((await get('/tracker/attendance?from=2026-01-04&to=2026-01-10', 'csr')).status, 403);
    assert.equal((await get('/tracker/attendance?from=bad&to=2026-01-10')).status, 400);
  } finally {
    server.close();
  }
});
