-- `SMART` leaves `meter_type`, which keeps AMR, AMI and MANUAL.
--
-- WHY
--
-- It was a second name for `AMI`, and spec 03 said so in writing:
-- "Smart meter with interval data capability (used interchangeably with
-- AMI in some contexts)". Two enum values for one idea is two answers
-- to "what kind of meter is this", and **nothing in the API branches on
-- `meter_type`** — it is read for a customer-graph subtext, a
-- notification variable and a portal field, all display. So the
-- ambiguity cost nothing today and would cost correctness the first
-- time something tried to mean anything by the answer.
--
-- It nearly did. The TOU pre-run check needed to know whether a meter
-- splits usage by its own clock, and `meter_type` is the obvious place
-- to look. It is the wrong place — how a meter is *read* is not how its
-- usage is *split*, and the seeded data shows both directions of that
-- (an AMR meter with three mapped TOU registers; AMI meters reporting
-- no intervals at all) — but an enum carrying a near-duplicate makes
-- that wrong turn easier to take and harder to argue against.
--
-- WHY THIS IS A TYPE SWAP
--
-- PostgreSQL cannot remove a value from an enum. The type is rebuilt
-- without it and the column converted through text, which is why the
-- rows have to move first: a `SMART` row would fail the cast, and
-- failing is right — a silent default would invent a fact about a
-- device.
--
-- `AMI` is where they go, because that is what `SMART` meant. One
-- column in one table uses this type and it has no default, so the
-- swap touches nothing else.
--
-- `migrate dev` would propose dropping this and recreating the enum
-- with four values, since `schema.prisma` cannot express a type swap.

-- ─── The rows first: a SMART meter is an AMI meter ────────────────
UPDATE "meter" SET "meter_type" = 'AMI' WHERE "meter_type" = 'SMART';

-- ─── Then the type, rebuilt without it ────────────────────────────
ALTER TYPE "meter_type" RENAME TO "meter_type_old";

CREATE TYPE "meter_type" AS ENUM ('AMR', 'AMI', 'MANUAL');

ALTER TABLE "meter"
  ALTER COLUMN "meter_type" TYPE "meter_type"
  USING ("meter_type"::text::"meter_type");

DROP TYPE "meter_type_old";

COMMENT ON COLUMN "meter"."meter_type" IS
  'How the meter is read: AMR, AMI or MANUAL. NOT how its usage is split into TOU periods — a register peak_code mapping declares that, and the two come apart in both directions. SMART was removed 2026-11-06 as a second name for AMI.';
