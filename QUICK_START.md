# YNT Dashboard — Quick Start Guide

**Get up and running in 5 minutes**

---

## ⚡ Quick Setup

### 1. Open Terminal/Command Prompt
```
Windows: Press Windows + R, type "cmd", hit Enter
Mac: Press Cmd + Space, type "Terminal", hit Enter
Linux: Open your terminal application
```

### 2. Navigate to Project
```bash
cd d:\SYSTEM\ynt-dashboard
# OR wherever your project folder is
```

### 3. Install & Start
```bash
# Install dependencies
npm install

# Go to backend
cd backend
npm install

# Start the server
npm start
```

**You should see:**
```
Server running at http://localhost:3001
```

### 4. Open in Browser
- Go to: **http://localhost:3001**
- Login with: `admin` / `admin123`
- Done! 🎉

---

## 📱 Main Features Overview

### Dashboard
Central hub showing:
- Order statistics
- Inventory status  
- Expense summary
- Upcoming pickups

### Orders
- View all customer orders
- Change status (Pending → Shipped → Delivered)
- Update tracking numbers
- Add notes

### Inventory
- Check stock levels
- Get low-stock alerts
- Add/edit items
- Set reorder points

### Expenses
- Log business expenses
- Choose category
- Auto-calculate totals
- View monthly reports

### More Features
- **Pickups** - Manage package collections
- **Scans** - Track barcode movements
- **HR** - Employee management
- **Marketing** - Campaign tracking
- **Integrations** - Connect external services
- **Announcements** - Team messages

---

## 🔧 Common Commands

```bash
# Start development server (auto-restarts on changes)
cd backend
npm run dev

# Reset database (clear everything, load samples)
npm run reset-db

# Create admin account
# Edit: backend/db/init.js

# View logs
tail -f backend/logs/server.log

# Stop server
Press Ctrl + C
```

---

## 🚀 Deployment

### Local (Windows Service)
```bash
cd deployment/nodejs
install-service.bat
```

### Cloud (Vercel)
```bash
npm install -g vercel
vercel deploy
```

### Cloud (Railway.app)
```bash
npm install -g @railway/cli
railway login
railway up
```

---

## ⚙️ Configuration

**File:** `backend/.env`

```env
PORT=3001
HOST=0.0.0.0
JWT_SECRET=your-secret-key-here

# Optional integrations:
GOOGLE_SHEETS_API_KEY=...
PANCAKE_POS_API_KEY=...
```

---

## 🐛 Troubleshooting

| Problem | Solution |
|---------|----------|
| Port 3001 in use | Change PORT in .env or close conflicting app |
| npm not found | Install Node.js from nodejs.org |
| Database error | Run: `npm run reset-db` |
| Can't login | Check username/password in browser console |
| Connection refused | Ensure server is running (`npm start`) |

---

## 📚 Full Documentation

For complete details, see: **SYSTEM_DOCUMENTATION.md**

Topics covered:
- Architecture & technology stack
- Complete database schema
- All API endpoints
- How to use each feature
- Deployment options
- Scaling & optimization

---

## 💡 Tips

✓ Use dark mode for comfortable viewing (theme toggle in top-right)  
✓ Keyboard shortcut: `Ctrl+/` to search within app  
✓ Export data from any table (CSV or Excel)  
✓ Changes auto-save (no manual save needed)  
✓ Check browser console (F12) for any errors  

---

## 🔒 Security

⚠️ **In Production:**
1. Change default username/password immediately
2. Set strong JWT_SECRET in .env
3. Use HTTPS (SSL certificate)
4. Enable firewall rules
5. Regular backups (`npm run backup:railway`)
6. Keep Node.js updated

---

## 📖 Next Steps

1. ✅ Customize theme colors in `frontend/assets/css/main.css`
2. ✅ Add your logo in `Images/` folder
3. ✅ Update company name in `frontend/index.html`
4. ✅ Configure integrations (Google Sheets, POS)
5. ✅ Deploy to production

---

**Questions?** Check SYSTEM_DOCUMENTATION.md for detailed info.

**Last Updated:** May 29, 2026
