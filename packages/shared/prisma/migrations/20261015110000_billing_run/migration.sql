-- The billing run: one initiated pass over a cycle's window, with one
-- row per account and the record of what happened to it.
--
-- Why a row and not a long request: twelve thousand accounts each rating
-- several agreements is minutes of work, and an HTTP request that long
-- dies to a proxy with the work half done and no record of how far it
-- got. Re-running it then turns the per-account overlap guard into
-- twelve thousand 409s rather than a resume.
--
-- Shaped after import_batch / import_row on purpose — per-item status,
-- resume by status filter, cancel_requested, last_progress_at — but kept
-- a separate schema: the two share a shape, not a vocabulary.

CREATE TYPE "billing_run_status" AS ENUM
  ('PENDING', 'RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED');

CREATE TYPE "billing_run_item_status" AS ENUM
  ('PENDING', 'BILLED', 'SKIPPED', 'FAILED');

CREATE TABLE "billing_run" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"       UUID        NOT NULL,
  "billing_cycle_id" UUID        NOT NULL,
  -- The scheduling window, not the service period: which accounts are
  -- due and which reads to expect. What a bill is *for* is read to read
  -- and lives on the segments.
  "window_start"     DATE        NOT NULL,
  "window_end"       DATE        NOT NULL,
  -- The utility's own dates, identical across the run.
  "bill_date"        DATE        NOT NULL,
  "due_date"         DATE        NOT NULL,
  "status"           "billing_run_status" NOT NULL DEFAULT 'PENDING',
  "account_count"    INTEGER     NOT NULL DEFAULT 0,
  "billed_count"     INTEGER     NOT NULL DEFAULT 0,
  "exception_count"  INTEGER     NOT NULL DEFAULT 0,
  "posted_at"        TIMESTAMPTZ,
  "posted_by"        UUID,
  "cancel_requested" BOOLEAN     NOT NULL DEFAULT false,
  "last_progress_at" TIMESTAMPTZ,
  "created_by"       UUID        NOT NULL,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "billing_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_run_cycle_fkey" FOREIGN KEY ("billing_cycle_id")
    REFERENCES "billing_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- A window that ends before it starts, or a bill dated before the
  -- reads were due, is a caller error rather than a state to carry.
  CONSTRAINT "billing_run_window_ordered" CHECK ("window_end" >= "window_start"),
  CONSTRAINT "billing_run_due_after_bill" CHECK ("due_date" >= "bill_date")
);

-- One run per cycle per window. A second attempt is a 409 naming the
-- first, not a second set of bills.
CREATE UNIQUE INDEX "billing_run_utility_cycle_window_key"
  ON "billing_run" ("utility_id", "billing_cycle_id", "window_end");

CREATE INDEX "billing_run_utility_id_created_at_idx"
  ON "billing_run" ("utility_id", "created_at");

CREATE TABLE "billing_run_item" (
  "id"                   UUID    NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"           UUID    NOT NULL,
  "billing_run_id"       UUID    NOT NULL,
  "account_id"           UUID    NOT NULL,
  "status"               "billing_run_item_status" NOT NULL DEFAULT 'PENDING',
  "bill_id"              UUID,
  -- What this account was actually billed for, so a 44-day interval is
  -- visible on the run's own page.
  "service_period_start" DATE,
  "service_period_end"   DATE,
  "segment_count"        INTEGER NOT NULL DEFAULT 0,
  "total"                NUMERIC(14,4),
  "error_code"           VARCHAR(64),
  "error_message"        TEXT,
  "processed_at"         TIMESTAMPTZ,
  CONSTRAINT "billing_run_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_run_item_run_fkey" FOREIGN KEY ("billing_run_id")
    REFERENCES "billing_run"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "billing_run_item_account_fkey" FOREIGN KEY ("account_id")
    REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- SET NULL rather than RESTRICT: dropping a bill should not be blocked
  -- by the run that made it, and the item's own record of having billed
  -- survives in its status and totals.
  CONSTRAINT "billing_run_item_bill_fkey" FOREIGN KEY ("bill_id")
    REFERENCES "bill"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "billing_run_item_period_ordered"
    CHECK ("service_period_end" IS NULL OR "service_period_start" IS NULL
           OR "service_period_end" >= "service_period_start")
);

-- One item per account per run, which is what makes a resume safe: a
-- BILLED item cannot be created twice.
CREATE UNIQUE INDEX "billing_run_item_run_account_key"
  ON "billing_run_item" ("billing_run_id", "account_id");

-- The worker's own query: the PENDING items of one run.
CREATE INDEX "billing_run_item_run_status_idx"
  ON "billing_run_item" ("billing_run_id", "status");

ALTER TABLE "billing_run" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "billing_run"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);

ALTER TABLE "billing_run_item" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "billing_run_item"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);
