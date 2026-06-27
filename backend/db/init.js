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

function migrateGoogleOrdersProvinceCity(db) {
  const columns = db.prepare('PRAGMA table_info(google_orders)').all();
  const hasProvinceCity = columns.some((c) => c.name === 'province_city');
  const hasProvince = columns.some((c) => c.name === 'province');
  if (hasProvinceCity) return;
  if (hasProvince) {
    db.exec('ALTER TABLE google_orders RENAME COLUMN province TO province_city');
    return;
  }
  db.exec('ALTER TABLE google_orders ADD COLUMN province_city TEXT');
}

async function migrateGoogleOrdersProvinceCityAsync(db) {
  if (db.type !== 'postgres') {
    migrateGoogleOrdersProvinceCity(db);
    return;
  }
  const columnExists = async (name) => {
    const row = await db.prepare(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'google_orders' AND column_name = ?
    `).get(name);
    return Boolean(row);
  };
  if (await columnExists('province_city')) return;
  if (await columnExists('province')) {
    await db.exec('ALTER TABLE google_orders RENAME COLUMN province TO province_city');
    return;
  }
  await db.exec('ALTER TABLE google_orders ADD COLUMN province_city TEXT');
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

function getSqliteIndexColumns(db, indexName) {
  return db.prepare(`PRAGMA index_info(${indexName})`).all().map((column) => column.name);
}

function migratePosOrdersCompositeIdentity(db) {
  const indexes = db.prepare('PRAGMA index_list(pos_orders)').all();
  const hasExternalOnlyUnique = indexes.some((index) => {
    if (!Number(index.unique || 0)) return false;
    const columns = getSqliteIndexColumns(db, index.name);
    return columns.length === 1 && columns[0] === 'external_id';
  });

  if (!hasExternalOnlyUnique) {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_orders_shop_external ON pos_orders(shop_id, external_id)');
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('ALTER TABLE pos_orders RENAME TO _pos_orders_external_unique_tmp');
  db.exec(`
    CREATE TABLE pos_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL,
      shop_id TEXT,
      inserted_at_remote TEXT,
      updated_at_remote TEXT,
      status INTEGER,
      status_name TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      page_id TEXT,
      shipping_fee REAL,
      cod REAL,
      cash REAL,
      total_discount REAL,
      note TEXT,
      attempts INTEGER,
      tracking_no TEXT,
      note_product TEXT,
      sprinter_name TEXT,
      sprinter_tel TEXT,
      page_name TEXT,
      assigned_user_id TEXT,
      assigning_seller_name TEXT,
      assigned_to_user_id INTEGER,
      assigned_to_name TEXT,
      items_json TEXT,
      tags_json TEXT,
      partner_json TEXT,
      shipping_address_json TEXT,
      raw_payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    INSERT INTO pos_orders (
      id, external_id, shop_id, inserted_at_remote, updated_at_remote, status, status_name,
      customer_name, customer_phone, customer_email, page_id, shipping_fee, cod, cash,
      total_discount, note, attempts, tracking_no, note_product, sprinter_name, sprinter_tel,
      page_name, assigned_user_id, assigning_seller_name, assigned_to_user_id, assigned_to_name,
      items_json, tags_json, partner_json, shipping_address_json, raw_payload, created_at, updated_at
    )
    SELECT
      id, external_id, COALESCE(shop_id, 'unknown'), inserted_at_remote, updated_at_remote, status, status_name,
      customer_name, customer_phone, customer_email, page_id, shipping_fee, cod, cash,
      total_discount, note, attempts, tracking_no, note_product, sprinter_name, sprinter_tel,
      page_name, assigned_user_id, assigning_seller_name, assigned_to_user_id, assigned_to_name,
      items_json, tags_json, partner_json, shipping_address_json, raw_payload, created_at, updated_at
    FROM _pos_orders_external_unique_tmp
  `);
  db.exec('DROP TABLE _pos_orders_external_unique_tmp');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pos_orders_shop ON pos_orders(shop_id, updated_at_remote DESC)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_orders_shop_external ON pos_orders(shop_id, external_id)');
  db.exec('PRAGMA foreign_keys = ON');
}

async function migratePosOrdersCompositeIdentityAsync(db) {
  if (db.type !== 'postgres') {
    migratePosOrdersCompositeIdentity(db);
    return;
  }
  await db.exec("UPDATE pos_orders SET shop_id = 'unknown' WHERE shop_id IS NULL OR shop_id = ''");
  await db.exec('ALTER TABLE pos_orders DROP CONSTRAINT IF EXISTS pos_orders_external_id_key');
  await db.exec('DROP INDEX IF EXISTS pos_orders_external_id_key');
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_orders_shop_external ON pos_orders(shop_id, external_id)');
}

function migrateIntegrationSettingsMultiRow(db) {
  const columns = db.prepare('PRAGMA table_info(integration_settings)').all();
  if (columns.some((c) => c.name === 'connection_id')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('ALTER TABLE integration_settings RENAME TO _integration_settings_mrow_tmp');
  db.exec(`
    CREATE TABLE integration_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL DEFAULT '',
      name TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      base_url TEXT,
      api_key TEXT,
      user_access_token TEXT,
      page_id TEXT,
      page_access_token TEXT,
      webhook_secret TEXT,
      sync_mode TEXT NOT NULL DEFAULT 'push_only',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, connection_id)
    )
  `);
  db.exec(`
    INSERT INTO integration_settings (
      id, provider, connection_id, name, enabled, base_url, api_key, user_access_token,
      page_id, page_access_token, webhook_secret, sync_mode, notes, created_at, updated_at
    )
    SELECT id, provider, '', NULL, enabled, base_url, api_key, user_access_token,
      page_id, page_access_token, webhook_secret, sync_mode, notes, created_at, updated_at
    FROM _integration_settings_mrow_tmp
  `);
  db.exec('DROP TABLE _integration_settings_mrow_tmp');
  db.exec('PRAGMA foreign_keys = ON');

  // Unpack pancake_pos connections from JSON into individual rows
  const posSetting = db.prepare(
    "SELECT user_access_token FROM integration_settings WHERE provider = 'pancake_pos' AND connection_id = ''"
  ).get();
  if (posSetting?.user_access_token) {
    let conns;
    try { conns = JSON.parse(posSetting.user_access_token); } catch { conns = null; }
    if (Array.isArray(conns)) {
      const insertConn = db.prepare(`
        INSERT OR IGNORE INTO integration_settings
          (provider, connection_id, name, enabled, base_url, api_key, page_id, page_access_token, user_access_token, sync_mode, notes)
        VALUES ('pancake_pos', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const conn of conns) {
        const connId = String(conn.id || '').trim();
        if (!connId || !conn.api_key || !conn.shop_id) continue;
        insertConn.run(
          connId,
          String(conn.name || `POS ${conn.shop_id}`),
          conn.enabled === false ? 0 : 1,
          String(conn.base_url || 'https://pos.pages.fm/api/v1'),
          String(conn.api_key),
          String(conn.shop_id),
          conn.page_access_token || null,
          conn.messaging_page_id || null,
          String(conn.sync_mode || 'pull_only'),
          conn.notes || null
        );
      }
    }
  }
}

function ensureOrderStatusConstraint(db) {
  if (db.type === 'postgres') return;
  const allowed = "'New','Confirmed','Waiting for pickup','Shipped','Delivered','Returning','Returned','Canceled','Pending'";
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('ALTER TABLE orders RENAME TO orders_old_status_migration');
  db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_ref TEXT NOT NULL UNIQUE,
      tracking_no TEXT,
      customer TEXT NOT NULL,
      phone TEXT,
      product TEXT NOT NULL,
      tags TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      cod_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Confirmed' CHECK(status IN (${allowed})),
      courier TEXT,
      source_sheet TEXT,
      confirmed_by TEXT,
      attempts INTEGER DEFAULT 1,
      order_date TEXT NOT NULL DEFAULT (date('now')),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    INSERT INTO orders (
      id, order_ref, tracking_no, customer, phone, product, tags, qty, cod_amount, status, courier,
      source_sheet, confirmed_by, attempts, order_date, created_by, created_at, updated_at
    )
    SELECT id, order_ref, tracking_no, customer, phone, product, tags, qty, cod_amount, status, courier,
      source_sheet, confirmed_by, attempts, order_date, created_by, created_at, updated_at
    FROM orders_old_status_migration
  `);
  db.exec('DROP TABLE orders_old_status_migration');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_source_sheet ON orders(source_sheet)');
  db.exec('PRAGMA foreign_keys = ON');
}

async function migrateIntegrationSettingsMultiRowAsync(db) {
  await ensureColumnAsync(db, 'integration_settings', 'connection_id', "TEXT NOT NULL DEFAULT ''");
  await ensureColumnAsync(db, 'integration_settings', 'name', 'TEXT');

  // Update unique constraint from (provider) to (provider, connection_id)
  try {
    const existing = await db.prepare(`
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'integration_settings'
        AND constraint_type = 'UNIQUE'
        AND constraint_name = 'integration_settings_provider_connection_id_key'
    `).get();
    if (!existing) {
      await db.exec('ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_provider_key');
      await db.exec('ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_provider_connection_id_key UNIQUE (provider, connection_id)');
    }
  } catch { /* Supabase migration handles this */ }
}

async function ensureOrderStatusConstraintAsync(db) {
  if (db.type !== 'postgres') {
    ensureOrderStatusConstraint(db);
    return;
  }

  await db.exec('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check');
  await db.exec("ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'Confirmed'");
  await db.exec(`
    ALTER TABLE orders
    ADD CONSTRAINT orders_status_check
    CHECK(status IN ('New', 'Confirmed', 'Waiting for pickup', 'Shipped', 'Delivered', 'Returning', 'Returned', 'Canceled', 'Pending'))
  `);
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
  ensureColumn(db, 'integration_settings', 'user_access_token', 'TEXT');
  ensureColumn(db, 'integration_settings', 'page_id', 'TEXT');
  ensureColumn(db, 'integration_settings', 'page_access_token', 'TEXT');
  ensureColumn(db, 'integration_settings', 'owner', 'TEXT');
  ensureColumn(db, 'integration_settings', 'botcake_token', 'TEXT');
  ensureColumn(db, 'users', 'birthday', 'TEXT');
  ensureColumn(db, 'users', 'address', 'TEXT');
  ensureColumn(db, 'users', 'phone_number', 'TEXT');
  ensureColumn(db, 'users', 'email_address', 'TEXT');
  ensureColumn(db, 'users', 'fb_account_name', 'TEXT');
  ensureColumn(db, 'users', 'daily_rate', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'orders', 'source_sheet', 'TEXT');
  ensureColumn(db, 'orders', 'tags', 'TEXT');
  ensureColumn(db, 'orders', 'confirmed_by', 'TEXT');
  ensureColumn(db, 'inventory', 'active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'expenses', 'classification', "TEXT NOT NULL DEFAULT 'OPEX'");
  ensureColumn(db, 'attendance_records', 'break2_out', 'TEXT');
  ensureColumn(db, 'attendance_records', 'break2_in', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_ref TEXT NOT NULL UNIQUE,
      credit_date TEXT NOT NULL DEFAULT (date('now')),
      amount REAL NOT NULL DEFAULT 0,
      source TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_expense_credits_date ON expense_credits(credit_date)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS overtime_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL,
      requested_minutes INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, work_date)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_overtime_user_date ON overtime_requests(user_id, work_date)');
  ensureColumn(db, 'pos_orders', 'tags_json', 'TEXT');
  ensureColumn(db, 'pos_orders', 'attempts', 'INTEGER');
  ensureColumn(db, 'pos_orders', 'tracking_no', 'TEXT');
  ensureColumn(db, 'pos_orders', 'note_product', 'TEXT');
  ensureColumn(db, 'pos_orders', 'sprinter_name', 'TEXT');
  ensureColumn(db, 'pos_orders', 'sprinter_tel', 'TEXT');
  ensureColumn(db, 'pos_orders', 'assigned_user_id', 'TEXT');
  ensureColumn(db, 'pos_orders', 'page_name', 'TEXT');
  ensureColumn(db, 'pos_orders', 'assigning_seller_name', 'TEXT');
  ensureColumn(db, 'pos_orders', 'assigned_to_user_id', 'INTEGER');
  ensureColumn(db, 'pos_orders', 'assigned_to_name', 'TEXT');
  ensureColumn(db, 'pos_orders', 'partner_reason', 'TEXT');
  ensureColumn(db, 'pos_orders', 'ad_id', 'TEXT');
  ensureColumn(db, 'pos_orders', 'ads_source', 'TEXT');
  migratePosOrdersCompositeIdentity(db);
  migrateIntegrationSettingsMultiRow(db);
  ensureOrderStatusConstraint(db);
  db.exec("UPDATE orders SET status = 'Confirmed' WHERE status = 'Pending'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_source_sheet ON orders(source_sheet)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL DEFAULT (date('now')),
      time_in TEXT,
      break_out TEXT,
      break_in TEXT,
      break2_out TEXT,
      break2_in TEXT,
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
    CREATE TABLE IF NOT EXISTS user_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      schedule_date TEXT NOT NULL,
      shift_start TEXT,
      shift_end TEXT,
      notes TEXT,
      is_holiday INTEGER NOT NULL DEFAULT 0,
      holiday_type TEXT NOT NULL DEFAULT 'Regular day',
      holiday_percentage INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_user_schedules_user_date ON user_schedules(user_id, schedule_date DESC)');
  ensureColumn(db, 'user_schedules', 'is_holiday', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'user_schedules', 'holiday_type', "TEXT NOT NULL DEFAULT 'Regular day'");
  ensureColumn(db, 'user_schedules', 'holiday_percentage', 'INTEGER NOT NULL DEFAULT 0');
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      tracking_no TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      product_name TEXT,
      quantity INTEGER,
      cod REAL,
      status TEXT,
      status_normalized TEXT,
      courier TEXT,
      day_created TEXT,
      chat_page TEXT,
      confirmed_by TEXT,
      delivery_attempts INTEGER,
      tag TEXT,
      pancake_tags TEXT,
      spreadsheet_id TEXT,
      source_sheet TEXT,
      sheet_row_number INTEGER,
      raw_row TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  ensureColumn(db, 'google_orders', 'external_id', 'TEXT');
  ensureColumn(db, 'google_orders', 'internal_notes', 'TEXT');
  ensureColumn(db, 'google_orders', 'address', 'TEXT');
  ensureColumn(db, 'google_orders', 'shipping_info', 'TEXT');
  ensureColumn(db, 'google_orders', 'ad_id', 'TEXT');
  migrateGoogleOrdersProvinceCity(db);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_google_orders_external_unique ON google_orders(external_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_google_orders_tracking ON google_orders(tracking_no)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_google_orders_sheet_day ON google_orders(source_sheet, day_created DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_google_orders_day_id ON google_orders(day_created DESC, id DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_google_orders_updated ON google_orders(updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_google_orders_status ON google_orders(status_normalized)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL DEFAULT '["orders:read"]',
      created_by INTEGER REFERENCES users(id),
      last_used_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      posted_by INTEGER REFERENCES users(id),
      posted_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, posted_at DESC)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      secret TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id INTEGER NOT NULL REFERENCES webhook_subscriptions(id),
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      response_status INTEGER,
      response_body TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub ON webhook_deliveries(subscription_id, created_at DESC)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS csr_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_ref TEXT NOT NULL UNIQUE,
      record_date TEXT NOT NULL DEFAULT (date('now')),
      csr_name TEXT,
      page_name TEXT,
      order_id TEXT,
      customer_name TEXT,
      cellphone_number TEXT,
      sales_type TEXT,
      status TEXT,
      price REAL NOT NULL DEFAULT 0,
      tracking_number TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_csr_records_created_by ON csr_records(created_by, record_date DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_csr_records_date ON csr_records(record_date DESC, id DESC)');
  // Append-only per-customer notes (keyed by normalized phone). Independent of
  // pos_orders so the history survives the 30-day order retention.
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_phone TEXT NOT NULL,
      note TEXT NOT NULL,
      author_id INTEGER REFERENCES users(id),
      author_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_customer_notes_phone ON customer_notes(customer_phone, id DESC)');
  // Page → SKU routing for RTS Return: a page's RTS pcs flow to the Product with this SKU.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rts_page_sku (
      page_name TEXT PRIMARY KEY,
      sku TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Assigned-staff alias merge: rows whose assigning_seller_name = alias are
  // reported under `canonical` (combined) in the Data Report By Assigned Staff card.
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_merge_map (
      alias TEXT PRIMARY KEY,
      canonical TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Permanent per-order pickup log: one row the first time an order is tagged
  // "Picked up" (any tag containing "picked up"), stamped with the Manila day.
  // Independent of pos_orders so the Daily Pickup → Pickup Status counts survive
  // later tag/status changes and the 30-day pos_orders retention. pcs is derived
  // from note_product at read time (leading-digit parse, same rule as RTS Scan).
  db.exec(`
    CREATE TABLE IF NOT EXISTS pickup_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id TEXT,
      external_id TEXT NOT NULL,
      page_name TEXT,
      note_product TEXT,
      pickup_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pickup_log_order ON pickup_log(shop_id, external_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pickup_log_date ON pickup_log(pickup_date)');
  // Idempotent backfill: seed any orders currently carrying a "Picked up" tag so
  // history isn't empty on first deploy. ON CONFLICT keeps it a no-op after.
  db.exec(`
    INSERT INTO pickup_log (shop_id, external_id, page_name, note_product, pickup_date)
    SELECT shop_id, external_id, page_name, note_product, date(updated_at_remote, '+8 hours')
    FROM pos_orders
    WHERE LOWER(COALESCE(tags_json,'')) LIKE '%picked up%' AND updated_at_remote IS NOT NULL
    ON CONFLICT(shop_id, external_id) DO NOTHING
  `);
  ensurePerformanceIndexes(db);
}

function ensurePerformanceIndexes(db) {
  // Composite index that lets the orders→pos_orders join resolve without CAST.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_isl_orders_lookup
    ON integration_source_links(local_table, entity_type, provider, local_id)`);
  // Direct tracking lookups and case-insensitive scan lookups.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_tracking_no
    ON orders(tracking_no) WHERE tracking_no IS NOT NULL`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_tracking_lower ON orders(LOWER(tracking_no))');
  db.exec('CREATE INDEX IF NOT EXISTS idx_scans_tracking_lower ON scan_records(LOWER(tracking_no))');
  // Cover the common ORDER BY / status-filter access paths on orders.
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_date_id ON orders(order_date DESC, id DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status_date ON orders(status, order_date DESC)');
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
  await ensureColumnAsync(db, 'integration_settings', 'user_access_token', 'TEXT');
  await ensureColumnAsync(db, 'integration_settings', 'page_id', 'TEXT');
  await ensureColumnAsync(db, 'integration_settings', 'page_access_token', 'TEXT');
  await ensureColumnAsync(db, 'integration_settings', 'owner', 'TEXT');
  await ensureColumnAsync(db, 'integration_settings', 'botcake_token', 'TEXT');
  await ensureColumnAsync(db, 'users', 'birthday', 'TEXT');
  await ensureColumnAsync(db, 'users', 'address', 'TEXT');
  await ensureColumnAsync(db, 'users', 'phone_number', 'TEXT');
  await ensureColumnAsync(db, 'users', 'email_address', 'TEXT');
  await ensureColumnAsync(db, 'users', 'fb_account_name', 'TEXT');
  await ensureColumnAsync(db, 'users', 'daily_rate', 'REAL NOT NULL DEFAULT 0');
  await ensureColumnAsync(db, 'orders', 'source_sheet', 'TEXT');
  await ensureColumnAsync(db, 'orders', 'tags', 'TEXT');
  await ensureColumnAsync(db, 'orders', 'confirmed_by', 'TEXT');
  await ensureColumnAsync(db, 'inventory', 'active', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumnAsync(db, 'expenses', 'classification', "TEXT NOT NULL DEFAULT 'OPEX'");
  await ensureColumnAsync(db, 'attendance_records', 'break2_out', 'TEXT');
  await ensureColumnAsync(db, 'attendance_records', 'break2_in', 'TEXT');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS expense_credits (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      credit_ref TEXT NOT NULL UNIQUE,
      credit_date TEXT NOT NULL DEFAULT (CURRENT_DATE::text),
      amount REAL NOT NULL DEFAULT 0,
      source TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_expense_credits_date ON expense_credits(credit_date)');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS overtime_requests (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL,
      requested_minutes INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, work_date)
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_overtime_user_date ON overtime_requests(user_id, work_date)');
  await ensureColumnAsync(db, 'pos_orders', 'tags_json', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'attempts', 'INTEGER');
  await ensureColumnAsync(db, 'pos_orders', 'tracking_no', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'note_product', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'sprinter_name', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'sprinter_tel', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'assigned_user_id', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'page_name', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'assigning_seller_name', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'assigned_to_user_id', 'INTEGER');
  await ensureColumnAsync(db, 'pos_orders', 'assigned_to_name', 'TEXT');
  // Botcake messaging: recipient PSID + page id derived from the order payload.
  await ensureColumnAsync(db, 'pos_orders', 'psid', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'botcake_page_id', 'TEXT');
  // Courier/partner status + latest courier tracking note (for RMO metrics + display).
  await ensureColumnAsync(db, 'pos_orders', 'partner_status', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'courier_note', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'partner_reason', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'ad_id', 'TEXT');
  await ensureColumnAsync(db, 'pos_orders', 'ads_source', 'TEXT');
  await migratePosOrdersCompositeIdentityAsync(db);
  await migrateIntegrationSettingsMultiRowAsync(db);
  await ensureOrderStatusConstraintAsync(db);
  await db.exec("UPDATE orders SET status = 'Confirmed' WHERE status = 'Pending'");
  await db.exec('CREATE INDEX IF NOT EXISTS idx_orders_source_sheet ON orders(source_sheet)');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL DEFAULT (CURRENT_DATE::text),
      time_in TEXT,
      break_out TEXT,
      break_in TEXT,
      break2_out TEXT,
      break2_in TEXT,
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
    CREATE TABLE IF NOT EXISTS user_schedules (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      schedule_date TEXT NOT NULL,
      shift_start TEXT,
      shift_end TEXT,
      notes TEXT,
      is_holiday INTEGER NOT NULL DEFAULT 0,
      holiday_type TEXT NOT NULL DEFAULT 'Regular day',
      holiday_percentage INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_user_schedules_user_date ON user_schedules(user_id, schedule_date DESC)');
  await ensureColumnAsync(db, 'user_schedules', 'is_holiday', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumnAsync(db, 'user_schedules', 'holiday_type', "TEXT NOT NULL DEFAULT 'Regular day'");
  await ensureColumnAsync(db, 'user_schedules', 'holiday_percentage', 'INTEGER NOT NULL DEFAULT 0');
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
  await db.exec(`
    CREATE TABLE IF NOT EXISTS google_orders (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      tracking_no TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      product_name TEXT,
      quantity INTEGER,
      cod REAL,
      status TEXT,
      status_normalized TEXT,
      courier TEXT,
      day_created TEXT,
      chat_page TEXT,
      confirmed_by TEXT,
      delivery_attempts INTEGER,
      tag TEXT,
      pancake_tags TEXT,
      spreadsheet_id TEXT,
      source_sheet TEXT,
      sheet_row_number INTEGER,
      raw_row TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumnAsync(db, 'google_orders', 'external_id', 'TEXT');
  await ensureColumnAsync(db, 'google_orders', 'internal_notes', 'TEXT');
  await ensureColumnAsync(db, 'google_orders', 'address', 'TEXT');
  await ensureColumnAsync(db, 'google_orders', 'shipping_info', 'TEXT');
  await ensureColumnAsync(db, 'google_orders', 'ad_id', 'TEXT');
  await migrateGoogleOrdersProvinceCityAsync(db);
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_google_orders_external_unique ON google_orders(external_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_google_orders_tracking ON google_orders(tracking_no)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_google_orders_sheet_day ON google_orders(source_sheet, day_created DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_google_orders_day_id ON google_orders(day_created DESC, id DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_google_orders_updated ON google_orders(updated_at)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_google_orders_status ON google_orders(status_normalized)');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL DEFAULT '["orders:read"]',
      created_by INTEGER REFERENCES users(id),
      last_used_at TIMESTAMPTZ,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      posted_by INTEGER REFERENCES users(id),
      posted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, posted_at DESC)');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      secret TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      subscription_id INTEGER NOT NULL REFERENCES webhook_subscriptions(id),
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      response_status INTEGER,
      response_body TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub ON webhook_deliveries(subscription_id, created_at DESC)');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS csr_records (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      record_ref TEXT NOT NULL UNIQUE,
      record_date TEXT NOT NULL DEFAULT (CURRENT_DATE::text),
      csr_name TEXT,
      page_name TEXT,
      order_id TEXT,
      customer_name TEXT,
      cellphone_number TEXT,
      sales_type TEXT,
      status TEXT,
      price REAL NOT NULL DEFAULT 0,
      tracking_number TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_csr_records_created_by ON csr_records(created_by, record_date DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_csr_records_date ON csr_records(record_date DESC, id DESC)');
  // Append-only per-customer notes (keyed by normalized phone). Independent of
  // pos_orders so the history survives the 30-day order retention.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS customer_notes (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      customer_phone TEXT NOT NULL,
      note TEXT NOT NULL,
      author_id INTEGER REFERENCES users(id),
      author_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_customer_notes_phone ON customer_notes(customer_phone, id DESC)');
  // Page → SKU routing for RTS Return: a page's RTS pcs flow to the Product with this SKU.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS rts_page_sku (
      page_name TEXT PRIMARY KEY,
      sku TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Assigned-staff alias merge: rows whose assigning_seller_name = alias are
  // reported under `canonical` (combined) in the Data Report By Assigned Staff card.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS staff_merge_map (
      alias TEXT PRIMARY KEY,
      canonical TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Permanent per-order pickup log — see runMigrations() for rationale. One row
  // the first time an order is tagged "Picked up" (any tag containing "picked up").
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pickup_log (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      shop_id TEXT,
      external_id TEXT NOT NULL,
      page_name TEXT,
      note_product TEXT,
      pickup_date TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pickup_log_order ON pickup_log(shop_id, external_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_pickup_log_date ON pickup_log(pickup_date)');
  await db.exec(`
    INSERT INTO pickup_log (shop_id, external_id, page_name, note_product, pickup_date)
    SELECT shop_id, external_id, page_name, note_product,
           to_char(updated_at_remote::timestamp + interval '8 hours', 'YYYY-MM-DD')
    FROM pos_orders
    WHERE LOWER(COALESCE(tags_json,'')) LIKE '%picked up%' AND updated_at_remote IS NOT NULL
    ON CONFLICT(shop_id, external_id) DO NOTHING
  `);
  await ensurePerformanceIndexesAsync(db);
}

async function ensurePerformanceIndexesAsync(db) {
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_isl_orders_lookup
    ON integration_source_links(local_table, entity_type, provider, local_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_tracking_no
    ON orders(tracking_no) WHERE tracking_no IS NOT NULL`);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_orders_tracking_lower ON orders(LOWER(tracking_no))');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_scans_tracking_lower ON scan_records(LOWER(tracking_no))');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_orders_date_id ON orders(order_date DESC, id DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status_date ON orders(status, order_date DESC)');
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
