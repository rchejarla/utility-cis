-- Slice 5a — Bill + BillLine
-- Persisted output of the v2 rate engine.
CREATE TABLE "bill" (
  "id"                     UUID         NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"             UUID         NOT NULL,
  "service_agreement_id"   UUID         NOT NULL,
  "period_start"           DATE         NOT NULL,
  "period_end"             DATE         NOT NULL,
  "subtotal"               DECIMAL(14,4) NOT NULL,
  "taxes"                  DECIMAL(14,4) NOT NULL,
  "credits"                DECIMAL(14,4) NOT NULL,
  "total"                  DECIMAL(14,4) NOT NULL,
  "minimum_floor_applied"  BOOLEAN      NOT NULL,
  "bill_number"            VARCHAR(50)  NOT NULL,
  "created_at"             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "bill_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bill_service_agreement_fkey"
    FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "bill_utility_bill_number_key" ON "bill"("utility_id", "bill_number");
CREATE INDEX "bill_sa_period_idx" ON "bill"("utility_id", "service_agreement_id", "period_start");
CREATE INDEX "bill_period_end_idx" ON "bill"("utility_id", "period_end");

ALTER TABLE "bill" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "bill"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);

CREATE TABLE "bill_line" (
  "id"                   UUID          NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"           UUID          NOT NULL,
  "bill_id"              UUID          NOT NULL,
  "label"                VARCHAR(255)  NOT NULL,
  "kind_code"            VARCHAR(50)   NOT NULL,
  "amount"               DECIMAL(14,4) NOT NULL,
  "quantity"             DECIMAL(14,4),
  "source_schedule_id"   UUID          NOT NULL,
  "source_component_id"  UUID          NOT NULL,
  "sort_order"           INTEGER       NOT NULL,
  CONSTRAINT "bill_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bill_line_bill_fkey"
    FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE CASCADE,
  CONSTRAINT "bill_line_schedule_fkey"
    FOREIGN KEY ("source_schedule_id") REFERENCES "rate_schedule"("id") ON DELETE RESTRICT,
  CONSTRAINT "bill_line_component_fkey"
    FOREIGN KEY ("source_component_id") REFERENCES "rate_component"("id") ON DELETE RESTRICT
);
CREATE INDEX "bill_line_bill_sort_idx" ON "bill_line"("bill_id", "sort_order");
CREATE INDEX "bill_line_component_idx" ON "bill_line"("utility_id", "source_component_id");

ALTER TABLE "bill_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "bill_line"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);
