-- Effective-dating constraints for service_agreement_meter (Slice 1 / Task 2).
--
-- Same pattern as the SA constraint (Task 1): a generated tsrange column
-- derived from added_date/removed_date, plus a partial GIST exclusion
-- preventing the same physical meter from being on two open assignments
-- simultaneously.
--
-- Why partial: a removed assignment is a historical fact. A meter that
-- was on SA-A from 2023-2024 and is on SA-B from 2024-onward is fine.
-- The exclusion only fires for rows that are currently open
-- (`removed_date IS NULL`) — those are the rows that *actively* claim
-- the meter right now. Closed assignments don't conflict with new ones.
--
-- Why not also include future-dated removals: index predicates must be
-- IMMUTABLE (no CURRENT_DATE / now()). Per-row equality on NULL is
-- sufficient for the dominant case — operators don't pre-schedule
-- removals; they set `removed_date` at the moment of removal. If the
-- pattern changes, a server-side trigger can layer extra logic later.
--
-- Why tsrange (not tstzrange): same reason as Task 1 — `date::timestamp`
-- is IMMUTABLE; `date::timestamptz` is STABLE and Postgres rejects
-- STABLE expressions in generated columns.

ALTER TABLE service_agreement_meter
  ADD COLUMN effective_range tsrange GENERATED ALWAYS AS (
    tsrange(
      added_date::timestamp,
      COALESCE(removed_date, 'infinity'::timestamp)::timestamp,
      '[)'
    )
  ) STORED;

ALTER TABLE service_agreement_meter
  ADD CONSTRAINT no_double_assigned_meter EXCLUDE USING gist (
    utility_id WITH =,
    meter_id WITH =,
    effective_range WITH &&
  ) WHERE (removed_date IS NULL);

ALTER TABLE service_agreement_meter
  ADD CONSTRAINT chk_sam_removed_ge_added
  CHECK (removed_date IS NULL OR removed_date >= added_date);
