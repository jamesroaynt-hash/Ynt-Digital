import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from './db/client.js';
import { replayStoredOrdersToDashboard } from './services/pancakePosSync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'db/ynt.db');
const db = createDatabaseClient({ filename: dbPath });
const shopId = process.argv[2] || process.env.POS_REPLAY_SHOP_ID || null;
const updateExisting = process.argv.includes('--update-existing') || process.env.POS_REPLAY_UPDATE_EXISTING === 'true';

try {
  const result = await replayStoredOrdersToDashboard(db, {
    all: !shopId,
    shop_id: shopId || undefined,
    missing_only: !updateExisting,
    batch_size: Number(process.env.POS_REPLAY_BATCH_SIZE || 500),
    limit: Number(process.env.POS_REPLAY_LIMIT || 5000),
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.close();
}
