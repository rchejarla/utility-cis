@echo off
echo Starting containers...
docker compose up -d

echo Waiting for PostgreSQL to be ready...
timeout /t 5 /nobreak >nul

echo Pushing Prisma schema...
cd packages\shared
call npx prisma db push

echo Applying RLS policies and TimescaleDB hypertable...
type prisma\migrations\00_rls_policies\migration.sql | docker compose exec -T postgres psql -U cis -d utility_cis

echo Applying CHECK constraints...
type prisma\migrations\01_check_constraints\migration.sql | docker compose exec -T postgres psql -U cis -d utility_cis

cd ..\..
echo.
echo Database setup complete!
