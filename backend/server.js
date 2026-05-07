const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createDatabaseClient } = require('./db/client');
const { initializeDatabaseAsync } = require('./db/init');
const {
  restoreDatabaseFromBlob,
  createBackupScheduler,
} = require('./db/blobPersistence');
const googleSheetsSync = require('./services/googleSheetsSync');

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

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET is not set. Using a temporary secret for this server session.');
}

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
    || /\.vercel\.app$/i.test(hostname);
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
    || req.originalUrl.includes('/google-sheets/cron');

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
  await db.pragma('journal_mode = WAL');
  await db.pragma('foreign_keys = ON');

  await initializeDatabaseAsync(db);

  const backupScheduler = createBackupScheduler(db, dbPath);

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
  attachDatabaseBackupMiddleware(app, backupScheduler);
  const staticCacheHeaders = {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    },
  };
  app.use('/Images', express.static(path.join(__dirname, '../Images'), staticCacheHeaders));
  app.use(express.static(path.join(__dirname, '../frontend'), staticCacheHeaders));

  function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  app.use('/api/auth', require('./routes/auth')(db, jwt, bcrypt, JWT_SECRET));
  app.use('/api/orders', authMiddleware, require('./routes/orders')(db));
  app.use('/api/inventory', authMiddleware, require('./routes/inventory')(db));
  app.use('/api/expenses', authMiddleware, require('./routes/expenses')(db));
  app.use('/api/pickups', authMiddleware, require('./routes/pickups')(db));
  app.use('/api/scans', authMiddleware, require('./routes/scans')(db));
  const integrationsRouter = require('./routes/integrations')(db);
  app.use('/api/integrations', authMiddleware, integrationsRouter);
  app.use('/api/public/integrations', integrationsRouter.publicRouter);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.originalUrl}` });
  });

  app.use((error, req, res, next) => {
    console.error(`[server] ${req.method} ${req.originalUrl}: ${error.stack || error.message}`);
    if (req.originalUrl.startsWith('/api')) {
      res.status(500).json({ error: error.message || 'Internal server error' });
      return;
    }
    next(error);
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
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

  app.locals.db = db;
  app.locals.backupDatabase = () => backupScheduler.uploadBackup();
  app.locals.runGoogleSheetsSync = runGoogleSheetsSync;
  app.locals.scheduleGoogleSheetsSync = scheduleGoogleSheetsSync;

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
        setTimeout(() => {
          app.locals.runGoogleSheetsSync('startup');
        }, 5 * 1000);

        app.locals.scheduleGoogleSheetsSync();
      }
    })
    .catch((error) => {
      console.error(`[server] Failed to start: ${error.stack || error.message}`);
      process.exit(1);
    });
}

module.exports = handler;
module.exports.getApp = getApp;
module.exports.createApp = createApp;
