-- Interval consumption (spec 26, TOU-INT-1).
--
-- The second of the two ways a TOU bucket comes to exist, and the one
-- that needs no registers at all. A register meter splits the usage
-- itself — its own clock routes consumption into a dial, and the
-- utility's mapping says which period that dial means. An interval
-- meter reports one quantity per interval, each with its own
-- timestamp, and *we* classify them against the published calendar.
--
-- Same destination either way: a `meter_read` row carrying a
-- `peak_code`, which is what the rating loader reads. So the engine
-- never learns which kind of meter produced a bucket, and a tariff
-- written for one works for the other.
--
-- ─── Why a row per interval ───────────────────────────────────────
--
-- Not a packed array per day, which is the usual instinct at this
-- volume (35 million rows a month at 12,000 accounts on 15-minute
-- data). Three things are worth more than the bytes: a quality flag
-- per interval, because an estimated interval has to be visible on the
-- bill that used it; a correction history per interval, because
-- TOU-INT-2 keeps a re-sent value rather than overwriting; and a
-- reconciliation that can name *which* interval disagrees with the
-- register read. An array gives none of those without unpacking it.
--
-- Native compression is the answer to the volume, and is deliberately
-- NOT in this migration: its threshold has to sit outside the rebill
-- window so a correction never decompresses a chunk, and that window
-- is a tenant setting nobody has measured yet. It belongs with the
-- volume work (TOU-INT-8), where the number can be justified. No
-- migration in this codebase calls `add_compression_policy` today;
-- this one should not be the first to do it blind.

CREATE TABLE "meter_read_interval" (
  "id"              UUID           NOT NULL,
  "utility_id"      UUID           NOT NULL,
  "meter_id"        UUID           NOT NULL,
  -- NULL for a meter reporting one channel. An interval meter that also
  -- has registers reports per register, which is what reconciliation
  -- against a register read compares (TOU-INT-5).
  "register_id"     UUID,
  "uom_id"          UUID           NOT NULL,
  -- Always UTC. The *source's* basis — local, local-standard, or an
  -- offset — is resolved at import (TOU-INT-2a) and never stored
  -- half-converted: a column that sometimes means local time is how
  -- every interval ends up an hour out with nothing raised.
  "interval_start"  TIMESTAMPTZ    NOT NULL,
  "length_minutes"  SMALLINT       NOT NULL,
  "quantity"        DECIMAL(18,6)  NOT NULL,
  "quality"         VARCHAR(20)    NOT NULL DEFAULT 'actual',
  "import_batch_id" UUID,
  "created_at"      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  -- TimescaleDB requires the partitioning column in every unique
  -- constraint, the primary key included. Service code holding only
  -- `id` must use `findFirst`, as it does for `meter_read`.
  CONSTRAINT "meter_read_interval_pkey" PRIMARY KEY ("id", "interval_start")
);

-- The lengths a calendar can classify without splitting an interval
-- (TOU-INT-4). 5 and 15 divide the 15-minute slot grid; 30 and 60 are
-- allowed but must start on a boundary that does not straddle a period
-- change, which the roll-up checks per interval rather than per import.
ALTER TABLE "meter_read_interval"
  ADD CONSTRAINT "meter_read_interval_length_known"
  CHECK ("length_minutes" IN (5, 15, 30, 60));

-- `missing` is a row, not an absence: a gap the utility knows about
-- reads differently from one nobody has noticed, and TOU-GAP-1 refuses
-- to bill either as off-peak.
ALTER TABLE "meter_read_interval"
  ADD CONSTRAINT "meter_read_interval_quality_known"
  CHECK ("quality" IN ('actual', 'estimated', 'missing', 'edited'));

SELECT create_hypertable(
  'meter_read_interval',
  'interval_start',
  -- A week, where `meter_read` uses a month: at 15-minute data a month
  -- of one tenant's intervals is two orders of magnitude more rows than
  -- a month of reads, and a billing period touches four or five chunks
  -- either way.
  chunk_time_interval => INTERVAL '1 week'
);

-- ─── Idempotency (TOU-INT-2) ──────────────────────────────────────
--
-- Two partial indexes rather than one, because `register_id` is
-- nullable and PostgreSQL treats NULLs as distinct: a single index
-- would let the same interval be imported twice for a single-channel
-- meter, and the roll-up sums, so that month would bill double.
CREATE UNIQUE INDEX "meter_read_interval_one_per_register"
  ON "meter_read_interval" ("meter_id", "register_id", "interval_start")
  WHERE ("register_id" IS NOT NULL);

CREATE UNIQUE INDEX "meter_read_interval_one_per_meter"
  ON "meter_read_interval" ("meter_id", "interval_start")
  WHERE ("register_id" IS NULL);

-- The roll-up's own query: one meter, one billing period.
CREATE INDEX "meter_read_interval_meter_start"
  ON "meter_read_interval" ("meter_id", "interval_start");

CREATE INDEX "meter_read_interval_batch"
  ON "meter_read_interval" ("utility_id", "import_batch_id");

-- ─── Keys ─────────────────────────────────────────────────────────
--
-- Tenant-scoped, like every key between two tenant-scoped tables: a
-- single-column key is satisfied by a parent the acting tenant cannot
-- see, because referential-integrity checks run as the owner and are
-- exempt from RLS. `schema-invariants.integration.test.ts` fails if one
-- of these regresses to a single column.
--
-- RESTRICT throughout, including the register: ON DELETE SET NULL
-- cannot be used on a composite key whose `utility_id` is NOT NULL, and
-- a register with billed intervals behind it is not a row to delete
-- quietly anyway.
ALTER TABLE "meter_read_interval"
  ADD CONSTRAINT "meter_read_interval_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "meter_read_interval"
  ADD CONSTRAINT "meter_read_interval_meter_id_fkey"
  FOREIGN KEY ("utility_id", "meter_id")
  REFERENCES "meter"("utility_id", "id") ON DELETE RESTRICT;

ALTER TABLE "meter_read_interval"
  ADD CONSTRAINT "meter_read_interval_register_id_fkey"
  FOREIGN KEY ("utility_id", "register_id")
  REFERENCES "meter_register"("utility_id", "id") ON DELETE RESTRICT;

ALTER TABLE "meter_read_interval"
  ADD CONSTRAINT "meter_read_interval_uom_id_fkey"
  FOREIGN KEY ("utility_id", "uom_id")
  REFERENCES "unit_of_measure"("utility_id", "id") ON DELETE RESTRICT;

-- ─── Row-level security ───────────────────────────────────────────
--
-- A new tenant-scoped table starts with RLS off, so it has to be said.
-- FORCE closes the owner exemption, which matters here because
-- migrations and the seed run as the owner.
ALTER TABLE "meter_read_interval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meter_read_interval" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "meter_read_interval"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

COMMENT ON TABLE "meter_read_interval" IS
  'Interval consumption, one row per interval per meter/register (spec 26, TOU-INT-1). Rolled up into peak-coded meter_read rows by the TOU calendar; a register meter reaches the same rows through its register mapping instead.';
