@echo off
rem Stop whatever is serving ports 3000 (web) and 3001 (api), and wait for
rem the ports to actually free.
rem
rem Identified by PORT, not by PID: a stale PID either kills nothing or
rem kills something else entirely. Called by both start_dev.bat and
rem restart_prod.bat so the logic lives in one place — two copies of it
rem would drift the way every other duplicated list in this repo has.
rem
rem Usable on its own when you just want the app to stop.
setlocal

echo Stopping API (3001) and Web (3000)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ids = Get-NetTCPConnection -State Listen -LocalPort 3000,3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($ids) { foreach ($id in $ids) { $n = (Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName; Write-Host ('  stopping PID ' + $id + ' (' + $n + ')'); Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } } else { Write-Host '  nothing was listening' }"

rem A freed port is not instant, and a new service cannot bind to a port
rem the old one still holds — which looks like a broken build rather than
rem a race. Bounded, so a process that refuses to die reports itself.
set /a _tries=0
:waitports
powershell -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort 3000,3001 -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if not errorlevel 1 goto portsfree
set /a _tries+=1
if %_tries% GEQ 15 goto stuck
timeout /t 1 /nobreak >nul
goto waitports

:stuck
echo.
echo PORTS STILL IN USE after 15 seconds. Something is holding 3000 or 3001
echo and would stop a new service binding. Find it with:
echo   Get-NetTCPConnection -State Listen -LocalPort 3000,3001
endlocal
exit /b 1

:portsfree
echo   Ports free.
endlocal
exit /b 0
