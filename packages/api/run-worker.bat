@echo off
setlocal
REM Dev launcher for the BullMQ worker process.
REM
REM Connection settings come from packages/api/.env and are NOT repeated
REM here. This script used to `set` DATABASE_URL, REDIS_URL, PORT,
REM WEB_URL, NEXTAUTH_SECRET and ENABLE_DEV_AUTH_ENDPOINTS itself, and
REM told the reader to keep both copies in step by hand. They went out of
REM step: .env was pointed at 127.0.0.1 after a stale WSL relay was found
REM squatting IPv6 loopback for 5432 and 6379, and this file kept sending
REM the worker to `localhost` — straight back into the broken listener.
REM
REM Node's --env-file will not overwrite a variable already present in
REM the environment, so anything set here silently outranks .env. The only
REM variables set below are the ones .env does not carry.
cd /d "%~dp0"

REM The original reason those `set` lines existed: a shell carrying
REM another project's DATABASE_URL beats --env-file, and the worker then
REM runs against the wrong database while looking healthy. Clearing is the
REM better answer than overriding — it lets .env win, and setlocal scopes
REM the clear to this script rather than editing the caller's shell (which
REM the old version did, having no setlocal at all).
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

REM Worker-specific, and absent from .env because only this process reads
REM them:
REM   WORKER_QUEUES      — "all" or a comma-list gating which queues this
REM                        replica serves. In prod you would run a replica
REM                        per queue; in dev one process takes everything.
REM   WORKER_HTTP_PORT   — health endpoint; must differ from the API's PORT.
REM   DISABLE_SCHEDULERS — true skips the whole bootstrap and exits, which
REM                        is how tests import this module just to read the
REM                        scheduler registry.
set WORKER_QUEUES=all
set WORKER_HTTP_PORT=3002
set DISABLE_SCHEDULERS=false

echo Starting the worker in dev mode.
echo   queues:   %WORKER_QUEUES%
echo   health:   http://localhost:%WORKER_HTTP_PORT%/health
echo   database and redis: from packages/api/.env
echo.
echo This process is what drains the queues — billing runs, imports,
echo notifications, delinquency sweeps and service-hold transitions.
echo start_dev.bat does not start it; without it a billing run stays
echo PENDING and nothing bills.
echo.
call pnpm dev:worker
endlocal
