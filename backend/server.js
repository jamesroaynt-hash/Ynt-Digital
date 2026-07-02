const express = require('express');
const compression = require('compression');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createDatabaseClient } = require('./db/client');
const { initializeDatabaseAsync } = require('./db/init');
const googleSheetsSync = require('./services/googleSheetsSync');
const pancakePosSync = require('./services/pancakePosSync');
const { dispatch: dispatchWebhook } = require('./services/webhookDispatcher');
const { hashKey: hashApiKey } = require('./routes/apiKeys');

let blobPersistence = {
  restoreDatabaseFromBlob: async () => false,
  createBackupScheduler: () => ({
    schedule() {},
    uploadBackup: async () => {},
  }),
};

try {
  blobPersistence = require('./db/blobPersistence');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const {
  restoreDatabaseFromBlob,
  createBackupScheduler,
} = blobPersistence;

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadEnvFile();

if (!process.env.JWT_SECRET) {
  const generated = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = generated;
  try {
    const envPath = path.join(__dirname, '.env');
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (!existing.includes('JWT_SECRET=')) {
      fs.appendFileSync(envPath, `\nJWT_SECRET=${generated}\n`, 'utf8');
      console.log('[security] Generated JWT_SECRET saved to .env — sessions will survive restarts.');
    }
  } catch {
    console.warn('[security] JWT_SECRET not set and .env is not writable. All sessions will be invalidated on restart. Set JWT_SECRET in your environment.');
  }
}

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET;
const PANCAKE_POS_SYNC_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.PANCAKE_POS_SYNC_INTERVAL_MS || 5 * 60 * 1000)
);
const PANCAKE_POS_SYNC_PAGE_SIZE = Math.max(
  10,
  Math.min(100, Number(process.env.PANCAKE_POS_SYNC_PAGE_SIZE || 100))
);
// Bound the interval sync's page drain. Pancake's start_time_updated_at filter
// is coarse and hands back the same ~2000 recent orders every cycle (maxPages
// default 20 × page_size 100). Results are sorted updated_at_desc, so the
// genuinely-changed orders are always on the first pages — a few pages catch
// every real change, and the unchanged tail is skipped at upsert anyway. This
// caps Pancake fetch size, memory, and sync time per cycle. Manual/backfill
// syncs don't use this window, so full history re-pulls are unaffected.
// Default 2 pages: genuinely-changed orders sort to the front (updated_at_desc),
// so 2×100 catches real changes while keeping peak memory low. Raise via env if
// a shop legitimately churns >200 orders between cycles.
const PANCAKE_POS_SYNC_MAX_PAGES = Math.max(
  1,
  Math.min(20, Number(process.env.PANCAKE_POS_SYNC_MAX_PAGES || 2))
);

// Shared security state
const tokenBlocklist = new Map(); // jti -> expiresAt (ms)
const loginAttempts = new Map();  // ip -> { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [jti, expiresAt] of tokenBlocklist) {
    if (now > expiresAt) tokenBlocklist.delete(jti);
  }
  for (const [ip, record] of loginAttempts) {
    if (now > record.resetAt) loginAttempts.delete(ip);
  }
}, 15 * 60 * 1000).unref();

const extraOrigins = (process.env.FRONTEND_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function isPrivateLanHost(hostname = '') {
  return /^(localhost|127\.0\.0\.1)$/i.test(hostname)
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
}

function isHostedAppHost(hostname = '') {
  return /\.onrender\.com$/i.test(hostname)
    || /\.vercel\.app$/i.test(hostname)
    || /\.up\.railway\.app$/i.test(hostname)
    || /\.railway\.app$/i.test(hostname)
    || /\.trycloudflare\.com$/i.test(hostname)
    || /\.workers\.dev$/i.test(hostname)
    || /\.pages\.dev$/i.test(hostname);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;

  try {
    const { hostname } = new URL(origin);
    if (isPrivateLanHost(hostname)) return true;
    if (isHostedAppHost(hostname)) return true;
    return extraOrigins.includes(origin);
  } catch {
    return false;
  }
}

function getLanUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .filter((details) => details.family === 'IPv4' && !details.internal)
    .map((details) => `http://${details.address}:${port}`);
}

function getDatabasePath() {
  return process.env.SQLITE_PATH
    || (process.env.VERCEL ? path.join(os.tmpdir(), 'ynt.db') : path.join(__dirname, 'db/ynt.db'));
}

function shouldBackupRequest(req, res) {
  const mayMutate = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
    || req.originalUrl.includes('/google-sheets/cron')
    || req.originalUrl.includes('/pancake-pos/cron');

  return mayMutate
    && res.statusCode >= 200
    && res.statusCode < 400
    && req.originalUrl.startsWith('/api/');
}

function attachDatabaseBackupMiddleware(app, backupScheduler) {
  app.use((req, res, next) => {
    res.on('finish', () => {
      if (shouldBackupRequest(req, res)) {
        backupScheduler.schedule();
      }
    });
    next();
  });
}

let appPromise = null;
let appInstance = null;

async function createApp() {
  const app = express();

  const dbPath = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  if (!process.env.DATABASE_URL) {
    await restoreDatabaseFromBlob(dbPath);
  }

  const db = createDatabaseClient({ filename: dbPath });
  console.log(`[database] Using ${db.type}${db.type === 'sqlite' ? ` at ${dbPath}` : ' from DATABASE_URL'}.`);
  await db.pragma('journal_mode = WAL');
  await db.pragma('foreign_keys = ON');

  await initializeDatabaseAsync(db);
  console.log('[database] Schema initialized.');
  if (process.env.POS_CLEAN_MALFORMED_ORDERS === 'true') {
    const cleaned = await pancakePosSync.cleanupMalformedDashboardOrders(db);
    if (cleaned) {
      console.log(`[pancake_pos] Removed ${cleaned} malformed dashboard order(s).`);
    }
  }

  const backupScheduler = createBackupScheduler(db, dbPath);
  backupScheduler.startPeriodicBackups();

  // gzip every compressible response (API JSON + the static frontend bundle).
  // Biggest egress win on Railway: the data-report/records walks and the ~550KB
  // app.js shrink ~5-10x on the wire. Registered first so it wraps all routes
  // and the express.static handlers below.
  app.use(compression());
  app.use(cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
  }));
  app.use(express.json({ limit: '5mb' }));
  app.set('etag', 'weak');
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  attachDatabaseBackupMiddleware(app, backupScheduler);
  const staticCacheHeaders = {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    },
  };
  app.get('/favicon.ico', (req, res) => {
    res
      .type('png')
      .set('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400')
      .sendFile(path.join(__dirname, '../Images/yntlogo.png'));
  });
  app.use('/Images', express.static(path.join(__dirname, '../Images'), staticCacheHeaders));
  app.use(express.static(path.join(__dirname, '../frontend'), staticCacheHeaders));

  async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const apiKeyHeader = req.headers['x-api-key'] || '';

    // API key auth: Authorization: ApiKey <key>  or  X-API-Key: <key>
    const apiKeyRaw = apiKeyHeader
      || (authHeader.toLowerCase().startsWith('apikey ') ? authHeader.slice(7).trim() : '');
    if (apiKeyRaw) {
      try {
        const hash = hashApiKey(apiKeyRaw);
        const row = await db.prepare(
          "SELECT id, name, scopes FROM api_keys WHERE key_hash = ? AND is_active = 1 LIMIT 1"
        ).get(hash);
        if (!row) return res.status(401).json({ error: 'Invalid or revoked API key' });
        Promise.resolve(db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id)).catch(() => {});
        req.user = {
          id: null,
          role: 'api_key',
          username: `apikey:${row.name}`,
          scopes: JSON.parse(row.scopes || '[]'),
          key_id: row.id,
        };
        return next();
      } catch (err) {
        return res.status(500).json({ error: 'Auth error' });
      }
    }

    // JWT auth: Authorization: Bearer <token>
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.jti && tokenBlocklist.has(payload.jti)) {
        return res.status(401).json({ error: 'Token has been revoked' });
      }
      req.user = payload;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  const webhookDispatch = (event, data) => dispatchWebhook(db, event, data);

  app.use('/api/auth', require('./routes/auth')(db, jwt, bcrypt, JWT_SECRET, { tokenBlocklist, loginAttempts }));
  app.use('/api/orders', authMiddleware, require('./routes/orders')(db, { dispatch: webhookDispatch }));
  app.use('/api/inventory', authMiddleware, require('./routes/inventory')(db, { dispatch: webhookDispatch }));
  app.use('/api/expenses', authMiddleware, require('./routes/expenses')(db));
  app.use('/api/hr', authMiddleware, require('./routes/hr')(db));
  app.use('/api/marketing', authMiddleware, require('./routes/marketing')(db));
  app.use('/api/pickups', authMiddleware, require('./routes/pickups')(db));
  app.use('/api/scans', authMiddleware, require('./routes/scans')(db));
  app.use('/api/csr', authMiddleware, require('./routes/csr')(db));
  const integrationsRouter = require('./routes/integrations')(db);
  app.use('/api/integrations', authMiddleware, integrationsRouter);
  app.use('/api/public/integrations', integrationsRouter.publicRouter);
  app.use('/api/api-keys', authMiddleware, require('./routes/apiKeys')(db));
  app.use('/api/webhooks', authMiddleware, require('./routes/webhooks')(db));
  app.use('/api/announcements', authMiddleware, require('./routes/announcements')(db));
  app.use('/api/chat', authMiddleware, require('./routes/chat')(db));

  // API discovery endpoint
  app.get('/api', (req, res) => {
    res.json({
      name: 'YNT Dashboard API',
      version: '1.0',
      auth: {
        jwt: 'POST /api/auth/login → returns token → Authorization: Bearer <token>',
        api_key: 'Create key at /api/api-keys → Authorization: ApiKey <key>  or  X-API-Key: <key>',
      },
      endpoints: {
        auth: ['POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/auth/me'],
        orders: ['GET /api/orders', 'POST /api/orders', 'PUT /api/orders/:id', 'DELETE /api/orders/:id', 'POST /api/orders/import'],
        inventory: ['GET /api/inventory', 'PATCH /api/inventory/:item_id/stock', 'GET /api/inventory/low-stock'],
        expenses: ['GET /api/expenses', 'POST /api/expenses', 'DELETE /api/expenses/:id'],
        hr: ['GET /api/hr/attendance', 'POST /api/hr/clock', 'GET /api/hr/summary'],
        scans: ['GET /api/scans', 'POST /api/scans', 'GET /api/scans/lookup/:tracking'],
        pickups: ['GET /api/pickups', 'POST /api/pickups'],
        api_keys: ['GET /api/api-keys', 'POST /api/api-keys', 'DELETE /api/api-keys/:id'],
        webhooks: ['GET /api/webhooks', 'POST /api/webhooks', 'PATCH /api/webhooks/:id', 'DELETE /api/webhooks/:id', 'GET /api/webhooks/:id/deliveries'],
        integrations: ['GET /api/integrations/pancake-pos/status', 'GET /api/integrations/google-sheets/status'],
      },
      webhook_events: ['order.created', 'order.updated', 'order.deleted', 'inventory.updated', '*'],
      api_key_scopes: ['orders:read', 'orders:write', 'inventory:read', 'inventory:write', 'expenses:read', 'expenses:write', 'hr:read'],
    });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.originalUrl}` });
  });

  app.use((error, req, res, next) => {
    console.error(`[server] ${req.method} ${req.originalUrl}: ${error.stack || error.message}`);
    if (req.originalUrl.startsWith('/api')) {
      const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL || process.env.RAILWAY_ENVIRONMENT;
      res.status(500).json({ error: isProduction ? 'Internal server error' : (error.message || 'Internal server error') });
      return;
    }
    next(error);
  });

  app.get('*', (req, res) => {
    res
      .set('Cache-Control', 'no-cache')
      .sendFile(path.join(__dirname, '../frontend/index.html'));
  });

  async function runGoogleSheetsSync(trigger) {
    try {
      const result = await googleSheetsSync.runScheduledSync(db);
      if (!result?.skipped) {
        backupScheduler.schedule();
        console.log(`[google_sheets] ${trigger} sync completed: imported=${result.imported || 0}, updated=${result.updated || 0}`);
      }
    } catch (error) {
      console.error(`[google_sheets] ${trigger} sync failed: ${error.message}`);
    }
  }

  async function scheduleGoogleSheetsSync() {
    const delay = await googleSheetsSync.getSyncIntervalMs(db);
    setTimeout(async () => {
      await runGoogleSheetsSync('interval');
      scheduleGoogleSheetsSync();
    }, delay);
  }

  let pancakePosSyncRunning = false;
  let pancakePosSyncStartedAt = null;
  const PANCAKE_POS_SYNC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max per sync

  function getPancakePosSyncWindow() {
    return {
      endDateTime: Math.floor(Date.now() / 1000),
      page_size: PANCAKE_POS_SYNC_PAGE_SIZE,
      max_pages: PANCAKE_POS_SYNC_MAX_PAGES,
      resources: ['orders'],
      replay_stored_orders: false,
    };
  }

  async function runPancakePosSync(trigger) {
    if (pancakePosSyncRunning) {
      const elapsed = pancakePosSyncStartedAt ? Date.now() - pancakePosSyncStartedAt : 0;
      if (elapsed < PANCAKE_POS_SYNC_TIMEOUT_MS) {
        console.log(`[pancake_pos] ${trigger} sync skipped: another POS sync is still running (${Math.round(elapsed / 1000)}s).`);
        return;
      }
      console.warn(`[pancake_pos] ${trigger} previous sync timed out after ${Math.round(elapsed / 1000)}s, forcing reset.`);
      pancakePosSyncRunning = false;
    }

    pancakePosSyncRunning = true;
    pancakePosSyncStartedAt = Date.now();
    try {
      const status = await pancakePosSync.getStatus(db);
      if (!status.enabled) {
        console.log(`[pancake_pos] ${trigger} sync skipped: integration is disabled.`);
        return;
      }
      const savedConnections = await pancakePosSync.getSavedConnections(db);
      const automaticConnections = savedConnections.filter((connection) => (
        connection.enabled !== false
        && connection.api_key
        && connection.shop_id
        && connection.sync_mode === 'automatic'
      ));
      if (trigger !== 'manual' && automaticConnections.length) {
        const result = await pancakePosSync.collectPosData(db, {
          connections: automaticConnections,
          resources: ['orders'],
          ...getPancakePosSyncWindow(),
        });
        backupScheduler.schedule();
        const replay = result?.dashboard_replay
          ? `, replayed=${result.dashboard_replay.transferred || 0}/${result.dashboard_replay.scanned || 0}`
          : '';
        console.log(`[pancake_pos] ${trigger} multi-sync completed: connections=${automaticConnections.length}${replay}`);
        return result;
      }
      if (status.sync_mode === 'manual_backup') {
        console.log(`[pancake_pos] ${trigger} sync skipped: sync mode is manual backup only.`);
        return;
      }
      if (trigger !== 'manual' && trigger !== 'cron' && status.sync_mode !== 'automatic' && process.env.PANCAKE_POS_SYNC_ENABLED !== 'true') {
        console.log(`[pancake_pos] ${trigger} sync skipped: automatic sync mode is not enabled.`);
        return;
      }
      if (!status.has_api_key || !status.shop_id) {
        console.log(`[pancake_pos] ${trigger} sync skipped: missing POS API key or shop ID.`);
        return;
      }

      const result = await pancakePosSync.collectPosData(db, trigger === 'manual'
        ? { resources: ['orders'], replay_stored_orders: false }
        : getPancakePosSyncWindow());
      backupScheduler.schedule();
      const imported = Object.entries(result?.resources || {})
        .map(([resource, details]) => `${resource}=${details.count || 0}`)
        .join(', ');
      const replay = result?.dashboard_replay
        ? `${imported ? ', ' : ''}replayed=${result.dashboard_replay.transferred || 0}/${result.dashboard_replay.scanned || 0}`
        : '';
      console.log(`[pancake_pos] ${trigger} sync completed${imported || replay ? `: ${imported}${replay}` : '.'}`);
    } catch (error) {
      console.error(`[pancake_pos] ${trigger} sync failed: ${error.message}`);
    } finally {
      pancakePosSyncRunning = false;
      pancakePosSyncStartedAt = null;
    }
  }

  function schedulePancakePosSync() {
    setTimeout(async () => {
      await runPancakePosSync('interval');
      schedulePancakePosSync();
    }, PANCAKE_POS_SYNC_INTERVAL_MS);
  }

  // Storage retention: keep ~POS_RETENTION_DAYS (default 30) of POS orders locally
  // so the database can't fill up again; older rows stay in Pancake. Runs shortly
  // after boot and then daily.
  const POS_RETENTION_DAYS = Math.max(1, Number(process.env.POS_RETENTION_DAYS || 30));
  const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
  async function runRetentionCleanup(trigger) {
    try {
      const result = await pancakePosSync.pruneOldData(db, { retentionDays: POS_RETENTION_DAYS });
      console.log(`[retention] ${trigger}: removed pos_orders=${result.deleted_pos_orders}, sync_runs=${result.deleted_sync_runs} (kept last ${result.retention_days}d, cutoff ${result.cutoff_date}).`);
    } catch (error) {
      console.warn(`[retention] ${trigger} cleanup failed: ${error.message}`);
    }
  }
  function scheduleRetentionCleanup() {
    setTimeout(async () => {
      await runRetentionCleanup('interval');
      scheduleRetentionCleanup();
    }, RETENTION_INTERVAL_MS);
  }

  app.locals.db = db;
  app.locals.backupDatabase = () => backupScheduler.uploadBackup({ force: true });
  app.locals.runGoogleSheetsSync = runGoogleSheetsSync;
  app.locals.scheduleGoogleSheetsSync = scheduleGoogleSheetsSync;
  app.locals.runPancakePosSync = runPancakePosSync;
  app.locals.schedulePancakePosSync = schedulePancakePosSync;
  app.locals.runRetentionCleanup = runRetentionCleanup;
  app.locals.scheduleRetentionCleanup = scheduleRetentionCleanup;

  return app;
}

async function getApp() {
  if (appInstance) return appInstance;
  if (!appPromise) {
    appPromise = createApp().then((app) => {
      appInstance = app;
      return app;
    });
  }
  return appPromise;
}

async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
}

if (require.main === module) {
  getApp()
    .then((app) => {
      app.listen(PORT, HOST, () => {
        const lanUrls = getLanUrls(PORT);
        const urlLines = [`Local:   http://localhost:${PORT}`];

        lanUrls.forEach((url) => {
          urlLines.push(`LAN:     ${url}`);
        });

        console.log(`\nYNT Dashboard running\n${urlLines.join('\n')}\n`);
      });

      if (!process.env.VERCEL) {
        // Google Sheets auto-sync is OFF by default — POS API is the data source.
        // Hard env guard so a stored DB setting can't silently re-enable the pull.
        if (process.env.GOOGLE_SHEETS_SYNC_ENABLED === 'true') {
          setTimeout(() => {
            app.locals.runGoogleSheetsSync('startup');
          }, 5 * 1000);

          app.locals.scheduleGoogleSheetsSync();
        } else {
          console.log('[google_sheets] auto-sync disabled (GOOGLE_SHEETS_SYNC_ENABLED!=true) — using POS API only.');
        }

        if (process.env.DISABLE_BACKGROUND_SYNC === 'true') {
          console.log('[pancake_pos] background sync disabled (DISABLE_BACKGROUND_SYNC=true) — manual trigger only.');
        } else {
          setTimeout(() => {
            app.locals.runPancakePosSync('startup');
          }, 10 * 1000);

          app.locals.schedulePancakePosSync();
        }

        // Always purge pos_orders from before 2026 on startup — pre-2026 data is
        // definitively old and can be re-synced from Pancake if ever needed.
        setTimeout(async () => {
          try {
            const r = await pancakePosSync.pruneOldData(app.locals.db, { cutoffDate: '2026-01-01' });
            if (r.deleted_pos_orders > 0) {
              console.log(`[retention] pre-2026 purge: removed ${r.deleted_pos_orders} pos_orders (cutoff 2026-01-01).`);
            }
          } catch (e) {
            console.warn(`[retention] pre-2026 purge failed: ${e.message}`);
          }
        }, 35 * 1000);

        // Rolling retention (30-day window). Requires POS_RETENTION_ENABLED=true —
        // disabled by default so 2026+ history is kept without explicit env config.
        if (process.env.POS_RETENTION_ENABLED === 'true') {
          setTimeout(() => {
            app.locals.runRetentionCleanup('startup');
          }, 60 * 1000);

          app.locals.scheduleRetentionCleanup();
        } else {
          console.log('[retention] rolling retention disabled (POS_RETENTION_ENABLED!=true) — keeping 2026+ history.');
        }
      }

      // Backups are now throttled (see createBackupScheduler), so flush a final
      // backup on shutdown to avoid losing writes since the last interval upload
      // — Railway's filesystem is ephemeral and SIGTERMs are frequent.
      let shuttingDown = false;
      const flushAndExit = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[server] ${signal} received; flushing final database backup.`);
        try {
          await app.locals.backupDatabase();
        } catch (error) {
          console.error(`[server] Shutdown backup failed: ${error.message}`);
        }
        process.exit(0);
      };
      process.on('SIGTERM', () => flushAndExit('SIGTERM'));
      process.on('SIGINT', () => flushAndExit('SIGINT'));
    })
    .catch((error) => {
      console.error(`[server] Failed to start: ${error.stack || error.message}`);
      process.exit(1);
    });
}

module.exports = handler;
module.exports.getApp = getApp;
module.exports.createApp = createApp;
