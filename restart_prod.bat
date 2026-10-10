@echo off
setlocal
rem Stop the app, then build and start it again in PRODUCTION mode.
rem
rem For a smoke test before shipping: `next start` over a real build, no
rem watch. If you are iterating on code, use start_dev.bat instead — this
rem rebuilds everything on every run by design.
cd /d "%~dp0"

call "%~dp0stop_services.bat"
if errorlevel 1 (
  echo.
  echo Nothing was started.
  endlocal
  exit /b 1
)

echo.
call "%~dp0start_prod.bat"
endlocal
