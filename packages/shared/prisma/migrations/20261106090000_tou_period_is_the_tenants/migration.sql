-- `tou_period` is the tenant's — said in the database, and enforced from
-- the register (spec 26, TOU-CAL-1 and TOU-REG-1).
--
-- WHAT WAS WRONG
--
-- The `tou_registers` migration (2026-11-03) argued that
-- `meter_register.peak_code` holds a code rather than a key because
-- "a `tou_period` row belongs to one calendar version", and wrote that
-- reason into a live `COMMENT ON COLUMN`. The `tenant_peak_codes`
-- migration (2026-11-04) reshaped the table the following day — one row
-- per code per tenant, unique on `(utility_id, peak_code)` — and did not
-- revisit the comment it had just falsified.
--
-- So the only prose about `tou_period` stored in the database sat on a
-- different table and said the opposite of the truth. `\d+` and every
-- schema browser repeated it, which is how a stale claim outlives the
-- design it described.
--
-- WHY A COMMENT NEEDS A MIGRATION
--
-- The 2026-11-03 file is applied and checksummed: editing it breaks
-- `migrate deploy` for every database that already holds it. A comment
-- lives in the catalog like any other object, so correcting one is a
-- forward migration. The old file stands as the record of what was
-- believed on the day it ran; this supersedes it.
--
-- AND THE KEY THE CORRECTION MAKES POSSIBLE
--
-- The old reason was the only argument against keying the register at
-- all, so with it gone the key is taken here. It is the same shape
-- `tou_slot` has carried since 2026-11-04 —
-- `(utility_id, peak_code) -> tou_period (utility_id, peak_code)`,
-- RESTRICT, no update cascade — and it buys the same two guards: a
-- register cannot count a period the tenant has not defined, and a code
-- cannot be deleted or renamed while a register counts it. A refused
-- rename is correct for the same reason it is on the slot; the code has
-- been copied onto reads and into rate components.
--
-- `setRegisterPeakCode` already refuses an unknown code and names the
-- ones the tenant has, which is the better message and stays the first
-- line of defence. This is the floor under it: the service is one write
-- path, and an import or a script is another.
--
-- A NULL `peak_code` still means "not a TOU register". The default
-- MATCH SIMPLE is what allows that — a composite key with any column
-- NULL is satisfied without a parent row, so a total register needs no
-- exemption.
--
-- No index is added on the child side. PostgreSQL scans
-- `meter_register` when a parent key changes, and that happens only
-- when a tenant deletes or renames a period — rare, refused while in
-- use, and against a table in the tens of thousands of rows rather than
-- a hypertable.
--
-- `meter_read.peak_code` stays a bare string, which has not changed: a
-- hypertable taking tens of millions of rows a month at TOU granularity
-- does not want a foreign key per row.

-- ─── The register names a period the tenant has defined ───────────
ALTER TABLE "meter_register"
  ADD CONSTRAINT "meter_register_peak_code_fkey"
  FOREIGN KEY ("utility_id", "peak_code")
  REFERENCES "tou_period" ("utility_id", "peak_code") ON DELETE RESTRICT;

COMMENT ON COLUMN "meter_register"."peak_code" IS
  'Which TOU period this register counts (spec 26, TOU-REG-1). NULL for a total register or a non-TOU meter. The code of a tenant tou_period row, keyed on (utility_id, peak_code) with RESTRICT since 2026-11-06, and held as the code rather than the id because the code is what travels onto reads and into rate components.';

-- ─── The table says what it is, on itself ─────────────────────────
--
-- Stated here because it was not stated anywhere in the database
-- before, which is the condition that let the wrong version travel.
COMMENT ON TABLE "tou_period" IS
  'A tenant TOU price tier — off_peak, mid_peak, peak (spec 26, TOU-CAL-1). One row per code per tenant, NOT per calendar: it was per calendar until 2026-11-04, when the duplication was removed. A calendar version has no periods of its own; its periods are derived as the distinct codes its tou_slot hours use. Every tenant is provisioned with three.';

COMMENT ON COLUMN "tou_period"."peak_code" IS
  'The code a calendar hour, a meter register, a meter read and a rate component all name this period by. Referenced by tou_slot and meter_register on (utility_id, peak_code) with RESTRICT and no update cascade, so a code in use can be neither deleted nor renamed — a refused rename is correct, because the code has been copied onto registers and into rate components.';
