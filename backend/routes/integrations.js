const express = require('express');
const posSync = require('../services/pancakePosSync');
const googleSheetsSync = require('../services/googleSheetsSync');

module.exports = function integrationRoutes(db) {
  const router = express.Router();
  const publicRouter = express.Router();

  function requireAdmin(req, res, next) {
    if (String(req.user?.role || '').trim() !== 'Administrator') {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    return next();
  }

  function cronSecretAllowed(req) {
    const expected = process.env.CRON_SECRET;
    if (!expected) return false; // deny if CRON_SECRET not configured
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    return bearer === expected || req.query.secret === expected;
  }

  async function pancakeWebhookAllowed(req) {
    const setting = await posSync.getPublicSetting(db);
    const expected = process.env.PANCAKE_POS_WEBHOOK_SECRET || setting.webhook_secret;
    if (!expected) return true; // allow all if no secret configured
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    return bearer === expected
      || req.headers['x-pancake-signature'] === expected
      || req.headers['x-webhook-secret'] === expected
      || req.query.secret === expected;
  }

  router.use(requireAdmin);

  router.get('/pancake-pos/status', async (req, res) => {
    res.json(await posSync.getStatus(db));
  });

  router.get('/pancake-pos/users', async (req, res) => {
    try {
      res.json(await posSync.listPosUsers(db, req.query || {}));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/google-sheets/status', async (req, res) => {
    res.json(await googleSheetsSync.getStatus(db));
  });

  router.post('/pancake-pos/config', async (req, res) => {
    const config = await posSync.saveSetting(db, req.body || {});
    res.json(config);
  });

  router.post('/google-sheets/config', async (req, res) => {
    const config = await googleSheetsSync.saveSetting(db, req.body || {});
    res.json(config);
  });

  router.post('/pancake-pos/shops', async (req, res) => {
    try {
      const result = await posSync.listShopsFromApi(db, req.body || {});
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/pancake-pos/collect', async (req, res) => {
    try {
      const result = await posSync.collectPosData(db, req.body || {});
      res.status(202).json({
        message: 'Pancake POS data collection completed.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/pancake-pos/replay', async (req, res) => {
    try {
      const result = await posSync.replayStoredOrdersToDashboard(db, req.body || {});
      res.status(202).json({
        message: 'Pancake POS SQL orders transferred to dashboard.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/pancake-pos/normalize-sources', async (req, res) => {
    try {
      const normalized = await posSync.normalizeSourceSheets(db);
      res.json({ normalized });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/pancake-pos/sync-users', async (req, res) => {
    try {
      const result = await posSync.syncPancakePageUsers(db);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/pancake-pos/staff-stats', async (req, res) => {
    try {
      const { from, to, source, pancake_only } = req.query;
      const params = [];

      const usePancakeOnly = pancake_only === 'true' || pancake_only === '1';

      // Base table: join with source_links when pancake_only is requested
      const fromClause = usePancakeOnly
        ? `FROM orders o
           INNER JOIN integration_source_links isl
             ON isl.provider = 'pancake_pos'
            AND isl.entity_type = 'orders'
            AND isl.local_table = 'orders'
            AND CAST(o.id AS TEXT) = isl.local_id`
        : 'FROM orders o';

      let where = "WHERE o.confirmed_by IS NOT NULL AND TRIM(o.confirmed_by) != ''";
      if (from) { where += ' AND o.order_date >= ?'; params.push(from); }
      if (to)   { where += ' AND o.order_date <= ?'; params.push(to); }
      if (source && source !== 'all') { where += ' AND o.source_sheet = ?'; params.push(source); }

      const stats = await db.prepare(`
        SELECT
          o.confirmed_by AS staff_name,
          COUNT(*) AS total,
          SUM(CASE WHEN o.status = 'Delivered' THEN 1 ELSE 0 END) AS delivered,
          SUM(CASE WHEN o.status IN ('Returned','Returning') THEN 1 ELSE 0 END) AS returned,
          SUM(CASE WHEN o.status = 'Canceled' THEN 1 ELSE 0 END) AS canceled,
          SUM(CASE WHEN o.status NOT IN ('Delivered','Returned','Returning','Canceled') THEN 1 ELSE 0 END) AS active,
          ROUND(100.0 * SUM(CASE WHEN o.status IN ('Returned','Returning') THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN o.status IN ('Delivered','Returned','Returning') THEN 1 ELSE 0 END),0), 1) AS rts_rate
        ${fromClause} ${where}
        GROUP BY o.confirmed_by ORDER BY total DESC
      `).all(...params);

      // Source sheet list: scoped to Pancake-linked orders if pancake_only
      const sourcesFromClause = usePancakeOnly
        ? `FROM orders o
           INNER JOIN integration_source_links isl
             ON isl.provider = 'pancake_pos'
            AND isl.entity_type = 'orders'
            AND isl.local_table = 'orders'
            AND CAST(o.id AS TEXT) = isl.local_id`
        : 'FROM orders o';

      const sources = await db.prepare(
        `SELECT DISTINCT o.source_sheet ${sourcesFromClause}
         WHERE o.source_sheet IS NOT NULL AND TRIM(o.source_sheet) != ''
         ORDER BY o.source_sheet`
      ).all();

      res.json({ stats, sources: sources.map((s) => s.source_sheet) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/google-sheets/records', async (req, res) => {
    try {
      const { sheet, status, search, page = 1, per_page = 50 } = req.query;
      const params = [];

      // Base: only orders synced via Google Sheets (tracked in integration_source_links)
      const baseJoin = `FROM orders o
        INNER JOIN integration_source_links isl
          ON isl.provider = 'google_sheets'
         AND isl.local_table = 'orders'
         AND CAST(o.id AS TEXT) = isl.local_id`;

      let where = 'WHERE 1=1';
      if (sheet && sheet !== 'all') { where += ' AND o.source_sheet = ?'; params.push(sheet); }
      if (status && status !== 'all') { where += ' AND o.status = ?'; params.push(status); }
      if (search) {
        where += ' AND (o.order_ref LIKE ? OR o.customer LIKE ? OR o.tracking_no LIKE ? OR o.source_sheet LIKE ?)';
        const q = `%${search}%`;
        params.push(q, q, q, q);
      }

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const perPage = Math.min(200, Math.max(10, parseInt(per_page, 10) || 50));
      const offset = (pageNum - 1) * perPage;

      const countRow = await db.prepare(`SELECT COUNT(*) AS total ${baseJoin} ${where}`).get(...params);
      const total = countRow?.total || 0;

      const records = await db.prepare(`
        SELECT o.id, o.order_ref, o.tracking_no, o.customer, o.phone,
               o.product, o.qty, o.cod_amount, o.status, o.courier,
               o.source_sheet, o.confirmed_by, o.attempts, o.tags,
               o.order_date, o.updated_at
        ${baseJoin} ${where}
        ORDER BY o.order_date DESC, o.id DESC
        LIMIT ? OFFSET ?
      `).all(...params, perPage, offset);

      // Distinct source_sheet values from Google Sheets records (for dropdown)
      const sheetNames = (await db.prepare(
        `SELECT DISTINCT o.source_sheet ${baseJoin}
         WHERE o.source_sheet IS NOT NULL AND TRIM(o.source_sheet) != ''
         ORDER BY o.source_sheet`
      ).all()).map((r) => r.source_sheet);

      res.json({ records, total, page: pageNum, per_page: perPage, pages: Math.ceil(total / perPage), sheet_names: sheetNames });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.patch('/google-sheets/rename-source', async (req, res) => {
    try {
      const { old_name, new_name } = req.body || {};
      if (!old_name || !new_name || old_name === new_name) {
        return res.status(400).json({ error: 'old_name and new_name are required and must differ.' });
      }
      const result = await db.prepare(
        `UPDATE orders SET source_sheet = ?, updated_at = datetime('now')
         WHERE source_sheet = ?
           AND id IN (
             SELECT CAST(isl.local_id AS INTEGER)
             FROM integration_source_links isl
             WHERE isl.provider = 'google_sheets' AND isl.local_table = 'orders'
           )`
      ).run(new_name.trim(), old_name.trim());
      res.json({ updated: result.changes, old_name, new_name: new_name.trim() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/google-sheets/collect', async (req, res) => {
    try {
      const result = await googleSheetsSync.collectSheetData(db, req.body || {});
      res.status(202).json({
        message: 'Google Sheets data sync completed.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.get('/pancake-pos/status', async (req, res) => {
    const status = await posSync.getStatus(db);
    res.json({ enabled: Boolean(status.enabled), sync_mode: status.sync_mode || null });
  });

  publicRouter.get('/google-sheets/status', async (req, res) => {
    const status = await googleSheetsSync.getStatus(db);
    res.json({ enabled: Boolean(status.enabled), sync_mode: status.sync_mode || null });
  });

  publicRouter.post([
    '/pancake-pos/config',
    '/google-sheets/config',
    '/pancake-pos/shops',
    '/pancake-pos/collect',
    '/pancake-pos/replay',
    '/google-sheets/collect',
  ], (req, res) => {
    res.status(403).json({ error: 'Administrator access required' });
  });

  publicRouter.get('/google-sheets/cron', async (req, res) => {
    if (!cronSecretAllowed(req)) {
      return res.status(401).json({ error: 'Invalid cron secret' });
    }

    try {
      const result = await googleSheetsSync.runScheduledSync(db);
      res.status(202).json({
        message: result?.skipped ? 'Google Sheets scheduled sync skipped.' : 'Google Sheets scheduled sync completed.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.get('/pancake-pos/cron', async (req, res) => {
    if (!cronSecretAllowed(req)) {
      return res.status(401).json({ error: 'Invalid cron secret' });
    }

    try {
      const app = req.app;
      if (typeof app?.locals?.runPancakePosSync === 'function') {
        const result = await app.locals.runPancakePosSync('cron');
        return res.status(202).json({
          message: result ? 'Pancake POS cron sync completed.' : 'Pancake POS cron sync skipped.',
          ...(result || {}),
        });
      }
      res.status(503).json({ error: 'Sync handler not available.' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.post('/pancake-pos/webhook', async (req, res) => {
    if (!(await pancakeWebhookAllowed(req))) {
      return res.status(401).json({ error: 'Invalid Pancake POS webhook secret' });
    }

    try {
      const result = await posSync.receiveWebhook(db, req.body || {});
      res.status(200).json({
        message: 'Pancake POS webhook received.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.publicRouter = publicRouter;
  return router;
};
