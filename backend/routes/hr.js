const express = require('express');

// Administrator, HR and Operation all manage HR: Operation was granted HR's
// access, so it clears every gate HR clears. Role text is typed by hand on
// accounts, hence the lowercase compare and the plural spelling.
const HR_MANAGER_ROLES = new Set(['administrator', 'hr', 'operation', 'operations']);

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

// Length of a break given its two HH:MM punches, or null if either is missing.
// A break is the SHORTER arc between the two punches, so it stays correct when
// the out/in punches are entered in reverse order (out later than in) and when
// a break legitimately crosses midnight on a night shift — instead of a
// reversed pair ballooning to ~23h and wiping out the whole worked day.
function spanMinutes(startValue, endValue) {
  const start = toMinutes(startValue);
  const end = toMinutes(endValue);
  if (start === null || end === null) return null;
  const raw = Math.abs(end - start);
  return Math.min(raw, 24 * 60 - raw);
}

function calculateWorkedMinutes(record) {
  const start = toMinutes(record?.time_in);
  const end = toMinutes(record?.time_out);
  if (start === null || end === null) return 0;
  let duration = end - start;
  if (duration < 0) duration += 24 * 60;

  // Only the 1-hour lunch (break_out/break_in) is unpaid and deducted. The
  // separate 15-min break (break2_out/break2_in) is a PAID break and never
  // reduces worked hours. If the lunch was never punched, fall back to the
  // standard break_minutes deduction (legacy behaviour).
  const lunch = spanMinutes(record?.break_out, record?.break_in);
  const breakMinutes = lunch === null
    ? Number(record?.break_minutes || DEFAULT_BREAK_MINUTES)
    : lunch;

  return Math.max(0, duration - Math.max(0, breakMinutes));
}

function calculateOtMinutes(record) {
  const manualOt = Number(record?.ot_minutes || 0);
  if (manualOt > 0) return manualOt;
  return Math.max(0, calculateWorkedMinutes(record) - STANDARD_DAY_MINUTES);
}

// Resolve the daily rate in effect on a given work date from a user's rate
// history (rows sorted ascending by effective_from). Falls back to the user's
// current daily_rate when no dated entry covers the date. Date strings are
// 'YYYY-MM-DD', so lexical comparison is chronological. This is what keeps past
// payroll frozen: changing a rate today inserts a row dated today, so earlier
// work dates still resolve to the older rate.
function rateOnDate(historyRows, workDate, fallbackRate) {
  let rate = null;
  for (const row of historyRows || []) {
    if (String(row.effective_from) <= String(workDate)) rate = Number(row.daily_rate || 0);
    else break;
  }
  return rate !== null ? rate : Number(fallbackRate || 0);
}

// Load rate history for a set of user ids into a Map<userId, rows[]>, each
// user's rows sorted ascending by effective_from so rateOnDate can scan them.
async function loadRateHistoryMap(db, userIds) {
  const map = new Map();
  const ids = (userIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.prepare(`
    SELECT user_id, daily_rate, effective_from
    FROM user_rate_history
    WHERE user_id IN (${placeholders})
    ORDER BY user_id ASC, effective_from ASC
  `).all(...ids);
  rows.forEach((row) => {
    const uid = Number(row.user_id);
    if (!map.has(uid)) map.set(uid, []);
    map.get(uid).push(row);
  });
  return map;
}

// Resolve the daily rate for a specific attendance record: a per-day override
// (rate_override) wins over the effective-dated history, which wins over the
// user's current daily_rate. Keeps the Work Hours table and payroll in agreement.
function rateForRecord(record, historyRows, fallbackRate) {
  const override = record && record.rate_override;
  if (override !== null && override !== undefined && override !== '' && Number.isFinite(Number(override))) {
    return Number(override);
  }
  return rateOnDate(historyRows, record && record.work_date, fallbackRate);
}

// A per-day rate is set by hand for that day, so it is paid as entered: not
// prorated against the hours on the clock and not subject to the short-day
// rule. That is the whole point of overriding a day — half-day training, a
// field errand, a make-up shift agreed at a flat figure.
function hasRateOverride(record) {
  const override = record && record.rate_override;
  return override !== null && override !== undefined && override !== '' && Number.isFinite(Number(override));
}

function approvedOtKey(userId, workDate) { return `${userId}|${workDate}`; }

function buildApprovedOtMap(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    map.set(approvedOtKey(Number(row.user_id), String(row.work_date)), Number(row.requested_minutes || 0));
  });
  return map;
}

// OT is paid strictly from the approved request: the approved minutes ARE the
// payable amount, whatever the clock happens to show. Minutes clocked past the
// standard day without an approved request pay nothing.
function payableOtMinutes(record, approvedMap) {
  if (!approvedMap) return 0;
  const approved = approvedMap.get(approvedOtKey(Number(record.user_id), String(record.work_date)));
  if (!Number.isFinite(approved) || approved <= 0) return 0;
  return approved;
}

// No work, no pay: a rest day nobody worked pays nothing. Coming in on it is
// paid for in full plus this 30% premium, and the whole of it — the day's own
// pay included — is booked as overtime rather than as a regular work day.
const REST_DAY_PREMIUM_RATE = 0.30;

// Weekday (0=Sunday) for a bare YYYY-MM-DD. Parsed as UTC so the date string
// never slips a day.
function weekdayForDate(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

function calculatePayroll(users, attendance, advances, approvedOtMap, rateHistory) {
  const byUser = new Map();
  users.forEach((user) => {
    byUser.set(Number(user.id), {
      user,
      days_worked: 0,
      // Days actually PAID: half a day worked is half a day paid, so this is
      // the sum of each day's fraction rather than a count of days present.
      days_paid: 0,
      worked_minutes: 0,
      ot_minutes: 0,
      base_pay: 0,
      ot_pay: 0,
      holiday_pay: 0,
      rest_days_worked: 0,
      cash_advances: 0,
      gross_pay: 0,
      net_pay: 0,
    });
  });

  attendance.forEach((record) => {
    const userId = Number(record.user_id);
    const summary = byUser.get(userId);
    if (!summary) return;

    const dailyRate = rateForRecord(record, rateHistory && rateHistory.get(userId), summary.user.daily_rate);
    const workedMinutes = calculateWorkedMinutes(record);
    const otMinutes = payableOtMinutes(record, approvedOtMap);
    const holidayPercentage = Number(record.holiday_percentage || 100);
    const perMinuteRate = dailyRate > 0 ? dailyRate / STANDARD_DAY_MINUTES : 0;
    const cappedWorkedMinutes = Math.min(workedMinutes, STANDARD_DAY_MINUTES);
    // An overridden day pays its rate in full; every other day is prorated
    // against the minutes actually worked.
    const overridden = hasRateOverride(record);
    const dayBase = overridden ? dailyRate : cappedWorkedMinutes * perMinuteRate;

    const recordDayOff = Number(summary.user.day_off);
    const restDayWorked = Number.isInteger(recordDayOff) && recordDayOff >= 0 && recordDayOff <= 6
      && weekdayForDate(record.work_date) === recordDayOff;

    if (workedMinutes > 0 || overridden) {
      if (restDayWorked) {
        // She came in on her rest day. The day is still paid — prorated the
        // same as any other — and earns 30% on top, but none of it is a
        // regular work day: the day's own pay and its premium both land in OT,
        // so days worked and base pay are untouched. An overridden day is the
        // exception: the figure entered by hand IS the day's pay, premium
        // included, so nothing is added on top of it.
        summary.rest_days_worked += 1;
        summary.ot_minutes += cappedWorkedMinutes;
        summary.ot_pay += overridden ? dayBase : dayBase * (1 + REST_DAY_PREMIUM_RATE);
      } else {
        summary.days_worked += 1;
        summary.days_paid += overridden ? 1 : cappedWorkedMinutes / STANDARD_DAY_MINUTES;
        summary.base_pay += dayBase;
      }
      // Same reason: a hand-entered rate already accounts for the holiday, so
      // the premium is not stacked on top of it.
      if (holidayPercentage > 100 && !overridden) {
        summary.holiday_pay += dayBase * ((holidayPercentage - 100) / 100);
      }
    }
    summary.worked_minutes += workedMinutes;
    summary.ot_minutes += otMinutes;
    summary.ot_pay += perMinuteRate > 0 ? perMinuteRate * otMinutes : 0;
  });

  // An advance marked Paid is already settled, so deducting it here would take
  // the same money twice. Only outstanding advances reduce net pay.
  advances.forEach((advance) => {
    if (Number(advance.paid)) return;
    const summary = byUser.get(Number(advance.user_id));
    if (summary) summary.cash_advances += Number(advance.amount || 0);
  });

  byUser.forEach((summary) => {
    summary.days_paid = Math.round(summary.days_paid * 100) / 100;
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
  return HR_MANAGER_ROLES.has(String(user?.role || '').trim().toLowerCase());
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

  // Scope defaults to active accounts, which is what every caller wanted before
  // ?status existed. A deactivated employee still has attendance and unpaid
  // advances behind them, so HR can widen this to reach a final payout.
  async function listUsersForScope(req) {
    if (!isHrManager(req.currentUser)) return [req.currentUser];
    const requestedId = Number(req.query?.user_id || 0);
    const status = String(req.query?.status || 'active').trim().toLowerCase();
    const clauses = [];
    const params = [];
    if (status === 'inactive') clauses.push('is_active = 0');
    else if (status !== 'all') clauses.push('is_active = 1');
    if (requestedId > 0) { clauses.push('id = ?'); params.push(requestedId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return db.prepare(`
      SELECT id, username, full_name, role, daily_rate, day_off, is_active
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
      SELECT a.*, u.full_name, u.username, u.role, u.daily_rate, u.day_off, u.is_active
      FROM attendance_records a
      JOIN users u ON u.id = a.user_id
      WHERE a.user_id IN (${placeholders}) AND a.work_date BETWEEN ? AND ?
      ORDER BY a.work_date DESC, u.full_name COLLATE NOCASE ASC
    `).all(...ids, from, to);

    // Resolve each row's daily_rate the same way payroll does: per-day override
    // first, then the effective-dated history, then the user's current rate.
    // (u.daily_rate from the join is only the current-rate fallback.)
    const rateHistory = await loadRateHistoryMap(db, ids);

    // Approved OT for these users/dates so the table can show the OT that will
    // actually be PAID — the approved request — and not raw hours clocked past 8h.
    const approvedOt = await db.prepare(`
      SELECT user_id, work_date, requested_minutes
      FROM overtime_requests
      WHERE status = 'approved' AND user_id IN (${placeholders}) AND work_date BETWEEN ? AND ?
    `).all(...ids, from, to);
    const approvedOtMap = buildApprovedOtMap(approvedOt);

    res.json({
      records: records.map((record) => ({
        ...record,
        rate_override: record.rate_override == null ? null : Number(record.rate_override),
        daily_rate: rateForRecord(record, rateHistory.get(Number(record.user_id)), record.daily_rate),
        worked_minutes: calculateWorkedMinutes(record),
        calculated_ot_minutes: calculateOtMinutes(record),
        payable_ot_minutes: payableOtMinutes(record, approvedOtMap),
        ot_approved: approvedOtMap.has(approvedOtKey(Number(record.user_id), String(record.work_date))),
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

    // Per-day rate override: blank/omitted clears it (revert to effective-dated
    // rate); a non-negative number overrides the rate for this date only.
    let rateOverride = null;
    const rawOverride = req.body?.rate_override;
    if (rawOverride !== undefined && rawOverride !== null && String(rawOverride).trim() !== '') {
      const n = Number(rawOverride);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Daily rate override must be a non-negative number' });
      rateOverride = n;
    }

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
          rate_override = ?,
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
      rateOverride,
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
    // Administrators aren't paid employees, so keep them out of the payroll list.
    const users = (await listUsersForScope(req)).filter((u) => String(u.role || '').trim() !== 'Administrator');
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

    const rateHistory = await loadRateHistoryMap(db, ids);
    res.json({ summary: calculatePayroll(users, attendance, advances, buildApprovedOtMap(approvedOt), rateHistory) });
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

    // Record the rate as effective from the chosen day (defaults to today,
    // Manila) so payroll BEFORE that date stays frozen at whatever rate applied
    // then. Upsert on (user_id, effective_from) so multiple changes on the same
    // effective day just correct that day's entry rather than stacking rows.
    const effectiveFrom = normalizeDate(req.body?.effective_from, manilaParts().date);
    await db.prepare(`
      INSERT INTO user_rate_history (user_id, daily_rate, effective_from, created_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, effective_from) DO UPDATE SET
        daily_rate = excluded.daily_rate,
        created_by = excluded.created_by
    `).run(userId, dailyRate, effectiveFrom, req.currentUser.id);

    // Derive users.daily_rate ("current" rate) from the FULL history as of today
    // rather than blindly storing the submitted amount. This keeps daily_rate in
    // sync with the history payroll actually reads, and removes two footguns:
    //   1. Recording an OLD rate at an earlier date (to freeze past payroll) no
    //      longer overwrites the present rate — correcting history is one safe
    //      step, not a rate-down-then-rate-back-up dance.
    //   2. A future-dated raise doesn't inflate today's pay before it takes
    //      effect; today still resolves to the rate currently in force.
    const today = manilaParts().date;
    const historyRows = await db.prepare(`
      SELECT daily_rate, effective_from
      FROM user_rate_history
      WHERE user_id = ?
      ORDER BY effective_from ASC
    `).all(userId);
    const currentRate = rateOnDate(historyRows, today, dailyRate);

    await db.prepare(`
      UPDATE users
      SET daily_rate = ?,
          day_off = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(currentRate, dayOff, userId);

    const updated = await getActiveUser(db, userId);
    res.json({ user: updated });
  });

  // Recorded rate history for a user, oldest first, so the payroll edit modal can
  // show what rate applies from when (and make a wrong/backfilled entry visible).
  router.get('/users/:id/rate-history', requireHrManager, async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user id' });
    const history = await db.prepare(`
      SELECT daily_rate, effective_from
      FROM user_rate_history
      WHERE user_id = ?
      ORDER BY effective_from ASC
    `).all(userId);
    res.json({ history });
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
    const rateHistory = await loadRateHistoryMap(db, [userId]);
    const [payroll] = calculatePayroll([user], attendance, advances, approvedOtMap, rateHistory);

    // The rate that applied over this period, not whatever users.daily_rate
    // holds today — those differ for any past period after a raise. If the rate
    // moved mid-period, say so rather than pick one of the two to show.
    const rateRows = rateHistory.get(userId) || [];
    const rateAtStart = rateOnDate(rateRows, from, user.daily_rate);
    const rateAtEnd = rateOnDate(rateRows, to, user.daily_rate);

    res.json({
      payslip: {
        user,
        from,
        to,
        daily_rate: rateAtEnd,
        daily_rate_changed: rateAtStart !== rateAtEnd,
        attendance: attendance.map((record) => ({
          ...record,
          worked_minutes: calculateWorkedMinutes(record),
          calculated_ot_minutes: calculateOtMinutes(record),
          payable_ot_minutes: payableOtMinutes(record, approvedOtMap),
          ot_approved: approvedOtMap.has(approvedOtKey(Number(record.user_id), String(record.work_date))),
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

  // Review an OT request, or revise one that was already reviewed: HR can
  // correct the hours on an approved request and can send it back to pending
  // or reject it after the fact. OT is paid strictly from the approved
  // request, so this is the only way to fix an approval that was wrong.
  router.patch('/ot-requests/:id', requireCurrentUser, async (req, res) => {
    if (!isHrManager(req.user)) return res.status(403).json({ error: 'HR or Administrator access required' });
    const id = Number(req.params.id);
    const existing = await db.prepare('SELECT * FROM overtime_requests WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const hasStatus = req.body?.status !== undefined && req.body?.status !== null && req.body?.status !== '';
    const hasMinutes = req.body?.requested_minutes !== undefined && req.body?.requested_minutes !== null && req.body?.requested_minutes !== '';
    if (!hasStatus && !hasMinutes) return res.status(400).json({ error: 'Nothing to update' });

    const status = hasStatus ? String(req.body.status).trim() : String(existing.status || 'pending');
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved, rejected or pending' });
    }

    let minutes = Math.round(Number(existing.requested_minutes || 0));
    if (hasMinutes) {
      minutes = Math.round(Number(req.body.requested_minutes));
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
        return res.status(400).json({ error: 'requested_minutes must be between 1 and 1440' });
      }
    }

    // Revising a request is itself a review, so the reviewer and the timestamp
    // move to whoever made the change. Sending one back to pending clears them
    // so it reappears in the queue as unreviewed.
    if (status === 'pending') {
      await db.prepare(`
        UPDATE overtime_requests
        SET status = 'pending', requested_minutes = ?, reviewed_by = NULL, reviewed_at = NULL
        WHERE id = ?
      `).run(minutes, id);
    } else {
      await db.prepare(`
        UPDATE overtime_requests
        SET status = ?, requested_minutes = ?, reviewed_by = ?, reviewed_at = datetime('now')
        WHERE id = ?
      `).run(status, minutes, req.user.id, id);
    }
    res.json({ id, status, requested_minutes: minutes });
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
