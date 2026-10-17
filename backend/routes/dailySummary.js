const express = require('express');
const dailySummary = require('../services/dailySummary');

// The end-of-day Summary page. Sales figures for the whole business, so it is
// the Administrator's alone — every route here checks, not just the menu.
function isAdministrator(user) {
  return ['administrator', 'admin'].includes(String(user?.role || '').trim().toLowerCase());
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

  router.use((req, res, next) => {
    if (!isAdministrator(req.user)) return res.status(403).json({ error: 'Administrator access required' });
    next();
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
            has_notes: !!String(row.notes || '').trim(),
            source: row.source || null,
            generated_at: row.generated_at || null,
          };
        }),
      });
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
        notes: row?.notes || '',
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
