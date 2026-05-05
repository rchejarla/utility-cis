-- Rate Model v2 — Slice 2 follow-up
--
-- Adds an explicit draft/published state to RateSchedule. Components
-- on a schedule are mutable iff
--   published_at IS NULL AND superseded_by_id IS NULL
-- Decouples editability from the calendar (effective_date) so backdating
-- works (e.g., utility ordinance approved Sep 20 effective Sep 15 —
-- operator enters with backdated effectiveDate, edits freely, publishes
-- when ready).
--
-- Backfill semantics:
--   - published_at: set to the row's effective_date (cast to timestamptz).
--     Reflects reality — every existing seeded RateSchedule represents a
--     real, locked rate sheet that should NOT become editable just
--     because we're adding the column.
--   - superseded_by_id: derived from the existing self-relation. A row
--     is "superseded" if any other row's supersedes_id points at it.
--     Until now this was only available via the inverse Prisma relation
--     `supersededBy: RateSchedule[]`; we make it an explicit column so
--     the editability assertion is a single column read.

ALTER TABLE rate_schedule ADD COLUMN superseded_by_id UUID;
ALTER TABLE rate_schedule ADD COLUMN published_at TIMESTAMPTZ;

UPDATE rate_schedule
SET published_at = effective_date::timestamptz
WHERE published_at IS NULL;

UPDATE rate_schedule predecessor
SET superseded_by_id = successor.id
FROM rate_schedule successor
WHERE successor.supersedes_id = predecessor.id
  AND predecessor.superseded_by_id IS NULL;
