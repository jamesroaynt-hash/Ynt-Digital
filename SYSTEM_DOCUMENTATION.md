# YNT Digital Marketing ERP Dashboard
## Complete System Documentation

**Document Version:** 1.0  
**Last Updated:** May 29, 2026  
**System Name:** YNT Dashboard  
**Purpose:** Internal e-commerce operations management platform

---

## 📋 Table of Contents
1. [System Overview](#system-overview)
2. [Technology Stack](#technology-stack)
3. [Architecture](#architecture)
4. [Project Structure](#project-structure)
5. [Database Schema](#database-schema)
6. [How to Use](#how-to-use)
7. [API Endpoints](#api-endpoints)
8. [Features & Modules](#features--modules)
9. [Setup & Installation](#setup--installation)
10. [Deployment Options](#deployment-options)
11. [Troubleshooting](#troubleshooting)

---

## System Overview

**YNT Digital Marketing ERP Dashboard** is a complete internal web application designed for managing e-commerce operations. It provides a unified interface for:

- **Order Management** - Track, manage, and monitor customer orders
- **Inventory Control** - Monitor stock levels, set reorder points
- **Expense Tracking** - Log and categorize business expenses
- **Human Resources** - Manage staff and HR operations
- **Marketing** - Track marketing campaigns and performance
- **Daily Pickups** - Manage package pickups and logistics
- **Barcode Scanning** - Scan and track item movement
- **Integrations** - Connect with external services (Google Sheets, PancakePOS)
- **Announcements** - Internal communications and alerts
- **API Keys** - Secure external API access management

### Key Benefits
✓ Zero build step - runs in browser without compilation  
✓ Fast performance - lightweight single-page application  
✓ Easy maintenance - vanilla JavaScript, no complex frameworks  
✓ Secure - JWT authentication, bcrypt password hashing  
✓ Flexible deployment - Local, cloud (Vercel, Railway), on-premises  

---

## Technology Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| **Frontend** | Vanilla HTML/CSS/JavaScript | ES6+ | Single Page Application |
| **Backend** | Node.js + Express.js | 22.x | REST API server |
| **Database** | SQLite / PostgreSQL | 3.x / 14+ | Data persistence |
| **Auth** | JWT + bcryptjs | 9.0 / 2.4 | Authentication & encryption |
| **Charts** | Chart.js | 4.4 | Data visualization |
| **File Storage** | AWS S3 / Vercel Blob | Latest | Cloud backups |
| **Fonts** | DM Sans + DM Mono | CDN | UI typography |

### Required Software
- **Node.js** 22.5.0 or higher
- **npm** (comes with Node.js)
- **Git** (for version control)
- **Python 3.x** (optional, for some scripts)

---

## Architecture

### System Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    USER BROWSER                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Frontend (HTML/CSS/JS)                             │  │
│  │  - Login Screen                                     │  │
│  │  - Dashboard (Orders, Inventory, Expenses, etc)    │  │
│  │  - Charts & Visualizations                         │  │
│  │  - Local Storage (theme, preferences)             │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTPS/HTTP REST API
                       │ JWT Authentication
                       ↓
┌──────────────────────────────────────────────────────────────┐
│             BACKEND SERVER (Node.js/Express)                │
├──────────────────────────────────────────────────────────────┤
│  Core Server (server.js)                                    │
│  ├─ Authentication Routes                                  │
│  ├─ CRUD API Endpoints                                     │
│  ├─ Webhook Handlers                                       │
│  └─ Background Tasks/Schedulers                            │
├──────────────────────────────────────────────────────────────┤
│  Services (Async Background Jobs)                           │
│  ├─ Google Sheets Sync (Sync data to/from Sheets)         │
│  ├─ PancakePOS Sync (Sync orders from POS system)         │
│  ├─ Webhook Dispatcher (Trigger external webhooks)         │
│  └─ Backup Scheduler (Cloud backups)                       │
├──────────────────────────────────────────────────────────────┤
│  Database Layer (SQLite or PostgreSQL)                      │
│  └─ All persistent data storage                            │
└──────────────────────────────────────────────────────────────┘
```

### Request/Response Flow

1. **User Action** → Frontend JavaScript captures action
2. **API Request** → Frontend sends REST request with JWT token
3. **Authentication** → Backend validates JWT token
4. **Processing** → Backend processes request (CRUD operations)
5. **Database** → Data stored/retrieved from SQLite/PostgreSQL
6. **Response** → Backend returns JSON response
7. **UI Update** → Frontend updates interface in real-time

---

## Project Structure

```
ynt-dashboard/
│
├── 📄 README.md                          ← Quick start guide
├── 📄 SYSTEM_DOCUMENTATION.md            ← This file
├── 📄 package.json                       ← Root dependencies
├── 📄 railway.json                       ← Railway.app config
├── 📄 vercel.json                        ← Vercel config
│
├── 🌐 frontend/                          ← Frontend SPA (user-facing)
│   ├── 📄 index.html                     ← HTML entry point + shell
│   └── 📂 assets/
│       ├── css/
│       │   └── main.css                  ← All styles (dark/light theme)
│       └── js/
│           └── app.js                    ← All frontend logic & routing
│
├── 🔧 backend/                           ← Backend API (server-side)
│   ├── 📄 server.js                      ← Express app entry point
│   ├── 📄 package.json                   ← Backend dependencies
│   │
│   ├── 🗄️ db/                           ← Database layer
│   │   ├── client.js                     ← SQLite/PostgreSQL wrapper
│   │   ├── init.js                       ← Schema initialization
│   │   ├── schema.sql                    ← SQLite table definitions
│   │   ├── schema.pg.sql                 ← PostgreSQL tables
│   │   ├── seed.sql                      ← Sample test data
│   │   ├── seed.pg.sql                   ← PostgreSQL sample data
│   │   ├── blobPersistence.js            ← Cloud backup logic
│   │   └── *.db                          ← Database files (created at runtime)
│   │
│   ├── 🛣️ routes/                       ← API endpoint handlers
│   │   ├── auth.js                       ← POST /api/auth/* (login, logout)
│   │   ├── orders.js                     ← GET/POST /api/orders/*
│   │   ├── inventory.js                  ← GET/POST /api/inventory/*
│   │   ├── expenses.js                   ← GET/POST /api/expenses/*
│   │   ├── pickups.js                    ← GET/POST /api/pickups/*
│   │   ├── scans.js                      ← Barcode scan tracking
│   │   ├── hr.js                         ← Human resources data
│   │   ├── marketing.js                  ← Marketing campaigns
│   │   ├── announcements.js              ← Internal announcements
│   │   ├── apiKeys.js                    ← API key management
│   │   ├── integrations.js               ← Third-party integrations
│   │   ├── webhooks.js                   ← Webhook handlers
│   │   └── _all.js                       ← Route registration
│   │
│   ├── ⚙️ services/                      ← Background services
│   │   ├── googleSheetsSync.js           ← Google Sheets sync logic
│   │   ├── pancakePosSync.js             ← POS sync logic
│   │   └── webhookDispatcher.js          ← Webhook triggering
│   │
│   ├── 🧠 scripts/                       ← Utility scripts
│   │   ├── backup-to-railway-postgres.js ← Backup database
│   │   ├── migrate-sqlite-to-postgres.js ← Migration tool
│   │   └── syncNow.js                    ← Manual sync trigger
│   │
│   └── 📁 logs/                          ← Server logs
│
├── 🚀 deployment/                        ← Deployment configs
│   ├── cloudflare/                       ← Cloudflare tunnel
│   ├── nodejs/                           ← Windows service scripts
│   └── xampp/                            ← Apache config
│
├── 🎨 Images/                            ← Assets (logo, etc)
│
└── 📂 api/                                ← API wrapper (Vercel)
    └── index.js

```

---

## Database Schema

### Core Tables

#### 1. **users** - Employee Accounts
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,           -- bcrypt hash
  full_name TEXT,
  role TEXT,                        -- 'Administrator' or 'Staff'
  is_active INTEGER DEFAULT 1,      -- 1=active, 0=disabled
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
**Usage:** Authentication, role-based access control

---

#### 2. **orders** - Customer Orders
```sql
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_ref TEXT UNIQUE,            -- "ORD-20260525-001"
  tracking_no TEXT,
  customer TEXT NOT NULL,
  phone TEXT,
  product TEXT,
  qty INTEGER DEFAULT 1,
  cod_amount REAL,                  -- Cash-on-delivery amount
  status TEXT,                      -- 'Pending', 'Confirmed', 'Shipped', 'Delivered', 'Cancelled'
  courier TEXT,                     -- Delivery company name
  order_date TEXT,                  -- ISO 8601 date
  shipping_address TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
**Usage:** Core business - order tracking and fulfillment

---

#### 3. **inventory** - Stock & Products
```sql
CREATE TABLE inventory (
  item_id TEXT PRIMARY KEY,         -- "P001", "S001", etc
  name TEXT NOT NULL,
  sku TEXT UNIQUE NOT NULL,
  type TEXT,                        -- 'Product' or 'Supply'
  stock INTEGER DEFAULT 0,
  reorder_point INTEGER,            -- Alert when stock falls below
  cost_price REAL,
  selling_price REAL,
  supplier TEXT,
  last_stock_check DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
**Usage:** Inventory management, stock alerts, COGS tracking

---

#### 4. **expenses** - Business Expenses
```sql
CREATE TABLE expenses (
  expense_ref TEXT UNIQUE PRIMARY KEY, -- "EXP-20260525-001"
  category TEXT NOT NULL,           -- 'Load', 'Utility', 'Supplies', 'Other'
  item_name TEXT,
  quantity INTEGER,
  unit_price REAL,
  total_amount REAL,                -- qty × unit_price
  payment_method TEXT,              -- 'Cash', 'Bank Transfer', etc
  date TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
**Usage:** Expense tracking, financial reporting

---

#### 5. **daily_pickups** - Package Collections
```sql
CREATE TABLE daily_pickups (
  pickup_id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_date TEXT,
  location TEXT,
  items_count INTEGER,
  status TEXT,                      -- 'Scheduled', 'In Progress', 'Completed'
  courier TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
**Usage:** Logistics management, pickup scheduling

---

#### 6. **scans** - Barcode Tracking
```sql
CREATE TABLE scans (
  scan_id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT,
  scan_code TEXT,
  scan_location TEXT,
  scan_type TEXT,                   -- 'In', 'Out', 'Transfer'
  scanned_by TEXT,
  scan_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);
```
**Usage:** Track item movement, barcode scanning logs

---

#### 7. **announcements** - Internal Communications
```sql
CREATE TABLE announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,
  priority TEXT,                    -- 'High', 'Normal', 'Low'
  posted_by TEXT,
  posted_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME
);
```
**Usage:** Team notifications, important alerts

---

#### 8. **api_keys** - External API Access
```sql
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,           -- sha256 hash
  usage_scope TEXT,                 -- What this key can access
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used DATETIME,
  is_active INTEGER DEFAULT 1
);
```
**Usage:** Secure third-party API integration

---

#### 9. **hr_staff** - Employee Directory
```sql
CREATE TABLE hr_staff (
  staff_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position TEXT,
  email TEXT,
  phone TEXT,
  department TEXT,
  hire_date TEXT,
  status TEXT,                      -- 'Active', 'On Leave', 'Inactive'
  salary REAL,
  manager_id TEXT
);
```
**Usage:** HR management, staff directory

---

#### 10. **marketing_campaigns** - Marketing Tracking
```sql
CREATE TABLE marketing_campaigns (
  campaign_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT,                     -- 'Social', 'Email', 'SMS', 'Ads'
  budget REAL,
  spent REAL,
  start_date TEXT,
  end_date TEXT,
  status TEXT,                      -- 'Planning', 'Active', 'Completed'
  performance_notes TEXT
);
```
**Usage:** Marketing campaign management, budget tracking

---

### Additional Tables
- **integrations** - Third-party service credentials
- **webhooks** - Webhook event logs and configurations
- **backup_metadata** - Cloud backup history

---

## How to Use

### 1. **Starting the Application**

#### Local Development
```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Start in development mode (with auto-reload)
npm run dev

# OR start in production mode
npm start
```

The application will be available at `http://localhost:3001`

#### Windows Service (On-Premises Deployment)
```bash
# Run as administrator
cd deployment/nodejs

# Install as Windows service
install-service.bat

# Start service
start-server.bat

# Stop service
stop-xampp-apache.bat

# Uninstall service
uninstall-service.bat
```

#### Cloud Deployment
See [Deployment Options](#deployment-options) section below.

---

### 2. **Logging In**

1. Open browser to application URL (localhost:3001 or your domain)
2. See login screen with username/password fields
3. Enter credentials
4. Click "Login" or press Enter
5. JWT token stored in browser (httpOnly cookie for security)

**Default Test Credentials** (if seeded):
```
Username: admin
Password: admin123
```

---

### 3. **Navigation & Dashboard**

After login, you'll see:

**Left Sidebar Menu:**
- 🏠 **Dashboard** - Overview & statistics
- 📦 **Orders** - Customer order management
- 📊 **Inventory** - Stock & product management
- 💰 **Expenses** - Financial tracking
- 👥 **HR** - Employee management
- 📢 **Marketing** - Campaign tracking
- 🎫 **Pickups** - Delivery management
- 📱 **Scans** - Barcode scanning
- 🔗 **Integrations** - External connections
- 📣 **Announcements** - Team messages
- 🔑 **API Keys** - External access

**Top Bar Features:**
- Search functionality
- Theme toggle (dark/light mode)
- User profile & logout
- Notifications

---

### 4. **Common Tasks**

#### Creating a New Order
1. Click "Orders" in sidebar
2. Click "+ New Order" button
3. Fill in form:
   - Customer name
   - Phone number
   - Product name
   - Quantity
   - COD Amount (if applicable)
   - Courier
4. Click "Save"
5. Order appears in list with auto-generated reference (ORD-XXXXX)

#### Adding Inventory
1. Click "Inventory"
2. Click "+ Add Item"
3. Fill fields:
   - Item ID (P001, S001, etc)
   - Item Name
   - SKU (barcode)
   - Type (Product or Supply)
   - Initial Stock
   - Reorder Point
   - Cost Price
4. Click "Save"

#### Logging Expenses
1. Click "Expenses"
2. Click "+ New Expense"
3. Select category (Load, Utility, Supplies, Other)
4. Enter item name, quantity, unit price
5. System auto-calculates total
6. Click "Save"

#### Scanning Items
1. Click "Scans"
2. Select scan type (In/Out/Transfer)
3. Use barcode scanner or manually enter code
4. Click "Process Scan"
5. Movement recorded in system

---

### 5. **Generating Reports**

#### Dashboard Charts
- **Orders Summary** - Status breakdown (Pending, Shipped, Delivered, etc)
- **Inventory Status** - Low stock alerts
- **Monthly Expenses** - Spending trends
- **Daily Pickups** - Logistics volume

#### Exporting Data
- Click table → Export icon
- Choose format: CSV or Excel
- Download file to computer

---

### 6. **User Roles & Permissions**

| Role | Can View | Can Edit | Can Delete |
|------|----------|----------|-----------|
| **Administrator** | Everything | Everything | Everything |
| **Staff** | Most data | Own entries | No |
| **Guest** | Read-only | Nothing | Nothing |

---

## API Endpoints

### Authentication Routes

```
POST /api/auth/login
  Input:  { username, password }
  Output: { token, user: { id, username, role } }
  
POST /api/auth/logout
  Input:  { }
  Output: { message: "Logged out" }
  
GET /api/auth/me
  Input:  (JWT required)
  Output: { id, username, full_name, role }
```

### Orders API

```
GET /api/orders
  Get all orders with pagination
  Query: ?page=1&limit=50&status=Pending

GET /api/orders/:id
  Get single order details

POST /api/orders
  Create new order
  Input: { customer, phone, product, qty, cod_amount, courier }

PUT /api/orders/:id
  Update order
  Input: { status, tracking_no, ... }

DELETE /api/orders/:id
  Delete order

GET /api/orders/stats
  Order statistics (counts by status, daily totals)
```

### Inventory API

```
GET /api/inventory
  Get all items with stock levels

GET /api/inventory/:id
  Get item details

POST /api/inventory
  Add new inventory item

PUT /api/inventory/:id
  Update inventory (stock, reorder point)

DELETE /api/inventory/:id
  Remove item

GET /api/inventory/alerts
  Get low-stock alerts
```

### Expenses API

```
GET /api/expenses
  Get all expenses with filtering

POST /api/expenses
  Log new expense

PUT /api/expenses/:id
  Update expense

DELETE /api/expenses/:id
  Delete expense

GET /api/expenses/summary
  Spending summary by category
```

### Other Endpoints

```
GET /api/pickups
POST /api/pickups

GET /api/scans
POST /api/scans

GET /api/announcements
POST /api/announcements

GET /api/integrations
POST /api/integrations

GET /api/webhooks
```

---

## Features & Modules

### 1. **Order Management**
- ✅ Create, read, update, delete orders
- ✅ Order status tracking (Pending → Confirmed → Shipped → Delivered)
- ✅ Tracking number integration
- ✅ Courier management
- ✅ COD (Cash-on-Delivery) amount tracking
- ✅ Order reference auto-generation (ORD-XXXXX)
- ✅ Order statistics & charts

### 2. **Inventory System**
- ✅ Product & supply tracking
- ✅ Real-time stock levels
- ✅ Low-stock alerts (configurable reorder points)
- ✅ Cost price tracking for COGS
- ✅ Barcode/SKU management
- ✅ Stock history

### 3. **Expense Tracking**
- ✅ Multi-category expenses (Load, Utility, Supplies, Other)
- ✅ Expense reference generation (EXP-XXXXX)
- ✅ Automatic total calculation
- ✅ Payment method tracking
- ✅ Monthly summaries & trends

### 4. **Barcode Scanning**
- ✅ Scan-in tracking
- ✅ Scan-out tracking
- ✅ Transfer tracking
- ✅ Batch scanning
- ✅ Location tracking

### 5. **Logistics (Pickups)**
- ✅ Daily pickup scheduling
- ✅ Pickup status tracking
- ✅ Courier assignment
- ✅ Item count tracking

### 6. **HR Management**
- ✅ Employee directory
- ✅ Position tracking
- ✅ Department management
- ✅ Salary/compensation
- ✅ Leave tracking

### 7. **Marketing**
- ✅ Campaign management
- ✅ Budget tracking
- ✅ Channel attribution (Social, Email, SMS, Ads)
- ✅ Performance metrics

### 8. **Integrations**
- 🔌 **Google Sheets Sync** - Auto-sync orders/inventory to Google Sheets
- 🔌 **PancakePOS Sync** - Pull orders from POS system
- 🔌 **Custom Webhooks** - Send data to external services
- 🔌 **API Keys** - Secure external access

### 9. **Communications**
- 📣 Internal announcements
- 🔔 Toast notifications
- ⚠️ System alerts

### 10. **Cloud Backups**
- ☁️ Automatic database backups
- ☁️ AWS S3 / Vercel Blob storage
- ☁️ One-click restore
- ☁️ Backup scheduling

---

## Setup & Installation

### Prerequisites Check
```bash
# Check Node.js version (need 22.5.0+)
node --version

# Check npm version
npm --version

# Check if git installed
git --version
```

### Step 1: Clone/Download Project
```bash
# Clone from repository (if using git)
git clone https://github.com/your-repo/ynt-dashboard.git
cd ynt-dashboard

# OR extract zip file
# Extract ynt-dashboard.zip and navigate to folder
```

### Step 2: Install Dependencies
```bash
# Install root dependencies
npm install

# Install backend dependencies
cd backend
npm install

# Return to root
cd ..
```

### Step 3: Setup Database
```bash
cd backend

# Create fresh database with sample data
npm run reset-db

# OR just initialize (keep existing data)
npm run seed
```

### Step 4: Configure Environment
```bash
# Create .env file in backend folder
cd backend
notepad .env  (Windows) or nano .env (Mac/Linux)
```

Add these settings:
```env
# Server settings
PORT=3001
HOST=0.0.0.0

# Security
JWT_SECRET=your-secret-key-here-change-this

# Google Sheets Integration (optional)
GOOGLE_SHEETS_API_KEY=your-key

# PancakePOS Integration (optional)
PANCAKE_POS_API_KEY=your-key
PANCAKE_POS_SYNC_INTERVAL_MS=300000

# Cloud Backup (optional)
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=us-east-1
```

### Step 5: Start Application
```bash
# From root directory
npm start

# Application runs on http://localhost:3001
```

### Step 6: Create Admin Account
```bash
# Default test user (if seeded)
# Username: admin
# Password: admin123

# Change these immediately in production!
```

---

## Deployment Options

### Option 1: Local/On-Premises (Windows)

#### A. Run as Console App
```bash
cd backend
npm start
```

#### B. Run as Windows Service
```bash
# As Administrator:
cd deployment/nodejs
install-service.bat

# Service will auto-start on system reboot
# Start service: start-server.bat
# Stop service: stop-xampp-apache.bat
```

#### C. Behind Apache (XAMPP)
```bash
# Windows: Use provided Apache config
# deployment/xampp/ynt-dashboard-lan.conf

# Replace [YOUR_SERVER_IP] with actual IP
# Access via: http://[YOUR_SERVER_IP]:80/
```

**Pros:** Full control, no external costs, works offline  
**Cons:** Requires IT expertise, security responsibility, maintenance  

---

### Option 2: Cloud Deployment - Vercel

**Best for:** Global CDN, auto-scaling, managed platform  
**Cost:** Free tier available, pay-per-use

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel deploy

# Follow prompts to connect GitHub repo
```

**Features:**
- Auto-deploy on git push
- Global edge caching
- Automatic HTTPS
- Serverless functions
- Zero downtime deploys

**Database:** Works with PostgreSQL on Vercel Storage

---

### Option 3: Cloud Deployment - Railway.app

**Best for:** Simple Node.js hosting, PostgreSQL included  
**Cost:** Pay-per-use, ~$5-20/month typical

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login & deploy
railway login
railway up
```

**Features:**
- Easy PostgreSQL database
- Environment variables GUI
- GitHub auto-deploy
- Monitoring dashboard

**Setup:** See `railway.json` config file

---

### Option 4: Docker (Any Cloud Provider)

```dockerfile
FROM node:22
WORKDIR /app
COPY . .
RUN npm install && cd backend && npm install
EXPOSE 3001
CMD ["npm", "start"]
```

Deploy to: AWS, Google Cloud, Azure, DigitalOcean, etc.

---

## Database Migration

### SQLite → PostgreSQL (for cloud)

```bash
cd backend
npm run migrate:railway
```

This script:
1. Reads SQLite database
2. Creates PostgreSQL tables
3. Copies all data
4. Validates consistency

### Backup Database

```bash
# Manual backup
npm run backup:railway

# Backs up to AWS S3 or Vercel Blob
```

---

## Troubleshooting

### Problem: Port 3001 Already in Use

**Solution:**
```bash
# Windows: Find process using port 3001
netstat -ano | findstr :3001

# Kill process (replace PID with actual number)
taskkill /PID 12345 /F

# OR use different port
set PORT=3002
npm start
```

### Problem: Database Locked

**Solution:**
```bash
# Delete database and recreate
cd backend
npm run reset-db
npm start
```

### Problem: JWT Secret Errors

**Solution:**
```bash
# Ensure .env file has JWT_SECRET
# File location: backend/.env
JWT_SECRET=your-very-long-random-string-here
```

### Problem: Connection Refused on Deployment

**Solution:**
- Check HOST variable (should be 0.0.0.0 for cloud)
- Check PORT variable matches deployment config
- Verify firewall rules

---

## Maintenance & Operations

### Regular Backups
- Automated: Daily via cloud backup scheduler
- Manual: `npm run backup:railway`
- Retention: Keep last 30 days of backups

### Database Optimization
```bash
# Optimize SQLite
PRAGMA vacuum;

# View database size
.tables
```

### Log Files
- Location: `backend/logs/`
- Size limit: Auto-rotated
- Retention: 7 days

### Performance Monitoring
- Check API response times
- Monitor database query times
- Review memory usage
- Monitor disk space

### Security Updates
```bash
# Check for vulnerability updates
npm audit

# Fix automatically
npm audit fix

# Update all packages
npm update
```

---

## Advanced Features

### 1. Custom API Integration
- Create webhook to external service
- Use API keys for secure access
- Implement custom sync service

### 2. Extended Analytics
- Add custom fields to tables
- Create new dashboard charts
- Export analytics to BI tools

### 3. Mobile App
- Use same REST API
- Create React Native / Flutter app
- Share database backend

### 4. Scaling for Growth
- Move to PostgreSQL on cloud
- Add Redis caching layer
- Implement API rate limiting
- Use load balancer for multiple servers

---

## Support & Resources

### Documentation
- **This File** - System overview and usage
- **README.md** - Quick start guide
- **Code Comments** - Inline documentation

### Common File Locations
| What | Where |
|------|-------|
| Frontend code | `frontend/assets/js/app.js` |
| Backend API | `backend/routes/*.js` |
| Database schema | `backend/db/schema.sql` |
| Server config | `backend/server.js` |
| Deployment configs | `deployment/` folder |

### Database Files
- **SQLite** (local): `backend/db/ynt.db`
- **PostgreSQL** (cloud): Connected via connection string

### Logs & Debugging
- **Server logs**: `backend/logs/server.log`
- **Browser console**: Press F12 in browser
- **Network tab**: See API requests/responses

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | May 29, 2026 | Initial system launch |

---

## System Requirements Summary

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| **CPU** | 2 cores | 4 cores |
| **RAM** | 2 GB | 4 GB |
| **Storage** | 500 MB | 2 GB |
| **Node.js** | 22.5.0 | 22.x LTS |
| **Network** | 1 Mbps | 10+ Mbps |
| **OS** | Windows 7+ / Linux / Mac | Windows 10+ / Linux / Mac |

---

## Contact & Support

For issues or questions:
1. Check logs (`backend/logs/`)
2. Review error messages in browser console
3. Check database connectivity
4. Restart application

---

**Document Created:** May 29, 2026  
**System:** YNT Digital Marketing ERP Dashboard v1.0  
**Status:** Production Ready

---

*This documentation should be updated whenever system changes are made. Keep this file current for team reference.*
