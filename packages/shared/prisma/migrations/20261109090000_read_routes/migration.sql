-- Read routes: the order a reader walks, and what they could not read
-- (spec 08; design 2026-11-08-read-routes-and-reading-system, 5.1-5.4).
--
-- Three tables and one column. Nothing here is backfilled: a tenant
-- with no routes has none, and a read with no route is a read taken
-- off-route, which is a normal thing for a read to be.
--
-- A STOP IS A PREMISE, NOT A METER
--
-- A reader walks to a building, not to a device. `read_route_stop`
-- therefore keys on `premise`, and the meters at that premise are
-- found by the same service-point chain the reading-progress query
-- already walks. Keying on meter would make a meter swap edit every
-- route that visits it, and would list a two-meter premise as two
-- stops the reader makes in one visit.
--
-- A premise appears at most once on a route, and a sequence number at
-- most once. Both are unique because they fail differently: a repeated
-- sequence leaves the walking order ambiguous, a repeated premise
-- sends the reader to the same door twice.
--
-- A SKIP IS A METER, NOT A STOP
--
-- `read_skip` keys on the meter because what could not be read is a
-- device: the gate is locked in front of one meter while the other at
-- the same premise reads fine. It is a note about a meter, so it
-- cascades from it, exactly as `meter_data_exception` does. The route
-- it was found on is kept for the report that groups by route, and
-- goes NULL with the route rather than taking the history with it.
--
-- WHY THE SKIP'S UNIQUE INDEX IS PARTIAL
--
-- One *open* skip per meter per day. A gate locked in January and
-- locked again in February is two rows, and so is a skip that was
-- resolved at noon and recurred at four: collapsing them would hide
-- the meter that is skipped every month, which is the pattern worth
-- seeing. Prisma cannot express a partial index; it lives here, and
-- `migrate dev` would propose dropping it.
--
-- `origin` ON A ROUTE
--
-- LOCAL is a route this utility owns and edits. EXTERNAL is one a
-- reading system's vendor owns and we mirror: the same shape, but not
-- ours to reorder. The column says which, so nothing has to guess
-- from the spelling of a code.
--
-- `meter_read.route_id` IS NULLABLE AND ADDS NO UNIQUE CONSTRAINT
--
-- `meter_read` is a hypertable partitioned on `read_datetime`, so any
-- unique constraint added to it must include that column. This adds
-- none. Existing reads stay NULL by design.

-- ─── read_route ───────────────────────────────────────────────────

CREATE TABLE "read_route" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "utility_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "billing_cycle_id" UUID NOT NULL,
    "origin" VARCHAR(20) NOT NULL DEFAULT 'LOCAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "read_route_pkey" PRIMARY KEY ("id")
);

-- Every key between two tenant-scoped tables carries the tenant: RLS
-- filters reads and a referential check is not a read, so a
-- single-column key would be satisfied by a parent the acting tenant
-- cannot see. RESTRICT on the cycle: a cycle with routes is not one to
-- delete quietly.
ALTER TABLE "read_route"
  ADD CONSTRAINT "read_route_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "read_route"
  ADD CONSTRAINT "read_route_billing_cycle_id_fkey"
  FOREIGN KEY ("utility_id", "billing_cycle_id")
  REFERENCES "billing_cycle"("utility_id", "id") ON DELETE RESTRICT;

ALTER TABLE "read_route"
  ADD CONSTRAINT "read_route_utility_id_code_key" UNIQUE ("utility_id", "code");

-- Three tables reference a route compositely, which needs the tenant in
-- a unique key on this side.
ALTER TABLE "read_route"
  ADD CONSTRAINT "read_route_utility_id_id_key" UNIQUE ("utility_id", "id");

ALTER TABLE "read_route"
  ADD CONSTRAINT "read_route_origin_known"
  CHECK ("origin" IN ('LOCAL', 'EXTERNAL'));

-- The cycle's routes: how a reader's day and the progress view are
-- both asked for.
CREATE INDEX "read_route_utility_id_billing_cycle_id_idx"
  ON "read_route" ("utility_id", "billing_cycle_id");

-- ─── read_route_stop ──────────────────────────────────────────────

CREATE TABLE "read_route_stop" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "utility_id" UUID NOT NULL,
    "read_route_id" UUID NOT NULL,
    "premise_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "read_route_stop_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "read_route_stop"
  ADD CONSTRAINT "read_route_stop_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

-- CASCADE from the route: a stop is a line of the route and means
-- nothing without it. RESTRICT on the premise: one on a route is in use.
ALTER TABLE "read_route_stop"
  ADD CONSTRAINT "read_route_stop_read_route_id_fkey"
  FOREIGN KEY ("utility_id", "read_route_id")
  REFERENCES "read_route"("utility_id", "id") ON DELETE CASCADE;

ALTER TABLE "read_route_stop"
  ADD CONSTRAINT "read_route_stop_premise_id_fkey"
  FOREIGN KEY ("utility_id", "premise_id")
  REFERENCES "premise"("utility_id", "id") ON DELETE RESTRICT;

ALTER TABLE "read_route_stop"
  ADD CONSTRAINT "read_route_stop_sequence_key"
  UNIQUE ("utility_id", "read_route_id", "sequence");

ALTER TABLE "read_route_stop"
  ADD CONSTRAINT "read_route_stop_premise_key"
  UNIQUE ("utility_id", "read_route_id", "premise_id");

-- The unique on sequence is also the index that serves the walk in
-- order; a second index on the same columns would only cost writes.

-- ─── read_skip ────────────────────────────────────────────────────

CREATE TABLE "read_skip" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "utility_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "read_route_id" UUID,
    "read_date" DATE NOT NULL,
    "skip_reason" VARCHAR(50) NOT NULL,
    "notes" TEXT,
    "reader_id" UUID,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "read_skip_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "read_skip"
  ADD CONSTRAINT "read_skip_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "read_skip"
  ADD CONSTRAINT "read_skip_meter_id_fkey"
  FOREIGN KEY ("utility_id", "meter_id")
  REFERENCES "meter"("utility_id", "id") ON DELETE CASCADE;

-- SET NULL names its column. A bare `ON DELETE SET NULL` on a
-- composite key would null `utility_id` too, which is NOT NULL, and the
-- delete would fail; the column list (PostgreSQL 15+) restricts the
-- action to the one nullable column, as the tenant_scoped_foreign_keys
-- migration does for every key of this shape.
ALTER TABLE "read_skip"
  ADD CONSTRAINT "read_skip_read_route_id_fkey"
  FOREIGN KEY ("utility_id", "read_route_id")
  REFERENCES "read_route"("utility_id", "id") ON DELETE SET NULL ("read_route_id");

-- The seven ways a reader could not read, spelled out where they are
-- enforced. An eighth is a migration, deliberately.
ALTER TABLE "read_skip"
  ADD CONSTRAINT "read_skip_reason_known"
  CHECK ("skip_reason" IN (
    'LOCKED_GATE', 'DOG', 'BURIED', 'UNREADABLE',
    'OBSTRUCTED', 'APPEARS_VACANT', 'NO_METER_FOUND'
  ));

CREATE UNIQUE INDEX "read_skip_one_open_per_meter_day"
  ON "read_skip" ("utility_id", "meter_id", "read_date")
  WHERE ("resolved_at" IS NULL);

-- A route's day: what was skipped on it, for the report.
CREATE INDEX "read_skip_utility_id_read_route_id_read_date_idx"
  ON "read_skip" ("utility_id", "read_route_id", "read_date");

-- ─── meter_read.route_id ──────────────────────────────────────────

ALTER TABLE "meter_read" ADD COLUMN "route_id" UUID;

-- SET NULL on the route column alone, as above: deleting a route must
-- not delete or rewrite billed reads, only forget which route took them.
ALTER TABLE "meter_read"
  ADD CONSTRAINT "meter_read_route_id_fkey"
  FOREIGN KEY ("utility_id", "route_id")
  REFERENCES "read_route"("utility_id", "id") ON DELETE SET NULL ("route_id");

CREATE INDEX "meter_read_utility_id_route_id_idx"
  ON "meter_read" ("utility_id", "route_id");

-- ─── Row-level security ───────────────────────────────────────────

ALTER TABLE "read_route" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "read_route" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "read_route"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE "read_route_stop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "read_route_stop" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "read_route_stop"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE "read_skip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "read_skip" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "read_skip"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

COMMENT ON TABLE "read_route" IS
  'An ordered walk a reader makes for one billing cycle. origin LOCAL is ours to edit; EXTERNAL mirrors a reading system route and is not.';
COMMENT ON TABLE "read_route_stop" IS
  'One premise on a route, at one position. A stop is a premise because a reader walks to a building; the meters there come from the service-point chain.';
COMMENT ON TABLE "read_skip" IS
  'A meter a reader could not read on a date, and why. One open skip per meter per day, by partial unique index; a resolved one stays as history.';
