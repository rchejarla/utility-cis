@echo off
setlocal
REM Dev launcher for the API on its own. Most of the time you want
REM start_dev.bat in the repo root, which starts the API and the web app
REM together and stops whatever is already holding the ports.
REM
REM Connection settings come from packages/api/.env and are NOT repeated
REM here. This file used to `set` DATABASE_URL, REDIS_URL, PORT, WEB_URL,
REM NEXTAUTH_SECRET and ENABLE_DEV_AUTH_ENDPOINTS, on the stated grounds
REM that ".env is what deployment tooling and tests reference, run.bat is
REM what the local dev loop uses". That stopped being true when
REM start_dev.bat arrived and read .env — leaving this as a third copy of
REM the connection strings, kept in step by hand. It drifted: .env was
REM pointed at 127.0.0.1 after a stale WSL relay was found squatting IPv6
REM loopback for 5432 and 6379, and this file still said `localhost`,
REM which is the broken listener.
cd /d "%~dp0"

REM The real problem those `set` lines were solving is worth keeping: a
REM shell carrying another project's DATABASE_URL beats --env-file, which
REM Node and tsx both refuse to override. That cost an afternoon once to
REM "API returns 12 modules when the DB has 19" — the API was connected to
REM an unrelated database the whole time. Clearing beats overriding,
REM because it lets .env win, and setlocal keeps the clear inside this
REM script instead of editing the caller's shell (the old version had no
REM setlocal, so its `set` lines leaked out of it).
if defined DATABASE_URL (
  echo [warn] Ignoring a DATABASE_URL inherited from your shell.
  echo        packages/api/.env is authoritative for this script.
  echo.
  set "DATABASE_URL="
)
if defined REDIS_URL (
  echo [warn] Ignoring a REDIS_URL inherited from your shell.
  echo.
  set "REDIS_URL="
)

echo Flushing Redis cache...
docker compose --project-directory ..\.. exec -T redis redis-cli FLUSHALL >nul 2>&1
if errorlevel 1 (
  echo   WARN: could not reach redis container - continuing anyway
) else (
  echo   OK
)

echo Starting the API in dev mode.
echo   api:      http://localhost:3001
echo   database and redis: from packages/api/.env
echo.
echo Background workers are not started here. Run them with
echo   pnpm --filter @utility-cis/api dev:worker
echo or packages/api/run-worker.bat. Without one, a billing run stays
echo PENDING and nothing bills.
echo.
call pnpm dev
endlocal
