@echo off
echo Stopping PostgreSQL + Redis...
docker compose down
echo.
echo Database stopped. Data is preserved.
echo To wipe all data, run: docker compose down -v
