@echo off
REM Dev launcher for the API.
REM
REM Explicitly sets every env var the API reads at runtime, clobbering any
REM leaked-in values from the parent shell. Node's native --env-file and
REM tsx's --env-file both refuse to override vars already present in
REM process.env, so a stale DATABASE_URL in the shell silently wins over
REM the project .env. That bit us once while debugging "API returns 12
REM modules when DB has 19" — the API was connected to an unrelated
REM database the whole time. Setting vars directly here with `set` means
REM the dev launcher is the single source of truth and nothing can leak in.
REM
REM If any of these values change (e.g., a new env var the code reads),
REM update BOTH this file AND packages/api/.env. They're intentionally
REM duplicated: .env is what deployment tooling and tests reference,
REM run.bat is what the local dev loop uses.

set DATABASE_URL=postgresql://cis:cis_dev_password@localhost:5432/utility_cis
set REDIS_URL=redis://localhost:6379
set PORT=3001
set WEB_URL=http://localhost:3000
set NEXTAUTH_SECRET=dev-secret-change-in-production
set ENABLE_DEV_AUTH_ENDPOINTS=true

echo Flushing Redis cache...
docker compose --project-directory ..\.. exec -T redis redis-cli FLUSHALL >nul 2>&1
if errorlevel 1 (
  echo   WARN: could not reach redis container — continuing anyway
) else (
  echo   OK
)

echo Starting API in dev mode with:
echo   DATABASE_URL=%DATABASE_URL%
echo   PORT=%PORT%
echo   ENABLE_DEV_AUTH_ENDPOINTS=%ENABLE_DEV_AUTH_ENDPOINTS%
pnpm dev