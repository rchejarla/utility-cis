-- One live delinquency action per account per tier.
--
-- `evaluateAll` guards against duplicates with an in-memory Set built
-- before its loop. That cannot see another process. The sweep runs on
-- `0 * * * *` with BullMQ retries behind it, so two `delinquency-tenant`
-- jobs for the same tenant — or one job retried after a partial failure
-- — each build the Set separately and neither sees the other's writes.
-- A database constraint is the only guard that spans processes, and it
-- stops mattering cosmetically the moment a tier charges a fee: a
-- duplicate notice is embarrassing, a duplicate fee is a wrong bill.
--
-- PARTIAL, on the two live statuses only. A RESOLVED or CANCELLED action
-- is history: the account cleared the tier and may legitimately enter it
-- again later, so including those statuses would lock an account out of
-- its own ladder forever.
--
-- (utility_id, …) leads so the index is usable per tenant and cannot
-- collide across tenants, consistent with every other key here.
--
-- If a database already holds duplicate live actions this fails loudly
-- rather than choosing which to keep. That is the intent: which of two
-- notices was really sent is not a question SQL should answer.
CREATE UNIQUE INDEX delinquency_action_one_live_per_rule
  ON delinquency_action (utility_id, account_id, rule_id)
  WHERE status IN ('PENDING'::delinquency_action_status,
                   'COMPLETED'::delinquency_action_status);
