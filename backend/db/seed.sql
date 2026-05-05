BEGIN;

INSERT INTO users (username, password, full_name, role)
SELECT 'admin', 'admin123', 'Admin User', 'Administrator'
WHERE NOT EXISTS (SELECT 1 FROM users)
UNION ALL
SELECT 'staff', 'staff123', 'Staff User', 'Staff'
WHERE NOT EXISTS (SELECT 1 FROM users);

INSERT INTO inventory (item_id, name, sku, type, unit, stock, reorder_pt, cost_price, sell_price)
SELECT 'P001', 'Ginseng Serum 120ml', 'SKU-001', 'Product', 'pcs', 156, 200, 120, 599
WHERE NOT EXISTS (SELECT 1 FROM inventory)
UNION ALL
SELECT 'P002', 'Dragon Blood Cream 50g', 'SKU-002', 'Product', 'pcs', 230, 200, 95, 450
WHERE NOT EXISTS (SELECT 1 FROM inventory)
UNION ALL
SELECT 'P003', 'Hally Lotions 100m', 'SKU-003', 'Product', 'pcs', 88, 200, 75, 399
WHERE NOT EXISTS (SELECT 1 FROM inventory)
UNION ALL
SELECT 'P004', 'Niaciamide', 'SKU-004', 'Product', 'pcs', 312, 200, 140, 699
WHERE NOT EXISTS (SELECT 1 FROM inventory)
UNION ALL
SELECT 'P005', 'Ginseng Footsoak', 'SKU-005', 'Product', 'pcs', 45, 200, 60, 299
WHERE NOT EXISTS (SELECT 1 FROM inventory)
UNION ALL
SELECT 'S001', 'Bubble Wrap Roll', 'SUP-001', 'Supply', 'roll', 8, 15, 180, NULL
WHERE NOT EXISTS (SELECT 1 FROM inventory)
UNION ALL
SELECT 'S002', 'Packing Box (S)', 'SUP-002', 'Supply', 'pcs', 25, 15, 12, NULL
WHERE NOT EXISTS (SELECT 1 FROM inventory)
UNION ALL
SELECT 'S003', 'Packing Box (M)', 'SUP-003', 'Supply', 'pcs', 6, 15, 18, NULL
WHERE NOT EXISTS (SELECT 1 FROM inventory)
UNION ALL
SELECT 'S004', 'Plastic Pouch', 'SUP-004', 'Supply', 'pcs', 120, 15, 3, NULL
WHERE NOT EXISTS (SELECT 1 FROM inventory)
UNION ALL
SELECT 'S005', 'Tape Roll', 'SUP-005', 'Supply', 'roll', 4, 15, 55, NULL
WHERE NOT EXISTS (SELECT 1 FROM inventory)
UNION ALL
SELECT 'S006', 'Airsoft Bubble', 'SUP-006', 'Supply', 'bag', 18, 15, 95, NULL
WHERE NOT EXISTS (SELECT 1 FROM inventory)
UNION ALL
SELECT 'S007', 'Thank You Card', 'SUP-007', 'Supply', 'pcs', 200, 15, 2, NULL
WHERE NOT EXISTS (SELECT 1 FROM inventory);

WITH RECURSIVE seq(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 80
)
INSERT INTO orders (
  order_ref,
  tracking_no,
  customer,
  phone,
  product,
  qty,
  cod_amount,
  status,
  courier,
  attempts,
  order_date
)
SELECT
  printf('ORD-%05d', 1000 + n),
  printf('%s%s%08dPH', char(65 + (n % 26)), char(65 + ((n + 1) % 26)), 10000000 + (n * 17391)),
  CASE ((n - 1) % 8)
    WHEN 0 THEN 'Maria Santos'
    WHEN 1 THEN 'Juan dela Cruz'
    WHEN 2 THEN 'Ana Reyes'
    WHEN 3 THEN 'Carlo Mendoza'
    WHEN 4 THEN 'Liza Tan'
    WHEN 5 THEN 'Ben Aquino'
    WHEN 6 THEN 'Rosa Cruz'
    ELSE 'Mark Lim'
  END,
  printf('09%09d', 100000000 + (n * 34567)),
  CASE ((n - 1) % 5)
    WHEN 0 THEN 'YNT Serum Glow'
    WHEN 1 THEN 'Hydra Cream'
    WHEN 2 THEN 'Vitamin C Drops'
    WHEN 3 THEN 'Retinol Boost'
    ELSE 'Toner Mist'
  END,
  ((n - 1) % 5) + 1,
  200 + (((n - 1) * 137) % 1800),
  CASE ((n - 1) % 5)
    WHEN 0 THEN 'Shipped'
    WHEN 1 THEN 'Delivered'
    WHEN 2 THEN 'Returned'
    WHEN 3 THEN 'Returning'
    ELSE 'Pending'
  END,
  CASE ((n - 1) % 4)
    WHEN 0 THEN 'J&T Express'
    WHEN 1 THEN 'Ninja Van'
    WHEN 2 THEN 'LBC'
    ELSE '2GO'
  END,
  ((n - 1) % 3) + 1,
  date('now', printf('-%d day', (n - 1) % 90))
FROM seq
WHERE NOT EXISTS (SELECT 1 FROM orders);

WITH RECURSIVE seq(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 30
)
INSERT INTO expenses (
  expense_ref,
  exp_date,
  category,
  item_name,
  quantity,
  unit_price,
  noted_by
)
SELECT
  printf('EXP-%04d', n),
  date('now', printf('-%d day', (n - 1) % 60)),
  CASE ((n - 1) % 4)
    WHEN 0 THEN 'Load'
    WHEN 1 THEN 'Utility'
    WHEN 2 THEN 'Product Supplies'
    ELSE 'Others'
  END,
  CASE ((n - 1) % 7)
    WHEN 0 THEN 'PLDT Wi-Fi Bill'
    WHEN 1 THEN 'Tape Supply'
    WHEN 2 THEN 'Facebook Ads Load'
    WHEN 3 THEN 'Electricity Bill'
    WHEN 4 THEN 'Office Supplies'
    WHEN 5 THEN 'Printer Ink'
    ELSE 'Packaging Materials'
  END,
  ((n - 1) % 10) + 1,
  50 + (((n - 1) * 43) % 1000),
  'Admin User'
FROM seq
WHERE NOT EXISTS (SELECT 1 FROM expenses);

WITH RECURSIVE seq(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 20
)
INSERT INTO daily_pickups (
  pickup_ref,
  pickup_date,
  product_name,
  product_type,
  customer_orders,
  total_pieces,
  notes
)
SELECT
  printf('PU-%04d', n),
  date('now', printf('-%d day', n - 1)),
  CASE ((n - 1) % 5)
    WHEN 0 THEN 'YNT Serum Glow'
    WHEN 1 THEN 'Hydra Cream'
    WHEN 2 THEN 'Vitamin C Drops'
    WHEN 3 THEN 'Retinol Boost'
    ELSE 'Toner Mist'
  END,
  CASE WHEN ((n - 1) % 3) = 0 THEN 'Supplies' ELSE 'Product' END,
  ((n - 1) % 4) + 1,
  (((n - 1) % 4) + 1) * ((((n - 1) + 1) % 3) + 1),
  CASE WHEN ((n - 1) % 4) = 0 THEN 'Rush delivery' ELSE '' END
FROM seq
WHERE NOT EXISTS (SELECT 1 FROM daily_pickups);

WITH RECURSIVE seq(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 40
)
INSERT INTO scan_records (
  scan_ref,
  tracking_no,
  customer,
  phone,
  scan_date,
  status,
  courier,
  scan_type
)
SELECT
  printf('SCN-%04d', n),
  printf('%s%s%08dPH', char(65 + (n % 26)), char(65 + ((n + 2) % 26)), 10000000 + (n * 23117)),
  CASE ((n - 1) % 8)
    WHEN 0 THEN 'Maria Santos'
    WHEN 1 THEN 'Juan dela Cruz'
    WHEN 2 THEN 'Ana Reyes'
    WHEN 3 THEN 'Carlo Mendoza'
    WHEN 4 THEN 'Liza Tan'
    WHEN 5 THEN 'Ben Aquino'
    WHEN 6 THEN 'Rosa Cruz'
    ELSE 'Mark Lim'
  END,
  printf('09%09d', 100000000 + (n * 45678)),
  date('now', printf('-%d day', (n - 1) % 30)),
  CASE ((n - 1) % 6)
    WHEN 0 THEN 'For Delivery'
    WHEN 1 THEN 'Delivered'
    WHEN 2 THEN 'Return to Sender'
    WHEN 3 THEN 'Failed Attempt'
    WHEN 4 THEN 'In Transit'
    ELSE 'Out for Delivery'
  END,
  CASE ((n - 1) % 4)
    WHEN 0 THEN 'J&T Express'
    WHEN 1 THEN 'Ninja Van'
    WHEN 2 THEN 'LBC'
    ELSE '2GO'
  END,
  CASE WHEN ((n - 1) % 5) = 0 THEN 'RTS' ELSE 'Standard' END
FROM seq
WHERE NOT EXISTS (SELECT 1 FROM scan_records);

COMMIT;
