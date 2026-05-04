-- Rate Model v2 — Slice 1 Task 6
--
-- Create the sa_rate_schedule_assignment join table. One SA can hold
-- N schedules, each with a role (delivery / supply / rider / ...) and
-- its own effective dating window. This is what makes a NWE-style
-- residential gas customer work — primary delivery + supply + rider —
-- while a Bozeman water customer can keep the same shape with a
-- single 'primary' assignment.
--
-- Range-overlap exclusion within the same role is deferred to slice
-- 2/3. For slice 1 the application enforces tenant scope at insert
-- (both SA and schedule must belong to the tenant); RLS catches any
-- cross-tenant read attempts.
--
-- No seed inserts — assignments are wholly tenant data.

CREATE TABLE sa_rate_schedule_assignment (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id            UUID NOT NULL,
  service_agreement_id  UUID NOT NULL,
  rate_schedule_id      UUID NOT NULL,
  role_code             VARCHAR(50) NOT NULL,
  effective_date        DATE NOT NULL,
  expiration_date       DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sa_rate_schedule_assignment_sa_fkey
    FOREIGN KEY (service_agreement_id) REFERENCES service_agreement(id) ON DELETE CASCADE,
  CONSTRAINT sa_rate_schedule_assignment_schedule_fkey
    FOREIGN KEY (rate_schedule_id) REFERENCES rate_schedule(id) ON DELETE RESTRICT
);

CREATE INDEX sa_rate_schedule_assignment_sa_effective_idx
  ON sa_rate_schedule_assignment (service_agreement_id, effective_date);
CREATE INDEX sa_rate_schedule_assignment_rate_schedule_id_idx
  ON sa_rate_schedule_assignment (rate_schedule_id);
CREATE INDEX sa_rate_schedule_assignment_role_code_idx
  ON sa_rate_schedule_assignment (role_code);

-- ─── RLS — pure per-tenant ────────────────────────────────────────────
-- All assignments are tenant data (no globals).

ALTER TABLE sa_rate_schedule_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sa_rate_schedule_assignment
  USING (
    utility_id = current_setting('app.current_utility_id', true)::uuid
  );
