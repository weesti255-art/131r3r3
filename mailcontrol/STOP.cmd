@echo off
setlocal
cd /d "%~dp0"
set "APP_MODE=local"
docker compose stop
set "APP_MODE=demo"
docker compose stop
if errorlevel 1 (
  echo Could not stop MailControl. Check that Docker Desktop is running.
) else (
  echo MailControl is stopped. Your data has NOT been deleted.
)
pause
