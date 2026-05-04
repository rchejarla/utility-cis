-- Rate Model v2 — Slice 4 Task 4
--
-- TenantSetting is a generic per-tenant key/value table backing the
-- TenantLoader. It holds the currently-declared drought_stage, named
-- flag toggles (`flags.<name>`), and any other scalar/JSON value the
-- rate engine needs to resolve at evaluation time.
--
-- Distinct from tenant_config (a single row of well-known scheduler /
-- runtime fields per tenant) — this is an open-ended (utility_id, name)
-- → JSON map. New keys can be introduced without a schema change; the
-- TenantLoader's capability list is the contract for which names are
-- meaningful to the rate engine.
--
-- RLS uses the standard per-tenant predicate. Every row is owned by
-- exactly one tenant (no globals).

CREATE TABLE tenant_setting (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id   UUID NOT NULL,
  name         VARCHAR(100) NOT NULL,
  value        JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tenant_setting_utility_id_name_key
  ON tenant_setting (utility_id, name);

CREATE INDEX tenant_setting_utility_id_idx
  ON tenant_setting (utility_id);

ALTER TABLE tenant_setting ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_setting
  USING (
    utility_id = current_setting('app.current_utility_id', true)::uuid
  );
