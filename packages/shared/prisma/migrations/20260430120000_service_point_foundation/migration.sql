-- Service Point foundation. Splits SA-with-premise into SA-without-
-- premise + SP-per-premise. Replaces SAM with SPM. Behaviour-preserving:
-- every existing SA gets one SP, every SAM row becomes one SPM row.
--
-- Slice 1 keeps SA.premise_id (now nullable) as a denormalised mirror
-- so that nothing reading it breaks today. Slice 2 drops the column
-- once all read paths go through SP.

-- ─── 1. Enums ─────────────────────────────────────────────────────────

CREATE TYPE service_point_type AS ENUM ('METERED', 'ITEM_BASED', 'NON_BADGED');
CREATE TYPE service_point_status AS ENUM ('PENDING', 'ACTIVE', 'FINAL', 'CLOSED');

-- ─── 2. service_point table ───────────────────────────────────────────

CREATE TABLE service_point (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id           UUID NOT NULL,
  service_agreement_id UUID NOT NULL,
  premise_id           UUID NOT NULL,
  type                 service_point_type NOT NULL DEFAULT 'METERED',
  status               service_point_status NOT NULL DEFAULT 'ACTIVE',
  start_date           DATE NOT NULL,
  end_date             DATE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_point_sa_fk      FOREIGN KEY (service_agreement_id) REFERENCES service_agreement(id) ON DELETE CASCADE,
  CONSTRAINT service_point_premise_fk FOREIGN KEY (premise_id)           REFERENCES premise(id)           ON DELETE RESTRICT
);
CREATE INDEX service_point_sa_idx           ON service_point (service_agreement_id);
CREATE INDEX service_point_premise_idx      ON service_point (premise_id);
CREATE INDEX service_point_utility_status   ON service_point (utility_id, status);

-- RLS, mirroring service_agreement.
ALTER TABLE service_point ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_point
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);

-- ─── 3. service_point_meter table ─────────────────────────────────────

CREATE TABLE service_point_meter (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id       UUID NOT NULL,
  service_point_id UUID NOT NULL,
  meter_id         UUID NOT NULL,
  added_date       DATE NOT NULL,
  removed_date     DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_range  tsrange GENERATED ALWAYS AS (
    tsrange(
      added_date::timestamp,
      COALESCE(removed_date::timestamp, 'infinity'::timestamp),
      '[)'
    )
  ) STORED,
  CONSTRAINT spm_sp_fk    FOREIGN KEY (service_point_id) REFERENCES service_point(id) ON DELETE CASCADE,
  CONSTRAINT spm_meter_fk FOREIGN KEY (meter_id)         REFERENCES meter(id)         ON DELETE RESTRICT
);
CREATE INDEX spm_sp_idx     ON service_point_meter (service_point_id);
CREATE INDEX spm_meter_idx  ON service_point_meter (meter_id);

-- A meter can't be installed at two SPs at once. Mirrors the SAM
-- exclusion constraint that this table replaces.
ALTER TABLE service_point_meter
  ADD CONSTRAINT spm_no_double_install
  EXCLUDE USING gist (meter_id WITH =, effective_range WITH &&);

ALTER TABLE service_point_meter ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_point_meter
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);

-- ─── 4. Backfill: one SP per existing SA ──────────────────────────────
-- Each existing SA has a non-null premise_id today (the column is
-- still NOT NULL at this point). Map status: SA PENDING → SP PENDING,
-- SA ACTIVE → SP ACTIVE, SA FINAL/CLOSED → SP CLOSED.

INSERT INTO service_point (
  id, utility_id, service_agreement_id, premise_id, type, status,
  start_date, end_date, created_at
)
SELECT
  gen_random_uuid(),
  utility_id,
  id AS service_agreement_id,
  premise_id,
  'METERED'::service_point_type,
  CASE
    WHEN status = 'PENDING' THEN 'PENDING'::service_point_status
    WHEN status = 'ACTIVE'  THEN 'ACTIVE'::service_point_status
    ELSE 'CLOSED'::service_point_status
  END,
  start_date,
  end_date,
  created_at
FROM service_agreement;

-- ─── 5. Backfill: one SPM per existing SAM ────────────────────────────
-- Each existing SAM row maps to a SPM row, attached to the SP we
-- just created for the SAM's service_agreement_id.

INSERT INTO service_point_meter (
  id, utility_id, service_point_id, meter_id, added_date, removed_date, created_at
)
SELECT
  gen_random_uuid(),
  sam.utility_id,
  sp.id AS service_point_id,
  sam.meter_id,
  sam.added_date,
  sam.removed_date,
  sam.created_at
FROM service_agreement_meter sam
JOIN service_point sp ON sp.service_agreement_id = sam.service_agreement_id;

-- ─── 6. Drop SAM ──────────────────────────────────────────────────────
-- Drop in reverse-dependency order: drop the table (its constraints
-- and indexes go with it).

DROP TABLE service_agreement_meter;

-- ─── 7. Loosen SA.premise_id ──────────────────────────────────────────
-- Now nullable so future SAs can be created without a premise (the
-- premise lives on the SP). Existing rows keep their value as a
-- denormalised mirror; Slice 2 will drop the column entirely once
-- all read sites use SP.

ALTER TABLE service_agreement ALTER COLUMN premise_id DROP NOT NULL;
