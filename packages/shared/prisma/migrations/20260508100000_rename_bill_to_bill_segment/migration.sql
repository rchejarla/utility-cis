-- Rename Bill → BillSegment to match industry convention (Oracle CC&B "Bill
-- Segment", SAP IS-U line item). Reserves the "Bill" name for the per-account
-- consolidated document (Statement) entity that Slice 5b will introduce.
--
-- Pure rename: tables, columns, indexes, FK constraints. RLS policies are
-- per-table so the policy name "tenant_isolation" can stay as-is on the
-- renamed tables.

-- 1. Rename tables.
ALTER TABLE "bill_line" RENAME TO "bill_segment_line";
ALTER TABLE "bill"      RENAME TO "bill_segment";

-- 2. Rename columns.
ALTER TABLE "bill_segment"      RENAME COLUMN "bill_number" TO "segment_number";
ALTER TABLE "bill_segment_line" RENAME COLUMN "bill_id"     TO "bill_segment_id";

-- 3. Rename indexes (Postgres ALTER TABLE RENAME does not rename indexes).
ALTER INDEX "bill_pkey"                     RENAME TO "bill_segment_pkey";
ALTER INDEX "bill_utility_bill_number_key"  RENAME TO "bill_segment_utility_segment_number_key";
ALTER INDEX "bill_sa_period_idx"            RENAME TO "bill_segment_sa_period_idx";
ALTER INDEX "bill_period_end_idx"           RENAME TO "bill_segment_period_end_idx";

ALTER INDEX "bill_line_pkey"                RENAME TO "bill_segment_line_pkey";
ALTER INDEX "bill_line_bill_sort_idx"       RENAME TO "bill_segment_line_segment_sort_idx";
ALTER INDEX "bill_line_component_idx"       RENAME TO "bill_segment_line_component_idx";

-- 4. Rename FK constraints.
ALTER TABLE "bill_segment"
  RENAME CONSTRAINT "bill_service_agreement_fkey" TO "bill_segment_service_agreement_fkey";
ALTER TABLE "bill_segment_line"
  RENAME CONSTRAINT "bill_line_bill_fkey"      TO "bill_segment_line_bill_segment_fkey";
ALTER TABLE "bill_segment_line"
  RENAME CONSTRAINT "bill_line_schedule_fkey"  TO "bill_segment_line_schedule_fkey";
ALTER TABLE "bill_segment_line"
  RENAME CONSTRAINT "bill_line_component_fkey" TO "bill_segment_line_component_fkey";
