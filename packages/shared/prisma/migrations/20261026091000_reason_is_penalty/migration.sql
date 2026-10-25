-- Whether an entry citing this reason is itself a penalty.
--
-- A percentage late fee has to be charged on principal. Including
-- earlier penalties in the base charges a penalty on a penalty;
-- excluding every FEE would stop a late fee applying to an unpaid tap
-- fee, which is money owed for work actually done. Nothing already on
-- the entry separates those two: all five seeded fee reasons are FEE,
-- and the code cannot be consulted, because reasons are
-- tenant-configurable and a utility that names its own "Late charge"
-- would be missed by any list of codes this codebase could hold.
--
-- Defaults false, so a reason nobody has classified counts as
-- principal. That direction under-charges rather than over-charges,
-- which is the right way for this to be wrong.
ALTER TABLE ledger_reason_def
  ADD COLUMN is_penalty BOOLEAN NOT NULL DEFAULT false;

-- Backfill the two default codes that are penalties, for tenants that
-- already hold them. `DEFAULT_REASON_CODES` remains the authority —
-- `seedDefaultReasons` sets the flag on create and marks any existing
-- row that is missing it, so this statement is a one-time catch-up and
-- not a second place the classification is decided.
UPDATE ledger_reason_def
   SET is_penalty = true
 WHERE code IN ('LATE_FEE', 'NSF_FEE');
