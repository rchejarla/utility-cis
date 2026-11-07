-- `AMI` leaves `read_type`, which keeps ACTUAL, ESTIMATED, CORRECTED
-- and FINAL.
--
-- WHY
--
-- It was never a type of read. The other four all answer one question —
-- is this figure measured, and if not, what stands in its place — and
-- `AMI` answers a different one: where the read came from. `read_source`
-- answers that, in the column beside it, and keeps `AMI` because there
-- it is the truth.
--
-- **No row ever carried it and nothing ever wrote it.** That is the
-- evidence rather than a tidiness argument: the interval roll-up is the
-- only producer of AMI reads in this codebase, and until 2026-11-06 it
-- set `read_source = 'AMI'` and then had to put something in
-- `read_type` — where it wrote the same word again instead of ACTUAL or
-- ESTIMATED. So the one column that can tell a customer their on-peak
-- charge rests on an estimate said nothing at all, and TOU-GAP-2 ("a
-- bill containing any estimate says so") had nothing to read. The
-- roll-up now writes ACTUAL or ESTIMATED per bucket, which left this
-- value with no writer, no row, and no meaning it did not duplicate.
--
-- What it still had was a filter pill on the meter-reads screen, which
-- offered an operator a value no read can have.
--
-- WHY THIS IS A TYPE SWAP
--
-- PostgreSQL cannot remove a value from an enum. The type is rebuilt
-- without it and the column converted through text. No `UPDATE` comes
-- first, unlike the `SMART` removal: there is nothing to move, and if a
-- row did carry `AMI` the cast would fail — which is the right outcome,
-- because nothing could tell whether that read was measured or
-- estimated, and guessing would put an invented fact on a bill.
--
-- `meter_read` is a **hypertable**, so the type is on its chunks too.
-- TimescaleDB propagates this `ALTER COLUMN ... TYPE` to all of them;
-- verified on a dev database with twelve chunks before this was
-- written, since the restriction would have made the migration
-- unrunnable rather than wrong.
--
-- `migrate dev` would propose dropping this and recreating the enum
-- with five values, since `schema.prisma` cannot express a type swap.

ALTER TYPE "read_type" RENAME TO "read_type_old";

CREATE TYPE "read_type" AS ENUM ('ACTUAL', 'ESTIMATED', 'CORRECTED', 'FINAL');

ALTER TABLE "meter_read"
  ALTER COLUMN "read_type" TYPE "read_type"
  USING ("read_type"::text::"read_type");

DROP TYPE "read_type_old";

COMMENT ON COLUMN "meter_read"."read_type" IS
  'Whether the figure was measured, and if not what stands in its place: ACTUAL, ESTIMATED, CORRECTED or FINAL. Not where it came from — read_source says that. AMI was removed 2026-11-06 as a source masquerading as a type, with no writer and no rows.';
