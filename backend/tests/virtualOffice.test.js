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

const { officeStatus, dayStanding } = virtualOfficeRoutes;

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

test('only HR, Administrators and the super admin open the Virtual Office', async () => {
  const { server, call } = await startApp();
  try {
    assert.equal((await call('hr')).status, 200);
    assert.equal((await call('ops')).status, 403);
    assert.equal((await call('csr')).status, 403);
    assert.equal((await call('admin')).status, 200);
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

test('HR sets the avatar look; anything but male, female or empty is refused', async () => {
  const { ids, server } = await startApp();
  const base = `http://127.0.0.1:${server.address().port}/api/virtual-office`;
  const put = (as, id, gender) => fetch(`${base}/avatar/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-test-user': as },
    body: JSON.stringify({ gender }),
  }).then(async (res) => ({ status: res.status, data: await res.json() }));
  const roster = (as) => fetch(base, { headers: { 'x-test-user': as } }).then((res) => res.json());
  try {
    assert.equal((await put('hr', ids.csr, 'female')).status, 200);
    assert.equal((await roster('hr')).people.find((p) => p.id === ids.csr).avatar_gender, 'female');
    assert.equal((await put('hr', ids.csr, 'robot')).status, 400);
    assert.equal((await put('ops', ids.csr, 'male')).status, 403);
    assert.equal((await put('hr', 99999, 'male')).status, 404);
    assert.equal((await put('hr', ids.csr, null)).status, 200);
    assert.equal((await roster('hr')).people.find((p) => p.id === ids.csr).avatar_gender, null);
  } finally {
    server.close();
  }
});

test('the day is read against the schedule: leave, rest day, late, absent', () => {
  const base = { shiftStart: '09:00', restDay: false, leaveType: null, nowTime: '10:00' };
  assert.equal(dayStanding({ ...base, record: { time_in: '08:55' } }).standing, 'on_time');
  assert.deepEqual(dayStanding({ ...base, record: { time_in: '09:12' } }), { standing: 'late', late_minutes: 12 });
  assert.equal(dayStanding({ ...base, record: null }).standing, 'absent');
  assert.equal(dayStanding({ ...base, record: null, nowTime: '08:30' }).standing, 'expected');
  assert.equal(dayStanding({ ...base, record: null, restDay: true }).standing, 'rest_day');
  assert.equal(dayStanding({ ...base, record: null, leaveType: 'Sick' }).standing, 'on_leave');
  assert.equal(dayStanding({ ...base, shiftStart: null, record: null }).standing, 'unscheduled');
});

test('roster carries schedule, leave, output and floor numbers; HR fixes seat order', async () => {
  const { db, ids, server, call } = await startApp();
  const base = `http://127.0.0.1:${server.address().port}/api/virtual-office`;
  try {
    const { date } = (await call('hr')).data;
    db.prepare("INSERT INTO user_schedules (user_id, schedule_date, shift_start, shift_end) VALUES (?, ?, '00:00', '23:59')").run(ids.csr, date);
    db.prepare("INSERT INTO attendance_records (user_id, work_date, time_in) VALUES (?, ?, '07:30')").run(ids.csr, date);
    db.prepare("INSERT INTO leave_requests (user_id, leave_date_from, leave_date_to, leave_type, status) VALUES (?, ?, ?, 'Sick', 'approved')").run(ids.ops, date, date);
    db.prepare("INSERT INTO scan_records (scan_ref, tracking_no, scan_date, scan_type, scanned_by) VALUES ('R1', 'T1', ?, 'RTS', ?)").run(date, ids.csr);
    const { data } = await call('hr');
    const csr = data.people.find((p) => p.id === ids.csr);
    assert.equal(csr.standing, 'late');
    assert.deepEqual(csr.shift, { start: '00:00', end: '23:59' });
    assert.equal(csr.punches.time_in, '07:30');
    assert.equal(csr.output.rts_scans, 0); // output is cached for a minute; first poll ran before the scan
    assert.equal(data.people.find((p) => p.id === ids.ops).standing, 'on_leave');
    assert.ok(data.kpis && typeof data.kpis.rts_rate_month === 'number');

    const put = (body, as = 'hr') => fetch(`${base}/seats`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-user': as }, body: JSON.stringify(body),
    }).then((r) => r.status);
    assert.equal(await put({ ids: [ids.csr, ids.hr] }), 200);
    assert.equal(await put({ ids: [ids.csr, ids.csr] }), 400);
    assert.equal(await put({ ids: [ids.csr] }, 'ops'), 403);
    const after = (await call('hr')).data.people;
    assert.equal(after.find((p) => p.id === ids.csr).desk_order, 0);
    assert.equal(after.find((p) => p.id === ids.hr).desk_order, 1);
  } finally {
    server.close();
  }
});
