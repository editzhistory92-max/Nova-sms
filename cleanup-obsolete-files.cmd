@echo off
REM Remove obsolete Railway/SMPP files from Windows local repo after extracting update.
if exist RAILWAY_DEPLOYMENT.md del /f /q RAILWAY_DEPLOYMENT.md
if exist RAILWAY_BACKUP_SETUP.txt del /f /q RAILWAY_BACKUP_SETUP.txt
REM SMPP runtime is removed. If you want to remove the old module file completely, uncomment next line.
REM if exist backend\smppServer.js del /f /q backend\smppServer.js
echo Cleanup done.
