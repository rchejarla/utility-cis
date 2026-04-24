-- Row Level Security for the Module 14 (Service Requests) tables.
--
-- Same pattern as the base RLS migration (20260423021700_rls_policies):
-- every tenant-scoped table gets a `tenant_isolation` policy that
-- matches on `utility_id = current_setting('app.current_utility_id')`.
-- The API sets that session setting from the JWT claim on each
-- request, so a service-layer bug can't leak rows cross-tenant — the
-- DB itself refuses to return them.
--
-- `service_request_type_def` mirrors `suspension_type_def`: rows with
-- utility_id IS NULL are global (seeded once, visible to every
-- tenant), rows with a utility_id set are tenant-local shadows of a
-- same-code global. The policy permits both cases.
--
-- `service_request_counter` is session-scoped per tenant and is
-- locked inside createServiceRequest via SELECT ... FOR UPDATE, so
-- the same isolation policy applies.

-- ─── Enable RLS ─────────────────────────────────────────────────────

ALTER TABLE service_request_type_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request_counter  ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request          ENABLE ROW LEVEL SECURITY;

-- ─── Tenant isolation ───────────────────────────────────────────────

CREATE POLICY tenant_isolation ON sla
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON service_request_counter
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON service_request
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

-- Global-or-tenant exception, matching suspension_type_def.
CREATE POLICY tenant_isolation ON service_request_type_def
  USING (
    utility_id IS NULL
    OR utility_id = current_setting('app.current_utility_id')::uuid
  );
