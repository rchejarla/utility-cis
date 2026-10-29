-- A debit may appear in more than one plan over time — just not in two
-- live ones.
--
-- The original key was `(utility_id, entry_id)`: a debit belongs to at
-- most one plan, full stop. Combined with the rows persisting after a
-- plan ends — which is deliberate, they are history, and every key is
-- RESTRICT — that locked every covered debt out of every *future* plan.
--
-- Three things in the same design contradicted it:
--
--   * the service's own refusal told the CSR "this account is already on
--     a payment plan, cancel it before agreeing another", and cancelling
--     was the one act that made agreeing another impossible;
--   * `allowSecondPlanAfterDefault` defaults to true, and the design
--     records that Iowa *requires* offering a second plan after two
--     consecutive payments under the first — "neither permits a flat
--     refusal in code";
--   * the spec says changing agreed terms means cancelling and agreeing
--     again, since there is no PATCH.
--
-- So a CSR who mistyped an instalment count had no recovery short of a
-- database edit, and a defaulted account could be offered a plan the
-- save would then refuse.
--
-- What still has to hold is "not in two **live** plans at once", and no
-- index can express that: the predicate lives on `payment_plan.status`,
-- in another table. It is enforced in `createPaymentPlan` instead, and
-- the one-ACTIVE-plan-per-account rule makes it structural rather than
-- merely checked — a debit must be on the plan's own account, and an
-- account may have one live plan, so two live plans cannot reach the
-- same debit.
ALTER TABLE payment_plan_debit
  DROP CONSTRAINT payment_plan_debit_pkey;

ALTER TABLE payment_plan_debit
  ADD CONSTRAINT payment_plan_debit_pkey PRIMARY KEY (utility_id, plan_id, entry_id);

-- The suppression predicates all look a debit up by entry id and ask
-- the plan for its status. The old primary key served that; the new one
-- leads on `plan_id`, so the access path needs its own index.
CREATE INDEX payment_plan_debit_entry_idx
  ON payment_plan_debit (utility_id, entry_id);

-- Redundant now: the primary key above leads on exactly these columns.
DROP INDEX IF EXISTS payment_plan_debit_plan_idx;
