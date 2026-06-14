const { createDatabaseClient } = await import('./db/client.js');
const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
const a = await db.prepare(`UPDATE orders SET source_sheet = 'Skin Expert - Dragon Blood' WHERE source_sheet LIKE '%Skin Expert%Dragon Blood%' AND source_sheet != 'Skin Expert - Dragon Blood'`).run();
const b = await db.prepare(`UPDATE orders SET source_sheet = 'Korean Glow Clinic PH Dragon Blood' WHERE source_sheet LIKE '%Korean Glow%Dragon Blood%' AND source_sheet != 'Korean Glow Clinic PH Dragon Blood'`).run();
process.stdout.write(`Fixed: ${(a.changes||0)+(b.changes||0)} orders\n`);
