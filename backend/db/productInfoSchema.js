// Product information sheet for inventory items: the details the Inventory
// page's Products tab keeps beside the stock numbers. One row per item; the
// item's cost_price and sell_price stay on the inventory table itself, so the
// stock tables and this sheet always show the same money.

function productInfoStatements(db) {
  const ts = db.type === 'postgres' ? 'TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP' : "TEXT NOT NULL DEFAULT (datetime('now'))";
  return [
    `CREATE TABLE IF NOT EXISTS inventory_product_info (
      item_id TEXT PRIMARY KEY,
      product_no TEXT,
      ingredients TEXT,
      supplier_name TEXT,
      supplier_link TEXT,
      cost_breakdown_json TEXT,
      pages_json TEXT,
      notes TEXT,
      updated_by INTEGER,
      updated_at ${ts}
    )`,
  ];
}

async function ensureProductInfoSchema(db) {
  for (const sql of productInfoStatements(db)) {
    await db.exec(sql);
  }
}

module.exports = { ensureProductInfoSchema, productInfoStatements };
