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
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_ref TEXT NOT NULL UNIQUE,
  tracking_no TEXT,
  customer TEXT NOT NULL,
  phone TEXT,
  product TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  cod_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending'
    CHECK(status IN ('Pending', 'Shipped', 'Delivered', 'Returned', 'Returning')),
  courier TEXT,
  source_sheet TEXT,
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
    CHECK(category IN ('Load', 'Utility', 'Product Supplies', 'Others')),
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
  provider TEXT NOT NULL UNIQUE,
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS integration_raw_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  external_id TEXT,
  mapped_table TEXT,
  local_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'stored'
    CHECK(sync_status IN ('stored', 'synced', 'error')),
  error_message TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_raw_records_provider ON integration_raw_records(provider, entity_type, created_at DESC);

CREATE TABLE IF NOT EXISTS pancake_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  platform TEXT,
  name TEXT,
  avatar_url TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pancake_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  page_id TEXT,
  conversation_type TEXT,
  page_uid TEXT,
  updated_at_remote TEXT,
  inserted_at_remote TEXT,
  tags_json TEXT,
  last_message_json TEXT,
  participants_json TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pancake_conversations_page ON pancake_conversations(page_id, updated_at_remote DESC);

CREATE TABLE IF NOT EXISTS pancake_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_key TEXT NOT NULL UNIQUE,
  external_id TEXT,
  conversation_id TEXT,
  page_id TEXT,
  sender_id TEXT,
  sender_name TEXT,
  message_text TEXT,
  message_type TEXT,
  has_phone INTEGER NOT NULL DEFAULT 0,
  inserted_at_remote TEXT,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  is_removed INTEGER NOT NULL DEFAULT 0,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pancake_messages_conversation ON pancake_messages(conversation_id, inserted_at_remote DESC);

CREATE TABLE IF NOT EXISTS pancake_customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_key TEXT NOT NULL UNIQUE,
  external_id TEXT,
  page_id TEXT,
  name TEXT,
  gender TEXT,
  birthday TEXT,
  lives_in TEXT,
  phone_numbers_json TEXT,
  notes_json TEXT,
  inserted_at_remote TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pancake_customers_page ON pancake_customers(page_id, name);

CREATE TABLE IF NOT EXISTS pancake_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  page_id TEXT,
  post_type TEXT,
  message TEXT,
  inserted_at_remote TEXT,
  comment_count INTEGER,
  reactions_json TEXT,
  phone_number_count INTEGER,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pancake_posts_page ON pancake_posts(page_id, inserted_at_remote DESC);

CREATE TABLE IF NOT EXISTS pancake_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_key TEXT NOT NULL UNIQUE,
  external_id TEXT,
  page_id TEXT,
  text TEXT,
  color TEXT,
  lighten_color TEXT,
  description TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pancake_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_key TEXT NOT NULL UNIQUE,
  external_id TEXT,
  page_id TEXT,
  name TEXT,
  status TEXT,
  fb_id TEXT,
  status_in_page TEXT,
  is_online INTEGER NOT NULL DEFAULT 0,
  user_group TEXT,
  page_permissions_json TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pancake_users_page ON pancake_users(page_id, name);

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
  external_id TEXT NOT NULL UNIQUE,
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
  items_json TEXT,
  partner_json TEXT,
  shipping_address_json TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pos_orders_shop ON pos_orders(shop_id, updated_at_remote DESC);

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

COMMIT;
