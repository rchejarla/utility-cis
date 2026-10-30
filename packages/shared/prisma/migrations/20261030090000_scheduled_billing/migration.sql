-- Billing that happens on its own day.
--
-- A billing cycle declares `bill_day_of_month` and nothing acts on it:
-- somebody opens a screen on the bill day and presses a button, per
-- cycle, every month, for every tenant. These three columns and one
-- dropped NOT NULL are what a dispatcher needs to do it instead.
-- `docs/specs/27-job-scheduling.md` §3.

-- ─── A run nobody started ────────────────────────────────────────────
--
-- `created_by` was NOT NULL because every run had a person behind it.
-- A scheduled run has no user principal, and the alternative — a
-- reserved system uuid in `cis_user` — would need a `utility_id` on a
-- row that is not a user and belongs to no tenant, which is exactly
-- the shape the platform-actor work spent a migration getting right.
--
-- Null here means "the schedule did this", and the audit trail carries
-- the sentence instead: `actor_name` of "Billing dispatcher" and a
-- `source` of `scheduler:billing-dispatch`, the convention the
-- suspension sweep already writes.
--
-- No foreign key to drop or re-point: `billing_run.created_by` has
-- never had one. It is a bare uuid column, like the other `created_by`
-- columns outside `service_request`.
--
-- Reversible in principle and not in practice: going back would need
-- every scheduled run's `created_by` filled in with somebody who did
-- not start it.
ALTER TABLE "billing_run"
  ALTER COLUMN "created_by" DROP NOT NULL;

-- ─── Whether a tenant's billing is automated, and when ───────────────
--
-- Beside the delinquency pair, which these mirror exactly:
-- an enable flag, a tenant-local hour, and the last dispatch, so a
-- missed tick can be told from one that never came due.
--
-- `billing_enabled` defaults to **false**, unlike every other
-- scheduler flag on this table. A tenant that has been billing by hand
-- must not discover automation by finding bills it did not ask for —
-- the one place where inheriting a default would charge somebody's
-- customers.
--
-- Per tenant rather than per cycle, decided 2026-10-30. One switch for
-- a utility's automated billing; a utility wanting its monthly
-- residential cycle automated and its quarterly irrigation cycle by
-- hand cannot say so yet, and `billing_cycle.active` already stops a
-- cycle being billed at all. A per-cycle column would narrow this flag
-- rather than replace it, so this does not foreclose it.
--
-- `billing_run_hour_local` carries no CHECK, matching
-- `delinquency_run_hour_local` beside it: the 0-23 range is enforced in
-- the Zod schema at the API boundary, which is the only way a value
-- reaches this column.
ALTER TABLE "utility_config"
  ADD COLUMN "billing_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "billing_run_hour_local" SMALLINT NOT NULL DEFAULT 3,
  ADD COLUMN "billing_last_run_at" TIMESTAMPTZ;
