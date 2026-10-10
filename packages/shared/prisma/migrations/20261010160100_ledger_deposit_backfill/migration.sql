-- Constraints for DEPOSIT, then the backfill.

-- A deposit is a credit: the utility holds it, the customer does not owe
-- it. Same sign as a payment, and for the same reason.
ALTER TABLE "ledger_entry" DROP CONSTRAINT "ledger_entry_type_sign";
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_type_sign" CHECK (
  ("type" IN ('BILL_CHARGE','FEE','ADJUSTMENT_DEBIT') AND "amount" > 0)
  OR ("type" IN ('PAYMENT','ADJUSTMENT_CREDIT','WRITE_OFF','DEPOSIT') AND "amount" < 0)
  OR ("type" = 'REVERSAL' AND "reverses_id" IS NOT NULL)
);

-- A deposit arrives by some tender, exactly as a payment does -- cash at
-- the counter, a cheque, a card. `tender` exists to record how money
-- moved, so a deposit is the second thing entitled to carry it.
ALTER TABLE "ledger_entry" DROP CONSTRAINT "ledger_entry_tender_only_payment";
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_tender_only_payment" CHECK (
  "tender" IS NULL OR "type" IN ('PAYMENT','DEPOSIT')
);

-- Backfill: every deposit currently held as a bare column becomes an open
-- DEPOSIT credit. `deposit_amount` survives as the cache of these, the
-- way `balance` caches the receivable.
--
-- `effective_date` is the account's creation date rather than today: the
-- money was taken when the account was opened, and dating it now would
-- put it in the wrong period on any report that groups by date.
--
-- Deliberately NOT touching `balance`. A deposit is a liability, not a
-- negative receivable: an account owing $169 while the utility holds
-- their $500 is still $169 in arrears, and the delinquency sweep reads
-- `balance > 0` to find it. Netting the two would silently stop chasing
-- exactly the customers a deposit was taken from.
INSERT INTO "ledger_entry" (
  "id", "utility_id", "account_id", "type", "amount", "open_amount",
  "due_date", "effective_date", "posted_at", "memo"
)
SELECT
  gen_random_uuid(),
  a."utility_id",
  a."id",
  'DEPOSIT',
  -a."deposit_amount",
  -a."deposit_amount",
  NULL,                        -- a credit has nothing to fall due
  a."created_at"::date,
  a."created_at",
  'Backfilled from account.deposit_amount'
FROM "account" a
WHERE a."deposit_amount" > 0;
