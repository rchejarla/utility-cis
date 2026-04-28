-- Import infrastructure (spec 22, slice 1).
--
-- Lifts ImportBatch out of being meter-read-specific into a generic
-- bulk-upload primitive used across customers, premises, meters,
-- accounts, and any future entity that wants bulk import. Adds:
--
--   1. ImportBatch column extensions: entity_kind (drives handler
--      dispatch), processing_started_at + last_progress_at (for the
--      slice-2 zombie-batch sweep), cancel_requested (slice 2 cancel
--      semantics), mapping (replay/audit). Drops the per-batch errors
--      JSON column — per-row errors live in the new import_row table.
--   2. ImportBatchStatus enum widened to include PARTIAL and CANCELLED.
--      PARTIAL = some rows succeeded (different from FAILED, which
--      means none did). CANCELLED = user pressed cancel.
--   3. import_row: per-row state. The reason this is a separate table,
--      not a JSON column on the batch, is that 100k-row imports want
--      paginated lists, status filtering, and resume-after-crash, all
--      of which are awkward against a single JSON blob.
--   4. in_app_notification: row-per-event "bell icon" inbox. First
--      consumer is import completion; designed for reuse by future
--      modules (suspension activations, billing-cycle finalisation,
--      etc.). Slice 2 emits these rows; slice 4 renders the bell.

-- ─── ImportBatch column extensions ──────────────────────────────────

ALTER TABLE import_batch
  ADD COLUMN entity_kind varchar(50) NOT NULL DEFAULT 'meter_read',
  ADD COLUMN processing_started_at timestamptz,
  ADD COLUMN last_progress_at timestamptz,
  ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN mapping jsonb;

-- DEFAULT was only needed for the backfill on existing rows; new
-- rows must declare their kind explicitly.
ALTER TABLE import_batch
  ALTER COLUMN entity_kind DROP DEFAULT;

ALTER TABLE import_batch
  DROP COLUMN errors;

CREATE INDEX import_batch_entity_kind_idx
  ON import_batch (utility_id, entity_kind, created_at DESC);

-- ─── ImportBatchStatus enum widening ────────────────────────────────

ALTER TYPE "ImportBatchStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';
ALTER TYPE "ImportBatchStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- ─── import_row table ───────────────────────────────────────────────

CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'IMPORTED', 'ERROR', 'SKIPPED');

CREATE TABLE import_row (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id   uuid NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  row_index         integer NOT NULL,
  raw_data          jsonb NOT NULL,
  status            "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
  result_entity_id  uuid,
  error_code        varchar(64),
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz
);

CREATE INDEX import_row_batch_status_idx ON import_row (import_batch_id, status);
CREATE INDEX import_row_batch_index_idx ON import_row (import_batch_id, row_index);

-- ─── in_app_notification table ──────────────────────────────────────

CREATE TYPE "InAppNotificationKind" AS ENUM (
  'IMPORT_COMPLETE',
  'IMPORT_FAILED',
  'IMPORT_CANCELLED',
  'IMPORT_PARTIAL'
);

CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ERROR');

CREATE TABLE in_app_notification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  kind        "InAppNotificationKind" NOT NULL,
  severity    "NotificationSeverity" NOT NULL,
  title       varchar(200) NOT NULL,
  body        text NOT NULL,
  link        varchar(500),
  metadata    jsonb,
  is_read     boolean NOT NULL DEFAULT false,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One index serves both "unread for me, newest first" (the bell drop-
-- down) and "everything for me" filtered/sorted use cases. Postgres
-- can use the leading is_read column on partial filters either way.
CREATE INDEX in_app_notification_user_idx
  ON in_app_notification (utility_id, user_id, is_read, created_at DESC);
