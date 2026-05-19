@echo off
REM ============================================================
REM YNT Dashboard - uninstall the Windows service.
REM Run this file as Administrator.
REM ============================================================

setlocal
net session >nul 2>&1
if errorlevel 1 (
  echo [error] Run this script as Administrator.
  pause
  exit /b 1
)

where nssm >nul 2>&1 && set "NSSM=nssm" || set "NSSM=%~dp0nssm.exe"
if not exist "%NSSM%" if not "%NSSM%"=="nssm" (
  echo [error] nssm.exe not found.
  pause
  exit /b 1
)

"%NSSM%" stop YNTDashboard
"%NSSM%" remove YNTDashboard confirm

netsh advfirewall firewall delete rule name="YNT Dashboard 80" >nul 2>&1

echo Service removed.
pause
endlocal
