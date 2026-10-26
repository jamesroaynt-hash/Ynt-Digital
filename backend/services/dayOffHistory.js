// Effective-dated weekly day off, the same way user_rate_history dates the
// daily rate: changing someone's day off inserts a row dated from the change,
// so every earlier date still resolves to the day off they had then. Payroll
// (rest-day premium), the Employee Tracker / Compliance attendance and the
// Virtual Office all read it per date. users.day_off is only the "today" copy.

// Number(null) is 0, which would read a missing day off as Sunday.
function validDayOff(value) {
  if (value === null || value === undefined || String(value).trim() === '') return -1;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : -1;
}

// rows sorted ascending by effective_from; dates are YYYY-MM-DD, so string
// comparison is chronological. Falls back to the user's current day off when
// no row covers the date.
function dayOffOnDate(rows, date, fallback) {
  let dayOff = null;
  for (const row of rows || []) {
    if (String(row.effective_from) <= String(date)) dayOff = validDayOff(row.day_off);
    else break;
  }
  return dayOff !== null ? dayOff : validDayOff(fallback);
}

// Map<userId, rows[]>; every user when ids is omitted.
async function loadDayOffHistoryMap(db, ids) {
  const map = new Map();
  let rows;
  if (ids) {
    const list = ids.map(Number).filter((id) => Number.isInteger(id) && id > 0);
    if (!list.length) return map;
    rows = await db.prepare(`
      SELECT user_id, day_off, effective_from FROM user_day_off_history
      WHERE user_id IN (${list.map(() => '?').join(',')})
      ORDER BY user_id ASC, effective_from ASC
    `).all(...list);
  } else {
    rows = await db.prepare(`
      SELECT user_id, day_off, effective_from FROM user_day_off_history
      ORDER BY user_id ASC, effective_from ASC
    `).all();
  }
  rows.forEach((row) => {
    const uid = Number(row.user_id);
    if (!map.has(uid)) map.set(uid, []);
    map.get(uid).push(row);
  });
  return map;
}

module.exports = { validDayOff, dayOffOnDate, loadDayOffHistoryMap };
