const express = require('express');
const posSync = require('../services/pancakePosSync');
const googleSheetsSync = require('../services/googleSheetsSync');
const infotxtSms = require('../services/infotxtSms');
const salesTrackerSheet = require('../services/salesTrackerSheet');

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
          SUM(CASE WHEN po.status_name IN ('shipped','delivered','submitted','returned','returning') THEN 1 ELSE 0 END) AS total,
          SUM(CASE WHEN po.status_name = 'delivered' THEN 1 ELSE 0 END) AS delivered,
          SUM(CASE WHEN po.status_name IN ('returned','returning') THEN 1 ELSE 0 END) AS returned,
          SUM(CASE WHEN po.status_name IN ('shipped','submitted') THEN 1 ELSE 0 END) AS active,
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

  const STATUS_NAME_MAP = {
    new: ['new'], confirmed: ['submitted'],
    'waiting for pickup': ['pending', 'wait_print', 'waitting'],
    shipped: ['shipped'], delivered: ['delivered'],
    returning: ['returning'], returned: ['returned'],
    canceled: ['canceled', 'removed'],
  };

  // Records — direct SQL pagination, no in-memory cache.
  router.get('/google-sheets/records', async (req, res) => {
    try {
      const { sheet, status, tag, search, date_from, date_to, page = 1, per_page = 50, view } = req.query;
      const reportView = view === 'report';
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const perPage = Math.min(1000, Math.max(10, parseInt(per_page, 10) || 50));
      const offset = (pageNum - 1) * perPage;

      const conditions = [];
      const params = [];

      if (sheet && sheet !== 'all') { conditions.push('page_name = ?'); params.push(sheet); }
      if (status && status !== 'all') {
        const rawStatuses = STATUS_NAME_MAP[status.toLowerCase()];
        if (rawStatuses?.length) {
          conditions.push(`status_name IN (${rawStatuses.map(() => '?').join(',')})`);
          params.push(...rawStatuses);
        }
      }
      if (tag && tag !== 'all') {
        conditions.push('LOWER(COALESCE(tags_json, \'\')) LIKE ?');
        params.push(`%${tag.toLowerCase()}%`);
      }
      if (date_from) { conditions.push('DATE(inserted_at_remote) >= ?'); params.push(date_from); }
      if (date_to)   { conditions.push('DATE(inserted_at_remote) <= ?'); params.push(date_to); }
      if (search) {
        const q = `%${search.toLowerCase()}%`;
        conditions.push(
          '(LOWER(COALESCE(external_id,\'\')) LIKE ? OR LOWER(COALESCE(tracking_no,\'\')) LIKE ?'
          + ' OR LOWER(COALESCE(customer_name,\'\')) LIKE ? OR LOWER(COALESCE(customer_phone,\'\')) LIKE ?'
          + ' OR LOWER(COALESCE(page_name,\'\')) LIKE ? OR LOWER(COALESCE(tags_json,\'\')) LIKE ?'
          + ' OR LOWER(COALESCE(shipping_address_json,\'\')) LIKE ?)'
        );
        params.push(q, q, q, q, q, q, q);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const summaryRow = await db.prepare(
        `SELECT COUNT(*) as total, COALESCE(SUM(cod), 0) as total_cod FROM pos_orders ${where}`
      ).get(...params);
      const total = Number(summaryRow?.total || 0);
      const totalCod = Number(summaryRow?.total_cod || 0);

      const statusRows = await db.prepare(
        `SELECT status_name, COUNT(*) as cnt FROM pos_orders ${where} GROUP BY status_name`
      ).all(...params);
      const statusCounts = statusRows.map((r) => ({
        status: POS_STATUS_DISPLAY[r.status_name] || (r.status_name ? r.status_name.charAt(0).toUpperCase() + r.status_name.slice(1) : 'Unknown'),
        count: Number(r.cnt),
      }));

      const rows = await db.prepare(`
        SELECT id, external_id, tracking_no, page_name, customer_name, customer_phone,
               note_product, cod, status_name, assigning_seller_name, attempts,
               tags_json, shipping_address_json, inserted_at_remote, updated_at_remote,
               sprinter_name
        FROM pos_orders ${where}
        ORDER BY inserted_at_remote DESC, id DESC
        LIMIT ? OFFSET ?
      `).all(...params, perPage, offset);
      const records = rows.map(posRowToReportShape);

      if (reportView) {
        res.json({
          records,
          total,
          total_cod: totalCod,
          status_counts: statusCounts,
          page: pageNum, per_page: perPage,
          pages: Math.ceil(total / perPage),
        });
        return;
      }

      const payload = {
        records,
        total,
        page: pageNum, per_page: perPage,
        pages: Math.ceil(total / perPage),
        status_counts: statusCounts,
      };

      if (pageNum === 1 && !sheet && !status && !tag && !search && !date_from && !date_to) {
        const sheetRows = await db.prepare(
          `SELECT DISTINCT page_name FROM pos_orders WHERE page_name IS NOT NULL AND TRIM(page_name) != '' ORDER BY page_name`
        ).all();
        payload.sheet_names = sheetRows.map((r) => r.page_name);

        const tagRows = await db.prepare(
          `SELECT tags_json FROM pos_orders WHERE tags_json IS NOT NULL AND LENGTH(tags_json) > 2`
        ).all();
        const tagSet = new Set();
        tagRows.forEach((r) => extractTags(r.tags_json).split(',').forEach((t) => { const s = t.trim(); if (s) tagSet.add(s); }));
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

  router.get('/pancake-pos/ads/ads', async (req, res) => {
    try {
      res.json(await posSync.listAdsFromApi(db, req.query || {}));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Re-read non-final orders straight from Pancake by id. The paged sync only
  // ever sees the newest orders by creation date, so this is what keeps an
  // older order honest. Runs on a timer too; this is the manual nudge.
  router.post('/pancake-pos/reconcile', async (req, res) => {
    try {
      const result = await posSync.reconcilePosOrders(db, {
        limit: req.body?.limit,
        shop_id: req.body?.shop_id,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Data Report aggregation — pure SQL, no in-memory cache needed.
  router.get('/google-sheets/report-summary', async (req, res) => {
    try {
      const { month, date_from, date_to, page } = req.query;

      // An undeliverable order older than the cutoff counts as returned — see
      // ABANDONED_UNDELIVERABLE_DAYS in the POS sync. The cutoff date is inlined
      // in the expression, so no query using it needs an extra bound parameter.
      const effStatus = posSync.effectivePosStatusSql();

      const conditions = [];
      const params = [];
      if (month) {
        conditions.push("SUBSTR(inserted_at_remote, 1, 7) = ?");
        params.push(month);
      } else {
        if (date_from) { conditions.push('DATE(inserted_at_remote) >= ?'); params.push(date_from); }
        if (date_to)   { conditions.push('DATE(inserted_at_remote) <= ?'); params.push(date_to); }
      }
      if (page && page !== 'all') { conditions.push('page_name = ?'); params.push(page); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      // Totals
      const totalsRow = await db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN ${effStatus} = 'delivered' THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN ${effStatus} = 'returned'  THEN 1 ELSE 0 END) as returned,
          SUM(CASE WHEN ${effStatus} = 'returning' THEN 1 ELSE 0 END) as returning,
          SUM(CASE WHEN ${effStatus} = 'shipped'   THEN 1 ELSE 0 END) as shipped,
          SUM(CASE WHEN status_name = 'wait_print' THEN 1 ELSE 0 END) as wait_print,
          -- The courier's own verdict, not a tag someone typed. The tag is
          -- sticky (it survives the order being delivered later) and drifted
          -- from the RMO page, which has always counted partner_status.
          SUM(CASE WHEN LOWER(COALESCE(partner_status,'')) = 'undeliverable' THEN 1 ELSE 0 END) as undeliverable,
          COALESCE(SUM(cod), 0) as cod
        FROM pos_orders ${where}
      `).get(...params);

      const total = Number(totalsRow?.total || 0);
      const delivered = Number(totalsRow?.delivered || 0);
      const returned = Number(totalsRow?.returned || 0);
      const returningCnt = Number(totalsRow?.returning || 0);
      const shipped = Number(totalsRow?.shipped || 0);
      const waitPrint = Number(totalsRow?.wait_print || 0);
      const undeliverable = Number(totalsRow?.undeliverable || 0);
      const cod = Number(totalsRow?.cod || 0);
      const base = delivered + returned + returningCnt;

      // byConfirmed — who confirmed the order, not who it is assigned to.
      // confirmed_by_name is the editor of the order's move to Confirmed in
      // Pancake's status_history, so an order that was never confirmed by anyone
      // (New straight to Awaiting print, or canceled out of New) has none and
      // drops out of the card. 'wait_print' is excluded outright as well: an
      // order sitting in Awaiting print is not a confirmed sale, same basis the
      // ROAS order counts use.
      const confirmedBase = "confirmed_by_name IS NOT NULL AND TRIM(confirmed_by_name) != '' AND COALESCE(status_name,'') != 'wait_print'";
      const confirmedWhere = conditions.length
        ? `WHERE (${conditions.join(' AND ')}) AND ${confirmedBase}`
        : `WHERE ${confirmedBase}`;
      const confirmedRows = await db.prepare(`
        SELECT
          confirmed_by_name as label,
          COUNT(*) as total,
          SUM(CASE WHEN ${effStatus} = 'delivered' THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN ${effStatus} = 'returned'  THEN 1 ELSE 0 END) as returned,
          SUM(CASE WHEN ${effStatus} = 'returning' THEN 1 ELSE 0 END) as returning,
          COALESCE(SUM(cod), 0) as cod
        FROM pos_orders ${confirmedWhere}
        GROUP BY confirmed_by_name
        ORDER BY total DESC
      `).all(...params);
      // Saved staff alias merges (Data Report only): combine rows whose
      // confirmed_by_name is a known alias into one canonical staff entry.
      let staffMergeMap = {};
      try {
        const mergeRows = await db.prepare('SELECT alias, canonical FROM staff_merge_map').all();
        for (const m of mergeRows) {
          const a = String(m.alias || '').trim();
          const c = String(m.canonical || '').trim();
          if (a && c) staffMergeMap[a] = c;
        }
      } catch { staffMergeMap = {}; }
      const resolveStaff = (name) => {
        let cur = String(name || '').trim();
        const seen = new Set();
        while (staffMergeMap[cur] && !seen.has(cur)) { seen.add(cur); cur = staffMergeMap[cur]; }
        return cur || name;
      };
      const confirmedAgg = {};
      for (const r of confirmedRows) {
        const label = resolveStaff(r.label);
        if (!confirmedAgg[label]) confirmedAgg[label] = { label, total: 0, delivered: 0, returned: 0, returning: 0, cod: 0 };
        const g = confirmedAgg[label];
        g.total += Number(r.total); g.delivered += Number(r.delivered);
        g.returned += Number(r.returned); g.returning += Number(r.returning);
        g.cod += Number(r.cod);
      }
      const byConfirmed = Object.values(confirmedAgg).map((g) => {
        const b = g.delivered + g.returned + g.returning;
        return { ...g, rtsRate: b ? ((g.returned + g.returning) / b) * 100 : 0 };
      }).sort((a, b) => b.total - a.total);

      // byAdId — direct column GROUP BY on ad_id. Exclude only 'wait_print'
      // (awaiting/waiting for print) from ROAS order counts; 'pending'/'waitting'
      // (waiting for pickup) are still included. COALESCE keeps NULL-status rows.
      const adBase = "ad_id IS NOT NULL AND TRIM(ad_id) != '' AND COALESCE(status_name,'') != 'wait_print'";
      const adWhere = conditions.length
        ? `WHERE (${conditions.join(' AND ')}) AND ${adBase}`
        : `WHERE ${adBase}`;
      const adRows = await db.prepare(`
        SELECT
          ad_id as label,
          COUNT(*) as total,
          SUM(CASE WHEN ${effStatus} = 'delivered' THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN ${effStatus} = 'returned'  THEN 1 ELSE 0 END) as returned,
          SUM(CASE WHEN ${effStatus} = 'returning' THEN 1 ELSE 0 END) as returning,
          COALESCE(SUM(cod), 0) as cod
        FROM pos_orders ${adWhere}
        GROUP BY ad_id
        ORDER BY total DESC
      `).all(...params);
      const byAdId = adRows.map((r) => {
        const b = Number(r.delivered) + Number(r.returned) + Number(r.returning);
        return {
          label: r.label,
          total: Number(r.total), delivered: Number(r.delivered),
          returned: Number(r.returned), returning: Number(r.returning),
          cod: Number(r.cod),
          rtsRate: b ? ((Number(r.returned) + Number(r.returning)) / b) * 100 : 0,
        };
      });

      // byPrice — CASE on cod column
      const priceRows = await db.prepare(`
        SELECT
          CASE
            WHEN COALESCE(cod,0) <= 500  THEN 'PHP 251 - PHP 500'
            WHEN COALESCE(cod,0) <= 750  THEN 'PHP 501 - PHP 750'
            WHEN COALESCE(cod,0) <= 1000 THEN 'PHP 751 - PHP 1,000'
            WHEN COALESCE(cod,0) <= 1500 THEN 'PHP 1,001 - PHP 1,500'
            WHEN COALESCE(cod,0) <= 2000 THEN 'PHP 1,501 - PHP 2,000'
            WHEN COALESCE(cod,0) <= 3000 THEN 'PHP 2,001 - PHP 3,000'
            WHEN COALESCE(cod,0) <= 5000 THEN 'PHP 3,001 - PHP 5,000'
            ELSE 'PHP 5,000+'
          END as label,
          COUNT(*) as total,
          SUM(CASE WHEN ${effStatus} = 'delivered' THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN ${effStatus} = 'returned'  THEN 1 ELSE 0 END) as returned,
          SUM(CASE WHEN ${effStatus} = 'returning' THEN 1 ELSE 0 END) as returning,
          COALESCE(SUM(cod), 0) as cod
        FROM pos_orders ${where}
        GROUP BY label
        ORDER BY total DESC
      `).all(...params);
      const byPrice = priceRows.map((r) => {
        const b = Number(r.delivered) + Number(r.returned) + Number(r.returning);
        return {
          label: r.label, total: Number(r.total), delivered: Number(r.delivered),
          returned: Number(r.returned), returning: Number(r.returning),
          cod: Number(r.cod),
          rtsRate: b ? ((Number(r.returned) + Number(r.returning)) / b) * 100 : 0,
        };
      });

      // byProvince — load 3 columns, JS JSON extraction (avoids SQL dialect diff)
      const provinceRows = await db.prepare(
        `SELECT shipping_address_json, ${effStatus} AS status_name, cod FROM pos_orders ${where}`
      ).all(...params);
      const provinceMap = {};
      for (const row of provinceRows) {
        const key = extractProvince(row.shipping_address_json) || null;
        if (!key) continue;
        if (!provinceMap[key]) provinceMap[key] = { label: key, total: 0, delivered: 0, returned: 0, returning: 0, cod: 0 };
        provinceMap[key].total++;
        if (row.status_name === 'delivered') provinceMap[key].delivered++;
        if (row.status_name === 'returned')  provinceMap[key].returned++;
        if (row.status_name === 'returning') provinceMap[key].returning++;
        provinceMap[key].cod += Number(row.cod || 0);
      }
      const byProvince = Object.values(provinceMap).map((g) => {
        const b = g.delivered + g.returned + g.returning;
        return { ...g, rtsRate: b ? ((g.returned + g.returning) / b) * 100 : 0 };
      }).sort((a, b) => b.total - a.total || b.rtsRate - a.rtsRate);

      // byPage — direct column GROUP BY on page_name
      const pageWhere = conditions.length
        ? `WHERE (${conditions.join(' AND ')}) AND page_name IS NOT NULL AND TRIM(page_name) != ''`
        : `WHERE page_name IS NOT NULL AND TRIM(page_name) != ''`;
      const pageReportRows = await db.prepare(`
        SELECT
          page_name as label,
          COUNT(*) as total,
          SUM(CASE WHEN ${effStatus} = 'delivered' THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN ${effStatus} = 'returned'  THEN 1 ELSE 0 END) as returned,
          SUM(CASE WHEN ${effStatus} = 'returning' THEN 1 ELSE 0 END) as returning,
          COALESCE(SUM(cod), 0) as cod
        FROM pos_orders ${pageWhere}
        GROUP BY page_name
        ORDER BY total DESC
      `).all(...params);
      const byPage = pageReportRows.map((r) => {
        const b = Number(r.delivered) + Number(r.returned) + Number(r.returning);
        return {
          label: r.label,
          total: Number(r.total), delivered: Number(r.delivered),
          returned: Number(r.returned), returning: Number(r.returning),
          cod: Number(r.cod),
          rtsRate: b ? ((Number(r.returned) + Number(r.returning)) / b) * 100 : 0,
        };
      });

      // Dropdown options from full dataset (no filter applied)
      const monthRows = await db.prepare(`
        SELECT DISTINCT SUBSTR(inserted_at_remote, 1, 7) as m
        FROM pos_orders
        WHERE inserted_at_remote IS NOT NULL AND LENGTH(inserted_at_remote) >= 7
        ORDER BY m DESC
      `).all();
      const months = monthRows.map((r) => r.m).filter((m) => /^\d{4}-\d{2}$/.test(m));

      const pageRows = await db.prepare(
        `SELECT DISTINCT page_name FROM pos_orders WHERE page_name IS NOT NULL AND TRIM(page_name) != '' ORDER BY page_name`
      ).all();
      const pages = pageRows.map((r) => r.page_name);

      res.json({
        counts: { total, delivered, returned, returning: returningCnt, shipped, wait_print: waitPrint, undeliverable },
        cod,
        rtsRate: base ? ((returned + returningCnt) / base) * 100 : 0,
        byPrice,
        byConfirmed,
        byAdId,
        byProvince,
        byPage,
        months,
        pages,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Staff alias merge map for the Data Report "By Confirmed By" card.
  // Returns the saved alias→canonical pairs plus the distinct staff names
  // present in pos_orders (so the UI can offer them as merge sources).
  router.get('/google-sheets/staff-merge-map', async (req, res) => {
    try {
      const map = await db.prepare('SELECT alias, canonical FROM staff_merge_map ORDER BY canonical, alias').all();
      const nameRows = await db.prepare(
        `SELECT DISTINCT confirmed_by_name AS name FROM pos_orders
         WHERE confirmed_by_name IS NOT NULL AND TRIM(confirmed_by_name) != ''
         ORDER BY confirmed_by_name`
      ).all();
      res.json({ map, names: nameRows.map((r) => r.name) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // SMS Automations is its own RMO page, so the teams that actually run
  // deliveries manage the rules — these sit above the admin gate below and are
  // role-checked individually. The Infotxt credentials and the test-send stay
  // administrator-only.
  const SMS_AUTOMATION_ROLES = new Set(['Administrator', 'RMO', 'RMO TL', 'Logistics']);
  function requireSmsAccess(req, res, next) {
    if (!SMS_AUTOMATION_ROLES.has(String(req.user?.role || '').trim())) {
      return res.status(403).json({ error: 'SMS automation access required' });
    }
    return next();
  }

  router.get('/infotxt/status', requireSmsAccess, async (req, res) => {
    res.json(await infotxtSms.getPublicSetting(db));
  });

  // What the trigger dropdown may offer. The two halves are independent, so a
  // tag lookup that fails still leaves the statuses usable and vice versa.
  router.get('/infotxt/triggers', requireSmsAccess, async (req, res) => {
    const [statuses, tags] = await Promise.allSettled([
      infotxtSms.listPosStatuses(db),
      listAllShopTags(),
    ]);
    res.json({
      statuses: statuses.status === 'fulfilled' ? statuses.value : [],
      tags: tags.status === 'fulfilled' ? tags.value : [],
      partial: statuses.status !== 'fulfilled' || tags.status !== 'fulfilled',
    });
  });

  router.get('/infotxt/rules', requireSmsAccess, async (req, res) => {
    try {
      res.json({ rules: await infotxtSms.listRules(db) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/infotxt/rules', requireSmsAccess, async (req, res) => {
    try {
      res.json({ rules: await infotxtSms.saveRule(db, req.body || {}) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/infotxt/rules/toggle', requireSmsAccess, async (req, res) => {
    try {
      res.json({ rules: await infotxtSms.setRuleEnabled(db, req.body?.id, req.body?.enabled) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/infotxt/rules/delete', requireSmsAccess, async (req, res) => {
    try {
      res.json({ rules: await infotxtSms.deleteRule(db, req.body?.id) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Shops, statuses and tags the blast's order filter may offer. Independent,
  // so a slow tag scan can't cost you the shop list.
  router.get('/infotxt/blast/shops', requireSmsAccess, async (req, res) => {
    try {
      const [shops, statuses, tags] = await Promise.allSettled([
        infotxtSms.listBlastShops(db),
        infotxtSms.listPosStatuses(db),
        infotxtSms.listBlastTags(db),
      ]);
      res.json({
        shops: shops.status === 'fulfilled' ? shops.value : [],
        statuses: statuses.status === 'fulfilled' ? statuses.value : [],
        tags: tags.status === 'fulfilled' ? tags.value : [],
        max_recipients: infotxtSms.BLAST_MAX_RECIPIENTS,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Preview only — counts who a filter would reach, sends nothing.
  router.get('/infotxt/blast/recipients', requireSmsAccess, async (req, res) => {
    try {
      const result = await infotxtSms.listBlastRecipients(db, {
        shop_id: req.query.shop_id,
        status: req.query.status,
        tag: req.query.tag,
        from: req.query.from,
        to: req.query.to,
      });
      // Numbers are the point of the preview, but the whole list is a customer
      // phone dump — hand back the count and a short sample, not all of it.
      res.json({
        total: result.total,
        orders: result.orders,
        unusable: result.unusable,
        // How many of them would get a blank {product name} / {page name}.
        missing_product: result.missing_product,
        missing_page: result.missing_page,
        truncated: result.truncated,
        max_recipients: result.max_recipients,
        sample: result.recipients.slice(0, 5).map((r) => r.mobile),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Sends now. A few hundred messages take minutes, so the batch runs after the
  // response goes out and progress is polled from /blast/status.
  router.post('/infotxt/blast', requireSmsAccess, async (req, res) => {
    try {
      const body = req.body || {};
      let mobiles = body.mobiles;
      // Only messages that use {product name} / {page name} / {customer} need
      // the per-recipient lookup; a plain promo skips it.
      const needsContext = infotxtSms.templateNeedsOrderData(body.message);
      let context = new Map();
      // source=orders: resolve the filter here rather than trusting a client
      // supplied list, so the preview and the send can't disagree.
      if (String(body.source || '') === 'orders') {
        const found = await infotxtSms.listBlastRecipients(db, body.filters || {});
        mobiles = found.recipients.map((r) => r.mobile);
        if (needsContext) context = infotxtSms.blastContext(found.recipients);
      } else if (needsContext) {
        context = await infotxtSms.lookupBlastContext(db, mobiles);
      }
      const blast = await infotxtSms.prepareBlast(db, {
        message: body.message,
        mobiles,
        context,
        sim: body.sim,
        sent_by: req.user?.full_name || req.user?.username || null,
      });
      // Detached on purpose: the caller polls the batch instead of waiting.
      blast.run().catch((error) => {
        console.error(`[sms-blast] ${blast.batch_id} failed: ${error.message}`);
      });
      res.status(202).json({
        batch_id: blast.batch_id,
        total: blast.total,
        invalid: blast.invalid,
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/infotxt/blast/status', requireSmsAccess, async (req, res) => {
    try {
      res.json(await infotxtSms.getBlastStatus(db, req.query.batch_id));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // ─── SALES MARKETING TRACKER (read-only sheet viewer) ─────
  // A second Google Sheets connection with its own credentials, used only to
  // display the spreadsheet's tabs on the Sales Marketing Tracker page. No
  // route here writes to Google or imports rows into dashboard tables.
  // Role text is typed by hand on accounts, so match it loosely — an exact
  // comparison locks out "Sales & Marketing" and other spellings of the same
  // role. Mirrors navAccessKey() on the frontend.
  const TRACKER_MANAGER_ROLES = new Set([
    'administrator',
    'admin',
  ]);

  function trackerRoleKey(role) {
    return String(role || '').trim().toLowerCase().replace(/&/g, 'and').replace(/[\s_-]+/g, ' ');
  }

  // Only admins may change the connection — it stores service account
  // credentials. Reading tabs and rows stays open to any signed-in user, which
  // is what lets Sales and Marketing use the spreadsheet an admin connected.
  function requireTrackerManager(req, res, next) {
    if (!TRACKER_MANAGER_ROLES.has(trackerRoleKey(req.user?.role))) {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    return next();
  }

  router.get('/sales-tracker/config', async (req, res) => {
    try {
      res.json(await salesTrackerSheet.getPublicSetting(db));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/sales-tracker/config', requireTrackerManager, async (req, res) => {
    try {
      res.json(await salesTrackerSheet.saveSetting(db, req.body || {}));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/sales-tracker/config/delete', requireTrackerManager, async (req, res) => {
    try {
      res.json(await salesTrackerSheet.deleteSetting(db));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 502, not 500: a failure here is Google or the connection config talking
  // back, and the page shows the message as-is.
  router.get('/sales-tracker/tabs', async (req, res) => {
    try {
      res.json(await salesTrackerSheet.listTabs(db));
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  router.get('/sales-tracker/sheet', async (req, res) => {
    try {
      res.json(await salesTrackerSheet.getTab(db, req.query.name));
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  // NOTE: registered above the router-wide requireAdmin gate on purpose —
  // Sales and Marketing have to be able to read the tracker. The two write
  // routes carry their own requireTrackerManager check instead.
  // Everything registered BELOW this line is Administrator-only. Routes that
  // any signed-in user must reach have to be registered above it.
  router.use(requireAdmin);

  // The send log carries customer names, numbers and COD amounts, so it stays
  // on the administrator-only Integrations tab rather than the RMO page.
  router.get('/infotxt/logs', async (req, res) => {
    try {
      res.json(await infotxtSms.listSmsLogs(db, {
        limit: req.query.limit,
        status: req.query.status,
      }));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Upsert/clear a single staff alias→canonical mapping. Empty canonical
  // (or canonical === alias) removes the mapping.
  router.put('/google-sheets/staff-merge-map', async (req, res) => {
    try {
      const alias = String(req.body?.alias || '').trim();
      const canonical = String(req.body?.canonical || '').trim();
      if (!alias) return res.status(400).json({ error: 'alias required' });
      if (!canonical || canonical === alias) {
        await db.prepare('DELETE FROM staff_merge_map WHERE alias = ?').run(alias);
        return res.json({ success: true, alias, canonical: '' });
      }
      await db.prepare(`
        INSERT INTO staff_merge_map (alias, canonical, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical, updated_at = datetime('now')
      `).run(alias, canonical);
      res.json({ success: true, alias, canonical });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

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

  // Order tags across every connected shop. Fanned out in parallel with a short
  // timeout and no retries: this feeds a dropdown, so a shop that is slow or
  // unreachable has to drop out rather than hold the whole request for the
  // default minute-per-shop that posRequest would otherwise allow.
  async function listAllShopTags() {
    const connections = await posSync.getSavedConnections(db);
    const results = await Promise.allSettled(connections.map((connection) => posSync.listShopOrderTags(db, {
      shop_id: connection.shop_id,
      __timeout_ms: 8000,
      __no_retry: true,
    })));
    // Keyed by name, not id: the same tag exists under a different id on each
    // shop, and rules match on the name. Group is carried through so the
    // dropdown can show tags the way RMO Management's tag editor does.
    const seen = new Map();
    results.forEach((result) => {
      if (result.status !== 'fulfilled') return;
      (result.value?.tags || []).forEach((tag) => {
        const name = String(tag?.name || '').trim();
        if (!name || seen.has(name.toLowerCase())) return;
        seen.set(name.toLowerCase(), { name, group: tag?.group || null });
      });
    });
    return [...seen.values()].sort((a, b) => (a.group || '').localeCompare(b.group || '')
      || a.name.localeCompare(b.name));
  }

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

  router.post('/infotxt/config', async (req, res) => {
    try {
      const config = await infotxtSms.saveSetting(db, req.body || {});
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/infotxt/test-sms', async (req, res) => {
    try {
      const result = await infotxtSms.sendSms(db, {
        mobile: req.body?.mobile,
        message: req.body?.message || 'YNT ERP Infotxt test message.',
        sim: req.body?.sim,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
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

  router.post('/pancake-pos/connections/delete', async (req, res) => {
    try {
      const result = await posSync.deleteConnection(db, req.body || {});
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/pancake-pos/collect', async (req, res) => {
    try {
      // Somebody pressed Sync, so this pass is allowed to fill in the customer
      // counters on orders stored before they existed — one write per such
      // order, once. The interval sync never sets this and keeps skipping
      // unchanged orders. Pass backfill_customer_stats: false to opt out.
      const result = await posSync.collectPosData(db, { backfill_customer_stats: true, ...(req.body || {}) });
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
      const normalized = await posSync.normalizeSourceSheets(db, { force: true });
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
      const from = old_name.trim();
      const to = new_name.trim();
      if (from === '(unknown)') {
        return res.status(400).json({ error: 'The "(unknown)" bucket has no real page name to rename.' });
      }
      // A page's orders are labelled with its CONNECTION name, keyed by
      // shop_id (pos_orders assigns page_name per shop_id from the connection).
      // So the durable rename keys off shop_id, not the old text: this catches
      // every variant spelling for the page (the cause of the "two entries"
      // split), and — by renaming the connection too — makes every FUTURE sync
      // use the new name so it can never re-split.
      const shopRows = await db.prepare(
        `SELECT DISTINCT shop_id FROM pos_orders
         WHERE page_name = ? AND shop_id IS NOT NULL AND TRIM(shop_id) != ''`
      ).all(from);
      const shopIds = shopRows.map((r) => String(r.shop_id));

      let posResult;
      let connResult = { changes: 0 };
      if (shopIds.length) {
        const ph = shopIds.map(() => '?').join(',');
        posResult = await db.prepare(
          `UPDATE pos_orders SET page_name = ?, updated_at = datetime('now')
           WHERE shop_id IN (${ph})`
        ).run(to, ...shopIds);
        // Rename the POS connection(s) too — page_id stores the shop_id — so the
        // sync's source of truth matches and new orders keep the new name.
        connResult = await db.prepare(
          `UPDATE integration_settings SET name = ?, updated_at = datetime('now')
           WHERE provider = 'pancake_pos' AND page_id IN (${ph})`
        ).run(to, ...shopIds);
        posSync.invalidateSavedConnectionsCache(); // drop 30s cache so sync sees new name now
      } else {
        // No POS rows for this name (e.g. legacy Google Sheets only) — plain rename.
        posResult = await db.prepare(
          `UPDATE pos_orders SET page_name = ?, updated_at = datetime('now')
           WHERE page_name = ?`
        ).run(to, from);
      }
      // Legacy Google Sheets orders (source_sheet is the page identity there).
      const result = await db.prepare(
        `UPDATE google_orders SET source_sheet = ?, updated_at = datetime('now')
         WHERE source_sheet = ?`
      ).run(to, from);
      // Also move the ad-spend rows: Ad Spend ROAS joins orders to spend by
      // page NAME (marketing_entries.page === the page identity), so a rename
      // that touches only orders would orphan the spend under the old name.
      const spendResult = await db.prepare(
        `UPDATE marketing_entries SET page = ?, updated_at = datetime('now')
         WHERE page = ?`
      ).run(to, from);
      // RTS SKU-per-page mapping. page_name is unique here, so only move the
      // row when the destination name doesn't already have a mapping (avoids a
      // unique-constraint failure); otherwise keep the existing target mapping.
      const skuResult = await db.prepare(
        `UPDATE rts_page_sku SET page_name = ?, updated_at = datetime('now')
         WHERE page_name = ? AND NOT EXISTS (SELECT 1 FROM rts_page_sku WHERE page_name = ?)`
      ).run(to, from, to);
      res.json({
        pos_updated: posResult.changes,
        connection_updated: connResult.changes,
        updated: result.changes,
        spend_updated: spendResult.changes,
        sku_updated: skuResult.changes,
        old_name: from,
        new_name: to,
      });
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

  publicRouter.get('/infotxt/status', async (req, res) => {
    const status = await infotxtSms.getPublicSetting(db);
    res.json({ enabled: Boolean(status.enabled), configured: Boolean(status.configured) });
  });

  publicRouter.post([
    '/pancake-pos/config',
    '/google-sheets/config',
    '/pancake-pos/shops',
    '/pancake-pos/validate-page-token',
    '/pancake-pos/validate-botcake-token',
    '/pancake-pos/connections/delete',
    '/infotxt/config',
    '/infotxt/test-sms',
    '/infotxt/rules',
    '/infotxt/rules/toggle',
    '/infotxt/rules/delete',
    '/infotxt/blast',
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
