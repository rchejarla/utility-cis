-- A delinquency tier charges a fee.
--
-- The fee goes on the tier rather than on a separate PenaltyRule, which
-- spec 10 had planned. That entity's four identifying fields —
-- days_past_due, min_balance, account_type, and a tier ordering — are
-- `delinquency_rule`'s already, and the escalation an operator actually
-- wants ($10 at 15 days, 1.5% at 30, shut-off at 45) is exactly the tier
-- ladder that exists and is already kept distinct by
-- (utility_id, account_type, tier). A separate entity would mean one row
-- per rung anyway, two ladders to maintain, and nothing keeping the
-- thresholds in step.
CREATE TYPE delinquency_fee_type AS ENUM ('FLAT_FEE', 'PERCENT_OF_BALANCE');

ALTER TABLE delinquency_rule
  ADD COLUMN fee_type      delinquency_fee_type,
  ADD COLUMN fee_amount    DECIMAL(10, 4),
  ADD COLUMN max_fee       DECIMAL(10, 2),
  ADD COLUMN fee_reason_id UUID;

ALTER TABLE delinquency_action
  ADD COLUMN fee_entry_id UUID;

-- Which reason the fee cites is configuration on the tier, because the
-- sweep cannot know it: reason codes are tenant-configurable, so there
-- is no code this codebase could hardcode. Tenant-scoped and composite,
-- like every other key between two tenant-scoped tables here, so a rule
-- cannot cite another tenant's reason — which RLS cannot enforce,
-- because a referential-integrity check is not a row read.
--
-- MATCH SIMPLE (the default) is what makes the key optional: with
-- fee_reason_id NULL the constraint is satisfied regardless of
-- utility_id, which is why a tier that charges nothing needs no
-- sentinel.
--
-- RESTRICT on both, following ledger_entry's own convention for
-- reason_id, assessed_on_id and reverses_id. A reason is retired by
-- is_active and a ledger entry is reversed, never deleted, so neither
-- parent has a delete path for this to soften.
ALTER TABLE delinquency_rule
  ADD CONSTRAINT delinquency_rule_fee_reason_id_fkey
  FOREIGN KEY (utility_id, fee_reason_id)
  REFERENCES ledger_reason_def (utility_id, id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE delinquency_action
  ADD CONSTRAINT delinquency_action_fee_entry_id_fkey
  FOREIGN KEY (utility_id, fee_entry_id)
  REFERENCES ledger_entry (utility_id, id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- The three fee columns move together. An amount with no reason is a
-- charge nobody can explain; a reason with no amount is dead
-- configuration that reads as if the tier charges something.
ALTER TABLE delinquency_rule
  ADD CONSTRAINT delinquency_rule_fee_complete CHECK (
    (fee_type IS NULL AND fee_amount IS NULL AND fee_reason_id IS NULL)
    OR (fee_type IS NOT NULL AND fee_amount IS NOT NULL AND fee_reason_id IS NOT NULL)
  );

ALTER TABLE delinquency_rule
  ADD CONSTRAINT delinquency_rule_fee_amount_positive CHECK (
    fee_amount IS NULL OR fee_amount > 0
  );

-- A ceiling on a flat fee says nothing — the flat amount is already the
-- ceiling — so accepting it would let an operator believe they had
-- capped something.
ALTER TABLE delinquency_rule
  ADD CONSTRAINT delinquency_rule_max_fee_percent_only CHECK (
    max_fee IS NULL OR fee_type = 'PERCENT_OF_BALANCE'
  );

ALTER TABLE delinquency_rule
  ADD CONSTRAINT delinquency_rule_max_fee_positive CHECK (
    max_fee IS NULL OR max_fee > 0
  );
