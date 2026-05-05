const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('./db/client');
const { initializeDatabase } = require('./db/init');
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

const app = express();
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

function isAllowedOrigin(origin) {
  if (!origin) return true;

  try {
    const { hostname } = new URL(origin);
    if (isPrivateLanHost(hostname)) return true;
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

// ─── DATABASE SETUP ────────────────────────────────────────
const db = new Database(path.join(__dirname, 'db/ynt.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema and seed data from SQL files.
initializeDatabase(db);

// ─── MIDDLEWARE ────────────────────────────────────────────
app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Auth middleware
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

// ─── ROUTES ────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth')(db, jwt, bcrypt, JWT_SECRET));
app.use('/api/orders',    authMiddleware, require('./routes/orders')(db));
app.use('/api/inventory', authMiddleware, require('./routes/inventory')(db));
app.use('/api/expenses',  authMiddleware, require('./routes/expenses')(db));
app.use('/api/pickups',   authMiddleware, require('./routes/pickups')(db));
app.use('/api/scans',     authMiddleware, require('./routes/scans')(db));
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

// ─── FALLBACK SPA ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── START ─────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  const lanUrls = getLanUrls(PORT);
  const urlLines = [`Local:   http://localhost:${PORT}`];

  lanUrls.forEach((url) => {
    urlLines.push(`LAN:     ${url}`);
  });

  console.log(`\nYNT Dashboard running\n${urlLines.join('\n')}\n`);
});

async function runGoogleSheetsSync(trigger) {
  try {
    const result = await googleSheetsSync.runScheduledSync(db);
    if (!result?.skipped) {
      console.log(`[google_sheets] ${trigger} sync completed: imported=${result.imported || 0}, updated=${result.updated || 0}`);
    }
  } catch (error) {
    console.error(`[google_sheets] ${trigger} sync failed: ${error.message}`);
  }
}

setTimeout(() => {
  runGoogleSheetsSync('startup');
}, 5 * 1000);

function scheduleGoogleSheetsSync() {
  const delay = googleSheetsSync.getSyncIntervalMs(db);
  setTimeout(async () => {
    await runGoogleSheetsSync('interval');
    scheduleGoogleSheetsSync();
  }, delay);
}

scheduleGoogleSheetsSync();

module.exports = app;
