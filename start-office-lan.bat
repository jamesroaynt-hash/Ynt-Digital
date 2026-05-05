@echo off
setlocal

cd /d "%~dp0backend"
set HOST=0.0.0.0
set PORT=3001

echo Starting YNT Dashboard for office LAN access on port %PORT%...
echo.
node server.js
