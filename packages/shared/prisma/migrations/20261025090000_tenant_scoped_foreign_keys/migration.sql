-- Put the tenant in the foreign key, so a row in one tenant cannot
-- point at a row in another.
--
-- Row-level security cannot close this and never could. Its policies
-- filter which rows a query *reads*, and a foreign key is not a read:
-- PostgreSQL's referential-integrity checks run as the table owner and
-- are exempt from RLS. So `service_agreement.account_id -> account(id)`
-- is satisfied by an account the acting tenant cannot see, and a
-- mismatched pair is writable today — measured, not assumed, in
-- `cross-tenant-fk.integration.test.ts`, which this migration turns
-- green.
--
-- Nothing in this product wants a cross-tenant relationship. Both rows
-- of every one of these keys are meant to belong to the same tenant;
-- the key named the id and not the tenant, so nothing said so. Four
-- things could write a bad pair: a route taking an id from a request
-- body (`POST /notifications/send` did exactly that before 2026-10-17),
-- an ordinary bug passing the wrong id between services, anything on
-- `cis_platform`, which bypasses RLS by design, and a seed or script run
-- as the owner. The damage is quiet: the child carries its own tenant,
-- so that tenant's reads show it and the joined parent comes back empty
-- — broken-looking rather than leaky, until a platform-authority read
-- joins the two and surfaces the other tenant's row.
--
-- Driven from the catalog rather than written out 64 times. A hand list
-- would be wrong the first time a relation was added and would have to
-- restate every `ON DELETE` action correctly; this derives both, and
-- states the rule it is applying instead of its consequences.
--
-- The rule: for every single-column foreign key whose child and parent
-- both carry a NOT NULL `utility_id`, the key becomes
-- `(utility_id, <fk>) -> parent (utility_id, id)`.
--
-- Deliberately out of scope:
--   * keys pointing at `utility` itself — it has no `utility_id`, its
--     own `id` is the tenant;
--   * keys pointing at the global reference tables, whose `utility_id`
--     is nullable because NULL means "belongs to no tenant". A
--     composite key there would refuse every global row, since a
--     child's tenant can never equal NULL.

DO $$
DECLARE
  fk record;
  parent_name text;
  del_action text;
BEGIN
  -- 1. Each rewritten key needs its parent's (utility_id, id) to be
  --    unique, or PostgreSQL has nothing to reference. Added only to
  --    tables that are actually a target, rather than to all 54.
  FOR parent_name IN
    SELECT DISTINCT parent.relname
      FROM pg_constraint con
      JOIN pg_class child  ON child.oid  = con.conrelid
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace n  ON n.oid      = child.relnamespace
     WHERE con.contype = 'f'
       AND n.nspname = 'public'
       AND array_length(con.conkey, 1) = 1
       AND EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = child.oid  AND attname = 'utility_id' AND attnotnull)
       AND EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = parent.oid AND attname = 'utility_id' AND attnotnull)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = parent_name
         AND c.contype IN ('u', 'p')
         AND c.conkey @> ARRAY[
               (SELECT attnum FROM pg_attribute
                 WHERE attrelid = t.oid AND attname = 'utility_id'),
               (SELECT attnum FROM pg_attribute
                 WHERE attrelid = t.oid AND attname = 'id')
             ]::smallint[]
         AND array_length(c.conkey, 1) = 2
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (utility_id, id)',
        parent_name, parent_name || '_utility_id_id_key');
    END IF;
  END LOOP;

  -- 2. Rewrite each key, keeping its name and its referential actions.
  FOR fk IN
    SELECT con.conname,
           child.relname  AS child,
           parent.relname AS parent,
           att.attname    AS fk_col,
           con.confdeltype
      FROM pg_constraint con
      JOIN pg_class child  ON child.oid  = con.conrelid
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace n  ON n.oid      = child.relnamespace
      JOIN pg_attribute att ON att.attrelid = con.conrelid
                           AND att.attnum   = con.conkey[1]
     WHERE con.contype = 'f'
       AND n.nspname = 'public'
       AND array_length(con.conkey, 1) = 1
       AND EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = child.oid  AND attname = 'utility_id' AND attnotnull)
       AND EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = parent.oid AND attname = 'utility_id' AND attnotnull)
  LOOP
    /*
     * `SET NULL` has to name its column. On a composite key the
     * unqualified form nulls every referencing column, `utility_id`
     * among them — and that column is NOT NULL, so the delete would
     * fail at runtime instead of clearing the reference. The
     * column-list form is PostgreSQL 15+; this schema requires 16 for
     * the hypertable anyway.
     */
    del_action := CASE fk.confdeltype
      WHEN 'a' THEN 'NO ACTION'
      WHEN 'r' THEN 'RESTRICT'
      WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN format('SET NULL (%I)', fk.fk_col)
      WHEN 'd' THEN 'SET DEFAULT'
    END;

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', fk.child, fk.conname);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (utility_id, %I) '
      || 'REFERENCES %I (utility_id, id) ON DELETE %s',
      fk.child, fk.conname, fk.fk_col, fk.parent, del_action);
  END LOOP;
END $$;
