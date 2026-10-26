-- Which reasons a delinquency tier may book its late fee to.
--
-- Only a late-fee reason should. Of the five seeded FEE reasons, four
-- answer to their own event rather than to time passing: a returned
-- payment fee when a payment bounces, a tap fee when a tap is cut, a
-- meter test fee when a meter is tested, a reconnection fee when service
-- is restored. Offering all five left a tier's dropdown with one right
-- answer out of five, and booking late fees under "Returned payment fee"
-- is a silent accounting error — the customer's bill would say it.
--
-- On the reason, not as a list of codes inside the delinquency module,
-- for the same reason `is_penalty` is: reason codes are
-- tenant-configurable, so a utility that calls theirs RETURNED_ITEM, or
-- adds a second bounced-payment reason, would defeat any such list. The
-- rule against keying business logic on a reason code is what this
-- column exists to honour.
--
-- Defaults false. A reason the tenant has not opted in is not something
-- a schedule may charge to, which is the safe direction: a tier that
-- cannot be saved is a visible problem, a tier quietly charging to the
-- wrong reason is not.
ALTER TABLE ledger_reason_def
  ADD COLUMN allows_delinquency_fee BOOLEAN NOT NULL DEFAULT false;

-- Backfill the one default that qualifies, for tenants that already hold
-- it. `DEFAULT_REASON_CODES` remains the authority —
-- `seedDefaultReasons` sets the flag on create and corrects any existing
-- row whose flag is wrong, so this is a one-time catch-up and not a
-- second place the classification is decided.
UPDATE ledger_reason_def
   SET allows_delinquency_fee = true
 WHERE code = 'LATE_FEE';
