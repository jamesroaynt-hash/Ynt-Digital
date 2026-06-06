// Load backend/.env so DATABASE_URL / POSTGRES_SSL are available without
// exposing credentials on the command line.
import { readFileSync } from 'node:fs';
try {
  const envText = readFileSync(new URL('./.env', import.meta.url), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* no .env present */ }

const { createDatabaseClient } = await import('./db/client.js');
const { collectPosData, getSavedConnections } = await import('./services/pancakePosSync.js');

const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

process.stderr.write('[db] Connected\n');

const connections = await getSavedConnections(db);
process.stderr.write(`[pos] Collecting from ${connections.length} connections since 2026-01-01...\n`);

const startOfYear = Math.floor(new Date('2026-01-01T00:00:00').getTime() / 1000);
const now = Math.floor(Date.now() / 1000);

try {
  const result = await collectPosData(db, {
    connections,
    resources: ['orders'],
    startDateTime: startOfYear,
    endDateTime: now,
    page_size: 100,
    max_pages: 2000,
    // pos_orders is now the dashboard source of truth — no need to replay into
    // the retired orders table (saves load + avoids re-bloating it).
    replay_stored_orders: false,
  });

  process.stderr.write('[pos] Sync complete\n');
  process.stdout.write(JSON.stringify({
    connections: result.connections?.map(c => ({
      name: c.name,
      shop_id: c.shop_id,
      orders: c.resources?.orders?.count,
      failed: c.failed_resources,
    })),
    dashboard_replay: result.dashboard_replay,
    failed_resources: result.failed_resources,
  }, null, 2) + '\n');
} catch (err) {
  process.stderr.write(`[error] ${err.message}\n`);
  process.exit(1);
}
