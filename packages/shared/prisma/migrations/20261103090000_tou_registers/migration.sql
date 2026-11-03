-- TOU registers and TOU reads (spec 26, TOU-REG-1 and TOU-REG-2).
--
-- A TOU meter splits the total itself: register 2 counts on-peak,
-- register 3 off-peak, and the meter's own clock decides which. So three
-- facts have to be recordable — which period a register counts, which
-- calendar the meter is programmed with, and which period a read's
-- consumption belongs to.
--
-- ─── A code, not a key to `tou_period` ────────────────────────────
--
-- The spec said `tou_period_id`. This reverses that, for two reasons
-- that only became clear with the calendar built:
--
-- **A `tou_period` row belongs to one calendar version.** Pointing a
-- register at one would bind a fact about a *device* to a version of a
-- *tariff*, so every republished calendar would need every register
-- re-pointed — and TOU-CAL-11 is explicit that what a meter is
-- programmed with never decides pricing.
--
-- **The integrity the key would buy already exists, better placed.** A
-- read carrying a peak code no component prices does not bill silently:
-- the `tou_period` quantity source raises when its bucket is absent, by
-- design, so a wrong code stops the bill and names the period. And the
-- mapping itself is checked once per register against the meter's
-- programmed calendar (TOU-REG-2), rather than by a foreign key on
-- every row of the highest-volume table in the system — one that is
-- already a hypertable and will take tens of millions of rows a month
-- at TOU granularity.
--
-- The naming follows the calendar's: a code column is qualified when the
-- value travels, and this one travels further than most — from a
-- register, onto a read, through the loader's variable key, into a
-- component's `peak_code`.

-- ─── Which period a register counts (TOU-REG-1) ───────────────────
--
-- NULL means the register is not a TOU register: a total register, or
-- any register on a meter that does not split by time.
ALTER TABLE "meter_register" ADD COLUMN "peak_code" VARCHAR(50);

COMMENT ON COLUMN "meter_register"."peak_code" IS
  'Which TOU period this register counts (spec 26, TOU-REG-1). NULL for a total register or a non-TOU meter. A code rather than a key to tou_period, because a register is a fact about the device and tou_period belongs to one calendar version.';

-- One register per period per meter. Two registers claiming on-peak
-- would make the bucket depend on row order, and the loader sums — so
-- the usage would be counted twice at the most expensive rate.
CREATE UNIQUE INDEX "meter_register_one_per_peak_code"
  ON "meter_register" ("meter_id", "peak_code")
  WHERE ("peak_code" IS NOT NULL);

-- ─── Which calendar the meter is programmed with (TOU-REG-2) ──────
--
-- A device fact, recorded so a mismatch with the rate schedule's
-- calendar can be flagged. It never decides pricing (TOU-CAL-11).
--
-- A key to a specific version, because that is what is in the device —
-- the firmware holds switch times, not a name. The *mismatch check*
-- compares calendar **names**, so republishing a calendar does not flag
-- every TOU meter in the territory; the version is here for the audit
-- trail of what we believe was loaded.
ALTER TABLE "meter" ADD COLUMN "tou_calendar_id" UUID;

ALTER TABLE "meter"
  ADD CONSTRAINT "meter_tou_calendar_id_fkey"
  FOREIGN KEY ("utility_id", "tou_calendar_id")
  REFERENCES "tou_calendar"("utility_id", "id") ON DELETE RESTRICT;

COMMENT ON COLUMN "meter"."tou_calendar_id" IS
  'The TOU calendar version this meter is programmed with (spec 26, TOU-REG-2). A device fact; it never decides pricing. The mismatch check compares calendar names, not versions.';

-- ─── Which period a read belongs to ───────────────────────────────
--
-- Carried on the read as well as derivable from its register, because
-- the two meter kinds must produce **one shape** (see *How usage is
-- stored*): a register-based bucket takes the code from its register,
-- and an interval-derived bucket has no register at all — it is
-- classified by the calendar. The engine then receives one shape and
-- never learns which kind of meter produced it.
--
-- NULL means a total read, which is every row written before today.
ALTER TABLE "meter_read" ADD COLUMN "peak_code" VARCHAR(50);

COMMENT ON COLUMN "meter_read"."peak_code" IS
  'Which TOU period this row consumption belongs to (spec 26). NULL for a total read. Set from the register for a register-based bucket, and from the calendar for an interval-derived one, so both kinds produce one shape.';

-- ─── Dial readings become optional ────────────────────────────────
--
-- A register-based TOU bucket has dial readings, because a register has
-- a dial. An interval-derived one does not: it is a sum over classified
-- intervals, and there is no cumulative reading to state. Inventing one
-- would be a number on a bill that matches nothing on the device.
--
-- `consumption` stays NOT NULL — it is the thing every read must have,
-- and the thing rating uses.
ALTER TABLE "meter_read" ALTER COLUMN "reading" DROP NOT NULL;
ALTER TABLE "meter_read" ALTER COLUMN "prior_reading" DROP NOT NULL;

-- Both or neither. `consumption` is the difference of the pair, so one
-- without the other is not a partial record — it is a record whose
-- consumption cannot be checked against anything, which is worse than
-- having neither and saying so.
ALTER TABLE "meter_read"
  ADD CONSTRAINT "meter_read_dial_readings_paired"
  CHECK (("reading" IS NULL) = ("prior_reading" IS NULL));
