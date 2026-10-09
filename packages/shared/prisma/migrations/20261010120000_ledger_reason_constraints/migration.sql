-- AR Ledger slice 3. The two CHECK constraints deferred from slice 1,
-- addable now that LedgerReasonDef is seeded and every service that
-- writes a reasoned type cites a reason.
--
-- Neither is the constraint spec §4.2 literally asks for, and both
-- departures were established by trying the specified version against
-- the live schema rather than by reading.

-- §4.2 asks for `reason_id IS NOT NULL` on these four types. Adding that
-- fails outright — `ERROR: check constraint ... is violated by some row`
-- — because two already-shipped paths write such rows without a reason:
--
--   * seed.js's opening balances, ADJUSTMENT_DEBIT with no reason and no
--     bill. Fixed at source: the seeder now cites OPENING_BALANCE.
--   * postBill's credit for a bill that nets negative, ADJUSTMENT_CREDIT
--     with no reason — but carrying bill_id since slice 1's fix wave.
--
-- Requiring a reason on that second path would couple posting a negative
-- bill to the tenant having reason seeds, so a tenant with none could not
-- post one. A credit that names the bill it came from is self-explaining,
-- so the rule is: a reason, OR the bill it came from.
--
-- PAYMENT and REVERSAL are absent from the list deliberately. A payment's
-- provenance is its tender and external_ref; a reversal's is reverses_id.
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_reason_required" CHECK (
  "type" NOT IN ('FEE','ADJUSTMENT_DEBIT','ADJUSTMENT_CREDIT','WRITE_OFF')
  OR "reason_id" IS NOT NULL
  OR "bill_id" IS NOT NULL
);

-- §4.2's field table calls assessed_on_id "FEE only — the debit that went
-- unpaid". That cannot mean every FEE names one: a tap fee or a meter test
-- fee is assessed on nothing, and requiring it would make the common case
-- unwritable. The enforceable half is the converse — only a FEE may name
-- one — which is what stops an adjustment or a write-off claiming a
-- provenance it does not have.
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_assessed_on_only_fee" CHECK (
  "assessed_on_id" IS NULL OR "type" = 'FEE'
);
