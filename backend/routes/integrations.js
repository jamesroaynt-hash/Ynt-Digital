const express = require('express');
const posSync = require('../services/pancakePosSync');
const googleSheetsSync = require('../services/googleSheetsSync');

module.exports = function integrationRoutes(db) {
  const router = express.Router();
  const publicRouter = express.Router();

  // Fingerprint pos_orders: MAX(id) catches new inserts, MAX(updated_at_remote)
  // catches status changes synced from Pancake, COUNT(*) catches pruned rows.
  async function getPosOrdersMarks() {
    const row = await db.prepare(
      `SELECT MAX(id) AS max_id, MAX(updated_at_remote) AS max_updated, COUNT(*) AS cnt FROM pos_orders`
    ).get();
    return {
      maxId: Number(row?.max_id || 0),
      maxUpdated: row?.max_updated ?? null,
      version: `${row?.max_id || 0}:${row?.max_updated || ''}:${row?.cnt || 0}`,
    };
  }
  async function getPosOrdersVersion() {
    return (await getPosOrdersMarks()).version;
  }

  // Backend cache of all pos_orders for the data-report and records views.
  // Full reload on every version change (pos_orders is ~20k rows, ~5 MB raw —
  // cheaper to reload in full than to track deltas).
  let reportCache = { version: null, records: null, loading: null, loadingVersion: null };

  // Parse shipping_address_json → province string (JS, avoids SQL dialect diff)
  function extractProvince(json) {
    try {
      const a = typeof json === 'string' ? JSON.parse(json) : (json || {});
      return (a.province || a.province_name || a.state || a.region || '').trim();
    } catch { return ''; }
  }

  // Parse tags_json → comma-joined label string
  function extractTags(json) {
    try {
      const tags = typeof json === 'string' ? JSON.parse(json) : (json || []);
      if (!Array.isArray(tags)) return '';
      return tags.map((t) => (typeof t === 'string' ? t : (t?.name || t?.tag_name || t?.label || ''))).filter(Boolean).join(', ');
    } catch { return ''; }
  }

  // Map a pos_orders row to the shape mapGoogleSheetReportRecord expects.
  const POS_STATUS_DISPLAY = {
    new: 'New', submitted: 'Confirmed',
    pending: 'Waiting for pickup', wait_print: 'Waiting for pickup', waitting: 'Waiting for pickup',
    shipped: 'Shipped', delivered: 'Delivered',
    returning: 'Returning', returned: 'Returned',
    canceled: 'Canceled', removed: 'Canceled',
  };
  function posRowToReportShape(g) {
    return {
      id: g.id,
      order_ref: g.external_id || '',
      tracking_no: g.tracking_no || '',
      customer: g.customer_name || '',
      phone: g.customer_phone || '',
      product: g.note_product || '',
      cod_amount: Number(g.cod || 0),
      status: POS_STATUS_DISPLAY[g.status_name] || (g.status_name ? g.status_name.charAt(0).toUpperCase() + g.status_name.slice(1) : 'Unknown'),
      chat_page: g.page_name || '',
      confirmed_by: g.assigning_seller_name || '',
      attempts: Number(g.attempts || 0),
      tag: extractTags(g.tags_json),
      province_city: extractProvince(g.shipping_address_json),
      order_date: (g.inserted_at_remote || '').slice(0, 10),
      // sheet records view extras
      source_sheet: g.page_name || '',
      courier: g.sprinter_name || '',
      address: extractAddress(g.shipping_address_json),
      updated_at: g.updated_at_remote || '',
    };
  }

  function extractAddress(json) {
    try {
      const a = typeof json === 'string' ? JSON.parse(json) : (json || {});
      return [a.address, a.street, a.barangay, a.city || a.city_name, a.province || a.province_name]
        .filter(Boolean).join(', ');
    } catch { return ''; }
  }

  async function refillReportCache(marks) {
    try {
      const rows = await db.prepare(`
        SELECT id, external_id, tracking_no, page_name, customer_name, customer_phone,
               note_product, cod, status_name, assigning_seller_name, attempts,
               tags_json, shipping_address_json, inserted_at_remote, updated_at_remote,
               sprinter_name
        FROM pos_orders
        ORDER BY inserted_at_remote DESC, id DESC
      `).all();
      reportCache.records = rows.map(posRowToReportShape);
      reportCache.version = marks.version;
      return reportCache.records;
    } finally {
      reportCache.loading = null;
    }
  }

  async function getOrRefreshCache() {
    const marks = await getPosOrdersMarks();
    if (reportCache.version !== marks.version || !reportCache.records) {
      if (!reportCache.loading || reportCache.loadingVersion !== marks.version) {
        reportCache.loadingVersion = marks.version;
        reportCache.loading = refillReportCache(marks);
      }
      await reportCache.loading;
    }
    return { records: reportCache.records, version: marks.version };
  }

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

  // Records — served from pos_orders. report view uses the backend cache
  // (one full pull per sync, then RAM). Regular view queries directly.
  router.get('/google-sheets/records', async (req, res) => {
    try {
      const { sheet, status, tag, search, date_from, date_to, page = 1, per_page = 50, view } = req.query;
      const reportView = view === 'report';
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const perPage = Math.min(1000, Math.max(10, parseInt(per_page, 10) || 50));
      const offset = (pageNum - 1) * perPage;

      const { records: all, version } = await getOrRefreshCache();

      // Apply JS-level filters on cached records
      const statusRawMap = {
        new: ['new'], confirmed: ['submitted'],
        'waiting for pickup': ['pending', 'wait_print', 'waitting'],
        shipped: ['shipped'], delivered: ['delivered'],
        returning: ['returning'], returned: ['returned'],
        canceled: ['canceled', 'removed'],
      };

      let filtered = all;
      if (sheet && sheet !== 'all') filtered = filtered.filter((r) => r.source_sheet === sheet);
      if (status && status !== 'all') {
        const sl = status.toLowerCase();
        filtered = filtered.filter((r) => (r.status || '').toLowerCase() === sl);
      }
      if (tag && tag !== 'all') {
        const tl = tag.toLowerCase();
        filtered = filtered.filter((r) => (r.tag || '').toLowerCase().split(',').map((s) => s.trim()).includes(tl));
      }
      if (date_from) filtered = filtered.filter((r) => (r.order_date || '') >= date_from);
      if (date_to)   filtered = filtered.filter((r) => (r.order_date || '') <= date_to);
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter((r) =>
          (r.order_ref || '').toLowerCase().includes(q)
          || (r.tracking_no || '').toLowerCase().includes(q)
          || (r.customer || '').toLowerCase().includes(q)
          || (r.phone || '').toLowerCase().includes(q)
          || (r.source_sheet || '').toLowerCase().includes(q)
          || (r.tag || '').toLowerCase().includes(q)
          || (r.province_city || '').toLowerCase().includes(q)
        );
      }

      const statusCounts = Object.entries(
        filtered.reduce((acc, r) => { acc[r.status || 'Unknown'] = (acc[r.status || 'Unknown'] || 0) + 1; return acc; }, {})
      ).map(([s, count]) => ({ status: s, count }));

      const sliced = filtered.slice(offset, offset + perPage);

      if (reportView) {
        res.json({
          records: sliced,
          total: filtered.length,
          total_cod: filtered.reduce((s, r) => s + Number(r.cod_amount || 0), 0),
          status_counts: statusCounts,
          page: pageNum, per_page: perPage,
          pages: Math.ceil(filtered.length / perPage),
        });
        return;
      }

      // Sheet Records page: include filter option dropdowns on first page
      const includeFilterOptions = pageNum === 1 && !sheet && !status && !tag && !search && !date_from && !date_to;
      const payload = {
        records: sliced,
        total: filtered.length,
        page: pageNum, per_page: perPage,
        pages: Math.ceil(filtered.length / perPage),
        status_counts: statusCounts,
      };
      if (includeFilterOptions) {
        payload.sheet_names = [...new Set(all.map((r) => r.source_sheet).filter(Boolean))].sort();
        const tagSet = new Set();
        all.forEach((r) => (r.tag || '').split(',').forEach((t) => { const s = t.trim(); if (s) tagSet.add(s); }));
        payload.tags = [...tagSet].sort();
      }
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Version fingerprint based on pos_orders state.
  router.get('/google-sheets/version', async (req, res) => {
    try {
      res.json({ version: await getPosOrdersVersion() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Lightweight home-page stats from pos_orders.
  router.get('/google-sheets/stats', async (req, res) => {
    try {
      const row = await db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status_name = 'delivered' THEN 1 ELSE 0 END) AS delivered,
          COALESCE(SUM(cod), 0) AS total_cod
        FROM pos_orders
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

  router.get('/pancake-pos/ads/ad-sets', async (req, res) => {
    try {
      res.json(await posSync.listAdSetsFromApi(db, req.query || {}));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Server-side Data Report aggregation. The page used to walk every /records
  // page (~30 MB of rows per visit, the #1 Supabase egress source) just to group
  // them in the browser. This computes the same grouped metrics in Postgres and
  // returns a few KB. The SQL below intentionally mirrors the frontend helpers
  // it replaces — getOrderStatusKey, orderHasTag('undeliverable'),
  // Data Report summary — JS groupBy on cached pos_orders records.
  // Avoids SQL JSON-extraction dialect differences (SQLite vs Postgres).
  router.get('/google-sheets/report-summary', async (req, res) => {
    try {
      const { month, date_from, date_to, page } = req.query;
      const { records: all } = await getOrRefreshCache();

      // Apply filters
      let data = all;
      if (month) data = data.filter((r) => (r.order_date || '').startsWith(month));
      else {
        if (date_from) data = data.filter((r) => (r.order_date || '') >= date_from);
        if (date_to)   data = data.filter((r) => (r.order_date || '') <= date_to);
      }
      if (page && page !== 'all') data = data.filter((r) => (r.chat_page || 'Sheets') === page);

      // Helpers
      function getPriceRange(cod) {
        const c = Number(cod || 0);
        if (c <= 500)  return 'PHP 251 - PHP 500';
        if (c <= 750)  return 'PHP 501 - PHP 750';
        if (c <= 1000) return 'PHP 751 - PHP 1,000';
        if (c <= 1500) return 'PHP 1,001 - PHP 1,500';
        if (c <= 2000) return 'PHP 1,501 - PHP 2,000';
        if (c <= 3000) return 'PHP 2,001 - PHP 3,000';
        if (c <= 5000) return 'PHP 3,001 - PHP 5,000';
        return 'PHP 5,000+';
      }
      function jsGroupBy(keyFn) {
        const map = {};
        for (const r of data) {
          const key = keyFn(r) || 'Unknown';
          if (!map[key]) map[key] = { label: key, total: 0, delivered: 0, returned: 0, returning: 0, cod: 0 };
          map[key].total++;
          if (r.status === 'Delivered') map[key].delivered++;
          if (r.status === 'Returned')  map[key].returned++;
          if (r.status === 'Returning') map[key].returning++;
          map[key].cod += Number(r.cod_amount || 0);
        }
        return Object.values(map).map((g) => {
          const base = g.delivered + g.returned + g.returning;
          return { ...g, rtsRate: base ? ((g.returned + g.returning) / base) * 100 : 0 };
        }).sort((a, b) => b.total - a.total || b.rtsRate - a.rtsRate);
      }

      // Totals
      let total = 0, delivered = 0, returned = 0, returning = 0, shipped = 0, undeliverable = 0, cod = 0;
      for (const r of data) {
        total++;
        if (r.status === 'Delivered')            delivered++;
        if (r.status === 'Returned')             returned++;
        if (r.status === 'Returning')            returning++;
        if (r.status === 'Shipped')              shipped++;
        if ((r.tag || '').toLowerCase().includes('undeliverable')) undeliverable++;
        cod += Number(r.cod_amount || 0);
      }
      const base = delivered + returned + returning;

      const summary = {
        counts: { total, delivered, returned, returning, shipped, undeliverable },
        cod,
        rtsRate: base ? ((returned + returning) / base) * 100 : 0,
        byPrice:     jsGroupBy((r) => getPriceRange(r.cod_amount)),
        byConfirmed: jsGroupBy((r) => r.confirmed_by || 'Unassigned'),
        byProvince:  jsGroupBy((r) => r.province_city || 'Unknown province'),
      };

      // Dropdown domains from full (unfiltered) cache
      const months = [...new Set(all.map((r) => (r.order_date || '').slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))].sort((a, b) => b.localeCompare(a));
      const pages = [...new Set(all.map((r) => r.chat_page || 'Sheets').filter(Boolean))].sort();

      res.json({ ...summary, months, pages });
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

  router.get('/google-sheets/tabs-status', async (req, res) => {
    try {
      const rows = await db.prepare(`
        SELECT
          COALESCE(NULLIF(TRIM(page_name), ''), '(unknown)') AS name,
          COUNT(*) AS rows,
          SUM(CASE WHEN LOWER(status_name) = 'delivered' THEN 1 ELSE 0 END) AS delivered,
          MAX(updated_at_remote) AS last_updated_at,
          MAX(inserted_at_remote) AS last_day
        FROM pos_orders
        GROUP BY name
        ORDER BY rows DESC
      `).all();

      const tabs = rows.map((r) => ({
        name: r.name,
        rows: Number(r.rows || 0),
        delivered: Number(r.delivered || 0),
        last_updated_at: r.last_updated_at || null,
        last_day: r.last_day || null,
        configured: true,
      }));

      res.json({ configured: [], auto_discover: true, tabs });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
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

  router.post('/pancake-pos/validate-page-token', async (req, res) => {
    try {
      const result = await posSync.validatePancakePageToken(db, req.body || {});
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/pancake-pos/validate-botcake-token', async (req, res) => {
    try {
      const result = await posSync.validateBotcakeToken(db, req.body || {});
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

  // Storage retention: drop POS orders older than the retention window (default 30
  // days, or `retention_days` in the body) plus old sync logs, on demand.
  router.post('/pancake-pos/prune', async (req, res) => {
    try {
      const retentionDays = Number(req.body?.retention_days) || 30;
      const result = await posSync.pruneOldData(db, { retentionDays });
      res.status(200).json({ message: 'Old POS data pruned.', ...result });
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
    '/pancake-pos/validate-page-token',
    '/pancake-pos/validate-botcake-token',
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
