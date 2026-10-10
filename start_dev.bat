@echo off
setlocal
rem Run the app for DEVELOPMENT: next dev with hot reload, and the API
rem under `tsx watch` so it restarts itself on save. No build step.
rem
rem Use this while working. start_prod.bat is for checking the thing
rem actually builds and behaves under `next start` before shipping — it
rem has no watch, so every change there needs a full rebuild and restart.
cd /d "%~dp0"

rem An inherited DATABASE_URL silently wins over packages/api/.env: node's
rem --env-file does not override a variable that is already set, and
rem neither does `tsx watch`. A shell carrying another project's
rem DATABASE_URL therefore runs the API against that project's database
rem while /health keeps returning ok, because health never queries — so
rem the symptom is "the UI shows no data".
rem
rem setlocal scopes this clear to this script and the processes it starts.
if defined DATABASE_URL (
  echo [warn] Ignoring a DATABASE_URL inherited from your shell.
  echo        packages/api/.env is authoritative for this script.
  echo        Unset it in your shell if you meant to pick the database.
  echo.
  set "DATABASE_URL="
)

rem Nothing starts if Postgres is not up; say so rather than letting the
rem API fail its first query.
powershell -NoProfile -Command "if (Test-NetConnection -ComputerName localhost -Port 5432 -InformationLevel Quiet -WarningAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo PostgreSQL is not answering on localhost:5432.
  echo Run start_db.bat first, then try again.
  endlocal
  exit /b 1
)

call "%~dp0stop_services.bat"
if errorlevel 1 (
  echo.
  echo Not starting: the ports are still in use.
  endlocal
  exit /b 1
)

echo.
echo Starting in DEV mode - hot reload, no build.
echo   API: http://localhost:3001   (tsx watch, restarts on save)
echo   Web: http://localhost:3000   (next dev, hot module reload)
echo.
echo Both run in THIS window. Ctrl-C stops them.
echo Background workers are not started; run them with
echo   pnpm --filter @utility-cis/api dev:worker
echo.
call pnpm dev
endlocal
