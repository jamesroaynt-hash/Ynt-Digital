@echo off
setlocal

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo cloudflared is not installed or is not in PATH.
  echo Download it from:
  echo https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  pause
  exit /b 1
)

cd /d "%~dp0backend"
set HOST=127.0.0.1
set PORT=3001

start "YNT Dashboard Backend" cmd /k "node --experimental-sqlite server.js"

echo Waiting for local server to start...
timeout /t 5 /nobreak >nul

echo Starting temporary Cloudflare Tunnel for http://localhost:%PORT%
echo.
echo Keep this window open while using the online URL.
echo Cloudflare will print a temporary https://*.trycloudflare.com address below.
echo.
cloudflared tunnel --url http://localhost:%PORT%
