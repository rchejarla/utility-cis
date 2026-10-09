@echo off
setlocal
rem Run from the repo root regardless of the caller's working directory,
rem because seed.js requires ./packages/shared/src/generated/prisma by
rem relative path.
cd /d "%~dp0"

rem seed.js DELETES before it inserts, so pointing it at the wrong database
rem destroys that database's data. The Prisma client loads .env at runtime,
rem but a DATABASE_URL already in the environment takes precedence over it
rem — so a shell carrying another project's DATABASE_URL would wipe that
rem project. setlocal scopes this clear to this script; the caller's shell
rem is not modified.
if defined DATABASE_URL (
  echo [warn] Ignoring a DATABASE_URL inherited from your shell.
  echo        packages/shared/.env is authoritative for this script.
  echo        Unset it in your shell if you meant to pick the database.
  echo.
  set "DATABASE_URL="
)

echo Seeding database with test data...
node seed.js
if errorlevel 1 goto :failed
echo.
echo Done! Restart the API to see the data.
goto :end

:failed
echo.
echo SEEDING FAILED - see the error above. Nothing was left half-written:
echo seed.js runs its deletes and inserts in order and exits on the first
echo failure, so re-run it once the cause is fixed.
endlocal
exit /b 1

:end
endlocal
