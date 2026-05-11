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

### Option D: Cloudflare Tunnel Online Access

Use this option when the dashboard and SQLite data should stay on the local server, but you still want an online HTTPS URL.

Cloudflare Tunnel works like this:

```text
Online browser -> Cloudflare URL -> tunnel -> local Node server -> local SQLite data
```

The database remains at `backend/db/ynt.db` on the host PC.

#### Quick temporary tunnel

This is the fastest test. It creates a temporary `https://*.trycloudflare.com` URL.

1. Install `cloudflared`:

```text
https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

2. From the project root, double-click:

```bat
start-cloudflare-quick-tunnel.bat
```

3. Keep the tunnel window open and use the printed Cloudflare URL.

#### Stable tunnel with your own domain

Use this when you want a permanent address like:

```text
https://dashboard.yourdomain.com
```

1. Add your domain to Cloudflare.
2. Login cloudflared:

```bash
cloudflared tunnel login
```

3. Create a named tunnel:

```bash
cloudflared tunnel create ynt-dashboard
```

4. Copy `deployment/cloudflare/config.example.yml` to your Cloudflare config location and edit it:

```text
C:\Users\YOUR_WINDOWS_USER\.cloudflared\config.yml
```

Set:

```yaml
tunnel: ynt-dashboard
credentials-file: C:\Users\YOUR_WINDOWS_USER\.cloudflared\TUNNEL_ID.json

ingress:
  - hostname: dashboard.yourdomain.com
    service: http://localhost:3001
  - service: http_status:404
```

5. Route DNS to the tunnel:

```bash
cloudflared tunnel route dns ynt-dashboard dashboard.yourdomain.com
```

6. Start the local dashboard:

```bash
cd backend
set HOST=127.0.0.1
set PORT=3001
npm start
```

7. In another terminal, run the tunnel:

```bash
cloudflared tunnel run ynt-dashboard
```

For production use, install the tunnel as a Windows service:

```bash
cloudflared service install
```

Security notes:

- Change `JWT_SECRET` in `backend/.env`.
- Change the default `admin` and `staff` passwords.
- Keep the host PC powered on and connected to the internet.
- Do not delete `backend/db/ynt.db`; that is the local live database.

---

### Environment Variables (optional)

Create `backend/.env`:
```
HOST=0.0.0.0
PORT=3001
JWT_SECRET=your-super-secret-key-here
FRONTEND_ORIGINS=http://192.168.1.25,http://office-dashboard
```

### Optional: Render Postgres

The backend uses SQLite by default. If `DATABASE_URL` is set, it switches to Postgres automatically and creates the Postgres schema on startup.

On Render:

1. Create a Render Postgres database in the same region as your web service.
2. Copy the database **Internal Database URL**.
3. Add it to your web service environment:

```text
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
JWT_SECRET=use-a-long-random-secret
```

Use the internal URL for Render-to-Render connections. Do not set `SQLITE_PATH` when using Postgres.

Existing SQLite records are not automatically copied into Postgres. The new Postgres database starts with the seeded `admin` and `staff` accounts unless you run a separate data migration/import.

### Railway Deployment

Use Railway when the dashboard should stay online even when your local PC is off.

This repo includes:

- `railway.json` for Railway/Nixpacks deployment.
- `.railwayignore` to keep local databases, secrets, and dependencies out of deploy uploads.
- `backend/db/schema.pg.sql` and `backend/db/seed.pg.sql` for Supabase/Railway Postgres.
- `backend/scripts/migrate-sqlite-to-postgres.js` to copy local SQLite rows into hosted Postgres.
- `backend/scripts/backup-to-railway-postgres.js` to copy the current live database into a separate Railway Postgres backup database.

#### 1. Create Railway + Supabase

1. Create a new Railway project.
2. Add this repo as the app service from GitHub, or deploy the local project with Railway CLI.
3. Create a Supabase project.
4. In Supabase, open **Project Settings** -> **Database** and copy the Postgres connection string.
5. Add that connection string to the Railway app service as `DATABASE_URL`.

Railway normally injects `PORT` automatically. The app already listens on `process.env.PORT`.

The current dashboard keeps its existing username/password login. Supabase is used here as hosted Postgres storage; switching the login system to Supabase Auth is a separate application change.

#### 2. Set environment variables

In the Railway app service, set:

```text
JWT_SECRET=use-a-long-random-secret
DATABASE_URL=postgresql://postgres.your-project:YOUR-PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres
POSTGRES_SSL=true
GOOGLE_SHEETS_SYNC_ENABLED=false
GOOGLE_SHEETS_SYNC_MODE=manual
PANCAKE_POS_SYNC_ENABLED=false
PANCAKE_POS_SYNC_INTERVAL_MS=300000
```

Optional integration variables:

```text
GOOGLE_SHEETS_SPREADSHEET_ID=your-sheet-id
GOOGLE_SHEETS_SHEET_NAME=Orders
GOOGLE_SHEETS_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
GOOGLE_SHEETS_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
FRONTEND_ORIGINS=https://your-app.up.railway.app,https://dashboard.yourdomain.com
```

To pull Pancake POS data automatically after you save the POS API key and Shop ID in the dashboard, set:

```text
PANCAKE_POS_SYNC_ENABLED=true
PANCAKE_POS_SYNC_INTERVAL_MS=300000
```

`300000` means every 5 minutes. The server skips automatic POS sync until the Pancake POS integration is enabled and has both API key and Shop ID saved.

#### 3. Add Cloudflare R2 for cheap large storage

Use R2 for large files or, if you still run SQLite somewhere, for cheap database backup storage. When `DATABASE_URL` is set, the app uses Supabase Postgres and does not need SQLite backup.

In Cloudflare:

1. Open **R2 Object Storage** and create a bucket, for example `ynt-dashboard`.
2. Open **Manage R2 API Tokens** and create an access key with read/write access to that bucket.
3. Copy the account ID, access key ID, and secret access key.

If you want the existing SQLite cloud backup helper to use R2, set these variables:

```text
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_BUCKET=ynt-dashboard
R2_SQLITE_BACKUP_KEY=ynt-dashboard/ynt.db
R2_SQLITE_BACKUP=true
```

For the recommended Railway + Supabase setup, keep the big file objects in R2 and save only file metadata in Supabase Postgres. The backend is ready to connect to R2; add upload routes when the dashboard needs user-uploaded files.

#### 4. Generate the public URL

In Railway:

1. Open the app service.
2. Go to **Settings**.
3. Find **Networking** / **Public Networking**.
4. Click **Generate Domain**.

Railway will create a URL like:

```text
https://your-app.up.railway.app
```

#### 5. Copy local data to Supabase Postgres

First deploy the app once so the backend creates the Postgres schema in Supabase.

Then on your local PC, set `DATABASE_URL` to the Supabase Postgres connection string and run:

```bash
npm run migrate:railway
```

By default it reads:

```text
backend/db/ynt.db
```

To use a different local SQLite file:

```bash
set SQLITE_PATH=D:\path\to\ynt.db
npm run migrate:railway
```

#### 6. Use a separate Railway Postgres database as backup

Create a second Railway Postgres database for backups only. Do not set this backup URL as `DATABASE_URL`, because `DATABASE_URL` is the live app database.

Set the backup database URL:

```text
RAILWAY_BACKUP_DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/railway
POSTGRES_SSL=true
```

If the live database is local SQLite, leave `DATABASE_URL` empty and run:

```bash
npm run backup:railway
```

If the live database is already Postgres, set the live source URL separately and run the same command:

```bash
set BACKUP_SOURCE_DATABASE_URL=postgresql://USER:PASSWORD@LIVE-HOST:PORT/live-db
set RAILWAY_BACKUP_DATABASE_URL=postgresql://USER:PASSWORD@BACKUP-HOST:PORT/railway
npm run backup:railway
```

The backup command creates/updates the Postgres schema, clears the backup tables, copies all rows from the source, and resets identity sequences. It refuses to run if the source URL and backup URL are the same.

#### 7. Security checklist

- Change the default `admin` and `staff` passwords after first login.
- Keep `JWT_SECRET` long and private.
- Use Supabase backups/export before relying on the app as the only live system.
- Keep `RAILWAY_BACKUP_DATABASE_URL` private and separate from `DATABASE_URL`.
- Keep `R2_SECRET_ACCESS_KEY` only in Railway/backend environment variables.
- If using a custom domain through Cloudflare, add the Railway custom-domain CNAME/TXT records exactly as Railway shows them.

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

---

## Vercel Deployment

This repo includes a Vercel wrapper:

- `vercel.json` routes `/api/*` to the Express backend and serves `frontend/` as the app shell.
- `api/index.js` exports the existing backend for Vercel Functions.
- On Vercel, SQLite runs from `/tmp/ynt.db`, but the app can now restore/back up that file through Vercel Blob when `BLOB_READ_WRITE_TOKEN` is configured.

Deploy steps:

1. Push the repo to GitHub.
2. Import the repo in Vercel.
3. Use Framework Preset: **Other**.
4. Add environment variables in Vercel Project Settings:

```text
JWT_SECRET=use-a-long-random-secret
BLOB_READ_WRITE_TOKEN=auto-added-when-you-connect-a-vercel-blob-store
SQLITE_BLOB_PATH=ynt-dashboard/ynt.db
GOOGLE_SHEETS_SPREADSHEET_ID=your-sheet-id
GOOGLE_SHEETS_SHEET_NAME=Orders
GOOGLE_SHEETS_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
GOOGLE_SHEETS_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
GOOGLE_SHEETS_SYNC_MODE=manual
GOOGLE_SHEETS_SYNC_ENABLED=false
FRONTEND_ORIGINS=https://your-project.vercel.app
```

5. In Vercel, open the project **Storage** tab, create a **Blob** store, choose private access, and connect it to this project/environment. Vercel will provide `BLOB_READ_WRITE_TOKEN`.

Important Vercel note: the live SQLite file still runs from `/tmp`, so Blob backup is a persistence bridge for this existing SQLite app. After each successful API write, the app checkpoints SQLite and uploads `ynt.db` to Blob; on cold start it restores from that Blob before opening the database. For higher-write production use, a real hosted SQL database such as Neon, Supabase, or Vercel Postgres is still the stronger long-term system of record.
