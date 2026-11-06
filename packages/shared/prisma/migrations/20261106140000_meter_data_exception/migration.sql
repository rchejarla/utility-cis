-- Somewhere to put a gap (spec 26, TOU-GAP-1; step 2 of the gap plan).
--
-- The coverage sweep shipped detecting and reporting: a log line and a
-- count. That is the right first step and a poor last one — a warning in
-- a worker's output is not work anybody is assigned, and the sweep
-- re-finds the same hole every night with no way to say "this one is
-- known" or "this one came back".
--
-- So: one row per problem somebody could act on.
--
-- ONE ROW PER (METER, WINDOW, KIND)
--
-- The window is the **day the sweep examined**, not the gap's own start.
-- That is what makes tonight's sighting of last night's hole find its
-- own row instead of opening a second one, and it is what the partial
-- unique index below enforces. Several holes in one day are one
-- exception whose minutes sum and whose detail keeps every sentence: a
-- bad night at a head-end should produce one task per meter-day, not
-- fifty.
--
-- `kind` is in the key because a gap and an overrun on one day are
-- different problems with different answers — chase the missing data,
-- or fix an interval length that is wrong.
--
-- WHY THE UNIQUE INDEX IS PARTIAL
--
-- Only one exception per key may be **open**. The history must stay:
-- a gap that was resolved in March and returns in April is two
-- exceptions, and collapsing them would hide a meter that fails every
-- month — which is the pattern worth seeing. So the index is
-- `WHERE status = 'open'`, which Prisma cannot express; it lives here
-- and `migrate dev` would propose dropping it.
--
-- WHAT THE SWEEP MAY WRITE, AND WHAT IT MAY NOT
--
-- `open` and `resolved` only. Both are facts about the data: the
-- intervals are there or they are not, so a sweep that finds the hole
-- filled may close its own row without asking anybody. `accepted` (bill
-- it as it stands) and `estimated` (a value was supplied) are
-- judgements, and no scheduled job makes those — the same line the
-- sweep already draws by detecting without repairing.
--
-- `resolved_at` is therefore "when it stopped being open", which the
-- CHECK ties to `status` in one direction and the other: an open row
-- with a resolution time and a closed row without one are both records
-- nobody can read.
--
-- NO `created_at`
--
-- `detected_at` is that column under the name that says what the
-- timestamp means here. Two columns holding one fact is how they come
-- to disagree.

CREATE TABLE "meter_data_exception" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "utility_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "window_start" TIMESTAMPTZ NOT NULL,
    "window_end" TIMESTAMPTZ NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "minutes_affected" INTEGER NOT NULL,
    "detail" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meter_data_exception_pkey" PRIMARY KEY ("id")
);

-- ─── Whose row it is, and what it is about ────────────────────────
--
-- The meter key carries the tenant, like every key between two
-- tenant-scoped tables: RLS filters reads and a referential check is
-- not a read, so a single-column key would be satisfied by a meter the
-- acting tenant cannot see.
--
-- CASCADE from the meter, unlike `meter_read_interval`'s RESTRICT. That
-- table refuses because billed interval data is not a row to delete
-- quietly; an exception is a note *about* a meter, and keeping notes
-- about a meter that no longer exists would block the delete for no
-- reader's benefit.
ALTER TABLE "meter_data_exception"
  ADD CONSTRAINT "meter_data_exception_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "meter_data_exception"
  ADD CONSTRAINT "meter_data_exception_meter_id_fkey"
  FOREIGN KEY ("utility_id", "meter_id")
  REFERENCES "meter"("utility_id", "id") ON DELETE CASCADE;

-- ─── The vocabularies, spelled out where they are enforced ────────
--
-- `missing_reading` has no writer yet: it is a property of a row that
-- exists, found by the roll-up's quality check, which has no flag
-- action until step 4. Declared now because adding a kind later is a
-- migration, and the four are the whole set of ways a day's data is
-- not billable as it stands.
ALTER TABLE "meter_data_exception"
  ADD CONSTRAINT "meter_data_exception_kind_known"
  CHECK ("kind" IN ('gap', 'overlap', 'overrun', 'missing_reading'));

ALTER TABLE "meter_data_exception"
  ADD CONSTRAINT "meter_data_exception_status_known"
  CHECK ("status" IN ('open', 'resolved', 'accepted', 'estimated'));

ALTER TABLE "meter_data_exception"
  ADD CONSTRAINT "meter_data_exception_resolution_matches_status"
  CHECK (("status" = 'open') = ("resolved_at" IS NULL));

-- A window that ends where it starts describes nothing, and an
-- exception accounting for no minutes is not one.
ALTER TABLE "meter_data_exception"
  ADD CONSTRAINT "meter_data_exception_window_ordered"
  CHECK ("window_end" > "window_start");

ALTER TABLE "meter_data_exception"
  ADD CONSTRAINT "meter_data_exception_minutes_positive"
  CHECK ("minutes_affected" > 0);

-- ─── One open exception per problem ───────────────────────────────
CREATE UNIQUE INDEX "meter_data_exception_one_open_per_window"
  ON "meter_data_exception" ("utility_id", "meter_id", "window_start", "kind")
  WHERE ("status" = 'open');

-- One index, serving both readers: the sweep asks for this tenant's
-- open rows over the days it swept, and the queue a person works asks
-- for this tenant's open rows newest first. Nothing yet reads by meter
-- alone, so there is no index for it.
CREATE INDEX "meter_data_exception_open_by_window"
  ON "meter_data_exception" ("utility_id", "status", "window_start");

-- ─── Row-level security ───────────────────────────────────────────
ALTER TABLE "meter_data_exception" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meter_data_exception" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "meter_data_exception"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

COMMENT ON TABLE "meter_data_exception" IS
  'A day of one meter data that cannot be billed as it stands (spec 26, TOU-GAP-1). One row per (meter, window, kind) while open, enforced by a partial unique index; the window is the day a sweep examined, not the problem own start. The interval-coverage sweep opens and resolves these, and writes no other status: accepted and estimated are judgements a person makes.';
