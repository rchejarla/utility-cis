-- Constraints for REFUND.

-- A refund is a DEBIT: positive, like a charge. It consumes an open
-- credit and brings the account back toward zero, which is the same
-- arithmetic a bill performs against an overpayment. Giving money back
-- is not a credit to the customer -- they already had the credit; this
-- is it being discharged.
ALTER TABLE "ledger_entry" DROP CONSTRAINT "ledger_entry_type_sign";
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_type_sign" CHECK (
  ("type" IN ('BILL_CHARGE','FEE','ADJUSTMENT_DEBIT','REFUND') AND "amount" > 0)
  OR ("type" IN ('PAYMENT','ADJUSTMENT_CREDIT','WRITE_OFF','DEPOSIT') AND "amount" < 0)
  OR ("type" = 'REVERSAL' AND "reverses_id" IS NOT NULL)
);

-- A refund carries HOW the money left, exactly as a payment and a
-- deposit carry how it arrived: `tender` for the method, `external_ref`
-- for the cheque number, `effective_date` for the day it was issued.
--
-- Those three columns are the disbursement record. A separate
-- `disbursement` table would add batching several refunds into one
-- cheque run, a lifecycle (issued -> cleared -> voided) and
-- approved-but-unpaid state; none of those is a stated need, and spec 10
-- already establishes that APPROVAL belongs outside the ledger because
-- posting is final.
ALTER TABLE "ledger_entry" DROP CONSTRAINT "ledger_entry_tender_only_payment";
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_tender_only_payment" CHECK (
  "tender" IS NULL OR "type" IN ('PAYMENT','DEPOSIT','REFUND')
);
