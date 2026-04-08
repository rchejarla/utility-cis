@echo off
echo Building and starting in production mode...
echo.

echo [1/3] Building shared package...
cd packages\shared
call npx tsc --build 2>nul

echo [2/3] Starting API (port 3001)...
cd ..\api
start "CIS API" cmd /c "npx tsx src/server.ts"

echo [3/3] Building and starting Web (port 3000)...
cd ..\web
call npx next build
start "CIS Web" cmd /c "npx next start"

cd ..\..
echo.
echo Both services starting:
echo   API: http://localhost:3001
echo   Web: http://localhost:3000
