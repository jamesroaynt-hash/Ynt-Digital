const express = require('express');
const posSync = require('../services/pancakePosSync');
const googleSheetsSync = require('../services/googleSheetsSync');

module.exports = function integrationRoutes(db) {
  const router = express.Router();
  const publicRouter = express.Router();

  // Cheap fingerprint of google_orders: MAX(updated_at) catches upserts, MAX(id)
  // catches inserts. Both are instant index-backward scans (~0.3ms). google_orders
  // is never DELETEd, so this never misses a change.
  // Returns the raw high-water marks plus the string fingerprint. maxUpdated is
  // kept RAW (a Date under pg, text under sqlite) so it can be passed straight
  // back as a query parameter — stringifying a pg Date yields a form Postgres
  // can't re-parse ("... GMT+0800 ...").
  async function getGoogleOrdersMarks() {
    const row = await db.prepare(
      `SELECT MAX(updated_at) AS max_updated, MAX(id) AS max_id FROM google_orders`
    ).get();
    return {
      maxUpdated: row?.max_updated ?? null,
      maxId: Number(row?.max_id || 0),
      version: `${row?.max_updated || ''}:${row?.max_id || 0}`,
    };
  }
  async function getGoogleOrdersVersion() {
    return (await getGoogleOrdersMarks()).version;
  }

  // Backend cache of the full unfiltered data-report dataset, keyed by the
  // google_orders fingerprint. The report loader walks every page on each visit
  // across every open session; without this, each walk re-pulls all ~33k rows
  // from Postgres (the #1 Supabase egress source).
  //
  // The cold cache does ONE full pull; after that each sync triggers a DELTA
  // refill that pulls only the rows changed since the last fingerprint and
  // merges them by id (maxUpdated/maxId are the high-water marks; byId is the
  // merge index). google_orders is upsert/insert-only and every change bumps
  // updated_at or id, so the delta can't miss a row — and the per-sync Supabase
  // pull drops from ~34k rows to just the handful that actually changed.
  let reportCache = { version: null, records: null, byId: null, maxUpdated: '', maxId: 0, loading: null, loadingVersion: null };

  // Narrow projection the data report consumes. Shared by the cached full-table
  // pull below and the filtered report path further down so they can't drift.
  const reportSelectCols = `g.id,
               g.external_id   AS order_ref,
               g.tracking_no,
               g.customer_name AS customer,
               g.customer_phone AS phone,
               g.product_name  AS product,
               g.cod           AS cod_amount,
               COALESCE(NULLIF(TRIM(g.status_normalized), ''), TRIM(g.status)) AS status,
               g.chat_page,
               g.confirmed_by,
               g.delivery_attempts AS attempts,
               g.tag,
               g.province_city,
               g.day_created   AS order_date`;

  // Refill reportCache to `marks`. Cold cache → one full pull. Warm cache →
  // pull ONLY rows changed since the last refill and merge them into byId:
  //   updated_at >= prevMaxUpdated  (catches upserts; >= re-reads the boundary
  //                                  timestamp batch, deduped by id on merge)
  //   OR id > prevMaxId             (catches new inserts)
  // The fetched delta is the entire Supabase read, so a sync that touched N rows
  // costs N rows, not 34k. prevMax* are raw DB values reused as query params.
  async function refillReportCache(marks) {
    try {
      const warm = Array.isArray(reportCache.records) && reportCache.byId;
      if (warm) {
        const changed = await db.prepare(`
          SELECT ${reportSelectCols}
          FROM google_orders g
          WHERE g.updated_at >= ? OR g.id > ?
        `).all(reportCache.maxUpdated, reportCache.maxId);
        for (const row of changed) reportCache.byId.set(row.id, row);
      } else {
        const rows = await db.prepare(`
          SELECT ${reportSelectCols}
          FROM google_orders g
        `).all();
        reportCache.byId = new Map(rows.map((row) => [row.id, row]));
      }
      // Rebuild the sorted array pagination slices from (day desc, id desc),
      // matching the original ORDER BY g.day_created DESC, g.id DESC.
      reportCache.records = [...reportCache.byId.values()].sort((a, b) => {
        const d = String(b.order_date || '').localeCompare(String(a.order_date || ''));
        return d !== 0 ? d : (Number(b.id) - Number(a.id));
      });
      reportCache.maxUpdated = marks.maxUpdated;
      reportCache.maxId = marks.maxId;
      reportCache.version = marks.version;
      return reportCache.records;
    } finally {
      reportCache.loading = null;
    }
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

  // Read-only Google Sheets records — available to any authenticated user.
  router.get('/google-sheets/records', async (req, res) => {
    try {
      const { sheet, status, tag, search, date_from, date_to, page = 1, per_page = 50, view } = req.query;
      const params = [];

      // The data-report loader walks every page just to read 12 aggregate
      // fields, so it requests view=report: a narrow projection that drops the
      // ~8 columns it discards and skips the per-page status/filter queries.
      const reportView = view === 'report';

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

      // The data-report walk is always unfiltered. Serve it from the version-keyed
      // backend cache: one full Postgres pull per sync, then RAM for every page and
      // every session until the fingerprint changes. (Filtered report calls, if any,
      // fall through to the normal per-page query below.)
      const hasFilters = (sheet && sheet !== 'all') || (status && status !== 'all')
        || (tag && tag !== 'all') || search || date_from || date_to;
      if (reportView && !hasFilters) {
        const marks = await getGoogleOrdersMarks();
        const version = marks.version;
        if (reportCache.version !== version || !reportCache.records) {
          // Coalesce concurrent misses (several sessions reloading right after a
          // sync) onto a single in-flight refill rather than N pulls.
          if (!reportCache.loading || reportCache.loadingVersion !== version) {
            reportCache.loadingVersion = version;
            reportCache.loading = refillReportCache(marks);
          }
          await reportCache.loading;
        }
        const all = reportCache.records;
        res.json({
          records: all.slice(offset, offset + perPage),
          total: all.length,
          page: pageNum,
          per_page: perPage,
          pages: Math.ceil(all.length / perPage),
        });
        return;
      }

      const countRow = await db.prepare(`SELECT COUNT(*) AS total ${baseFrom} ${where}`).get(...params);
      const total = countRow?.total || 0;

      const selectCols = reportView
        ? reportSelectCols
        : `g.id,
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
               g.shipping_info,
               g.ad_id,
               g.day_created   AS order_date,
               g.updated_at`;

      const records = await db.prepare(`
        SELECT ${selectCols}
        ${baseFrom} ${where}
        ORDER BY g.day_created DESC, g.id DESC
        LIMIT ? OFFSET ?
      `).all(...params, perPage, offset);

      // Report mode only needs rows + pagination; skip the status GROUP BY and
      // the distinct sheet/tag scans the records UI uses.
      if (reportView) {
        res.json({ records, total, page: pageNum, per_page: perPage, pages: Math.ceil(total / perPage) });
        return;
      }

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

  // Cheap fingerprint of google_orders (~30 bytes, ~0.3ms). The data-report
  // loader fetches this first and skips the whole multi-page /records walk when
  // the fingerprint is unchanged — reloads only when a sync changed data.
  // MAX(updated_at) catches upserts, MAX(id) catches inserts; both are instant
  // index-backward scans. google_orders is never DELETEd, so this never misses
  // a change. (COUNT(*) would be exact but costs a ~1s full index scan.)
  router.get('/google-sheets/version', async (req, res) => {
    try {
      res.json({ version: await getGoogleOrdersVersion() });
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

  // Server-side Data Report aggregation. The page used to walk every /records
  // page (~30 MB of rows per visit, the #1 Supabase egress source) just to group
  // them in the browser. This computes the same grouped metrics in Postgres and
  // returns a few KB. The SQL below intentionally mirrors the frontend helpers
  // it replaces — getOrderStatusKey, orderHasTag('undeliverable'),
  // getPriceRangeLabel and groupDataReportRows — so the numbers stay identical.
  const dr = {
    statusExpr: "LOWER(COALESCE(NULLIF(TRIM(g.status_normalized), ''), TRIM(g.status)))",
  };
  dr.isDelivered = `(${dr.statusExpr} IN ('delivered','completed'))`;
  dr.isReturned = `(${dr.statusExpr} IN ('returned','return to sender','rts'))`;
  dr.isReturning = `(${dr.statusExpr} IN ('returning','for return','return in transit'))`;
  dr.isShipped = `(${dr.statusExpr} IN ('shipped','in transit','out for delivery'))`;
  // Undeliverable is tag-driven (g.tag is a comma-joined list); matches the
  // frontend's orderHasTag() and the established tag-filter pattern in /records.
  dr.isUndeliverable = "(LOWER(',' || REPLACE(COALESCE(g.tag, ''), ', ', ',') || ',') LIKE '%,undeliverable,%')";
  // Price buckets keyed on COD; COALESCE(...,0) so NULL/blank COD falls in the
  // lowest band, exactly like getPriceRangeLabel(Number(cod||0)).
  dr.priceExpr = `CASE
      WHEN COALESCE(g.cod, 0) <= 500  THEN 'PHP 251 - PHP 500'
      WHEN COALESCE(g.cod, 0) <= 750  THEN 'PHP 501 - PHP 750'
      WHEN COALESCE(g.cod, 0) <= 1000 THEN 'PHP 751 - PHP 1,000'
      WHEN COALESCE(g.cod, 0) <= 1500 THEN 'PHP 1,001 - PHP 1,500'
      WHEN COALESCE(g.cod, 0) <= 2000 THEN 'PHP 1,501 - PHP 2,000'
      WHEN COALESCE(g.cod, 0) <= 3000 THEN 'PHP 2,001 - PHP 3,000'
      WHEN COALESCE(g.cod, 0) <= 5000 THEN 'PHP 3,001 - PHP 5,000'
      ELSE 'PHP 5,000+'
    END`;
  dr.staffExpr = "COALESCE(NULLIF(g.confirmed_by, ''), 'Unassigned')";
  dr.provinceExpr = "COALESCE(NULLIF(g.province_city, ''), 'Unknown province')";
  // The Page dropdown mirrors getPosSourceOptions(): blank chat_page shows as
  // 'Sheets'. Filtering by the same expression keeps option↔rows consistent.
  dr.pageExpr = "COALESCE(NULLIF(g.chat_page, ''), 'Sheets')";

  // months/pages are the full dropdown domains — independent of the active
  // filter and only change on sync, so they're cached by the google_orders
  // version. Per-filter metric results are memoised under the same version.
  let reportSummaryCache = { version: null, months: null, pages: null, entries: new Map() };

  router.get('/google-sheets/report-summary', async (req, res) => {
    try {
      const { month, date_from, date_to, page } = req.query;

      const where = [];
      const params = [];
      if (month) {
        where.push('substr(g.day_created, 1, 7) = ?');
        params.push(month);
      } else {
        if (date_from) { where.push('substr(g.day_created, 1, 10) >= ?'); params.push(date_from); }
        if (date_to)   { where.push('substr(g.day_created, 1, 10) <= ?'); params.push(date_to); }
      }
      if (page && page !== 'all') { where.push(`${dr.pageExpr} = ?`); params.push(page); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const version = await getGoogleOrdersVersion();
      if (reportSummaryCache.version !== version) {
        reportSummaryCache = { version, months: null, pages: null, entries: new Map() };
      }

      // Dropdown domains: one DISTINCT scan per sync, served from RAM after.
      if (!reportSummaryCache.months || !reportSummaryCache.pages) {
        const [monthRows, pageRows] = await Promise.all([
          db.prepare(
            `SELECT DISTINCT substr(g.day_created, 1, 7) AS m FROM google_orders g
             WHERE g.day_created IS NOT NULL AND g.day_created != ''`
          ).all(),
          db.prepare(`SELECT DISTINCT ${dr.pageExpr} AS p FROM google_orders g`).all(),
        ]);
        reportSummaryCache.months = monthRows
          .map((r) => r.m)
          .filter((m) => /^\d{4}-\d{2}$/.test(m))
          .sort((a, b) => b.localeCompare(a));
        reportSummaryCache.pages = pageRows
          .map((r) => r.p)
          .filter(Boolean)
          .sort((a, b) => String(a).localeCompare(String(b)));
      }
      const months = reportSummaryCache.months;
      const pages = reportSummaryCache.pages;

      const filterKey = `${month || ''}|${date_from || ''}|${date_to || ''}|${page || ''}`;
      if (reportSummaryCache.entries.has(filterKey)) {
        res.json({ ...reportSummaryCache.entries.get(filterKey), months, pages });
        return;
      }

      // Mirrors groupDataReportRows(): per-group counts + RTS rate, sorted by
      // total desc then RTS desc. 'returning' is a Postgres keyword, so the
      // column is aliased returning_ct.
      const groupBy = async (keyExpr) => {
        const rows = await db.prepare(`
          SELECT ${keyExpr} AS label,
            COUNT(*) AS total,
            SUM(CASE WHEN ${dr.isDelivered} THEN 1 ELSE 0 END) AS delivered,
            SUM(CASE WHEN ${dr.isReturned} THEN 1 ELSE 0 END) AS returned,
            SUM(CASE WHEN ${dr.isReturning} THEN 1 ELSE 0 END) AS returning_ct
          FROM google_orders g
          ${whereSql}
          GROUP BY ${keyExpr}
        `).all(...params);
        return rows.map((r) => {
          const total = Number(r.total || 0);
          const delivered = Number(r.delivered || 0);
          const returned = Number(r.returned || 0);
          const returning = Number(r.returning_ct || 0);
          const base = delivered + returned + returning;
          return { label: r.label, total, delivered, returned, returning, rtsRate: base ? ((returned + returning) / base) * 100 : 0 };
        }).sort((a, b) => b.total - a.total || b.rtsRate - a.rtsRate);
      };

      const [totals, byPrice, byConfirmed, byProvince] = await Promise.all([
        db.prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN ${dr.isDelivered} THEN 1 ELSE 0 END) AS delivered,
            SUM(CASE WHEN ${dr.isReturned} THEN 1 ELSE 0 END) AS returned,
            SUM(CASE WHEN ${dr.isReturning} THEN 1 ELSE 0 END) AS returning_ct,
            SUM(CASE WHEN ${dr.isShipped} THEN 1 ELSE 0 END) AS shipped,
            SUM(CASE WHEN ${dr.isUndeliverable} THEN 1 ELSE 0 END) AS undeliverable,
            COALESCE(SUM(g.cod), 0) AS cod
          FROM google_orders g
          ${whereSql}
        `).get(...params),
        groupBy(dr.priceExpr),
        groupBy(dr.staffExpr),
        groupBy(dr.provinceExpr),
      ]);

      const delivered = Number(totals?.delivered || 0);
      const returned = Number(totals?.returned || 0);
      const returning = Number(totals?.returning_ct || 0);
      const base = delivered + returned + returning;
      const summary = {
        counts: {
          total: Number(totals?.total || 0),
          delivered,
          returned,
          returning,
          shipped: Number(totals?.shipped || 0),
          undeliverable: Number(totals?.undeliverable || 0),
        },
        cod: Number(totals?.cod || 0),
        rtsRate: base ? ((returned + returning) / base) * 100 : 0,
        byPrice,
        byConfirmed,
        byProvince,
      };

      // Bound the per-filter memo so a long-lived process can't grow unbounded.
      if (reportSummaryCache.entries.size > 60) reportSummaryCache.entries.clear();
      reportSummaryCache.entries.set(filterKey, summary);

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
      const status = await googleSheetsSync.getStatus(db);
      const configuredRaw = String(status.sheet_name || status.page_id || '').trim();
      const configured = configuredRaw && configuredRaw !== '*'
        ? configuredRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const autoDiscover = !configuredRaw || configuredRaw === '*' || configured.includes('*');

      const rows = await db.prepare(`
        SELECT
          COALESCE(NULLIF(TRIM(source_sheet), ''), '(unknown)') AS name,
          COUNT(*) AS rows,
          SUM(CASE WHEN LOWER(COALESCE(NULLIF(TRIM(status_normalized), ''), TRIM(status))) = 'delivered' THEN 1 ELSE 0 END) AS delivered,
          MAX(updated_at) AS last_updated_at,
          MAX(day_created) AS last_day
        FROM google_orders
        GROUP BY name
        ORDER BY rows DESC
      `).all();

      const presentNames = new Set(rows.map((r) => r.name));
      const tabs = rows.map((r) => ({
        name: r.name,
        rows: Number(r.rows || 0),
        delivered: Number(r.delivered || 0),
        last_updated_at: r.last_updated_at || null,
        last_day: r.last_day || null,
        configured: configured.length === 0 ? autoDiscover : configured.includes(r.name),
      }));

      // Configured tab in settings but no rows pulled yet — flag it as missing.
      for (const name of configured) {
        if (!presentNames.has(name)) {
          tabs.push({
            name,
            rows: 0,
            delivered: 0,
            last_updated_at: null,
            last_day: null,
            configured: true,
            missing: true,
          });
        }
      }

      res.json({ configured, auto_discover: autoDiscover, tabs });
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
