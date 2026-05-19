@echo off
REM ============================================================
REM YNT Dashboard - install Node/Express as a Windows service
REM Run this file as Administrator (right-click -> Run as administrator).
REM
REM Prerequisite: NSSM must be installed and on PATH.
REM   Download: https://nssm.cc/download
REM   Place nssm.exe somewhere on PATH (e.g. C:\Windows\System32\)
REM   or in the same folder as this script.
REM ============================================================

setlocal

REM --- admin check -------------------------------------------------
net session >nul 2>&1
if errorlevel 1 (
  echo [error] This script must be run as Administrator.
  echo Right-click the file and pick "Run as administrator".
  pause
  exit /b 1
)

REM --- locate nssm -------------------------------------------------
where nssm >nul 2>&1
if errorlevel 1 (
  if exist "%~dp0nssm.exe" (
    set "NSSM=%~dp0nssm.exe"
  ) else (
    echo [error] nssm.exe not found on PATH and not next to this script.
    echo Download from https://nssm.cc/download and try again.
    pause
    exit /b 1
  )
) else (
  set "NSSM=nssm"
)

REM --- locate node -------------------------------------------------
for /f "delims=" %%i in ('where node 2^>nul') do set "NODE_EXE=%%i" & goto :have_node
echo [error] node.exe not found on PATH. Install Node.js 22+ first.
pause
exit /b 1
:have_node

REM --- paths -------------------------------------------------------
set "SERVICE_NAME=YNTDashboard"
set "BACKEND_DIR=%~dp0..\..\backend"
pushd "%BACKEND_DIR%"
set "BACKEND_DIR=%CD%"
popd
set "SERVER_JS=%BACKEND_DIR%\server.js"
set "LOG_DIR=%BACKEND_DIR%\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo.
echo Installing service "%SERVICE_NAME%"
echo   node:        %NODE_EXE%
echo   server.js:   %SERVER_JS%
echo   working dir: %BACKEND_DIR%
echo   logs:        %LOG_DIR%
echo.

REM --- remove any prior install so this script is idempotent -------
sc query %SERVICE_NAME% >nul 2>&1
if not errorlevel 1 (
  echo Existing service "%SERVICE_NAME%" found - removing before reinstall.
  "%NSSM%" stop %SERVICE_NAME% >nul 2>&1
  "%NSSM%" remove %SERVICE_NAME% confirm >nul 2>&1
)

REM --- install service ---------------------------------------------
"%NSSM%" install %SERVICE_NAME% "%NODE_EXE%" "--experimental-sqlite" "%SERVER_JS%"
if errorlevel 1 ( echo [error] nssm install failed. & pause & exit /b 1 )

"%NSSM%" set %SERVICE_NAME% AppDirectory "%BACKEND_DIR%"
"%NSSM%" set %SERVICE_NAME% AppEnvironmentExtra "PORT=80" "HOST=0.0.0.0" "NODE_ENV=production"
"%NSSM%" set %SERVICE_NAME% Start SERVICE_AUTO_START
"%NSSM%" set %SERVICE_NAME% AppStdout "%LOG_DIR%\stdout.log"
"%NSSM%" set %SERVICE_NAME% AppStderr "%LOG_DIR%\stderr.log"
"%NSSM%" set %SERVICE_NAME% AppRotateFiles 1
"%NSSM%" set %SERVICE_NAME% AppRotateBytes 10485760
"%NSSM%" set %SERVICE_NAME% Description "YNT Dashboard (Node.js + Express)"

REM --- open firewall on port 80 ------------------------------------
netsh advfirewall firewall delete rule name="YNT Dashboard 80" >nul 2>&1
netsh advfirewall firewall add rule name="YNT Dashboard 80" dir=in action=allow protocol=TCP localport=80
if errorlevel 1 echo [warn] could not add firewall rule - add it manually if LAN clients can't connect.

REM --- start -------------------------------------------------------
"%NSSM%" start %SERVICE_NAME%
echo.
echo Service installed and started. Manage it with:
echo   nssm status %SERVICE_NAME%
echo   nssm stop %SERVICE_NAME%
echo   nssm start %SERVICE_NAME%
echo Logs:  %LOG_DIR%
echo.
pause
endlocal
