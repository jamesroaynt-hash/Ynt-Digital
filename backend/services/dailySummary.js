// End-of-day summary: one frozen snapshot per Manila day of the POS orders,
// saved into daily_summaries so it can be read the next morning even after the
// statuses have moved on. Two halves:
//   day   — the orders placed that day, by confirmer, by page and by status
//   month — month to date (1st → that day): sales so far and the delivered /
//           returning / returned verdicts, with the RTS rate the Data Report uses
// Counting rules match the POS dashboard (posDashboardWhere in routes/_all.js):
// Manila business day, a customer phone on the order, canceled/removed left out,
// and the effective status so an abandoned undeliverable counts as returned.
const pancakePosSync = require('./pancakePosSync');

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

// The snapshot is taken this many minutes before Manila midnight.
const SNAPSHOT_HOUR = 23;
const SNAPSHOT_MINUTE = 50;

function manilaNow(now = new Date()) {
  return new Date(now.getTime() + MANILA_OFFSET_MS);
}

function manilaToday(now = new Date()) {
  return manilaNow(now).toISOString().slice(0, 10);
}

function previousDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDay(value) {
  const text = String(value || '').trim().slice(0, 10);
  return DAY_PATTERN.test(text) ? text : null;
}

// The dashboard's status buckets, in the order they are read.
const STATUS_ORDER = ['New', 'Confirmed', 'Waiting for pickup', 'Shipped', 'Delivered', 'Returning', 'Returned'];

function statusCaseSql() {
  const effective = pancakePosSync.effectivePosStatusSql();
  return `CASE
    WHEN ${effective} = 'returned' THEN 'Returned'
    WHEN status_name = 'new' THEN 'New'
    WHEN status_name = 'submitted' THEN 'Confirmed'
    WHEN status_name IN ('pending','wait_print','waitting') THEN 'Waiting for pickup'
    WHEN status_name = 'shipped' THEN 'Shipped'
    WHEN status_name = 'delivered' THEN 'Delivered'
    WHEN status_name = 'returning' THEN 'Returning'
    WHEN status_name = 'returned' THEN 'Returned'
    ELSE 'Confirmed'
  END`;
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function rows(list, key) {
  return list.map((row) => ({
    name: row[key] || null,
    orders: Number(row.orders || 0),
    sales: money(row.sales),
  }));
}

function byStatusOrder(list) {
  const map = new Map(list.map((row) => [row.name, row]));
  return STATUS_ORDER.map((name) => map.get(name) || { name, orders: 0, sales: 0 });
}

function totals(list) {
  return {
    orders: list.reduce((sum, row) => sum + row.orders, 0),
    sales: money(list.reduce((sum, row) => sum + row.sales, 0)),
  };
}

async function buildDailySummary(db, day) {
  const manilaDay = pancakePosSync.posManilaDaySql(db.type);
  const status = statusCaseSql();
  const base = `
    SELECT ${manilaDay} AS day, ${status} AS status, status_name, page_name, confirmed_by_name, cod
    FROM pos_orders
    WHERE customer_phone IS NOT NULL AND customer_phone <> ''
      AND COALESCE(status_name, '') NOT IN ('canceled', 'removed')`;
  const monthStart = `${day.slice(0, 7)}-01`;

  const group = (column, from, to, extraWhere = '') => db.prepare(`
    SELECT ${column} AS name, COUNT(*) AS orders, COALESCE(SUM(cod), 0) AS sales
    FROM (${base}) o
    WHERE day >= ? AND day <= ? ${extraWhere}
    GROUP BY ${column}
    ORDER BY COUNT(*) DESC
  `).all(from, to);

  // Per page counts only Confirmed, Shipped and Delivered orders, plus the ones
  // waiting for the courier — Pancake's 'pending' (9): waybill printed. Awaiting
  // print (wait_print, 12) and waiting for stock (waitting, 11) are left out.
  const pageWhere = `AND (status IN ('Confirmed', 'Shipped', 'Delivered') OR (status = 'Waiting for pickup' AND status_name = 'pending'))`;

  const [dayStatus, dayPage, dayConfirmer, monthStatus, monthPage] = await Promise.all([
    group('status', day, day),
    group('page_name', day, day, pageWhere),
    group('confirmed_by_name', day, day),
    group('status', monthStart, day),
    group('page_name', monthStart, day, pageWhere),
  ]);

  const monthByStatus = byStatusOrder(rows(monthStatus, 'name'));
  const pick = (name) => monthByStatus.find((row) => row.name === name);
  const delivered = pick('Delivered');
  const returning = pick('Returning');
  const returned = pick('Returned');
  const settled = delivered.orders + returning.orders + returned.orders;

  const dayByStatus = byStatusOrder(rows(dayStatus, 'name'));
  return {
    date: day,
    day: {
      ...totals(dayByStatus),
      by_status: dayByStatus,
      by_page: rows(dayPage, 'name'),
      by_confirmer: rows(dayConfirmer, 'name'),
    },
    month: {
      from: monthStart,
      to: day,
      ...totals(monthByStatus),
      by_status: monthByStatus,
      by_page: rows(monthPage, 'name'),
      delivered,
      returning,
      returned,
      // Same formula as the Data Report: only settled orders have a verdict.
      rts_rate: settled ? Math.round(((returning.orders + returned.orders) / settled) * 10000) / 100 : null,
    },
  };
}

// Saves (or refreshes) a day's snapshot. The notes written on the day are kept.
async function saveDailySummary(db, day, { trigger = 'manual' } = {}) {
  const summary = await buildDailySummary(db, day);
  await db.prepare(`
    INSERT INTO daily_summaries (summary_date, data, source, generated_at, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(summary_date) DO UPDATE SET
      data = excluded.data,
      source = excluded.source,
      generated_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(day, JSON.stringify(summary), trigger);
  return summary;
}

async function hasSnapshot(db, day) {
  const row = await db.prepare(
    "SELECT summary_date FROM daily_summaries WHERE summary_date = ? AND data IS NOT NULL AND data <> ''"
  ).get(day);
  return !!row;
}

// Called on a timer. Takes today's snapshot once it is past 23:50 Manila, and
// fills in yesterday's if the server was down when it should have been taken —
// late, so its statuses are a little further on than they were that night.
async function runScheduledSnapshot(db, now = new Date()) {
  const local = manilaNow(now);
  const today = local.toISOString().slice(0, 10);
  const taken = [];
  const yesterday = previousDay(today);
  if (!(await hasSnapshot(db, yesterday))) {
    await saveDailySummary(db, yesterday, { trigger: 'catch-up' });
    taken.push(yesterday);
  }
  const pastCutoff = local.getUTCHours() > SNAPSHOT_HOUR
    || (local.getUTCHours() === SNAPSHOT_HOUR && local.getUTCMinutes() >= SNAPSHOT_MINUTE);
  if (pastCutoff && !(await hasSnapshot(db, today))) {
    await saveDailySummary(db, today, { trigger: 'scheduled' });
    taken.push(today);
  }
  return taken;
}

module.exports = {
  buildDailySummary,
  saveDailySummary,
  runScheduledSnapshot,
  manilaToday,
  previousDay,
  validDay,
  STATUS_ORDER,
};
