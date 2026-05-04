-- Rate Model v2 — Slice 4 Task 5
--
-- WqaValue stores the seasonally-computed Winter Quarter Average per
-- service agreement per water year, with an optional staff override
-- pathway for corrections. Backs the WqaLoader's `wqa:current:<sa_id>`
-- (override-or-computed) and `wqa:override:<sa_id>` (override-only)
-- variable patterns used by the Bozeman sewer Residential and
-- Multi-Family rate classes.
--
-- One row per (utility_id, service_agreement_id, water_year). The
-- loader reads the latest waterYear row for the SA. Override beats
-- computed_avg when both are set; the loader returns null on
-- `wqa:override:*` when no override is recorded.
--
-- RLS uses the standard per-tenant predicate.

CREATE TABLE wqa_value (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id            UUID NOT NULL,
  service_agreement_id  UUID NOT NULL,
  water_year            INTEGER NOT NULL,
  computed_at           TIMESTAMPTZ NOT NULL,
  source_window_start   DATE NOT NULL,
  source_window_end     DATE NOT NULL,
  computed_avg          NUMERIC(10, 4) NOT NULL,
  override_value        NUMERIC(10, 4),
  override_reason       TEXT,
  override_by           UUID,
  override_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL,

  CONSTRAINT wqa_value_service_agreement_id_fkey
    FOREIGN KEY (service_agreement_id) REFERENCES service_agreement(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX wqa_value_utility_id_service_agreement_id_water_year_key
  ON wqa_value (utility_id, service_agreement_id, water_year);

CREATE INDEX wqa_value_utility_id_service_agreement_id_idx
  ON wqa_value (utility_id, service_agreement_id);

ALTER TABLE wqa_value ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON wqa_value
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);
