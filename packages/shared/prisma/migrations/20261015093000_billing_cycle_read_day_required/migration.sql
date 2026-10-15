-- A cycle must say when its reads are due.
--
-- The column landed nullable an hour earlier, on the reasoning that
-- cycles predating it had no declared read day and choosing one for them
-- would be inventing data. Rao's call, and the right one: we are in
-- development, there is no data worth protecting, and a cycle that
-- cannot say when its reads are due is a cycle that cannot safely be
-- billed. "Not declared" is not a state worth modelling.
--
-- Forward-only, as a second migration rather than an edit to the first:
-- the first has already been applied here, and rewriting an applied
-- migration makes every database that ran it drift against its own
-- history.
--
-- The backfill picks two days before the bill day, which is a guess, and
-- the only defensible one available — it is the smallest gap that still
-- leaves a late reader somewhere to land. On a database where the column
-- was never null it does nothing.
UPDATE "billing_cycle"
   SET "read_day_of_month" = GREATEST(1, "bill_day_of_month" - 2)
 WHERE "read_day_of_month" IS NULL;

ALTER TABLE "billing_cycle"
  ALTER COLUMN "read_day_of_month" SET NOT NULL;

-- The null branch of the old CHECK can no longer be reached.
ALTER TABLE "billing_cycle"
  DROP CONSTRAINT "billing_cycle_read_day_valid";
ALTER TABLE "billing_cycle"
  ADD CONSTRAINT "billing_cycle_read_day_valid"
  CHECK ("read_day_of_month" >= 1 AND "read_day_of_month" <= 31);
