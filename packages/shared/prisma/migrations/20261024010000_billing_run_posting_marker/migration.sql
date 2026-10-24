-- When the current posting pass over a run began.
--
-- Posting moves to the worker, and a job that dies mid-loop has to be
-- recoverable the way a generation job already is. Generation marks
-- itself with status = 'RUNNING', which the boot sweep looks for;
-- posting had no marker at all, because `posted_at` is stamped only
-- after the loop finishes and so cannot say "a pass is under way".
--
-- A posting zombie is therefore `posting_started_at IS NOT NULL AND
-- posted_at IS NULL`: a pass began and never reached the end.
--
-- Not cleared on success — it records when the last pass started, which
-- is what you want when diagnosing one that is merely slow. A second
-- pass over a run with stragglers overwrites it, so the marker always
-- describes the pass in progress rather than the first one ever run.
ALTER TABLE "billing_run"
  ADD COLUMN "posting_started_at" TIMESTAMPTZ;

-- Partial, because the sweep only ever asks for the zombies and they are
-- a vanishing fraction of the table — the steady state is none at all.
CREATE INDEX "billing_run_posting_in_flight_idx"
  ON "billing_run" ("posting_started_at")
  WHERE "posting_started_at" IS NOT NULL AND "posted_at" IS NULL;
