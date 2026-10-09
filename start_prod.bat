@echo off
setlocal
rem Run from the repo root regardless of the caller's working directory.
cd /d "%~dp0"

echo Building and starting in production mode...
echo.

rem Use pnpm, never npx. npx falls back to downloading from the registry
rem when a local binary is missing, which silently swaps in a different
rem major version (e.g. next@16 over the locked next@15) and produces
rem errors that look nothing like the real cause. pnpm fails loudly.
rem
rem `pnpm build` is turbo build, which honors dependsOn ^build and so
rem compiles shared -> api -> web in order.
echo [1/3] Building shared, api and web...
call pnpm build
if errorlevel 1 goto :buildfailed

rem Runs from TypeScript source via tsx, not the compiled dist/. That's not a
rem shortcut: @utility-cis/shared exports ./src/index.ts, whose relative
rem imports are extensionless, so plain `node dist/server.js` cannot resolve
rem them. --env-file is what the old npx line was missing, and without it
rem DATABASE_URL defaulted to "" (see packages/api/src/config.ts).
echo [2/3] Starting API (port 3001)...
start "CIS API" cmd /c "pnpm --filter @utility-cis/api exec tsx --env-file=.env src/server.ts"

echo [3/3] Starting Web (port 3000)...
start "CIS Web" cmd /c "pnpm --filter @utility-cis/web start"

echo.
echo Both services starting:
echo   API: http://localhost:3001
echo   Web: http://localhost:3000
echo.
echo Note: background workers are not started here. Run them with
echo   pnpm --filter @utility-cis/api start:worker
goto :end

:buildfailed
echo.
echo BUILD FAILED - no services were started.
echo Fix the errors above and re-run.
exit /b 1

:end
endlocal
