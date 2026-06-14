const { createDatabaseClient } = await import('./db/client.js');
const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const rows = await db.prepare(`
  SELECT external_id, status AS pos_status, status_name, partner_json
  FROM pos_orders
  WHERE partner_json IS NOT NULL AND partner_json NOT IN ('null','{}','')
  LIMIT 500
`).all();

const partnerStatusCounts = {};
const isReturnedCounts = { true: 0, false: 0, null: 0 };
const extendUpdateSamples = [];

for (const row of rows) {
  let p = null;
  try { p = JSON.parse(row.partner_json); } catch {}
  if (!p) continue;

  const ps = String(p?.partner_status ?? '');
  partnerStatusCounts[ps] = (partnerStatusCounts[ps] || 0) + 1;

  if (p?.is_returned === true) isReturnedCounts.true++;
  else if (p?.is_returned === false) isReturnedCounts.false++;
  else isReturnedCounts.null++;

  const updates = Array.isArray(p?.extend_update) ? p.extend_update : [];
  if (updates.length && extendUpdateSamples.length < 5) {
    const latest = [...updates].reverse()[0];
    extendUpdateSamples.push({ pos_status: row.status_name, partner_status: ps, is_returned: p?.is_returned, latest_status: latest?.status });
  }
}

console.log('\n=== partner_status values ===');
Object.entries(partnerStatusCounts).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  "${k}": ${v}`));
console.log('\n=== is_returned counts ===');
console.log(`  true: ${isReturnedCounts.true}, false: ${isReturnedCounts.false}, null/missing: ${isReturnedCounts.null}`);
console.log('\n=== extend_update sample statuses ===');
extendUpdateSamples.forEach(s => console.log(`  POS: ${s.pos_status} | partner_status: ${s.partner_status} | is_returned: ${s.is_returned} | latest: ${s.latest_status}`));
