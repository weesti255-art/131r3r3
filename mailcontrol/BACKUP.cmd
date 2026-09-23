@echo off
setlocal
cd /d "%~dp0"
set "APP_MODE=%~1"
if "%APP_MODE%"=="" set "APP_MODE=local"
if not "%APP_MODE%"=="demo" if not "%APP_MODE%"=="local" (
  echo Usage: BACKUP.cmd [local^|demo]
  pause
  exit /b 1
)
for /f "tokens=1-3 delims=/.- " %%a in ("%date%") do set "STAMP=%%c%%b%%a"
set "STAMP=%STAMP%-%time:~0,2%%time:~3,2%"
set "STAMP=%STAMP: =0%"
set "OUT=backups\mailcontrol-%APP_MODE%-%STAMP%"
if not exist backups mkdir backups
echo Creating backup %OUT%.dump and %OUT%.key (%APP_MODE% mode)...
docker compose exec -T db pg_dump -U mailcontrol -d mailcontrol -Fc > "%OUT%.dump"
if errorlevel 1 (
  echo Backup failed. Is MailControl running in %APP_MODE% mode?
  del "%OUT%.dump" >nul 2>&1
  pause
  exit /b 1
)
docker compose cp app:/var/lib/mailcontrol/mailcontrol.key "%OUT%.key"
if errorlevel 1 (
  echo The encryption key was not copied. Without it saved account passwords cannot be decrypted after a restore.
  pause
  exit /b 1
)
echo Done. Keep BOTH files together and away from other people: the key file decrypts account passwords.
pause
