@echo off
setlocal
REM First-time database setup.
REM Starts the Postgres + Redis containers, then applies every migration in
REM packages/shared/prisma/migrations in order via `prisma migrate deploy`.
REM Run seed_db.bat afterwards to populate dev data.

REM prisma.config.ts reads process.env.DATABASE_URL and says so ("Prisma
REM config detected, skipping environment variable loading"), so a
REM DATABASE_URL inherited from your shell wins over packages/shared/.env
REM and this script would run migrations against that database instead.
REM setlocal scopes this clear to this script.
if defined DATABASE_URL (
  echo [warn] Ignoring a DATABASE_URL inherited from your shell.
  echo        packages/shared/.env is authoritative for this script.
  echo        Unset it in your shell if you meant to pick the database.
  echo.
  set "DATABASE_URL="
)

echo Starting containers...
docker compose up -d

echo Waiting for PostgreSQL to be ready...
:wait_loop
docker compose exec -T db pg_isready -U postgres -d utility_cis >nul 2>&1
if errorlevel 1 (
  timeout /t 2 /nobreak >nul
  goto wait_loop
)

echo Applying Prisma migrations...
cd packages\shared
call npx prisma migrate deploy
cd ..\..

echo.
echo Database setup complete!
echo Run seed_db.bat next to populate dev data.
endlocal
