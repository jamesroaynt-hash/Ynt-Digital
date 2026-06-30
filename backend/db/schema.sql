BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Trainee',
  birthday TEXT,
  address TEXT,
  phone_number TEXT,
  email_address TEXT,
  fb_account_name TEXT,
  daily_rate REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
);

CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance_records(user_id, work_date);

CREATE TABLE IF NOT EXISTS cash_advances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  advance_date TEXT NOT NULL DEFAULT (date('now')),
  amount REAL NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'deducted', 'void')),
  paid INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cash_advances_user_date ON cash_advances(user_id, advance_date);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  leave_date_from TEXT NOT NULL,
  leave_date_to TEXT NOT NULL,
  leave_type TEXT NOT NULL DEFAULT 'Personal',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_user_date ON leave_requests(user_id, leave_date_from);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_ref TEXT NOT NULL UNIQUE,
  tracking_no TEXT,
  customer TEXT NOT NULL,
  phone TEXT,
  product TEXT NOT NULL,
  tags TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  cod_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Confirmed'
    CHECK(status IN ('New', 'Confirmed', 'Waiting for pickup', 'Shipped', 'Delivered', 'Returning', 'Returned', 'Canceled', 'Pending')),
  courier TEXT,
  source_sheet TEXT,
  confirmed_by TEXT,
  attempts INTEGER DEFAULT 1,
  order_date TEXT NOT NULL DEFAULT (date('now')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sku TEXT UNIQUE,
  type TEXT NOT NULL DEFAULT 'Product'
    CHECK(type IN ('Product', 'Supply')),
  unit TEXT NOT NULL DEFAULT 'pcs',
  stock INTEGER NOT NULL DEFAULT 0,
  reorder_pt INTEGER NOT NULL DEFAULT 200,
  cost_price REAL DEFAULT 0,
  sell_price REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES inventory(item_id),
  action TEXT NOT NULL CHECK(action IN ('add', 'remove', 'set', 'adjustment')),
  qty_before INTEGER NOT NULL,
  qty_change INTEGER NOT NULL,
  qty_after INTEGER NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_ref TEXT NOT NULL UNIQUE,
  exp_date TEXT NOT NULL DEFAULT (date('now')),
  category TEXT NOT NULL
    CHECK(category IN ('Load', 'Utility', 'Product Supplies', 'Product', 'Shipping Fee', 'Transfer Fee', 'Others')),
  classification TEXT NOT NULL DEFAULT 'OPEX'
    CHECK(classification IN ('COGS', 'OPEX', 'CAPEX')),
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  total_amt REAL GENERATED ALWAYS AS (quantity * unit_price) VIRTUAL,
  noted_by TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(exp_date);
CREATE INDEX IF NOT EXISTS idx_expenses_cat ON expenses(category);

CREATE TABLE IF NOT EXISTS expense_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_ref TEXT NOT NULL UNIQUE,
  credit_date TEXT NOT NULL DEFAULT (date('now')),
  amount REAL NOT NULL DEFAULT 0,
  source TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_expense_credits_date ON expense_credits(credit_date);

CREATE TABLE IF NOT EXISTS overtime_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  requested_minutes INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'approved', 'rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_overtime_user_date ON overtime_requests(user_id, work_date);

CREATE TABLE IF NOT EXISTS daily_pickups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_ref TEXT NOT NULL UNIQUE,
  pickup_date TEXT NOT NULL DEFAULT (date('now')),
  product_name TEXT NOT NULL,
  product_type TEXT NOT NULL CHECK(product_type IN ('Product', 'Supplies')),
  customer_orders INTEGER NOT NULL DEFAULT 1,
  total_pieces INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scan_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_ref TEXT NOT NULL UNIQUE,
  tracking_no TEXT NOT NULL,
  customer TEXT,
  phone TEXT,
  scan_date TEXT NOT NULL DEFAULT (date('now')),
  scan_time TEXT NOT NULL DEFAULT (time('now')),
  status TEXT,
  courier TEXT,
  scan_type TEXT NOT NULL DEFAULT 'Standard'
    CHECK(scan_type IN ('Standard', 'RTS')),
  scanned_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scans_tracking ON scan_records(tracking_no);
CREATE INDEX IF NOT EXISTS idx_scans_type ON scan_records(scan_type);

CREATE TABLE IF NOT EXISTS integration_settings (
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
);

CREATE TABLE IF NOT EXISTS integration_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'inbound',
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running', 'success', 'partial', 'failed')),
  payload_summary TEXT,
  result_summary TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_integration_sync_runs_provider ON integration_sync_runs(provider, started_at DESC);

CREATE TABLE IF NOT EXISTS integration_source_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  local_table TEXT NOT NULL,
  local_id TEXT NOT NULL,
  last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, entity_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_integration_source_links_local ON integration_source_links(local_table, local_id);


CREATE TABLE IF NOT EXISTS pos_shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  pages_json TEXT,
  link_post_marketer_json TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pos_warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  shop_id TEXT,
  name TEXT,
  address TEXT,
  full_address TEXT,
  phone_number TEXT,
  country_code TEXT,
  allow_create_order INTEGER NOT NULL DEFAULT 0,
  custom_id TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pos_warehouses_shop ON pos_warehouses(shop_id, name);

CREATE TABLE IF NOT EXISTS pos_orders (
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
  psid TEXT,
  botcake_page_id TEXT,
  partner_status TEXT,
  courier_note TEXT,
  partner_reason TEXT,
  ad_id TEXT,
  ads_source TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pos_orders_shop ON pos_orders(shop_id, updated_at_remote DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_orders_shop_external ON pos_orders(shop_id, external_id);

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
  internal_notes TEXT,
  address TEXT,
  province_city TEXT,
  spreadsheet_id TEXT,
  source_sheet TEXT,
  sheet_row_number INTEGER,
  raw_row TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_google_orders_tracking ON google_orders(tracking_no);
CREATE INDEX IF NOT EXISTS idx_google_orders_sheet_day ON google_orders(source_sheet, day_created DESC);
CREATE INDEX IF NOT EXISTS idx_google_orders_day_id ON google_orders(day_created DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_google_orders_updated ON google_orders(updated_at);
CREATE INDEX IF NOT EXISTS idx_google_orders_status ON google_orders(status_normalized);

CREATE TABLE IF NOT EXISTS pos_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_key TEXT NOT NULL UNIQUE,
  shop_id TEXT,
  product_id TEXT,
  variation_id TEXT,
  name TEXT,
  sku TEXT,
  barcode TEXT,
  custom_id TEXT,
  category_name TEXT,
  retail_price REAL,
  imported_price REAL,
  available_quantity INTEGER,
  warehouse_json TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pos_products_shop ON pos_products(shop_id, name);

CREATE TABLE IF NOT EXISTS pos_customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  shop_id TEXT,
  name TEXT,
  phone_number TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  district TEXT,
  ward TEXT,
  level_name TEXT,
  note TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pos_customers_shop ON pos_customers(shop_id, name);

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
);

CREATE INDEX IF NOT EXISTS idx_pos_users_shop ON pos_users(shop_id, name);

CREATE TABLE IF NOT EXISTS pos_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  shop_id TEXT,
  transaction_type TEXT,
  status INTEGER,
  code TEXT,
  value REAL,
  note TEXT,
  inserted_at_remote TEXT,
  updated_at_remote TEXT,
  contact_name TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  posted_by INTEGER REFERENCES users(id),
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, posted_at DESC);

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
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE is_active = 1;

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
);

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
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub ON webhook_deliveries(subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_transactions_shop ON pos_transactions(shop_id, inserted_at_remote DESC);

CREATE TABLE IF NOT EXISTS pos_inventory_histories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_key TEXT NOT NULL UNIQUE,
  shop_id TEXT,
  variation_id TEXT,
  product_id TEXT,
  action_type TEXT,
  changed_quantity INTEGER,
  avg_price REAL,
  warehouse_json TEXT,
  current_inventory_json TEXT,
  inserted_at_remote TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pos_inventory_histories_shop ON pos_inventory_histories(shop_id, inserted_at_remote DESC);

CREATE TABLE IF NOT EXISTS marketing_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  page TEXT NOT NULL,
  product TEXT,
  owner TEXT,
  spend REAL NOT NULL DEFAULT 0,
  sales REAL NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  rts INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_marketing_entries_date ON marketing_entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_entries_page ON marketing_entries(page);

COMMIT;
