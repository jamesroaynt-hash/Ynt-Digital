const express = require('express');
const dailySummary = require('../services/dailySummary');
const superAdmin = require('../services/superAdmin');

// The end-of-day Summary page. Sales figures for the whole business: the
// super admin's, and the Administrators' and team leads' (CSR TL, RMO TL,
// Sales and Marketing TL) to read. Taking a snapshot and the notes stay the
// super admin's — every route here checks, not just the menu, and a reader
// never receives the notes.
const TL_ROLES = new Set(['csr tl', 'rmo tl', 'sales and marketing tl', 'administrator', 'admin']);

function roleKey(role) {
  return String(role || '').trim().toLowerCase().replace(/&/g, 'and').replace(/[\s_-]+/g, ' ');
}

function parseData(row) {
  try {
    return row?.data ? JSON.parse(row.data) : null;
  } catch {
    return null;
  }
}

module.exports = function dailySummaryRoutes(db) {
  const router = express.Router();

  // Everyone here is either the super admin (full access) or an Administrator
  // or TL (read only).
  router.use(async (req, res, next) => {
    try {
      if (await superAdmin.isSuperAdmin(db, req.user)) { req.summaryRole = 'owner'; return next(); }
      const user = await db.prepare('SELECT role FROM users WHERE id = ? AND is_active = 1').get(Number(req.user?.id));
      if (user && TL_ROLES.has(roleKey(user.role)) && req.method === 'GET') { req.summaryRole = 'tl'; return next(); }
      return res.status(403).json({ error: user && TL_ROLES.has(roleKey(user.role)) ? 'You can read the Summary only' : 'Super admin access required' });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  // The days with a snapshot, newest first, with the headline numbers for the
  // picker.
  router.get('/', async (req, res) => {
    try {
      const list = await db.prepare(`
        SELECT summary_date, data, notes, source, generated_at
        FROM daily_summaries
        ORDER BY summary_date DESC
        LIMIT 90
      `).all();
      res.json({
        today: dailySummary.manilaToday(),
        data: list.map((row) => {
          const data = parseData(row);
          return {
            date: row.summary_date,
            orders: data?.day?.orders ?? null,
            sales: data?.day?.sales ?? null,
            has_notes: req.summaryRole === 'owner' && !!String(row.notes || '').trim(),
            source: row.source || null,
            generated_at: row.generated_at || null,
          };
        }),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // A custom range of days, worked out live from the orders as they are now.
  // Registered before /:date so "range" is not read as a date.
  router.get('/range', async (req, res) => {
    try {
      const from = dailySummary.validDay(req.query.from);
      const to = dailySummary.validDay(req.query.to);
      if (!from || !to) return res.status(400).json({ error: 'Pick a start and end date' });
      if (from > to) return res.status(400).json({ error: 'The start date is after the end date' });
      const days = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000 + 1;
      if (days > 366) return res.status(400).json({ error: 'Pick a range of a year or less' });
      res.json({ summary: await dailySummary.buildRangeSummary(db, from, to), live: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // One day. A saved snapshot is returned as it was taken; today, before the
  // 23:50 snapshot exists, is worked out live (and not saved) with ?live=1.
  router.get('/:date', async (req, res) => {
    try {
      const day = dailySummary.validDay(req.params.date);
      if (!day) return res.status(400).json({ error: 'Invalid date' });
      const row = await db.prepare('SELECT * FROM daily_summaries WHERE summary_date = ?').get(day);
      let data = parseData(row);
      let live = false;
      if (!data && String(req.query.live) === '1') {
        data = await dailySummary.buildDailySummary(db, day);
        live = true;
      }
      res.json({
        date: day,
        summary: data,
        live,
        notes: req.summaryRole === 'owner' ? (row?.notes || '') : '',
        can_edit: req.summaryRole === 'owner',
        source: row?.source || null,
        generated_at: row?.generated_at || null,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Take (or retake) a day's snapshot now. The day's notes are kept.
  router.post('/:date/generate', async (req, res) => {
    try {
      const day = dailySummary.validDay(req.params.date);
      if (!day) return res.status(400).json({ error: 'Invalid date' });
      if (day > dailySummary.manilaToday()) return res.status(400).json({ error: 'That day has not happened yet.' });
      const summary = await dailySummary.saveDailySummary(db, day, { trigger: 'manual' });
      res.json({ saved: true, date: day, summary });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // The Administrator's notes for a day — saved whether or not the snapshot
  // has been taken yet.
  router.put('/:date/notes', async (req, res) => {
    try {
      const day = dailySummary.validDay(req.params.date);
      if (!day) return res.status(400).json({ error: 'Invalid date' });
      const notes = String(req.body?.notes ?? '').slice(0, 20000);
      await db.prepare(`
        INSERT INTO daily_summaries (summary_date, notes, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(summary_date) DO UPDATE SET
          notes = excluded.notes,
          updated_at = CURRENT_TIMESTAMP
      `).run(day, notes);
      res.json({ saved: true, date: day });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
