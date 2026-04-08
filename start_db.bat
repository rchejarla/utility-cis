@echo off
echo Starting PostgreSQL + Redis...
docker compose up -d
echo.
echo Database running on localhost:5432
echo Redis running on localhost:6379
