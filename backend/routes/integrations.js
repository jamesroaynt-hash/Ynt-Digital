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

  // Read-only report — available to any authenticated user, not just Administrators.
  router.get('/pancake-pos/staff-stats', async (req, res) => {
    try {
      const { from, to, source } = req.query;
      const params = [];

      let onFilter = '';
      if (from) { onFilter += ' AND DATE(po.inserted_at_remote) >= ?'; params.push(from); }
      if (to)   { onFilter += ' AND DATE(po.inserted_at_remote) <= ?'; params.push(to); }
      if (source && source !== 'all') { onFilter += ' AND po.page_name = ?'; params.push(source); }

      const stats = await db.prepare(`
        SELECT
          COALESCE(NULLIF(TRIM(pu.name), ''), pu.username, pu.email, '—') AS staff_name,
          COUNT(po.id) AS total,
          SUM(CASE WHEN po.status_name = 'delivered' THEN 1 ELSE 0 END) AS delivered,
          SUM(CASE WHEN po.status_name IN ('returned','returning') THEN 1 ELSE 0 END) AS returned,
          SUM(CASE WHEN po.status_name IN ('canceled','removed') THEN 1 ELSE 0 END) AS canceled,
          SUM(CASE WHEN po.id IS NOT NULL AND po.status_name NOT IN ('delivered','returned','returning','canceled','removed') THEN 1 ELSE 0 END) AS active,
          ROUND(100.0 * SUM(CASE WHEN po.status_name IN ('returned','returning') THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN po.status_name IN ('delivered','returned','returning') THEN 1 ELSE 0 END),0), 1) AS rts_rate
        FROM pos_users pu
        LEFT JOIN pos_orders po
          ON po.assigned_user_id = pu.external_id${onFilter}
        WHERE pu.is_active = 1
        GROUP BY pu.id, pu.name, pu.username, pu.email
        ORDER BY total DESC, staff_name
      `).all(...params);

      const sources = await db.prepare(
        `SELECT DISTINCT page_name FROM pos_orders
         WHERE page_name IS NOT NULL AND TRIM(page_name) != ''
         ORDER BY page_name`
      ).all();

      res.json({ stats, sources: sources.map((s) => s.page_name) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Read-only Google Sheets records — available to any authenticated user.
  router.get('/google-sheets/records', async (req, res) => {
    try {
      const { sheet, status, tag, search, date_from, date_to, page = 1, per_page = 50 } = req.query;
      const params = [];

      const baseFrom = 'FROM google_orders g';

      let where = 'WHERE 1=1';
      if (sheet && sheet !== 'all') { where += ' AND g.source_sheet = ?'; params.push(sheet); }
      // Match the displayed/normalized status so filter agrees with status chips.
      if (status && status !== 'all') {
        where += " AND LOWER(COALESCE(NULLIF(TRIM(g.status_normalized), ''), TRIM(g.status))) = LOWER(?)";
        params.push(status);
      }
      // g.tag may hold a comma-joined list ("1st Attemp, 2ND ATTEMP"); match any single tag.
      if (tag && tag !== 'all') {
        where += " AND ',' || REPLACE(COALESCE(g.tag, ''), ', ', ',') || ',' LIKE '%,' || ? || ',%'";
        params.push(tag);
      }
      if (date_from) { where += ' AND g.day_created >= ?'; params.push(date_from); }
      if (date_to)   { where += ' AND g.day_created <= ?'; params.push(date_to); }
      if (search) {
        where += ' AND (g.external_id LIKE ? OR g.customer_name LIKE ? OR g.customer_phone LIKE ? OR g.tracking_no LIKE ? OR g.source_sheet LIKE ? OR g.tag LIKE ? OR g.province_city LIKE ? OR g.address LIKE ?)';
        const q = `%${search}%`;
        params.push(q, q, q, q, q, q, q, q);
      }

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const perPage = Math.min(1000, Math.max(10, parseInt(per_page, 10) || 50));
      const offset = (pageNum - 1) * perPage;

      const countRow = await db.prepare(`SELECT COUNT(*) AS total ${baseFrom} ${where}`).get(...params);
      const total = countRow?.total || 0;

      const records = await db.prepare(`
        SELECT g.id,
               g.external_id   AS order_ref,
               g.tracking_no,
               g.customer_name AS customer,
               g.customer_phone AS phone,
               g.product_name  AS product,
               g.quantity      AS qty,
               g.cod           AS cod_amount,
               COALESCE(NULLIF(TRIM(g.status_normalized), ''), TRIM(g.status)) AS status,
               g.courier,
               g.source_sheet,
               g.chat_page,
               g.confirmed_by,
               g.delivery_attempts AS attempts,
               g.tag,
               g.pancake_tags,
               g.internal_notes,
               g.address,
               g.province_city,
               g.day_created   AS order_date,
               g.updated_at
        ${baseFrom} ${where}
        ORDER BY g.day_created DESC, g.id DESC
        LIMIT ? OFFSET ?
      `).all(...params, perPage, offset);

      const whereForCounts = (() => {
        const cp = [];
        let w = 'WHERE 1=1';
        if (sheet && sheet !== 'all') { w += ' AND g.source_sheet = ?'; cp.push(sheet); }
        if (date_from) { w += ' AND g.day_created >= ?'; cp.push(date_from); }
        if (date_to)   { w += ' AND g.day_created <= ?'; cp.push(date_to); }
        if (search) {
          w += ' AND (g.external_id LIKE ? OR g.customer_name LIKE ? OR g.customer_phone LIKE ? OR g.tracking_no LIKE ? OR g.source_sheet LIKE ? OR g.tag LIKE ? OR g.province_city LIKE ? OR g.address LIKE ?)';
          const q = `%${search}%`;
          cp.push(q, q, q, q, q, q, q, q);
        }
        return { where: w, params: cp };
      })();
      const statusCounts = await db.prepare(
        `SELECT COALESCE(NULLIF(TRIM(g.status_normalized), ''), TRIM(g.status)) AS status, COUNT(*) AS count
         ${baseFrom} ${whereForCounts.where}
         GROUP BY COALESCE(NULLIF(TRIM(g.status_normalized), ''), TRIM(g.status))
         ORDER BY count DESC`
      ).all(...whereForCounts.params);

      const includeFilterOptions = pageNum === 1 && !sheet && !status && !tag && !search && !date_from && !date_to;
      const sheetNames = includeFilterOptions
        ? (await db.prepare(
            `SELECT DISTINCT g.source_sheet ${baseFrom}
             WHERE g.source_sheet IS NOT NULL AND TRIM(g.source_sheet) != ''
             ORDER BY g.source_sheet`
          ).all()).map((r) => r.source_sheet)
        : undefined;
      // g.tag is a comma-joined list per row — fetch distinct compound strings,
      // then split + dedupe in JS so the dropdown shows individual tags.
      let tags;
      if (includeFilterOptions) {
        const tagRows = await db.prepare(
          `SELECT DISTINCT TRIM(g.tag) AS tag ${baseFrom}
           WHERE g.tag IS NOT NULL AND TRIM(g.tag) != ''`
        ).all();
        const seen = new Set();
        for (const row of tagRows) {
          for (const piece of String(row.tag || '').split(',')) {
            const t = piece.trim();
            if (t) seen.add(t);
          }
        }
        tags = Array.from(seen).sort((a, b) => a.localeCompare(b));
      }

      const payload = { records, total, page: pageNum, per_page: perPage, pages: Math.ceil(total / perPage), status_counts: statusCounts };
      if (sheetNames) payload.sheet_names = sheetNames;
      if (tags) payload.tags = tags;
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Lightweight aggregates for home-page tiles. Returns ~50 bytes instead of
  // ~30 MB the full /records walk costs, and renders before the heavy load
  // finishes. Mirrors the status normalization used by /records.
  router.get('/google-sheets/stats', async (req, res) => {
    try {
      const row = await db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN LOWER(COALESCE(NULLIF(TRIM(g.status_normalized), ''), TRIM(g.status))) = 'delivered' THEN 1 ELSE 0 END) AS delivered,
          COALESCE(SUM(g.cod), 0) AS total_cod
        FROM google_orders g
      `).get();
      res.json({
        total: Number(row?.total || 0),
        delivered: Number(row?.delivered || 0),
        total_cod: Number(row?.total_cod || 0),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

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

  router.patch('/google-sheets/rename-source', async (req, res) => {
    try {
      const { old_name, new_name } = req.body || {};
      if (!old_name || !new_name || old_name === new_name) {
        return res.status(400).json({ error: 'old_name and new_name are required and must differ.' });
      }
      const result = await db.prepare(
        `UPDATE google_orders SET source_sheet = ?, updated_at = datetime('now')
         WHERE source_sheet = ?`
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
