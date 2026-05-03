-- Rate Model v2 — Slice 1 Task 1
--
-- Create the two top-level discriminator ref tables for the v2 rate
-- model: rate_component_kind (kindCode on a rate component) and
-- rate_assignment_role (roleCode on a rate→service-agreement
-- assignment). Same global+tenant-shadow pattern used by
-- measure_type_def / premise_type_def / account_type_def: utility_id
-- NULL means a system-defined global row (read-only to tenants);
-- utility_id NOT NULL is a per-tenant override that wins over the
-- global with the same code.
--
-- Codebase-defined codes only — the rate engine (slice 3) will
-- dispatch on these codes, so tenants can relabel/disable but cannot
-- introduce new codes.

-- ─── 1. rate_component_kind ────────────────────────────────────────────

CREATE TABLE rate_component_kind (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id  UUID,
  code        VARCHAR(50) NOT NULL,
  label       VARCHAR(100) NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rate_component_kind_utility_code_uq UNIQUE (utility_id, code)
);
CREATE INDEX rate_component_kind_active_sort_idx
  ON rate_component_kind (is_active, sort_order);

-- ─── 2. rate_assignment_role ──────────────────────────────────────────

CREATE TABLE rate_assignment_role (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id  UUID,
  code        VARCHAR(50) NOT NULL,
  label       VARCHAR(100) NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rate_assignment_role_utility_code_uq UNIQUE (utility_id, code)
);
CREATE INDEX rate_assignment_role_active_sort_idx
  ON rate_assignment_role (is_active, sort_order);

-- ─── 3. RLS — globals visible to all, tenant rows isolated ────────────
-- Mirrors measure_type_def / premise_type_def / account_type_def.

ALTER TABLE rate_component_kind ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rate_component_kind
  USING (
    utility_id IS NULL
    OR utility_id = current_setting('app.current_utility_id', true)::uuid
  );

ALTER TABLE rate_assignment_role ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rate_assignment_role
  USING (
    utility_id IS NULL
    OR utility_id = current_setting('app.current_utility_id', true)::uuid
  );

-- ─── 4. Seed globals: rate_component_kind ─────────────────────────────

INSERT INTO rate_component_kind (id, utility_id, code, label, sort_order) VALUES
  (gen_random_uuid(), NULL, 'service_charge',      'Service Charge',       10),
  (gen_random_uuid(), NULL, 'consumption',         'Consumption',          20),
  (gen_random_uuid(), NULL, 'derived_consumption', 'Derived Consumption',  25),
  (gen_random_uuid(), NULL, 'non_meter',           'Non-Meter Charge',     30),
  (gen_random_uuid(), NULL, 'item_price',          'Item Price',           40),
  (gen_random_uuid(), NULL, 'one_time_fee',        'One-Time Fee',         50),
  (gen_random_uuid(), NULL, 'surcharge',           'Surcharge',            60),
  (gen_random_uuid(), NULL, 'tax',                 'Tax',                  70),
  (gen_random_uuid(), NULL, 'credit',              'Credit',               80),
  (gen_random_uuid(), NULL, 'reservation_charge',  'Reservation Charge',   90),
  (gen_random_uuid(), NULL, 'minimum_bill',        'Minimum Bill',        100);

-- ─── 5. Seed globals: rate_assignment_role ────────────────────────────

INSERT INTO rate_assignment_role (id, utility_id, code, label, sort_order) VALUES
  (gen_random_uuid(), NULL, 'primary',  'Primary',           10),
  (gen_random_uuid(), NULL, 'delivery', 'Delivery',          20),
  (gen_random_uuid(), NULL, 'supply',   'Supply',            30),
  (gen_random_uuid(), NULL, 'rider',    'Rider / Surcharge', 40),
  (gen_random_uuid(), NULL, 'opt_in',   'Opt-In Program',    50);
