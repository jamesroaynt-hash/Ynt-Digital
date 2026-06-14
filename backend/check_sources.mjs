const { createDatabaseClient } = await import('./db/client.js');
const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
const rows = await db.prepare(`
  SELECT source_sheet, COUNT(*) AS cnt FROM orders
  WHERE source_sheet IS NOT NULL AND TRIM(source_sheet) != ''
  GROUP BY source_sheet ORDER BY cnt DESC
`).all();
console.log('All source_sheet values:');
rows.forEach(r => console.log(`  "${r.source_sheet}": ${r.cnt}`));
