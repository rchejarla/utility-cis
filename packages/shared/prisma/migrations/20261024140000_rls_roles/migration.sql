-- Two roles the policies can actually bind to, and FORCE so ownership
-- cannot quietly undo it.
--
-- Until now one role did everything: `cis` owns every table, runs the
-- migrations and serves the application, and it is a SUPERUSER.
-- PostgreSQL exempts a superuser from row-level security, and exempts a
-- table's owner independently of that — so the 62 policies have never
-- once been applied. Dropping SUPERUSER alone would not have helped,
-- because `cis` would still own the tables.
--
--   cis           keeps the schema and runs migrations. Still superuser.
--   cis_app       the application. Neither owner nor superuser, so RLS
--                 applies. DML only.
--   cis_platform  the paths that cross tenants by design — the platform
--                 console's 24 routes and the 6 all-tenants queues.
--                 BYPASSRLS.
--
-- BYPASSRLS on a separate role rather than an `OR current_setting(...)`
-- escape hatch in every policy: a hatch is reachable from any code path
-- that can set a GUC, which puts the invariant straight back into
-- application code remembering something. A role is enforced by
-- PostgreSQL and cannot be assumed from SQL.
--
-- NOLOGIN and no password here. Credentials are not a migration's
-- business: `docker/init-cis-user.sh` grants LOGIN and a dev password,
-- and production provisions its own. NOLOGIN is enough for `SET ROLE`,
-- which is how the tests exercise them.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cis_app') THEN
    CREATE ROLE cis_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cis_platform') THEN
    CREATE ROLE cis_platform NOLOGIN;
  END IF;
END $$;

-- Only a superuser may grant this, and `cis` is one; it stays one as the
-- owner/migrator after the application moves off it.
ALTER ROLE cis_platform BYPASSRLS;

GRANT USAGE ON SCHEMA public TO cis_app, cis_platform;

-- DML, never DDL. Neither role may create, alter or drop anything, so
-- neither can grant itself a way around a policy.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO cis_app, cis_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO cis_app, cis_platform;

-- Tables a later migration creates are covered without a second grant
-- pass. Default privileges attach to the role that creates the object,
-- and `FOR ROLE` is omitted deliberately so that role is whoever runs
-- the migration: `cis` in dev and production, but `postgres` in the
-- testcontainer, which has no `cis` at all. Naming `cis` explicitly
-- failed every integration suite with `role "cis" does not exist` —
-- bootPostgres runs `migrate deploy` for all of them.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cis_app, cis_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cis_app, cis_platform;

-- FORCE on every table that has a policy. Generated rather than a
-- hand-typed list of 62, so a table added later with RLS but no FORCE is
-- caught by the invariant test instead of living here as a stale list.
--
-- This changes nothing today: `cis` is still a superuser and a superuser
-- is exempt from FORCE as well. It matters the moment the application
-- connects as `cis_app`, and it means a future migration that makes
-- `cis_app` an owner of something cannot silently re-open the hole.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relrowsecurity
       AND NOT c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;
