-- The platform actor is a row RLS was hiding from the query that reads it.
--
-- `cis_user.utility_id` is nullable, and the platform actor is *defined*
-- as the row where it is null (tenancy note Q2): it holds no user_role,
-- because being the platform actor is the authority. Its policy was
--
--   USING (utility_id = current_setting('app.current_utility_id')::uuid)
--
-- with no NULL branch. So the moment RLS binds, `getPlatformActor`
-- cannot read the one row that authorises all 24 platform routes, and
-- every one of them answers 403 — for a reason indistinguishable from
-- the role split itself failing.
--
-- Same shape as the global reference tables: the NULL branch, and
-- `nullif(..., '')` so an empty setting behaves like an unset one. This
-- widens the policy by exactly one row shape — the tenant-less user —
-- and a tenant still sees only its own staff beside it.
DROP POLICY "tenant_isolation" ON "cis_user";
CREATE POLICY "tenant_isolation" ON "cis_user"
  USING (
    "utility_id" IS NULL
    OR "utility_id" = (nullif(current_setting('app.current_utility_id', true), ''))::uuid
  );
