@echo off
echo Seeding database with test data...
cd packages\shared
call npx tsx prisma/seed.ts
cd ..\..
echo.
echo Done! Restart the API to see the data.
