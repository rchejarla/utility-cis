-- Add automation/scheduler config columns to tenant_config.
-- Per spec docs/superpowers/specs/2026-04-24-job-scheduler-migration-design.md §3.4.
--
-- All columns NOT NULL with sensible defaults so existing rows backfill
-- without a separate UPDATE pass. Defaults match current behavior:
-- every scheduler enabled, UTC timezone, quiet hours 22:00-07:00 local,
-- delinquency runs at 03:00 local, audit retention 365 days.
--
-- Prisma's generated SQL also contained spurious DROP INDEX and
-- ALTER COLUMN ... DROP DEFAULT statements for FTS GIN indexes and
-- generated search_vector columns, plus an unrelated meter_read index
-- swap. Those are shadow-DB drift artifacts from earlier raw-SQL
-- migrations (FTS + Timescale features Prisma doesn't model) — stripped
-- per the project's prisma-migrations workflow rule.

ALTER TABLE "tenant_config"
  ADD COLUMN "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
  ADD COLUMN "suspension_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notification_send_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sla_breach_sweep_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "delinquency_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "delinquency_run_hour_local" SMALLINT NOT NULL DEFAULT 3,
  ADD COLUMN "delinquency_last_run_at" TIMESTAMPTZ,
  ADD COLUMN "notification_quiet_start" VARCHAR(5) NOT NULL DEFAULT '22:00',
  ADD COLUMN "notification_quiet_end" VARCHAR(5) NOT NULL DEFAULT '07:00',
  ADD COLUMN "scheduler_audit_retention_days" INTEGER NOT NULL DEFAULT 365;
