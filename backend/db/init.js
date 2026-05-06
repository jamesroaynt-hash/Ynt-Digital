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

function runMigrations(db) {
  ensureColumn(db, 'integration_settings', 'user_access_token', 'TEXT');
  ensureColumn(db, 'integration_settings', 'page_id', 'TEXT');
  ensureColumn(db, 'integration_settings', 'page_access_token', 'TEXT');
  ensureColumn(db, 'users', 'birthday', 'TEXT');
  ensureColumn(db, 'users', 'address', 'TEXT');
  ensureColumn(db, 'users', 'phone_number', 'TEXT');
  ensureColumn(db, 'users', 'email_address', 'TEXT');
  ensureColumn(db, 'users', 'fb_account_name', 'TEXT');
  ensureColumn(db, 'orders', 'source_sheet', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_source_sheet ON orders(source_sheet)');
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

function initializeDatabase(db) {
  runSqlFile(db, 'schema.sql');
  runMigrations(db);
  runSqlFile(db, 'seed.sql');
}

module.exports = {
  initializeDatabase,
  runSqlFile,
};
