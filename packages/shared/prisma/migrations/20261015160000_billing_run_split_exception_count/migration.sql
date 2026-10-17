-- Split `exception_count` into what failed and what was skipped.
--
-- The run's own design argues that SKIPPED and FAILED are different
-- kinds — "nothing to bill" against "should have billed and could not" —
-- and then the summary row added them together. A run with 40 skips and
-- no failures said "40 exceptions", which reads as 40 things to fix, and
-- a run with 39 skips and 1 failure looked identical to it.
--
-- One number per kind. "Exceptions" remains available as their sum where
-- a single figure is wanted, derived rather than stored, so a third
-- counter cannot disagree with the two it is made of.

ALTER TABLE "billing_run"
  ADD COLUMN "failed_count"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "skipped_count" INTEGER NOT NULL DEFAULT 0;

-- Existing dev rows: everything counted as an exception becomes a
-- failure, which is the safe direction — it over-reports work rather
-- than hiding it, and the item rows hold the truth either way.
UPDATE "billing_run" SET "failed_count" = "exception_count"
  WHERE "exception_count" > 0;

ALTER TABLE "billing_run" DROP COLUMN "exception_count";
