@echo off
REM Dev launcher for the BullMQ worker process.
REM
REM Same env-clobbering rationale as run.bat — Node's --env-file refuses
REM to override vars already in process.env, so a stale DATABASE_URL in
REM the parent shell would silently win over .env. Setting them directly
REM here keeps this script the single source of truth for the dev loop.
REM
REM Worker-specific vars:
REM   WORKER_QUEUES        — "all" (default) or a comma-list to gate which
REM                          queues this replica subscribes to. In prod
REM                          you'd run separate replicas per queue.
REM   WORKER_HTTP_PORT     — health endpoint port; must differ from PORT.
REM   DISABLE_SCHEDULERS   — when true, skips queue + scheduler bootstrap
REM                          and exits (used by tests that import the
REM                          worker module just to read the registry).
REM
REM If any of these change, update BOTH this file AND packages/api/.env.

set DATABASE_URL=postgresql://cis:cis_dev_password@localhost:5432/utility_cis
set REDIS_URL=redis://localhost:6379
set PORT=3001
set WEB_URL=http://localhost:3000
set NEXTAUTH_SECRET=dev-secret-change-in-production
set ENABLE_DEV_AUTH_ENDPOINTS=true
set WORKER_QUEUES=all
set WORKER_HTTP_PORT=3002
set DISABLE_SCHEDULERS=false

echo Starting worker in dev mode with:
echo   DATABASE_URL=%DATABASE_URL%
echo   REDIS_URL=%REDIS_URL%
echo   WORKER_QUEUES=%WORKER_QUEUES%
echo   WORKER_HTTP_PORT=%WORKER_HTTP_PORT%
pnpm dev:worker
