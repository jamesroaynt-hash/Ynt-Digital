@echo off
REM ============================================================
REM Stop the XAMPP Apache service so it stops fighting for port 80.
REM Run as Administrator. Safe to run if Apache is not installed
REM as a service (will simply report not found).
REM ============================================================

setlocal
net session >nul 2>&1
if errorlevel 1 (
  echo [error] Run this script as Administrator.
  pause
  exit /b 1
)

echo Stopping Apache service if present...
net stop Apache2.4 2>nul
net stop apache 2>nul
sc config Apache2.4 start= demand 2>nul

echo If you launch Apache from the XAMPP Control Panel, also click "Stop" there
echo and uncheck the "Module" autostart box for Apache.
pause
endlocal
