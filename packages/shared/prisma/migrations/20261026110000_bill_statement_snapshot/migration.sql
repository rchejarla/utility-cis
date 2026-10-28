-- Where the account stood when this bill was issued.
--
-- The bill prints arrears since the fees group shipped, and its total
-- became a quantity answering no question: this period's rated charges
-- plus whichever non-bill entries fell inside a date window. On a real
-- account the AR tab said $41.54, the bill said $489.34, and the account
-- owed $554.71. The standard rule is current charges **plus past due**
-- (design: docs/superpowers/specs/2026-10-26-bill-statement-layout-design.md).
--
-- Snapshotted at posting rather than recomputed at render, because
-- `open_amount` is *now* and not as-of: rendering the August bill today
-- asks $523.55 while the account owes $503.17, the difference being
-- payments that arrived in October. Reconstructing a past balance is
-- possible — the settlement block already filters applications by the
-- credit's effective date — but `reverseEntry` DELETES the
-- `ledger_application` rows it undoes, so once a payment is reversed
-- there is no record the allocation existed and the reconstruction
-- cannot see it. A reprint would then differ from the document the
-- customer received, which is the one property `sha256` and byte-stable
-- regeneration exist to protect.
--
-- All three are NULLABLE, and that is the whole mechanism for bills
-- issued before this migration: the presentation omits the statement
-- lines rather than inventing them, so old bills keep printing exactly
-- as they do today. No backfill — the figures are not recoverable for
-- past bills, which is the same fact that makes snapshotting necessary.
--
-- Decimal(14,2), matching the ledger rather than the bill's own 4dp
-- columns: these are sums of `ledger_entry.amount`, which is
-- Decimal(14,2). Rating works in 4dp and the ledger does not.
ALTER TABLE bill
  ADD COLUMN previous_balance NUMERIC(14,2),
  ADD COLUMN payments_since   NUMERIC(14,2),
  ADD COLUMN past_due_amount  NUMERIC(14,2);

-- Either a bill carries the whole snapshot or none of it. A partial one
-- would let the presentation print a previous balance with no past-due
-- figure beside it, which reads as "none of this is overdue" — a claim
-- nothing checked.
ALTER TABLE bill
  ADD CONSTRAINT bill_statement_snapshot_whole CHECK (
    (previous_balance IS NULL AND payments_since IS NULL AND past_due_amount IS NULL)
    OR (previous_balance IS NOT NULL AND payments_since IS NOT NULL AND past_due_amount IS NOT NULL)
  );

-- Payments are reported as a positive figure and subtracted in the
-- layout, the way every bill in the trade prints them. Past due is a
-- part of what is owed, so neither can be negative. Previous balance
-- CAN be: an account in credit at the last bill carried that credit
-- forward, and clamping it would overstate what is owed.
ALTER TABLE bill
  ADD CONSTRAINT bill_payments_since_not_negative CHECK (payments_since >= 0);

ALTER TABLE bill
  ADD CONSTRAINT bill_past_due_not_negative CHECK (past_due_amount >= 0);
