const express = require('express');

const MANILA_TIMEZONE = 'Asia/Manila';
const DEFAULT_BREAK_MINUTES = 15;
const STANDARD_DAY_MINUTES = 8 * 60;

function manilaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function toMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// Minutes between two HH:MM punches, or null if either is missing.
function spanMinutes(startValue, endValue) {
  const start = toMinutes(startValue);
  const end = toMinutes(endValue);
  if (start === null || end === null) return null;
  let duration = end - start;
  if (duration < 0) duration += 24 * 60;
  return Math.max(0, duration);
}

function calculateWorkedMinutes(record) {
  const start = toMinutes(record?.time_in);
  const end = toMinutes(record?.time_out);
  if (start === null || end === null) return 0;
  let duration = end - start;
  if (duration < 0) duration += 24 * 60;

  // Two independent breaks: the 1-hour break out and a separate 15-min break.
  // Each is measured from its own punches; if neither break was punched at all,
  // fall back to the standard break_minutes deduction (legacy behaviour).
  const break1 = spanMinutes(record?.break_out, record?.break_in);
  const break2 = spanMinutes(record?.break2_out, record?.break2_in);
  let breakMinutes;
  if (break1 === null && break2 === null) {
    breakMinutes = Number(record?.break_minutes || DEFAULT_BREAK_MINUTES);
  } else {
    breakMinutes = (break1 || 0) + (break2 || 0);
  }

  return Math.max(0, duration - Math.max(0, breakMinutes));
}

function calculateOtMinutes(record) {
  const manualOt = Number(record?.ot_minutes || 0);
  if (manualOt > 0) return manualOt;
  return Math.max(0, calculateWorkedMinutes(record) - STANDARD_DAY_MINUTES);
}

function approvedOtKey(userId, workDate) { return `${userId}|${workDate}`; }

function buildApprovedOtMap(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    map.set(approvedOtKey(Number(row.user_id), String(row.work_date)), Number(row.requested_minutes || 0));
  });
  return map;
}

function payableOtMinutes(record, approvedMap) {
  if (!approvedMap) return 0;
  const approved = approvedMap.get(approvedOtKey(Number(record.user_id), String(record.work_date)));
  if (!Number.isFinite(approved) || approved <= 0) return 0;
  const earnedOt = calculateOtMinutes(record);
  return Math.min(approved, earnedOt);
}

// Enumerate every calendar date in [from, to] inclusive, returning the date
// string plus its weekday (0=Sunday..6=Saturday). UTC math keeps the weekday
// stable regardless of server timezone.
function enumerateDates(from, to) {
  const out = [];
  const parse = (s) => {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const start = parse(from);
  const end = parse(to);
  if (start === null || end === null || start > end) return out;
  const DAY = 86400000;
  for (let t = start; t <= end; t += DAY) {
    const d = new Date(t);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    out.push({ date, weekday: d.getUTCDay() });
  }
  return out;
}

function calculatePayroll(users, attendance, advances, approvedOtMap, range) {
  const byUser = new Map();
  const workedDatesByUser = new Map();
  users.forEach((user) => {
    byUser.set(Number(user.id), {
      user,
      days_worked: 0,
      worked_minutes: 0,
      ot_minutes: 0,
      base_pay: 0,
      ot_pay: 0,
      holiday_pay: 0,
      rest_days: 0,
      rest_day_pay: 0,
      cash_advances: 0,
      gross_pay: 0,
      net_pay: 0,
    });
    workedDatesByUser.set(Number(user.id), new Set());
  });

  attendance.forEach((record) => {
    const userId = Number(record.user_id);
    const summary = byUser.get(userId);
    if (!summary) return;

    const dailyRate = Number(summary.user.daily_rate || 0);
    const workedMinutes = calculateWorkedMinutes(record);
    const otMinutes = payableOtMinutes(record, approvedOtMap);
    const holidayPercentage = Number(record.holiday_percentage || 100);
    const perMinuteRate = dailyRate > 0 ? dailyRate / STANDARD_DAY_MINUTES : 0;
    const cappedWorkedMinutes = Math.min(workedMinutes, STANDARD_DAY_MINUTES);
    const proratedBase = cappedWorkedMinutes * perMinuteRate;

    if (workedMinutes > 0) {
      summary.days_worked += 1;
      summary.base_pay += proratedBase;
      workedDatesByUser.get(userId).add(String(record.work_date));
      if (holidayPercentage > 100) {
        summary.holiday_pay += proratedBase * ((holidayPercentage - 100) / 100);
      }
    }
    summary.worked_minutes += workedMinutes;
    summary.ot_minutes += otMinutes;
    summary.ot_pay += perMinuteRate > 0 ? perMinuteRate * otMinutes * 1.25 : 0;
  });

  // Paid rest days: for each user with a permanent day off, pay one daily rate
  // for every rest-day date in the period that has no attendance (worked rest
  // days are already paid through their attendance record above).
  if (range && range.from && range.to) {
    const calendar = enumerateDates(range.from, range.to);
    byUser.forEach((summary, userId) => {
      const dayOff = Number(summary.user.day_off);
      if (!Number.isInteger(dayOff) || dayOff < 0 || dayOff > 6) return;
      const dailyRate = Number(summary.user.daily_rate || 0);
      if (dailyRate <= 0) return;
      const workedDates = workedDatesByUser.get(userId);
      calendar.forEach(({ date, weekday }) => {
        if (weekday !== dayOff || workedDates.has(date)) return;
        summary.rest_days += 1;
        summary.rest_day_pay += dailyRate;
      });
    });
  }

  advances.forEach((advance) => {
    const summary = byUser.get(Number(advance.user_id));
    if (summary) summary.cash_advances += Number(advance.amount || 0);
  });

  byUser.forEach((summary) => {
    summary.gross_pay = summary.base_pay + summary.ot_pay + summary.holiday_pay + summary.rest_day_pay;
    summary.net_pay = summary.gross_pay - summary.cash_advances;
  });

  return [...byUser.values()];
}

function normalizeDate(value, fallback) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : fallback;
}

function normalizeMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

function normalizeTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

async function getActiveUser(db, userId) {
  return db.prepare(`
    SELECT id, username, full_name, role, daily_rate, day_off, is_active
    FROM users
    WHERE id = ? AND is_active = 1
  `).get(userId);
}

function isHrManager(user) {
  const role = String(user?.role || '').trim();
  return role === 'Administrator' || role === 'HR';
}

module.exports = function hrRoutes(db) {
  const router = express.Router();

  async function requireCurrentUser(req, res, next) {
    const user = await getActiveUser(db, req.user?.id);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    req.currentUser = user;
    next();
  }

  function requireHrManager(req, res, next) {
    if (!isHrManager(req.currentUser)) {
      return res.status(403).json({ error: 'HR access required' });
    }
    next();
  }

  async function listUsersForScope(req) {
    if (!isHrManager(req.currentUser)) return [req.currentUser];
    const requestedId = Number(req.query?.user_id || 0);
    const where = requestedId > 0 ? 'WHERE is_active = 1 AND id = ?' : 'WHERE is_active = 1';
    const params = requestedId > 0 ? [requestedId] : [];
    return db.prepare(`
      SELECT id, username, full_name, role, daily_rate, day_off
      FROM users
      ${where}
      ORDER BY full_name COLLATE NOCASE ASC
    `).all(...params);
  }

  router.use(requireCurrentUser);

  router.get('/today', async (req, res) => {
    const { date } = manilaParts();
    const record = await db.prepare(`
      SELECT *
      FROM attendance_records
      WHERE user_id = ? AND work_date = ?
    `).get(req.currentUser.id, date);

    res.json({ date, record: record || null });
  });

  router.post('/clock', async (req, res) => {
    const action = String(req.body?.action || '').trim();
    const allowed = new Map([
      ['time_in', 'time_in'],
      ['break_out', 'break_out'],
      ['break_in', 'break_in'],
      ['break2_out', 'break2_out'],
      ['break2_in', 'break2_in'],
      ['time_out', 'time_out'],
    ]);
    const column = allowed.get(action);
    if (!column) return res.status(400).json({ error: 'Invalid clock action' });

    const now = manilaParts();
    const existing = await db.prepare(`
      SELECT *
      FROM attendance_records
      WHERE user_id = ? AND work_date = ?
    `).get(req.currentUser.id, now.date);

    // Once timed in for the day, block a second time-in (it would overwrite the
    // original). Other punches (break/time-out) may still update.
    if (column === 'time_in' && existing && existing.time_in) {
      return res.status(409).json({ error: 'You already timed in today.' });
    }

    // 1-hour break out: start once, end once.
    if (column === 'break_out' && existing && existing.break_out) {
      return res.status(409).json({ error: 'You already took your break out today.' });
    }
    if (column === 'break_in') {
      if (!existing || !existing.break_out) {
        return res.status(409).json({ error: 'Break out first before ending a break.' });
      }
      if (existing.break_in) {
        return res.status(409).json({ error: 'You already ended your break today.' });
      }
    }
    // 15-minute break: tracked separately, so it can be taken even after the
    // 1-hour break has already ended. Same start-once / end-once rules.
    if (column === 'break2_out' && existing && existing.break2_out) {
      return res.status(409).json({ error: 'You already took your 15-minute break today.' });
    }
    if (column === 'break2_in') {
      if (!existing || !existing.break2_out) {
        return res.status(409).json({ error: 'Start your 15-minute break first.' });
      }
      if (existing.break2_in) {
        return res.status(409).json({ error: 'You already ended your 15-minute break today.' });
      }
    }

    if (!existing) {
      await db.prepare(`
        INSERT INTO attendance_records (user_id, work_date, break_minutes, ${column}, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(req.currentUser.id, now.date, DEFAULT_BREAK_MINUTES, now.time, String(req.body?.notes || '').trim() || null);
    } else {
      const nextRecord = { ...existing, [column]: now.time };
      const nextOt = column === 'time_out' ? calculateOtMinutes(nextRecord) : Number(existing.ot_minutes || 0);
      await db.prepare(`
        UPDATE attendance_records
        SET ${column} = ?,
            ot_minutes = ?,
            notes = COALESCE(?, notes),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(now.time, nextOt, String(req.body?.notes || '').trim() || null, existing.id);
    }

    const record = await db.prepare('SELECT * FROM attendance_records WHERE user_id = ? AND work_date = ?').get(req.currentUser.id, now.date);
    res.status(201).json({ record });
  });

  router.get('/attendance', async (req, res) => {
    const today = manilaParts().date;
    const from = normalizeDate(req.query?.from, today);
    const to = normalizeDate(req.query?.to, from);
    const users = await listUsersForScope(req);
    if (!users.length) return res.json({ records: [] });

    const ids = users.map((user) => Number(user.id));
    const placeholders = ids.map(() => '?').join(',');
    const records = await db.prepare(`
      SELECT a.*, u.full_name, u.username, u.role, u.daily_rate
      FROM attendance_records a
      JOIN users u ON u.id = a.user_id
      WHERE a.user_id IN (${placeholders}) AND a.work_date BETWEEN ? AND ?
      ORDER BY a.work_date DESC, u.full_name COLLATE NOCASE ASC
    `).all(...ids, from, to);

    res.json({
      records: records.map((record) => ({
        ...record,
        worked_minutes: calculateWorkedMinutes(record),
        calculated_ot_minutes: calculateOtMinutes(record),
      })),
    });
  });

  router.put('/attendance/self', async (req, res) => {
    const today = manilaParts().date;
    const fields = ['time_in', 'break_out', 'break_in', 'break2_out', 'break2_in', 'time_out'];
    const existing = await db.prepare(`
      SELECT *
      FROM attendance_records
      WHERE user_id = ? AND work_date = ?
    `).get(req.currentUser.id, today);

    const next = {
      ...(existing || {}),
      user_id: req.currentUser.id,
      work_date: today,
      break_minutes: DEFAULT_BREAK_MINUTES,
    };

    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        const value = String(req.body?.[field] || '').trim();
        const normalized = normalizeTime(value);
        if (value && !normalized) return res.status(400).json({ error: `${field.replace('_', ' ')} must be HH:MM` });
        next[field] = normalized;
      }
    }

    const notes = Object.prototype.hasOwnProperty.call(req.body || {}, 'notes')
      ? String(req.body?.notes || '').trim()
      : (existing?.notes || '');
    next.notes = notes || null;
    next.ot_minutes = calculateOtMinutes(next);

    if (!existing) {
      const result = await db.prepare(`
        INSERT INTO attendance_records (user_id, work_date, time_in, break_out, break_in, break2_out, break2_in, time_out, break_minutes, ot_minutes, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.currentUser.id,
        today,
        next.time_in || null,
        next.break_out || null,
        next.break_in || null,
        next.break2_out || null,
        next.break2_in || null,
        next.time_out || null,
        DEFAULT_BREAK_MINUTES,
        next.ot_minutes,
        next.notes,
      );
      const record = await db.prepare('SELECT * FROM attendance_records WHERE id = ?').get(result.lastInsertRowid);
      return res.status(201).json({ record });
    }

    await db.prepare(`
      UPDATE attendance_records
      SET time_in = ?,
          break_out = ?,
          break_in = ?,
          break2_out = ?,
          break2_in = ?,
          time_out = ?,
          ot_minutes = ?,
          notes = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      next.time_in || null,
      next.break_out || null,
      next.break_in || null,
      next.break2_out || null,
      next.break2_in || null,
      next.time_out || null,
      next.ot_minutes,
      next.notes,
      existing.id,
    );

    const record = await db.prepare('SELECT * FROM attendance_records WHERE id = ?').get(existing.id);
    res.json({ record });
  });

  router.put('/attendance/:id', requireHrManager, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid attendance id' });

    const existing = await db.prepare('SELECT id FROM attendance_records WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Attendance record not found' });

    const breakMinutes = Math.max(0, Number(req.body?.break_minutes || DEFAULT_BREAK_MINUTES));
    const otMinutes = Math.max(0, Number(req.body?.ot_minutes || 0));
    const holidayPercentage = Math.max(100, Number(req.body?.holiday_percentage || 100));
    const holidayType = String(req.body?.holiday_type || 'Regular day').trim() || 'Regular day';

    await db.prepare(`
      UPDATE attendance_records
      SET time_in = ?,
          break_out = ?,
          break_in = ?,
          break2_out = ?,
          break2_in = ?,
          time_out = ?,
          break_minutes = ?,
          ot_minutes = ?,
          holiday_type = ?,
          holiday_percentage = ?,
          notes = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      String(req.body?.time_in || '').trim() || null,
      String(req.body?.break_out || '').trim() || null,
      String(req.body?.break_in || '').trim() || null,
      String(req.body?.break2_out || '').trim() || null,
      String(req.body?.break2_in || '').trim() || null,
      String(req.body?.time_out || '').trim() || null,
      breakMinutes,
      otMinutes,
      holidayType,
      holidayPercentage,
      String(req.body?.notes || '').trim() || null,
      id,
    );

    const record = await db.prepare('SELECT * FROM attendance_records WHERE id = ?').get(id);
    res.json({ record });
  });

  router.delete('/attendance/:id', requireHrManager, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid attendance id' });
    const existing = await db.prepare('SELECT id FROM attendance_records WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Attendance record not found' });
    await db.prepare('DELETE FROM attendance_records WHERE id = ?').run(id);
    res.json({ deleted: true, id });
  });

  router.get('/summary', async (req, res) => {
    const today = manilaParts().date;
    const from = normalizeDate(req.query?.from, today);
    const to = normalizeDate(req.query?.to, from);
    const users = await listUsersForScope(req);
    if (!users.length) return res.json({ summary: [] });

    const ids = users.map((user) => Number(user.id));
    const placeholders = ids.map(() => '?').join(',');
    const attendance = await db.prepare(`
      SELECT *
      FROM attendance_records
      WHERE user_id IN (${placeholders}) AND work_date BETWEEN ? AND ?
    `).all(...ids, from, to);
    const advances = await db.prepare(`
      SELECT *
      FROM cash_advances
      WHERE user_id IN (${placeholders}) AND advance_date BETWEEN ? AND ?
    `).all(...ids, from, to);
    const approvedOt = await db.prepare(`
      SELECT user_id, work_date, requested_minutes
      FROM overtime_requests
      WHERE status = 'approved' AND user_id IN (${placeholders}) AND work_date BETWEEN ? AND ?
    `).all(...ids, from, to);

    res.json({ summary: calculatePayroll(users, attendance, advances, buildApprovedOtMap(approvedOt), { from, to }) });
  });

  router.get('/cash-advances', async (req, res) => {
    const today = manilaParts().date;
    const from = normalizeDate(req.query?.from, today);
    const to = normalizeDate(req.query?.to, from);
    const users = await listUsersForScope(req);
    if (!users.length) return res.json({ advances: [] });

    const ids = users.map((user) => Number(user.id));
    const placeholders = ids.map(() => '?').join(',');
    const advances = await db.prepare(`
      SELECT c.*, u.full_name, u.username
      FROM cash_advances c
      JOIN users u ON u.id = c.user_id
      WHERE c.user_id IN (${placeholders}) AND c.advance_date BETWEEN ? AND ?
      ORDER BY c.advance_date DESC, c.created_at DESC
    `).all(...ids, from, to);

    res.json({ advances });
  });

  router.post('/cash-advances', requireHrManager, async (req, res) => {
    const userId = Number(req.body?.user_id);
    const amount = normalizeMoney(req.body?.amount);
    const advanceDate = normalizeDate(req.body?.advance_date, manilaParts().date);
    const reason = String(req.body?.reason || '').trim();

    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'User is required' });
    if (amount <= 0) return res.status(400).json({ error: 'Cash advance amount is required' });

    const user = await getActiveUser(db, userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await db.prepare(`
      INSERT INTO cash_advances (user_id, advance_date, amount, reason, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, advanceDate, amount, reason || null, req.currentUser.id);

    const advance = await db.prepare('SELECT * FROM cash_advances WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ advance });
  });

  router.post('/cash-advances/request', async (req, res) => {
    const amount = normalizeMoney(req.body?.amount);
    const advanceDate = manilaParts().date;
    const reason = String(req.body?.reason || '').trim();

    if (amount <= 0) return res.status(400).json({ error: 'Cash advance amount is required' });

    const result = await db.prepare(`
      INSERT INTO cash_advances (user_id, advance_date, amount, reason, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.currentUser.id, advanceDate, amount, reason || null, req.currentUser.id);

    const advance = await db.prepare('SELECT * FROM cash_advances WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ advance });
  });

  router.patch('/cash-advances/:id/paid', requireHrManager, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid cash advance id' });

    const existing = await db.prepare('SELECT id FROM cash_advances WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Cash advance not found' });

    const paid = req.body?.paid ? 1 : 0;
    await db.prepare(`
      UPDATE cash_advances
      SET paid = ?,
          paid_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(paid, paid, id);

    const advance = await db.prepare('SELECT * FROM cash_advances WHERE id = ?').get(id);
    res.json({ advance });
  });

  router.get('/leave-requests', async (req, res) => {
    const today = manilaParts().date;
    const from = normalizeDate(req.query?.from, today);
    const to = normalizeDate(req.query?.to, from);
    const users = await listUsersForScope(req);
    if (!users.length) return res.json({ requests: [] });

    const ids = users.map((user) => Number(user.id));
    const placeholders = ids.map(() => '?').join(',');
    const requests = await db.prepare(`
      SELECT l.*, u.full_name, u.username, reviewer.full_name AS reviewed_by_name
      FROM leave_requests l
      JOIN users u ON u.id = l.user_id
      LEFT JOIN users reviewer ON reviewer.id = l.reviewed_by
      WHERE l.user_id IN (${placeholders})
        AND l.leave_date_from <= ?
        AND l.leave_date_to >= ?
      ORDER BY l.created_at DESC
    `).all(...ids, to, from);

    res.json({ requests });
  });

  router.post('/leave-requests', async (req, res) => {
    const today = manilaParts().date;
    const from = normalizeDate(req.body?.leave_date_from, today);
    const to = normalizeDate(req.body?.leave_date_to, from);
    const leaveType = String(req.body?.leave_type || 'Personal').trim() || 'Personal';
    const reason = String(req.body?.reason || '').trim();

    if (to < from) return res.status(400).json({ error: 'Leave end date must be after start date' });

    const result = await db.prepare(`
      INSERT INTO leave_requests (user_id, leave_date_from, leave_date_to, leave_type, reason)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.currentUser.id, from, to, leaveType, reason || null);

    const request = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ request });
  });

  router.patch('/leave-requests/:id', requireHrManager, async (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body?.status || '').trim();
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid leave request id' });
    if (!['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid leave status' });
    }

    const existing = await db.prepare('SELECT id FROM leave_requests WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Leave request not found' });

    await db.prepare(`
      UPDATE leave_requests
      SET status = ?,
          reviewed_by = ?,
          reviewed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(status, req.currentUser.id, id);

    const request = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
    res.json({ request });
  });

  router.patch('/users/:id/rate', requireHrManager, async (req, res) => {
    const userId = Number(req.params.id);
    const dailyRate = normalizeMoney(req.body?.daily_rate);
    // day_off: 0=Sunday..6=Saturday, or -1 for none. Anything out of range = none.
    const rawDayOff = Number(req.body?.day_off);
    const dayOff = Number.isInteger(rawDayOff) && rawDayOff >= 0 && rawDayOff <= 6 ? rawDayOff : -1;
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user id' });

    const user = await getActiveUser(db, userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await db.prepare(`
      UPDATE users
      SET daily_rate = ?,
          day_off = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(dailyRate, dayOff, userId);

    const updated = await getActiveUser(db, userId);
    res.json({ user: updated });
  });

  router.get('/payslip', async (req, res) => {
    const today = manilaParts().date;
    const from = normalizeDate(req.query?.from, today);
    const to = normalizeDate(req.query?.to, from);
    const requestedId = Number(req.query?.user_id || req.currentUser.id);
    const userId = isHrManager(req.currentUser) ? requestedId : Number(req.currentUser.id);
    const user = await getActiveUser(db, userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const attendance = await db.prepare(`
      SELECT *
      FROM attendance_records
      WHERE user_id = ? AND work_date BETWEEN ? AND ?
      ORDER BY work_date ASC
    `).all(userId, from, to);
    const advances = await db.prepare(`
      SELECT *
      FROM cash_advances
      WHERE user_id = ? AND advance_date BETWEEN ? AND ?
      ORDER BY advance_date ASC
    `).all(userId, from, to);
    const approvedOt = await db.prepare(`
      SELECT user_id, work_date, requested_minutes
      FROM overtime_requests
      WHERE status = 'approved' AND user_id = ? AND work_date BETWEEN ? AND ?
    `).all(userId, from, to);
    const approvedOtMap = buildApprovedOtMap(approvedOt);
    const [payroll] = calculatePayroll([user], attendance, advances, approvedOtMap, { from, to });

    res.json({
      payslip: {
        user,
        from,
        to,
        attendance: attendance.map((record) => ({
          ...record,
          worked_minutes: calculateWorkedMinutes(record),
          calculated_ot_minutes: calculateOtMinutes(record),
          payable_ot_minutes: payableOtMinutes(record, approvedOtMap),
        })),
        cash_advances: advances,
        totals: payroll,
      },
    });
  });

  // ─── OVERTIME REQUESTS ───────────────────────────────────────
  router.get('/ot-requests', requireCurrentUser, async (req, res) => {
    const isManager = isHrManager(req.user);
    const status = String(req.query?.status || '').trim();
    const params = [];
    let where = 'WHERE 1=1';
    if (!isManager) { where += ' AND o.user_id = ?'; params.push(req.user.id); }
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      where += ' AND o.status = ?';
      params.push(status);
    }
    if (req.query?.from) { where += ' AND o.work_date >= ?'; params.push(req.query.from); }
    if (req.query?.to)   { where += ' AND o.work_date <= ?'; params.push(req.query.to); }
    const rows = await db.prepare(`
      SELECT o.*, u.full_name AS user_name, r.full_name AS reviewer_name
      FROM overtime_requests o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN users r ON r.id = o.reviewed_by
      ${where}
      ORDER BY o.created_at DESC
      LIMIT 200
    `).all(...params);
    res.json({ data: rows });
  });

  router.post('/ot-requests', requireCurrentUser, async (req, res) => {
    const workDate = normalizeDate(req.body?.work_date, manilaParts().date);
    const minutes = Math.max(0, Math.round(Number(req.body?.requested_minutes || 0)));
    const reason = String(req.body?.reason || '').trim() || null;
    if (!minutes) return res.status(400).json({ error: 'requested_minutes must be greater than 0' });
    try {
      const result = await db.prepare(`
        INSERT INTO overtime_requests (user_id, work_date, requested_minutes, reason)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, work_date) DO UPDATE SET
          requested_minutes = excluded.requested_minutes,
          reason = excluded.reason,
          status = 'pending',
          reviewed_by = NULL,
          reviewed_at = NULL
      `).run(req.user.id, workDate, minutes, reason);
      res.status(201).json({ id: Number(result.lastInsertRowid) || null, work_date: workDate });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.patch('/ot-requests/:id', requireCurrentUser, async (req, res) => {
    if (!isHrManager(req.user)) return res.status(403).json({ error: 'HR or Administrator access required' });
    const id = Number(req.params.id);
    const status = String(req.body?.status || '').trim();
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });
    await db.prepare(`
      UPDATE overtime_requests
      SET status = ?, reviewed_by = ?, reviewed_at = datetime('now')
      WHERE id = ?
    `).run(status, req.user.id, id);
    res.json({ id, status });
  });

  router.delete('/ot-requests/:id', requireCurrentUser, async (req, res) => {
    const id = Number(req.params.id);
    const row = await db.prepare('SELECT user_id, status FROM overtime_requests WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (Number(row.user_id) !== Number(req.user.id) && !isHrManager(req.user)) {
      return res.status(403).json({ error: 'Cannot delete another user request' });
    }
    if (row.status === 'approved' && !isHrManager(req.user)) {
      return res.status(403).json({ error: 'Approved requests can only be removed by HR' });
    }
    await db.prepare('DELETE FROM overtime_requests WHERE id = ?').run(id);
    res.json({ deleted: id });
  });

  // ─── USER SCHEDULES ───────────────────────────────────────────
  router.get('/schedules', requireCurrentUser, async (req, res) => {
    try {
      const userId = isHrManager(req.currentUser)
        ? (Number(req.query?.user_id || 0) || null)
        : Number(req.currentUser.id);
      const today = manilaParts().date;
      const from = normalizeDate(req.query?.from, today);
      const to = normalizeDate(req.query?.to, from);
      const params = [];
      let where = 'WHERE s.schedule_date BETWEEN ? AND ?';
      params.push(from, to);
      if (userId) { where += ' AND s.user_id = ?'; params.push(userId); }
      const rows = await db.prepare(`
        SELECT s.*, u.full_name, u.username,
               a.time_in, a.time_out
        FROM user_schedules s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN attendance_records a ON a.user_id = s.user_id AND a.work_date = s.schedule_date
        ${where}
        ORDER BY s.schedule_date DESC, s.id DESC
      `).all(...params);

      function timeToMinutes(t) {
        if (!t) return null;
        const m = String(t).match(/^(\d{1,2}):(\d{2})/);
        return m ? Number(m[1]) * 60 + Number(m[2]) : null;
      }

      const schedules = rows.map((row) => {
        const isFuture = row.schedule_date > today;
        let status = 'no-schedule'; // shift_start not set
        let minutes_late = null;

        if (!isFuture && row.shift_start) {
          if (!row.time_in) {
            status = 'absent';
          } else {
            const shiftMin = timeToMinutes(row.shift_start);
            const clockMin = timeToMinutes(row.time_in);
            if (shiftMin !== null && clockMin !== null && clockMin > shiftMin) {
              status = 'late';
              minutes_late = clockMin - shiftMin;
            } else {
              status = 'on-time';
            }
          }
        } else if (isFuture) {
          status = 'upcoming';
        } else if (!row.shift_start) {
          // schedule with no set start — just track absent/present
          status = row.time_in ? 'present' : 'absent';
        }

        return { ...row, status, minutes_late };
      });

      res.json({ schedules });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/schedules', requireCurrentUser, requireHrManager, async (req, res) => {
    try {
      const userId = Number(req.body?.user_id);
      const scheduleDate = normalizeDate(req.body?.schedule_date, manilaParts().date);
      const shiftStart = normalizeTime(req.body?.shift_start);
      const shiftEnd = normalizeTime(req.body?.shift_end);
      const notes = String(req.body?.notes || '').trim() || null;
      const isHoliday = req.body?.is_holiday ? 1 : 0;
      const allowedHolidayTypes = ['Regular day', 'Special Holiday', 'Regular Holiday'];
      const holidayType = allowedHolidayTypes.includes(req.body?.holiday_type) ? req.body.holiday_type : 'Regular day';
      const allowedPct = [0, 30, 50, 100];
      const holidayPercentage = allowedPct.includes(Number(req.body?.holiday_percentage)) ? Number(req.body.holiday_percentage) : 0;
      if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'User is required' });
      const user = await getActiveUser(db, userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const result = await db.prepare(`
        INSERT INTO user_schedules (user_id, schedule_date, shift_start, shift_end, notes, is_holiday, holiday_type, holiday_percentage, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, scheduleDate, shiftStart, shiftEnd, notes, isHoliday, holidayType, holidayPercentage, req.currentUser.id);
      const schedule = await db.prepare('SELECT * FROM user_schedules WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json({ schedule });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/schedules/:id', requireCurrentUser, requireHrManager, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid schedule id' });
      const existing = await db.prepare('SELECT id FROM user_schedules WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Schedule not found' });
      await db.prepare('DELETE FROM user_schedules WHERE id = ?').run(id);
      res.json({ deleted: true, id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
