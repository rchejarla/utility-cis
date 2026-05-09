-- Slice 5b.2 — per-Account, per-period customer-facing Bill.
-- Aggregates many BillSegments. See spec
-- docs/superpowers/specs/2026-05-08-rate-model-v2-slice-5b.md §4.

CREATE TABLE "bill" (
  "id"                  UUID          NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"          UUID          NOT NULL,
  "account_id"          UUID          NOT NULL,
  "billing_cycle_id"    UUID          NOT NULL,
  "period_start"        DATE          NOT NULL,
  "period_end"          DATE          NOT NULL,
  "bill_date"           DATE          NOT NULL,
  "due_date"            DATE          NOT NULL,
  "subtotal"            DECIMAL(14,4) NOT NULL,
  "taxes"               DECIMAL(14,4) NOT NULL,
  "credits"             DECIMAL(14,4) NOT NULL,
  "total"               DECIMAL(14,4) NOT NULL,
  "bill_number"         VARCHAR(50)   NOT NULL,
  "created_at"          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT "bill_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bill_account_fkey"
    FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
  CONSTRAINT "bill_billing_cycle_fkey"
    FOREIGN KEY ("billing_cycle_id") REFERENCES "billing_cycle"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "bill_utility_bill_number_key" ON "bill"("utility_id", "bill_number");
CREATE INDEX "bill_account_period_end_idx" ON "bill"("utility_id", "account_id", "period_end");
CREATE INDEX "bill_due_date_idx" ON "bill"("utility_id", "due_date");

ALTER TABLE "bill" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "bill"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);

-- Add bill_id link on BillSegment. Nullable: a segment exists before
-- being attached to a Bill (5a default). Singular column = at most one
-- Bill per segment (no join table needed).
ALTER TABLE "bill_segment"
  ADD COLUMN "bill_id" UUID NULL;
ALTER TABLE "bill_segment"
  ADD CONSTRAINT "bill_segment_bill_fkey"
  FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE RESTRICT;
CREATE INDEX "bill_segment_bill_idx" ON "bill_segment"("utility_id", "bill_id");
