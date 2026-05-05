# YNT Digital Marketing — Internal Dashboard

A complete internal web application for e-commerce operations management.

## ─── Recommended Stack ─────────────────────────────────────

| Layer      | Technology              | Why                                          |
|------------|-------------------------|----------------------------------------------|
| Frontend   | Vanilla HTML/CSS/JS SPA | Zero build step, fast load, easy to maintain |
| Backend    | Node.js + Express.js    | Lightweight, fast REST API, great ecosystem  |
| Database   | SQLite (better-sqlite3) | No server needed, perfect for internal tools |
| Auth       | JWT + bcryptjs          | Stateless, secure, simple                    |
| Charts     | Chart.js CDN            | Excellent for dashboard visuals              |
| Fonts      | DM Sans + DM Mono       | Clean, professional, highly legible          |

---

## ─── Folder Structure ──────────────────────────────────────

```
ynt-dashboard/
├── frontend/
│   ├── index.html              ← SPA entry point + app shell
│   └── assets/
│       ├── css/
│       │   └── main.css        ← All shared styles
│       └── js/
│           └── app.js          ← All page rendering + logic
│
├── backend/
│   ├── server.js               ← Express app entry point
│   ├── package.json
│   ├── db/
│   │   ├── schema.sql          ← SQLite table definitions
│   │   ├── seed.sql            ← Sample dummy data
│   │   ├── client.js           ← SQLite wrapper
│   │   └── init.js             ← Schema/seed initializer
│   └── routes/
│       ├── auth.js             ← Login / logout / me
│       ├── orders.js           ← CRUD orders
│       ├── inventory.js        ← CRUD inventory + stock
│       ├── expenses.js         ← CRUD expenses
│       ├── pickups.js          ← CRUD daily pickups
│       └── scans.js            ← Scan + lookup tracking
│
└── README.md
```

---

## ─── Database Schema ───────────────────────────────────────

### users
| Column     | Type    | Notes               |
|------------|---------|---------------------|
| id         | INTEGER | PK, autoincrement   |
| username   | TEXT    | UNIQUE              |
| password   | TEXT    | bcrypt hash         |
| full_name  | TEXT    |                     |
| role       | TEXT    | Administrator/Staff |
| is_active  | INTEGER | 1=active, 0=disabled|

### orders
| Column     | Type    | Notes               |
|------------|---------|---------------------|
| id         | INTEGER | PK                  |
| order_ref  | TEXT    | UNIQUE (ORD-xxxxx)  |
| tracking_no| TEXT    |                     |
| customer   | TEXT    |                     |
| phone      | TEXT    |                     |
| product    | TEXT    |                     |
| qty        | INTEGER |                     |
| cod_amount | REAL    |                     |
| status     | TEXT    | Enum (5 statuses)   |
| courier    | TEXT    |                     |
| order_date | TEXT    | ISO date            |

### inventory
| Column     | Type    | Notes                    |
|------------|---------|--------------------------|
| item_id    | TEXT    | PK (P001, S001...)       |
| name       | TEXT    |                          |
| sku        | TEXT    | UNIQUE                   |
| type       | TEXT    | Product or Supply        |
| stock      | INTEGER |                          |
| reorder_pt | INTEGER | 200 for products, 15 for supplies |
| cost_price | REAL    |                          |

### expenses
| Column     | Type    | Notes                         |
|------------|---------|-------------------------------|
| expense_ref| TEXT    | UNIQUE (EXP-xxxx)             |
| category   | TEXT    | Load/Utility/Supplies/Others  |
| item_name  | TEXT    |                               |
| quantity   | INTEGER |                               |
| unit_price | REAL    |                               |
| total_amt  | REAL    | VIRTUAL (qty * price)         |

### daily_pickups
| Column          | Type    | Notes           |
|-----------------|---------|-----------------|
| pickup_ref      | TEXT    | UNIQUE          |
| pickup_date     | TEXT    |                 |
| product_name    | TEXT    |                 |
| product_type    | TEXT    | Product/Supplies|
| customer_orders | INTEGER |                 |
| total_pieces    | INTEGER |                 |

### scan_records
| Column     | Type    | Notes             |
|------------|---------|-------------------|
| tracking_no| TEXT    | indexed           |
| customer   | TEXT    |                   |
| scan_type  | TEXT    | Standard or RTS   |
| status     | TEXT    |                   |

---

## ─── Backend API Routes ────────────────────────────────────

### Auth
| Method | Endpoint           | Description         |
|--------|--------------------|---------------------|
| POST   | /api/auth/login    | Login, returns JWT  |
| POST   | /api/auth/logout   | Logout              |
| GET    | /api/auth/me       | Current user info   |

### Orders
| Method | Endpoint                | Description              |
|--------|-------------------------|--------------------------|
| GET    | /api/orders             | List with filter/search  |
| GET    | /api/orders/stats       | Status counts + COD sum  |
| POST   | /api/orders             | Create order             |
| PUT    | /api/orders/:id         | Update order             |
| DELETE | /api/orders/:id         | Delete order             |

### Inventory
| Method | Endpoint                      | Description         |
|--------|-------------------------------|---------------------|
| GET    | /api/inventory                | List all items      |
| GET    | /api/inventory/low-stock      | Items below reorder |
| POST   | /api/inventory                | Add item            |
| PATCH  | /api/inventory/:id/stock      | Update stock qty    |

### Expenses
| Method | Endpoint           | Description          |
|--------|--------------------|----------------------|
| GET    | /api/expenses      | List with filter     |
| POST   | /api/expenses      | Create expense       |
| DELETE | /api/expenses/:id  | Delete expense       |

### Daily Pickups
| Method | Endpoint         | Description    |
|--------|------------------|----------------|
| GET    | /api/pickups     | List pickups   |
| POST   | /api/pickups     | Create pickup  |

### Scans
| Method | Endpoint                      | Description         |
|--------|-------------------------------|---------------------|
| GET    | /api/scans                    | List scan records   |
| GET    | /api/scans/lookup/:tracking   | Look up tracking no |
| POST   | /api/scans                    | Save scan record    |

---

## ─── Setup & Run Instructions ──────────────────────────────

### Prerequisites
- Node.js v22.5+ → https://nodejs.org
- A modern browser (Chrome, Edge, Firefox, Safari)

---

### Option A: Frontend Only (Quickest — No Node needed)

Open `frontend/index.html` directly in your browser, or use VS Code Live Server:

1. Install VS Code extension: **Live Server**
2. Open `frontend/index.html`
3. Right-click → **Open with Live Server**
4. Browser opens at `http://127.0.0.1:5500`

Login credentials:
- `admin` / `admin123`
- `staff` / `staff123`

> ℹ️ In this mode, all data is in-memory (JavaScript). Data resets on page refresh.

---

### Option B: Full Stack (Backend + Database)

```bash
# 1. Clone / unzip the project
cd ynt-dashboard/backend

# 2. Install dependencies
npm install

# 3. Start the backend server
npm start
# OR for development with auto-reload:
npm run dev

# 4. Open browser
open http://localhost:3001
```

The backend serves the frontend at `http://localhost:3001`.
The API is available at `http://localhost:3001/api/...`

The SQLite database is auto-created at `backend/db/ynt.db` with seed data on first run.

**To reset the database:**
```bash
npm run reset-db
```

---

### Option C: Office LAN / XAMPP Setup

This is the recommended setup if one office PC will host the dashboard and everyone else will open it over the local network.

#### 1. Start the backend in LAN mode on the host PC

From the project root, double-click:

```bat
start-office-lan.bat
```

Or run manually:

```bash
cd backend
set HOST=0.0.0.0
set PORT=3001
npm start
```

The server will print:
- `Local: http://localhost:3001`
- `LAN: http://<host-ip>:3001`

Other office PCs can open the printed `LAN` URL, for example:

```text
http://192.168.1.25:3001
```

#### 2. Allow Windows Firewall

On the host PC, allow inbound TCP port `3001` for the office/private network.

#### 3. Optional: Put XAMPP Apache in front

If you want the app to run through Apache/XAMPP instead of exposing the Node port directly:

1. Make sure XAMPP Apache is installed on the host PC.
2. Copy `deployment/xampp/ynt-dashboard-lan.conf` to `C:\xampp\apache\conf\extra\`.
3. In `C:\xampp\apache\conf\httpd.conf`, add:

```apache
Include conf/extra/ynt-dashboard-lan.conf
```

4. Restart Apache from the XAMPP Control Panel.
5. Keep the Node backend running on port `3001`.

Then users can open the Apache URL instead, such as:

```text
http://192.168.1.25/
```

#### 4. Optional environment overrides

You can create `backend/.env` or set system variables for:

```text
HOST=0.0.0.0
PORT=3001
JWT_SECRET=your-super-secret-key-here
FRONTEND_ORIGINS=http://192.168.1.25,http://office-dashboard
```

---

### Environment Variables (optional)

Create `backend/.env`:
```
HOST=0.0.0.0
PORT=3001
JWT_SECRET=your-super-secret-key-here
FRONTEND_ORIGINS=http://192.168.1.25,http://office-dashboard
```

---

### GitHub Upload Checklist

This repo is ready to upload with source files only. Local runtime files are ignored by `.gitignore`, including:

- `backend/node_modules/`
- `backend/.env`
- `backend/db/ynt.db`
- `backend/db/ynt.db-shm`
- `backend/db/ynt.db-wal`

Commit `backend/package-lock.json`, but do not commit installed dependencies or live database files. New developers can recreate them with:

```bash
cd backend
npm install
npm run seed
```

---

## ─── Demo Credentials ──────────────────────────────────────

| Username | Password  | Role          |
|----------|-----------|---------------|
| admin    | admin123  | Administrator |
| staff    | staff123  | Staff         |

---

## ─── Pages Guide ───────────────────────────────────────────

| Page            | URL Hash         | Features                              |
|-----------------|------------------|---------------------------------------|
| Login           | (auto)           | Auth, demo credentials                |
| Home            | home             | Stats cards, quick actions, gallery   |
| Sales Dashboard | sales            | KPI cards, charts, filters, table     |
| Inventory       | inventory        | Tabs, stock levels, reorder alerts    |
| Expenses        | expenses         | Form + live table                     |
| Daily Pickup    | daily-pickup     | Order count selector, form            |
| RTS Scanning    | rts-scanning     | Barcode/tracking input, auto-lookup   |
| Scanning        | scanning         | Standard scan, auto-lookup            |
| View Records    | view-records     | Unified tabbed records + export       |
| Damage Sheets   | damage-sheets    | Print-ready damage report             |
