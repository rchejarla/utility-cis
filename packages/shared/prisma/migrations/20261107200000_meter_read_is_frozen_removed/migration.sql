-- `is_frozen` leaves `meter_read`. `billed_at` was always the column
-- that said it.
--
-- WHY
--
-- It was the flag for "this read has been billed, so it is locked" —
-- spec 08's "locking of reads after billing to prevent retroactive
-- tampering" — and **nothing in the codebase ever set it.** It has been
-- `BOOLEAN NOT NULL DEFAULT false` since the baseline migration, with
-- no writer: billing stamps `billed_at`
-- (`services/bill-segment.service.ts`), which carries the same fact and
-- the moment it happened.
--
-- Five readers believed it, and every one of them was inert:
--
--   * `deleteMeterRead` refused a "frozen (already billed) read" and
--     named the rebill workflow — so a read that had gone out on an
--     invoice was deletable by anyone holding `meter_reads:DELETE`.
--   * `resolveException` refused the same thing, the same way.
--   * The read log's Billed filter could only ever return nothing for
--     "Frozen (billed)", and returned billed reads under "Unbilled".
--   * Its ❄ indicator column never appeared.
--   * The read detail page never disabled Correct or Delete, and its
--     "Frozen" row printed "editable" for a read billed a month ago —
--     while already holding `billed_at`, which it rendered inside the
--     branch the dead flag guarded.
--
-- The integration test for the delete guard passed throughout, because
-- its fixture set `is_frozen` itself. Tested behaviour, unreachable in
-- production.
--
-- WHY DROP IT RATHER THAN START WRITING IT
--
-- Two columns for one fact is how they come to disagree, and the
-- migration that introduced `meter_data_exception` argued the same
-- thing about `created_at` beside `detected_at`. `billed_at` is the
-- better of the two: it answers "is it billed" and "when", and a
-- boolean beside it could only ever be derived from it.
--
-- `meter_read` is a hypertable, so the column is on its chunks too.
-- TimescaleDB propagates `DROP COLUMN` to all of them; verified against
-- a dev database with twelve chunks before this was written.

ALTER TABLE "meter_read" DROP COLUMN "is_frozen";

COMMENT ON COLUMN "meter_read"."billed_at" IS
  'When this read was billed, and therefore the one thing that locks it: a billed read cannot be deleted or have its exception resolved, and corrections create a new row. is_frozen held the same fact as a boolean until 2026-11-07, with no writer anywhere.';
