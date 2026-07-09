const { createDatabaseClient } = await import('./db/client.js');
const { normalizeSourceSheets } = await import('./services/pancakePosSync.js');

const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

process.stderr.write('Normalizing source sheets...\n');
const normalized = await normalizeSourceSheets(db, { force: true });
process.stderr.write(`Normalized: ${normalized} orders updated\n`);
