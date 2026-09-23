@echo off
setlocal
set "APP_MODE=%~1"
if not "%APP_MODE%"=="demo" if not "%APP_MODE%"=="local" exit /b 1
where docker >nul 2>&1
if errorlevel 1 (
  echo Install Docker Desktop and enable Linux containers first.
  pause
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  echo Start Docker Desktop, wait until it is ready, then run this file again.
  pause
  exit /b 1
)
if not exist ".env" (
  powershell -NoProfile -Command "$bytes = New-Object byte[] 32; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose(); ('POSTGRES_PASSWORD=' + [Convert]::ToBase64String($bytes)) | Set-Content -LiteralPath '.env' -Encoding ascii"
  if errorlevel 1 (
    echo Cannot create the local database configuration. Check folder permissions.
    pause
    exit /b 1
  )
)
echo Starting MailControl M1 in %APP_MODE% mode. The first build requires internet access.
echo M1 cannot send accounts or connect to Mail SMTP.
docker compose up -d --build --wait --wait-timeout 120
if errorlevel 1 (
  echo Startup failed. Read the message above; your saved data has not been deleted.
  echo Useful command: docker compose logs --tail=80 app db
  pause
  exit /b 1
)
echo Open http://localhost:3000 in your browser.
start "MailControl" "http://localhost:3000"
pause
