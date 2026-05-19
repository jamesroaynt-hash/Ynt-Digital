@echo off
REM ============================================================
REM YNT Dashboard - manual foreground launch on port 80.
REM Use this for testing before installing the service.
REM Run as Administrator (port 80 requires elevation on Windows).
REM Ctrl+C to stop.
REM ============================================================

setlocal
net session >nul 2>&1
if errorlevel 1 (
  echo [error] Port 80 needs Administrator. Right-click -^> Run as administrator.
  pause
  exit /b 1
)

set "PORT=80"
set "HOST=0.0.0.0"
set "NODE_ENV=production"

pushd "%~dp0..\..\backend"
echo Starting YNT Dashboard on http://localhost:80
node --experimental-sqlite server.js
popd
endlocal
