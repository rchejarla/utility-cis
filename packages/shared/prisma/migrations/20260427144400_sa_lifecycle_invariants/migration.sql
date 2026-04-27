-- Lifecycle invariants for service_agreement (Slice 1 / Task 3, FR-EFF-003).
--
-- Two rules the database enforces unconditionally, regardless of which
-- service code path is doing the write:
--
--   1. Terminal status (FINAL, CLOSED) requires end_date IS NOT NULL.
--      A terminal SA without an end date has no defined effective range
--      and would be ambiguous in point-in-time queries.
--
--   2. While the SA is still PENDING/ACTIVE, end_date may not be set
--      to a non-null value unless the same statement also moves status
--      to FINAL or CLOSED. Setting end_date alone leaves the row in an
--      inconsistent state — "still active but ends sometime" is the
--      kind of half-finished mutation the close-and-cascade workflow
--      is meant to replace. To close an SA, callers must use the
--      transitional endpoint that bundles end_date + status.
--
-- Implemented as a single BEFORE INSERT OR UPDATE trigger so both
-- rules apply on every write path. CHECK constraints can't express
-- rule 2 because it depends on the OLD vs. NEW row state.

CREATE OR REPLACE FUNCTION enforce_sa_lifecycle_invariants()
RETURNS trigger AS $$
BEGIN
  -- Rule 1: terminal status must carry an end_date.
  IF NEW.status IN ('FINAL', 'CLOSED') AND NEW.end_date IS NULL THEN
    RAISE EXCEPTION 'SA_LIFECYCLE_INVARIANT_VIOLATION: status % requires end_date to be set', NEW.status
      USING ERRCODE = 'check_violation',
            HINT = 'Use the close-service-agreement endpoint to bundle end_date + status atomically.';
  END IF;

  -- Rule 2: cannot set end_date on an open SA without simultaneously
  -- moving status to terminal. Only relevant on UPDATE — INSERT can
  -- legitimately set end_date with PENDING/ACTIVE if the SA is being
  -- created with a known end (e.g., short-term construction water).
  IF TG_OP = 'UPDATE' THEN
    IF OLD.end_date IS NULL
       AND NEW.end_date IS NOT NULL
       AND NEW.status IN ('PENDING', 'ACTIVE')
       AND OLD.status IN ('PENDING', 'ACTIVE') THEN
      RAISE EXCEPTION 'SA_LIFECYCLE_INVARIANT_VIOLATION: cannot set end_date on a still-active SA without also moving status to FINAL/CLOSED'
        USING ERRCODE = 'check_violation',
              HINT = 'Use the close-service-agreement endpoint instead of a generic UPDATE.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_sa_lifecycle_invariants
BEFORE INSERT OR UPDATE ON service_agreement
FOR EACH ROW EXECUTE FUNCTION enforce_sa_lifecycle_invariants();
