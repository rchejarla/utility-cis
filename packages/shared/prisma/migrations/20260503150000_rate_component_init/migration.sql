-- Rate Model v2 — Slice 1 Task 4
--
-- Create the rate_component table — the heart of the v2 rate model.
-- Each component is one closed-grammar rule under a RateSchedule:
--   - predicate (JSON DSL): when this component applies
--   - quantity_source (JSON DSL): what quantity feeds the price
--   - pricing (JSON DSL discriminated union): how the quantity is priced
-- The Zod validators in packages/shared/src/validators/rate-grammar/*
-- are the contract; the engine (slice 3) walks these JSON shapes with
-- a deterministic evaluator.
--
-- No seed inserts — components are wholly tenant data; the dev seed
-- in slice 1 task 10 populates a baseline set.

CREATE TABLE rate_component (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id        UUID NOT NULL,
  rate_schedule_id  UUID NOT NULL,
  kind_code         VARCHAR(50) NOT NULL,
  label             VARCHAR(255) NOT NULL,
  predicate         JSONB NOT NULL,
  quantity_source   JSONB NOT NULL,
  pricing           JSONB NOT NULL,
  sort_order        INT NOT NULL DEFAULT 100,
  effective_date    DATE NOT NULL,
  expiration_date   DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rate_component_rate_schedule_fkey
    FOREIGN KEY (rate_schedule_id) REFERENCES rate_schedule(id) ON DELETE CASCADE
);

CREATE INDEX rate_component_rate_schedule_id_idx
  ON rate_component (rate_schedule_id);
CREATE INDEX rate_component_utility_schedule_sort_idx
  ON rate_component (utility_id, rate_schedule_id, sort_order);
CREATE INDEX rate_component_kind_code_idx
  ON rate_component (kind_code);

-- ─── RLS — pure per-tenant ────────────────────────────────────────────
-- All rate_component rows are tenant data (no globals).

ALTER TABLE rate_component ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rate_component
  USING (
    utility_id = current_setting('app.current_utility_id', true)::uuid
  );
