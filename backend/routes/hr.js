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

function calculateWorkedMinutes(record) {
  const start = toMinutes(record?.time_in);
  const end = toMinutes(record?.time_out);
  if (start === null || end === null) return 0;
  let duration = end - start;
  if (duration < 0) duration += 24 * 60;

  const breakStart = toMinutes(record?.break_out);
  const breakEnd = toMinutes(record?.break_in);
  let breakMinutes = Number(record?.break_minutes || DEFAULT_BREAK_MINUTES);
  if (breakStart !== null && breakEnd !== null) {
    breakMinutes = breakEnd - breakStart;
    if (breakMinutes < 0) breakMinutes += 24 * 60;
  }

  return Math.max(0, duration - Math.max(0, breakMinutes));
}

function calculateOtMinutes(record) {
  const manualOt = Number(record?.ot_minutes || 0);
  if (manualOt > 0) return manualOt;
  return Math.max(0, calculateWorkedMinutes(record) - STANDARD_DAY_MINUTES);
}

function calculatePayroll(users, attendance, advances) {
  const byUser = new Map();
  users.forEach((user) => {
    byUser.set(Number(user.id), {
      user,
      days_worked: 0,
      worked_minutes: 0,
      ot_minutes: 0,
      base_pay: 0,
      ot_pay: 0,
      holiday_pay: 0,
      cash_advances: 0,
      gross_pay: 0,
      net_pay: 0,
    });
  });

  attendance.forEach((record) => {
    const userId = Number(record.user_id);
    const summary = byUser.get(userId);
    if (!summary) return;

    const dailyRate = Number(summary.user.daily_rate || 0);
    const workedMinutes = calculateWorkedMinutes(record);
    const otMinutes = calculateOtMinutes(record);
    const holidayPercentage = Number(record.holiday_percentage || 100);
    const completedDay = record.time_in && record.time_out;

    if (completedDay) {
      summary.days_worked += 1;
      summary.base_pay += dailyRate;
      if (holidayPercentage > 100) {
        summary.holiday_pay += dailyRate * ((holidayPercentage - 100) / 100);
      }
    }
    summary.worked_minutes += workedMinutes;
    summary.ot_minutes += otMinutes;
    summary.ot_pay += dailyRate > 0 ? (dailyRate / STANDARD_DAY_MINUTES) * otMinutes * 1.25 : 0;
  });

  advances.forEach((advance) => {
    const summary = byUser.get(Number(advance.user_id));
    if (summary) summary.cash_advances += Number(advance.amount || 0);
  });

  byUser.forEach((summary) => {
    summary.gross_pay = summary.base_pay + summary.ot_pay + summary.holiday_pay;
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

async function getActiveUser(db, userId) {
  return db.prepare(`
    SELECT id, username, full_name, role, daily_rate, is_active
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
      SELECT id, username, full_name, role, daily_rate
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

    res.json({ summary: calculatePayroll(users, attendance, advances) });
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

  router.patch('/users/:id/rate', requireHrManager, async (req, res) => {
    const userId = Number(req.params.id);
    const dailyRate = normalizeMoney(req.body?.daily_rate);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user id' });

    const user = await getActiveUser(db, userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await db.prepare(`
      UPDATE users
      SET daily_rate = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(dailyRate, userId);

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
    const [payroll] = calculatePayroll([user], attendance, advances);

    res.json({
      payslip: {
        user,
        from,
        to,
        attendance: attendance.map((record) => ({
          ...record,
          worked_minutes: calculateWorkedMinutes(record),
          calculated_ot_minutes: calculateOtMinutes(record),
        })),
        cash_advances: advances,
        totals: payroll,
      },
    });
  });

  return router;
};
