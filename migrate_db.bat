@echo off
setlocal
rem Apply pending Prisma migrations to the dev database.
rem
rem Run from the repo root regardless of the caller's working directory:
rem the Prisma CLI reads .env from the current directory, and the root
rem .env is the one carrying the dev DATABASE_URL.
cd /d "%~dp0"

rem A DATABASE_URL already in the environment takes precedence over .env,
rem and shells in this workspace sometimes carry one pointing at another
rem project. Applying migrations to the wrong database writes schema
rem changes into it that nothing will undo. setlocal scopes this clear to
rem this script; the caller's shell is not modified.
if defined DATABASE_URL (
  echo [warn] Ignoring a DATABASE_URL inherited from your shell.
  echo        .env is authoritative for this script.
  echo        Unset it in your shell if you meant to pick the database.
  echo.
  set "DATABASE_URL="
)

set "PRISMA=.\packages\shared\node_modules\.bin\prisma"
set "SCHEMA=packages\shared\prisma\schema.prisma"

if not exist "%PRISMA%.CMD" (
  echo [error] Prisma CLI not found at %PRISMA%
  echo         Run: pnpm install
  goto :failed
)

echo Checking what is pending...
call "%PRISMA%" migrate status --schema "%SCHEMA%"
echo.
echo Applying pending migrations...
echo Note: some migrations add PostgreSQL enum values, which cannot be
echo       removed again. This is forward-only.
echo.
call "%PRISMA%" migrate deploy --schema "%SCHEMA%"
if errorlevel 1 goto :failed
echo.
echo Done. Restart the API so Prisma reconnects:
echo   stop_services.bat  then  start_dev.bat
goto :end

:failed
echo.
echo MIGRATION FAILED - see the error above.
echo.
echo If it reports a FAILED migration, Prisma refuses to apply anything
echo further until that one is resolved:
echo   prisma migrate resolve --rolled-back ^<migration_name^>   (it never applied)
echo   prisma migrate resolve --applied     ^<migration_name^>   (it did apply)
echo.
echo If it reports drift, check which database you are pointed at:
echo   docker exec utility-cis-db-1 psql -U cis -d utility_cis -c "select current_database()"
endlocal
exit /b 1

:end
endlocal
