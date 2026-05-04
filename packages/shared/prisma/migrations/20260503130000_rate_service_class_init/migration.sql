-- Rate Model v2 — Slice 1 Task 2
--
-- Per-tenant, per-commodity customer service class (Single Family,
-- Multi-Family, MSU, Commercial, ...). Distinct from
-- premise.premise_type (a physical-property classification) — this is
-- the billing classification consumed by the rate engine to select
-- which rate components apply to a service agreement.
--
-- Unlike rate_component_kind / rate_assignment_role, ServiceClass is
-- genuinely tenant-specific (Bozeman has "msu"; another muni
-- doesn't), so there are NO globals in this table — every row has a
-- populated utility_id. RLS uses the standard per-tenant predicate,
-- not the global-allowing variant used by kind/role.
--
-- The service_agreement.rate_service_class_id FK arrives in slice 1
-- task 8; this migration only creates the standalone reference table.

-- ─── 1. Reference table ───────────────────────────────────────────────

CREATE TABLE rate_service_class (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id   UUID NOT NULL,
  commodity_id UUID NOT NULL,
  code         VARCHAR(50) NOT NULL,
  label        VARCHAR(100) NOT NULL,
  sort_order   INT NOT NULL DEFAULT 100,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rate_service_class_utility_commodity_code_uq
    UNIQUE (utility_id, commodity_id, code),
  CONSTRAINT rate_service_class_commodity_fkey
    FOREIGN KEY (commodity_id) REFERENCES commodity(id) ON DELETE RESTRICT
);

CREATE INDEX rate_service_class_utility_commodity_active_sort_idx
  ON rate_service_class (utility_id, commodity_id, is_active, sort_order);

-- ─── 2. RLS — pure per-tenant, no globals ─────────────────────────────
-- Mirrors account_type_def's tenant rows (no IS NULL branch). Every
-- row in this table is owned by exactly one tenant.

ALTER TABLE rate_service_class ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rate_service_class
  USING (
    utility_id = current_setting('app.current_utility_id', true)::uuid
  );
