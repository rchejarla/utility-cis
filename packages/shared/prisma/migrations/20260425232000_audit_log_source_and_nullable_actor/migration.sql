-- Make audit_log.actor_id nullable + add a `source` column.
--
-- Why nullable actor_id:
--   Scheduler-emitted audits don't have a user actor (the scheduler
--   isn't a CisUser). Forcing a sentinel UUID would either pollute
--   the user space or require a "system user" row that's never a
--   real principal. NULL is the honest value.
--
-- Why a `source` column:
--   Per spec docs/superpowers/specs/2026-04-24-job-scheduler-migration-design.md §3.6.
--   Scheduler audits use `source = 'scheduler:<queue-name>'` (e.g.,
--   'scheduler:suspension-transitions'). User audits use
--   `source = 'user:<cisUserId>'`. The audit-retention sweep
--   (Task 9) filters on source LIKE 'scheduler:%' so user audits
--   stay outside its scope.

ALTER TABLE "audit_log" ALTER COLUMN "actor_id" DROP NOT NULL;

ALTER TABLE "audit_log" ADD COLUMN "source" VARCHAR(100);

CREATE INDEX "audit_log_utility_id_source_created_at_idx"
  ON "audit_log" ("utility_id", "source", "created_at");
