@echo off
setlocal
set "APP_MODE=%~1"
if not "%APP_MODE%"=="demo" if not "%APP_MODE%"=="local" exit /b 1
if "%APP_MODE%"=="demo" (set "OTHER_MODE=local") else (set "OTHER_MODE=demo")
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
echo Starting MailControl in %APP_MODE% mode. The first build requires internet access.
echo Only one mode uses port 3000 at a time; the %OTHER_MODE% mode is stopped if it runs.
docker stop mailcontrol-%OTHER_MODE%-worker-1 mailcontrol-%OTHER_MODE%-app-1 mailcontrol-%OTHER_MODE%-db-1 >nul 2>&1
echo [1/2] Database (its access for the application is synchronised automatically)...
docker compose up -d --build --wait --wait-timeout 180 db
if errorlevel 1 goto :failed
echo [2/2] Application and sending process (the first build may take a few minutes)...
docker compose up -d --build --wait --wait-timeout 300 app worker
if errorlevel 1 goto :failed
echo.
echo MailControl is running: http://localhost:3000
if "%APP_MODE%"=="demo" echo Demo mode: sample data only, no connections to Mail.
if "%APP_MODE%"=="local" echo Real sending stays off until you enable it in the settings.
start "MailControl" "http://localhost:3000"
pause
exit /b 0

:failed
echo.
echo Startup failed. Your saved data has not been deleted. Recent logs:
docker compose logs --tail=40 --no-color db app worker
echo.
echo The warning "volume ... was created for project mailcontrol" is harmless: the old data volume is reused.
pause
exit /b 1
