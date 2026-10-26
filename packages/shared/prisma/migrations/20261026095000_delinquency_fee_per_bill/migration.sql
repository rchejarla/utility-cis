-- A delinquency tier charges per overdue bill.
--
-- The ladder's clock was the account's: `days_past_due` comes from the
-- oldest open debit, so a bill posted last week was charged a late fee
-- because an older one had reached 40 days, and a percentage tier took
-- its rate against the whole balance — money the customer had not yet
-- been asked to pay. Each unpaid bill now passes the tiers on its own
-- clock and pays its own penalty.
--
-- One consequence is structural: a tier can raise several fees for one
-- account, one per qualifying bill, so the action's single
-- `fee_entry_id` cannot hold them. The alternative was an action per
-- bill, which would also have meant a notice per bill — three tier-one
-- emails for three unpaid bills. The action stays the record of what was
-- *done* to the account, and the fees hang off it here.
CREATE TABLE delinquency_action_fee (
  utility_id UUID        NOT NULL,
  action_id  UUID        NOT NULL,
  entry_id   UUID        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Keyed on the entry: a fee belongs to one action and no other.
  CONSTRAINT delinquency_action_fee_pkey PRIMARY KEY (utility_id, entry_id)
);

CREATE INDEX delinquency_action_fee_action_idx
  ON delinquency_action_fee (utility_id, action_id);

-- Tenant-scoped composites, like every other key between two
-- tenant-scoped tables here, so a row in one tenant cannot reference a
-- row in another. RESTRICT on both: an action is history and a ledger
-- entry is reversed, never deleted.
ALTER TABLE delinquency_action_fee
  ADD CONSTRAINT delinquency_action_fee_utility_id_fkey
  FOREIGN KEY (utility_id) REFERENCES utility (id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE delinquency_action_fee
  ADD CONSTRAINT delinquency_action_fee_action_id_fkey
  FOREIGN KEY (utility_id, action_id)
  REFERENCES delinquency_action (utility_id, id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE delinquency_action_fee
  ADD CONSTRAINT delinquency_action_fee_entry_id_fkey
  FOREIGN KEY (utility_id, entry_id)
  REFERENCES ledger_entry (utility_id, id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- Tenant isolation, which `schema-invariants.integration.test.ts`
-- requires of every table carrying a `utility_id` — and which caught
-- this table arriving without it.
--
-- One-argument `current_setting`, deliberately: with no tenant set this
-- raises 22023 rather than returning nothing. An empty result from the
-- table that says which fees the ladder owns would read as "this tier
-- has charged nothing", and a replacing tier would then reverse nothing
-- and charge on top.
--
-- FORCE as well as ENABLE, so the owner is not exempt either. The index
-- the policy reads through is the (utility_id, action_id) one above,
-- whose leading column is the policy's.
ALTER TABLE delinquency_action_fee ENABLE ROW LEVEL SECURITY;
ALTER TABLE delinquency_action_fee FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delinquency_action_fee
  USING (utility_id = (current_setting('app.current_utility_id'))::uuid);

-- `delinquency_action` needs (utility_id, id) unique for the key above.
-- The 2026-10-25 sweep added that only to tables already targeted by a
-- single-column foreign key, and nothing referenced an action until now.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'delinquency_action'
       AND c.contype IN ('u', 'p')
       AND array_length(c.conkey, 1) = 2
  ) THEN
    ALTER TABLE delinquency_action
      ADD CONSTRAINT delinquency_action_utility_id_id_key UNIQUE (utility_id, id);
  END IF;
END $$;

-- Carry across what the one-fee-per-action model recorded, then drop it.
-- This branch is unmerged and the column is three commits old, so there
-- is little to carry — but a dev database that has run those migrations
-- holds rows, and losing the link silently would make a replacing tier
-- reverse nothing.
INSERT INTO delinquency_action_fee (utility_id, action_id, entry_id)
SELECT utility_id, id, fee_entry_id
  FROM delinquency_action
 WHERE fee_entry_id IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE delinquency_action
  DROP CONSTRAINT delinquency_action_fee_entry_id_fkey;

ALTER TABLE delinquency_action
  DROP COLUMN fee_entry_id;
