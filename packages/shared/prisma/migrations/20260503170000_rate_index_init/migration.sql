-- Rate Model v2 — Slice 1 Task 7
--
-- Create the rate_index table — backs `pricing.type = "indexed"` for
-- periodic values (FAC, EPCC, supply quarterlies, drought_reserve_rate,
-- ...) that are updated independently of the RateComponents that
-- reference them. Each row is one (name, period) value snapshot with
-- its own effective dating window.
--
-- No seed inserts — Task 10 seeds the baseline (name, period, value)
-- rows for FAC, EPCC, supply_residential, etc.

CREATE TABLE rate_index (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id      UUID NOT NULL,
  name            VARCHAR(50) NOT NULL,
  period          VARCHAR(20) NOT NULL,
  value           NUMERIC(18, 8) NOT NULL,
  effective_date  DATE NOT NULL,
  expiration_date DATE,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX rate_index_utility_name_period_key
  ON rate_index (utility_id, name, period);
CREATE INDEX rate_index_utility_name_effective_idx
  ON rate_index (utility_id, name, effective_date);

-- ─── RLS — pure per-tenant ────────────────────────────────────────────
-- All rate_index rows are tenant data (no globals).

ALTER TABLE rate_index ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rate_index
  USING (
    utility_id = current_setting('app.current_utility_id', true)::uuid
  );
