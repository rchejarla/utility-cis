#!/bin/bash
# Runs once on first container init (placed in /docker-entrypoint-initdb.d/).
# Creates the `cis` application role that the DATABASE_URL expects and grants
# it ownership of utility_cis. Idempotent so repeat runs don't fail.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "postgres" <<-EOSQL
  DO \$\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cis') THEN
      CREATE ROLE cis WITH LOGIN PASSWORD 'cis_dev_password';
    END IF;
  END \$\$;

  ALTER DATABASE utility_cis OWNER TO cis;
  GRANT ALL PRIVILEGES ON DATABASE utility_cis TO cis;
  ALTER ROLE cis SUPERUSER;
EOSQL
