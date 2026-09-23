@echo off
setlocal
cd /d "%~dp0"
if "%~2"=="" (
  echo Usage: RESTORE.cmd path\to\backup.dump path\to\backup.key [local^|demo]
  echo Restores the database and the encryption key into the chosen mode. Current data in that mode is REPLACED.
  pause
  exit /b 1
)
set "APP_MODE=%~3"
if "%APP_MODE%"=="" set "APP_MODE=local"
if not exist "%~1" ( echo Dump file not found: %~1 & pause & exit /b 1 )
if not exist "%~2" ( echo Key file not found: %~2 & pause & exit /b 1 )
echo This REPLACES all MailControl data in %APP_MODE% mode with the backup.
set /p CONFIRM=Type YES to continue: 
if not "%CONFIRM%"=="YES" ( echo Cancelled. & pause & exit /b 1 )
docker compose stop app worker
docker compose up -d --wait --wait-timeout 180 db
if errorlevel 1 goto :failed
docker compose exec -T db bash /mailcontrol/sync-app-role.sh
if errorlevel 1 goto :failed
docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U mailcontrol -d mailcontrol -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
if errorlevel 1 goto :failed
type "%~1" | docker compose exec -T db pg_restore -U mailcontrol -d mailcontrol --no-owner --no-privileges
if errorlevel 1 goto :failed
docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U mailcontrol -d mailcontrol -f /mailcontrol/after-restore.sql
if errorlevel 1 goto :failed
docker compose run --rm --no-deps -T --entrypoint sh app -c "cat > /var/lib/mailcontrol/mailcontrol.key && chmod 600 /var/lib/mailcontrol/mailcontrol.key" < "%~2"
if errorlevel 1 goto :failed
docker compose up -d --wait --wait-timeout 300 app worker
if errorlevel 1 goto :failed
echo Restore complete. Campaigns that were running are PAUSED: reconcile already sent letters before continuing.
start "MailControl" "http://localhost:3000"
pause
exit /b 0
:failed
echo Restore failed. Recent logs:
docker compose logs --tail=30 --no-color db app
pause
exit /b 1
