const fs = require('fs');
const path = require('path');

function runSqlFile(db, filename) {
  const sqlPath = path.join(__dirname, filename);
  const sql = fs.readFileSync(sqlPath, 'utf8');
  db.exec(sql);
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some(column => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

async function ensureColumnAsync(db, tableName, columnName, definition) {
  if (db.type !== 'postgres') {
    ensureColumn(db, tableName, columnName, definition);
    return;
  }

  const column = await db.prepare(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = ? AND column_name = ?
  `).get(tableName, columnName);

  if (column) return;
  await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function runMigrations(db) {
  [
    'pancake_messages',
    'pancake_conversations',
    'pancake_customers',
    'pancake_posts',
    'pancake_tags',
    'pancake_users',
    'pancake_pages',
  ].forEach((tableName) => {
    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
  });
  db.exec("DELETE FROM integration_settings WHERE provider = 'pancake'");
  db.exec("DELETE FROM integration_sync_runs WHERE provider = 'pancake'");
  db.exec("DELETE FROM integration_source_links WHERE provider = 'pancake'");
  db.exec("DELETE FROM integration_raw_records WHERE provider = 'pancake'");
  ensureColumn(db, 'integration_settings', 'user_access_token', 'TEXT');
  ensureColumn(db, 'integration_settings', 'page_id', 'TEXT');
  ensureColumn(db, 'integration_settings', 'page_access_token', 'TEXT');
  ensureColumn(db, 'users', 'birthday', 'TEXT');
  ensureColumn(db, 'users', 'address', 'TEXT');
  ensureColumn(db, 'users', 'phone_number', 'TEXT');
  ensureColumn(db, 'users', 'email_address', 'TEXT');
  ensureColumn(db, 'users', 'fb_account_name', 'TEXT');
  ensureColumn(db, 'users', 'daily_rate', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'orders', 'source_sheet', 'TEXT');
  ensureColumn(db, 'orders', 'tags', 'TEXT');
  ensureColumn(db, 'pos_orders', 'tags_json', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_source_sheet ON orders(source_sheet)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL DEFAULT (date('now')),
      time_in TEXT,
      break_out TEXT,
      break_in TEXT,
      time_out TEXT,
      break_minutes INTEGER NOT NULL DEFAULT 15,
      ot_minutes INTEGER NOT NULL DEFAULT 0,
      holiday_type TEXT NOT NULL DEFAULT 'Regular day',
      holiday_percentage REAL NOT NULL DEFAULT 100,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, work_date)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance_records(user_id, work_date)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cash_advances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      advance_date TEXT NOT NULL DEFAULT (date('now')),
      amount REAL NOT NULL DEFAULT 0,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'deducted', 'void')),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cash_advances_user_date ON cash_advances(user_id, advance_date)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      leave_date_from TEXT NOT NULL,
      leave_date_to TEXT NOT NULL,
      leave_type TEXT NOT NULL DEFAULT 'Personal',
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_leave_requests_user_date ON leave_requests(user_id, leave_date_from)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pos_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_key TEXT NOT NULL UNIQUE,
      shop_id TEXT,
      external_id TEXT,
      name TEXT,
      username TEXT,
      email TEXT,
      phone_number TEXT,
      role_name TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      raw_payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pos_users_shop ON pos_users(shop_id, name)');
}

async function runPostgresMigrations(db) {
  for (const tableName of [
    'pancake_messages',
    'pancake_conversations',
    'pancake_customers',
    'pancake_posts',
    'pancake_tags',
    'pancake_users',
    'pancake_pages',
  ]) {
    await db.exec(`DROP TABLE IF EXISTS ${tableName}`);
  }
  await db.exec("DELETE FROM integration_settings WHERE provider = 'pancake'");
  await db.exec("DELETE FROM integration_sync_runs WHERE provider = 'pancake'");
  await db.exec("DELETE FROM integration_source_links WHERE provider = 'pancake'");
  await db.exec("DELETE FROM integration_raw_records WHERE provider = 'pancake'");
  await ensureColumnAsync(db, 'integration_settings', 'user_access_token', 'TEXT');
  await ensureColumnAsync(db, 'integration_settings', 'page_id', 'TEXT');
  await ensureColumnAsync(db, 'integration_settings', 'page_access_token', 'TEXT');
  await ensureColumnAsync(db, 'users', 'birthday', 'TEXT');
  await ensureColumnAsync(db, 'users', 'address', 'TEXT');
  await ensureColumnAsync(db, 'users', 'phone_number', 'TEXT');
  await ensureColumnAsync(db, 'users', 'email_address', 'TEXT');
  await ensureColumnAsync(db, 'users', 'fb_account_name', 'TEXT');
  await ensureColumnAsync(db, 'users', 'daily_rate', 'REAL NOT NULL DEFAULT 0');
  await ensureColumnAsync(db, 'orders', 'source_sheet', 'TEXT');
  await ensureColumnAsync(db, 'orders', 'tags', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'tags_json', 'TEXT');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_orders_source_sheet ON orders(source_sheet)');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL DEFAULT (CURRENT_DATE::text),
      time_in TEXT,
      break_out TEXT,
      break_in TEXT,
      time_out TEXT,
      break_minutes INTEGER NOT NULL DEFAULT 15,
      ot_minutes INTEGER NOT NULL DEFAULT 0,
      holiday_type TEXT NOT NULL DEFAULT 'Regular day',
      holiday_percentage REAL NOT NULL DEFAULT 100,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, work_date)
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance_records(user_id, work_date)');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS cash_advances (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      advance_date TEXT NOT NULL DEFAULT (CURRENT_DATE::text),
      amount REAL NOT NULL DEFAULT 0,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'deducted', 'void')),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_cash_advances_user_date ON cash_advances(user_id, advance_date)');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      leave_date_from TEXT NOT NULL,
      leave_date_to TEXT NOT NULL,
      leave_type TEXT NOT NULL DEFAULT 'Personal',
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_leave_requests_user_date ON leave_requests(user_id, leave_date_from)');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pos_users (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      external_key TEXT NOT NULL UNIQUE,
      shop_id TEXT,
      external_id TEXT,
      name TEXT,
      username TEXT,
      email TEXT,
      phone_number TEXT,
      role_name TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      raw_payload TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_pos_users_shop ON pos_users(shop_id, name)');
}

function initializeDatabase(db) {
  runSqlFile(db, 'schema.sql');
  runMigrations(db);
  runSqlFile(db, 'seed.sql');
}

async function initializeDatabaseAsync(db) {
  if (db.type !== 'postgres') {
    initializeDatabase(db);
    return;
  }

  await runSqlFileAsync(db, 'schema.pg.sql');
  await runPostgresMigrations(db);
  await runSqlFileAsync(db, 'seed.pg.sql');
}

async function runSqlFileAsync(db, filename) {
  const sqlPath = path.join(__dirname, filename);
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await db.exec(sql);
}

module.exports = {
  initializeDatabase,
  initializeDatabaseAsync,
  runSqlFile,
  runSqlFileAsync,
};
