-- Whether a tier's fee adds to what the ladder charged below it, or
-- replaces it.
--
-- $10 at 15 days and $25 at 30 days should leave $25 owing, not $35: the
-- second charge is the penalty for being a month late, not an addition
-- to the penalty for being a fortnight late. Which of the two a utility
-- wants is policy, so it is configuration.
--
-- Defaults to ACCUMULATE, which is what every tier did before the mode
-- existed, so nobody's bill changes until someone asks for replacement.
CREATE TYPE delinquency_fee_mode AS ENUM ('ACCUMULATE', 'REPLACE_LOWER_TIERS');

ALTER TABLE delinquency_rule
  ADD COLUMN fee_mode delinquency_fee_mode NOT NULL DEFAULT 'ACCUMULATE';

-- A tier that charges nothing cannot ask to replace. Allowing it would
-- make REPLACE_LOWER_TIERS a way to spell "cancel the earlier late
-- fees", which is forgiveness — and forgiveness is a waiver, raised by
-- someone who decided to grant it, not a side effect of a schedule.
ALTER TABLE delinquency_rule
  ADD CONSTRAINT delinquency_rule_replace_needs_fee CHECK (
    fee_mode = 'ACCUMULATE' OR fee_type IS NOT NULL
  );
