-- A rate schedule names its TOU calendar (spec 26, TOU-CAL-10).
--
-- TOU-CAL-10 says the calendar "is referenced by a rate schedule's
-- components", and the component shape that shipped does not: a TOU
-- component carries `{ base: "tou_period", peak_code: "peak" }` and no
-- calendar. That was enough to rate a **register** meter, because the
-- device did the classification and the component only has to name which
-- of its dials to price — which is why the golden rating test passes
-- with no calendar anywhere.
--
-- It is not enough for three things that follow:
--
-- **Interval rating** (slice 2) has to classify each interval, and
-- classification is the calendar's job. Without this column there is
-- nothing to classify against.
--
-- **The meter-mismatch check** (TOU-REG-2) compares the calendar a meter
-- is programmed with against the one the rate schedule references. The
-- first half shipped as `meter.tou_calendar_id`; this is the second.
--
-- **Publish-time validation** (TOU-UI-3) refuses a schedule whose
-- periods do not line up with its calendar's. Nothing to line up
-- against, before now.
--
-- ─── On the schedule, not on each component ───────────────────────
--
-- A schedule's TOU components are written against one set of peak hours
-- — that is what makes them a tariff rather than a pile of charges. Put
-- on each component it would be repeated on every one of them, and two
-- components of one schedule could name different calendars, which has
-- no coherent meaning but would save and bill.
--
-- Nullable, because most schedules are not TOU. A schedule with TOU
-- components and no calendar is refused at publish, not by a constraint:
-- the rule is "every period these components price exists in that
-- calendar", which is a property of the component set and a CHECK cannot
-- see it.
--
-- Keys a specific **version**, like `meter.tou_calendar_id`: a published
-- schedule is immutable and must keep meaning what it meant, so it
-- cannot follow a calendar that is republished with different hours.
-- Changing the hours means publishing a new schedule version against the
-- new calendar version — which is exactly what a regulator expects to
-- see.

ALTER TABLE "rate_schedule" ADD COLUMN "tou_calendar_id" UUID;

ALTER TABLE "rate_schedule"
  ADD CONSTRAINT "rate_schedule_tou_calendar_id_fkey"
  FOREIGN KEY ("utility_id", "tou_calendar_id")
  REFERENCES "tou_calendar"("utility_id", "id") ON DELETE RESTRICT;

COMMENT ON COLUMN "rate_schedule"."tou_calendar_id" IS
  'The TOU calendar version this schedule''s TOU components are written against (spec 26, TOU-CAL-10). NULL for a non-TOU schedule. On the schedule rather than each component, because the components of one tariff share one set of peak hours.';

-- Which schedules reference a calendar, for the publish check and for
-- answering "what breaks if this calendar is wrong". Partial: almost
-- every schedule is NULL here.
CREATE INDEX "rate_schedule_tou_calendar_idx"
  ON "rate_schedule" ("utility_id", "tou_calendar_id")
  WHERE ("tou_calendar_id" IS NOT NULL);
