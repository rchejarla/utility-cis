-- Adds `read_event_id` to `meter_read` — a nullable UUID that groups
-- sibling reads captured together during a single visit to a multi-
-- register meter. Single-register reads keep `read_event_id = NULL`
-- (no backfill required).
--
-- The index is partial (WHERE read_event_id IS NOT NULL) because only
-- a minority of reads come from multi-register meters; skipping the
-- NULL-heavy rows keeps the index small without losing any query
-- acceleration for the "fetch siblings for one event" path.
--
-- Note: Prisma's auto-generated migration also proposed dropping the
-- GIN indexes on the FTS tsvector columns and the hypertable partition
-- index, plus DROP DEFAULT on the GENERATED ALWAYS tsvector columns.
-- Those are shadow-DB drift artifacts (Prisma can't model tsvector or
-- TimescaleDB hypertables), not real changes we want applied — so they
-- have been stripped from this migration.

-- AlterTable
ALTER TABLE "meter_read" ADD COLUMN "read_event_id" UUID;

-- CreateIndex
CREATE INDEX "meter_read_utility_id_read_event_id_idx"
  ON "meter_read" ("utility_id", "read_event_id")
  WHERE "read_event_id" IS NOT NULL;
