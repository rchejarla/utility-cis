-- One failure mode for a tenant table, and it is loud.
--
-- 21 policies used the two-argument `current_setting(..., true)`, which
-- returns NULL when the setting has never been set — and
-- `utility_id = NULL` matches no row. So the table answered with nothing
-- and no error, which for `ledger_entry`, `bill` or `billing_run` reads
-- as "there is nothing here". The one-argument form raises instead.
--
-- Scope is the 21 TENANT tables, not all 26 two-argument policies. The
-- other five are global reference tables whose rows belong to no tenant
-- and match through an `utility_id IS NULL` branch; making those raise
-- would break a legitimate read of data every tenant shares.
--
-- Generated from pg_policies rather than a hand-typed list, and the
-- predicate below is the classification: two-argument, and no IS NULL
-- branch. `utility` is in this set and is keyed on `id` rather than
-- `utility_id`, because the utility row IS the tenant — so the column is
-- derived per table rather than assumed.
DO $$
DECLARE p record;
DECLARE col text;
BEGIN
  FOR p IN
    SELECT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND qual LIKE '%, true)%'
       AND qual NOT LIKE '%IS NULL%'
  LOOP
    SELECT CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = p.tablename
                AND column_name = 'utility_id'
           ) THEN 'utility_id' ELSE 'id' END
      INTO col;

    EXECUTE format('DROP POLICY %I ON %I', p.policyname, p.tablename);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (%I = (current_setting(''app.current_utility_id''))::uuid)',
      p.policyname, p.tablename, col);
  END LOOP;
END $$;

-- And the other half of the same problem, which only showed up under
-- test: a transaction-local `set_config(..., true)` does not disappear
-- when its transaction commits. The parameter persists on that session
-- as the EMPTY STRING. So on any pooled connection that has ever served
-- a tenant, `current_setting('app.current_utility_id', true)` returns
-- '' rather than NULL, and `''::uuid` raises 22P02 — including on the
-- global reference tables, whose `IS NULL` branch would otherwise have
-- matched. PostgreSQL does not guarantee it short-circuits the OR.
--
-- `nullif(..., '')` makes "unset" and "empty" the same thing again, so a
-- row belonging to no tenant stays readable either way. These tables
-- keep the two-argument form deliberately: they are the case where
-- answering without a tenant is correct rather than dangerous.
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public' AND qual LIKE '%IS NULL%'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I', p.policyname, p.tablename);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ('
      || 'utility_id IS NULL OR '
      || 'utility_id = (nullif(current_setting(''app.current_utility_id'', true), ''''))::uuid)',
      p.policyname, p.tablename);
  END LOOP;
END $$;
