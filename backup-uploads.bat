@echo off
rem Copies new File Uploads files from Supabase to this computer.
rem Settings: backend\scripts\.env.uploads-backup  (see backend\scripts\backup-uploads-local.js)
cd /d "%~dp0"
node backend\scripts\backup-uploads-local.js
