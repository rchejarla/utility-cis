-- Bill holds (Bozeman #136) — stopping a bill without cancelling it.
--
-- A held bill cannot be posted and cannot be delivered. It still exists,
-- still carries its lines and its total; nothing further happens to it
-- until somebody releases it. It is not a cancellation, not a reversal,
-- and not a reason to skip calculating: an account on hold is still
-- billed, because a period that goes unbilled rolls up into the next one
-- and that is its own failure.
--
-- Both gates rather than delivery alone. Posting is the irreversible
-- step — a wrong charge is undone by a reversal on the ledger, in full
-- view, never by an edit — so a hold that stopped only delivery would
-- let the bill somebody is unsure about become money owed, move the
-- account's balance, and show up in the portal and in delinquency while
-- they were still looking at it.
--
-- Two columns rather than a `bill_hold` entity. The usual case for the
-- entity is the history: who held it, when, why, and who let it go. That
-- history already exists — every change here goes through `auditUpdate`,
-- which records the actor, so the entity would restate fields to
-- re-answer an answered question. If a hold ever needs approval to
-- release, an expiry, or a type, it becomes a workflow object with a
-- lifecycle and a column cannot carry that; today the requirement is one
-- line.
--
-- The column *is* the hold: NULL means not held. A hold with no reason
-- is useless to whoever finds it next week, so placing one requires a
-- reason and releasing clears it.

ALTER TABLE "bill" ADD COLUMN "hold_reason" VARCHAR(500);

-- A standing rule on the account: its bills are born held, carrying this
-- reason. The individual half of "individual accounts or events"; the
-- event half is a bulk apply that writes per-bill holds, so that what was
-- held can be listed and released exactly.
ALTER TABLE "account" ADD COLUMN "billing_hold_reason" VARCHAR(500);

-- "Bills on hold" is a dashboard figure and a worklist, and held bills
-- are a small minority of the table, so the index carries only them.
CREATE INDEX "bill_utility_id_hold_reason_idx"
  ON "bill" ("utility_id")
  WHERE "hold_reason" IS NOT NULL;

CREATE INDEX "account_utility_id_billing_hold_reason_idx"
  ON "account" ("utility_id")
  WHERE "billing_hold_reason" IS NOT NULL;
