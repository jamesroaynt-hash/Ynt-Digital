import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('db/ynt.db');
const row = db.prepare("SELECT user_access_token FROM integration_settings WHERE provider = 'pancake_pos' LIMIT 1").get();
db.close();

const conns = JSON.parse(row?.user_access_token || '[]');
console.log('connections:', conns.map(c => ({ id: c.id, shop_id: c.shop_id, has_key: !!c.api_key })));

// Hit the backend collect endpoint (assumes server is running on 3000)
const ports = [3000, 3001, 5000, 8080];
let serverPort = null;
for (const port of ports) {
  try {
    const r = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) { serverPort = port; break; }
  } catch {}
}

if (!serverPort) {
  console.log('Server not running. Triggering sync directly via service...');

  // Import and run directly
  const { createDatabaseClient } = await import('./db/client.js');
  const { collectPosData } = await import('./services/pancakePosSync.js');
  const dbClient = createDatabaseClient({ filename: 'db/ynt.db' });

  console.log('Running collectPosData...');
  const result = await collectPosData(dbClient, { resources: ['orders'] });
  console.log('Result:', JSON.stringify(result, null, 2));
} else {
  console.log(`Server found on port ${serverPort}, calling collect endpoint...`);
  // Need auth token - get admin user
  const db2 = new DatabaseSync('db/ynt.db');
  const admin = db2.prepare("SELECT id FROM users WHERE role IN ('admin','super_admin') LIMIT 1").get();
  db2.close();

  const res = await fetch(`http://localhost:${serverPort}/api/integrations/pancake-pos/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resources: ['orders'] })
  });
  const data = await res.json();
  console.log('Response status:', res.status);
  console.log('Result:', JSON.stringify(data, null, 2));
}
