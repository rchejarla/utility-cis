-- Slice 5b.1 — move billing cycle from ServiceAgreement to Account.
--
-- Rationale: industry convention (Oracle CC&B CI_ACCT.BILL_CYC_CD; SAP IS-U
-- Contract Account FKKVKP) places billing cycle on the financial-relationship
-- entity (our Account), not on per-service contracts (our SA). One bill per
-- account per cycle is the customer-facing model. See spec
-- docs/superpowers/specs/2026-05-08-rate-model-v2-slice-5b.md §3.
--
-- Also drops billing_cycle.read_day_of_month — collected today but consumed
-- by zero code paths. Reserves the read-schedule concept for the future
-- MeterRoute entity, attached to ServicePoint.

-- 1. Drop read_day_of_month and its CHECK constraint.
ALTER TABLE "billing_cycle" DROP CONSTRAINT IF EXISTS "billing_cycle_read_day_of_month_check";
ALTER TABLE "billing_cycle" DROP COLUMN "read_day_of_month";

-- 2. Add nullable cycle FK to Account so the backfill can run.
ALTER TABLE "account" ADD COLUMN "billing_cycle_id" UUID;

-- 3. Backfill: each Account inherits one of its SAs' cycles. Dev-DB
--    invariant is that all SAs under one Account share a cycle today; the
--    LIMIT 1 is defensive if real data ever exhibits drift. If an Account
--    has zero SAs, billing_cycle_id stays NULL and the next step will fail
--    loudly — surface the problem rather than silently picking a default.
UPDATE "account"
   SET "billing_cycle_id" = (
     SELECT "sa"."billing_cycle_id"
       FROM "service_agreement" "sa"
      WHERE "sa"."account_id" = "account"."id"
      LIMIT 1
   );

-- 4. NOT NULL + FK + index. The NOT NULL conversion will fail if any
--    Account remained un-backfilled in step 3 — that's intentional
--    (forces a manual decision rather than corrupting data).
ALTER TABLE "account" ALTER COLUMN "billing_cycle_id" SET NOT NULL;
ALTER TABLE "account"
  ADD CONSTRAINT "account_billing_cycle_id_fkey"
  FOREIGN KEY ("billing_cycle_id") REFERENCES "billing_cycle"("id") ON DELETE RESTRICT;
CREATE INDEX "account_utility_billing_cycle_idx" ON "account"("utility_id", "billing_cycle_id");

-- 5. Drop SA's billing_cycle_id column + its FK + index.
ALTER TABLE "service_agreement" DROP CONSTRAINT IF EXISTS "service_agreement_billing_cycle_id_fkey";
DROP INDEX IF EXISTS "service_agreement_billing_cycle_id_idx";
ALTER TABLE "service_agreement" DROP COLUMN "billing_cycle_id";
