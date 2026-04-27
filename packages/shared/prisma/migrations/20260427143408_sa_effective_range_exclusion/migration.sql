-- Effective-dating constraints for service_agreement (Slice 1 / Task 1).
--
-- Adds:
--   1. A generated tsrange `effective_range` column derived from
--      start_date and end_date. Half-open interval [start, end) so that
--      the day a SA closes can be the same day a successor SA opens
--      without overlap. NULL end_date means "still effective" — modeled
--      as +infinity so the GIST exclusion treats the range as open-ended.
--   2. A partial GIST exclusion constraint preventing two ACTIVE/PENDING
--      SAs from overlapping in time on the same (utility, account,
--      premise, commodity). Closed/Final SAs are exempt because their
--      ranges are historical.
--   3. A CHECK constraint that end_date >= start_date when both are
--      present. The DB rejects backwards ranges before the application
--      ever sees them.
--
-- Why tsrange (not tstzrange): Postgres requires generation expressions
-- to be IMMUTABLE. `date::timestamptz` is STABLE (timezone-dependent),
-- which Postgres rejects in a generated column. `date::timestamp`
-- (without time zone) IS immutable — and our start_date/end_date are
-- DATE columns with no time-of-day semantics anyway. tsrange is the
-- right type for "calendar-date overlap"; no timezone reasoning needed.
--
-- Why partial: a closed SA's range is historical fact; another ACTIVE
-- SA can validly cover the same period if it represents a new account
-- relationship. The exclusion only fires for ACTIVE/PENDING because
-- those are the rows that *currently* claim ownership of the period.
--
-- Why btree_gist: the exclusion combines equality on UUID columns
-- (utility_id, account_id, ...) with overlap (&&) on the tsrange.
-- The btree_gist extension (Task 0 migration) lets a single GIST index
-- handle both operator classes.

ALTER TABLE service_agreement
  ADD COLUMN effective_range tsrange GENERATED ALWAYS AS (
    tsrange(
      start_date::timestamp,
      COALESCE(end_date, 'infinity'::timestamp)::timestamp,
      '[)'
    )
  ) STORED;

ALTER TABLE service_agreement
  ADD CONSTRAINT no_overlapping_active_sa EXCLUDE USING gist (
    utility_id WITH =,
    account_id WITH =,
    premise_id WITH =,
    commodity_id WITH =,
    effective_range WITH &&
  ) WHERE (status IN ('PENDING', 'ACTIVE'));

ALTER TABLE service_agreement
  ADD CONSTRAINT chk_sa_end_ge_start
  CHECK (end_date IS NULL OR end_date >= start_date);
