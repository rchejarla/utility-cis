-- Holidays become explicit dates in a versioned set, and the
-- `is_holiday` flag goes away.
--
-- WHAT WAS WRONG
--
-- A holiday was defined by a *rule* ("4 July, nearest weekday") in a
-- list shared across calendars, and which day type those days took was
-- carried by a boolean on `tou_day_type` — with a partial unique index
-- to enforce "at most one per calendar" and a validator rule reporting
-- duplicates. Three mechanisms for one fact.
--
-- The flag existed only because the day-type code was the tenant's own
-- (TOU-CAL-2 leaves the vocabulary open, so nothing could match the
-- literal string "holiday"). Fixing the code settles it: `holiday` is
-- now a reserved code the system creates and owns, so the engine
-- matches it directly and the flag has no job left. A tenant may still
-- define any other day type they like — Saturday separate from Sunday,
-- which real tariffs need — they simply may not name one `holiday`.
--
-- RULES BECOME DATES
--
-- A rule is a computation nobody checked. "4 July, nearest weekday"
-- does not tell anybody that 2026 lands on a Saturday and moves the
-- holiday to Friday the 3rd — a weekday whose peak hours disappear —
-- which is why the editor had to grow a three-year preview to show what
-- the rules would do. An explicit date is the fact itself: auditable,
-- and the observance is applied by the person who knows it, at the
-- moment they type the date.
--
-- The cost is that a set covers a horizon and runs out. That is a real
-- failure mode and it is loud by design: `validateCalendar` reports a
-- year the calendar covers with no dates in its set, rather than
-- letting every holiday that year quietly bill as an ordinary weekday.
--
-- VERSIONED LIKE A SEASON SET
--
-- A published calendar names a published *version*, exactly as it does
-- for seasons (TOU-CAL-10). Without that, editing a shared list would
-- change which days got holiday hours on bills already issued. With it,
-- a published calendar is frozen in the only sense that matters: every
-- input it prices against is immutable.

-- ─── The set ──────────────────────────────────────────────────────
CREATE TABLE "tou_holiday_set" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "effective_date" DATE NOT NULL,
    -- Null until published. A published set is immutable, so a calendar
    -- naming it cannot have the ground move under it.
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tou_holiday_set_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tou_holiday_set"
  ADD CONSTRAINT "tou_holiday_set_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "tou_holiday_set_version_per_tenant"
  ON "tou_holiday_set" ("utility_id", "name", "effective_date");

-- The composite key a calendar references, so a calendar in one tenant
-- cannot name a set in another.
CREATE UNIQUE INDEX "tou_holiday_set_tenant_id_key"
  ON "tou_holiday_set" ("utility_id", "id");

-- ─── The dates ────────────────────────────────────────────────────
CREATE TABLE "tou_holiday" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "tou_holiday_set_id" UUID NOT NULL,
    -- A real date with a year, not a recurring month/day: the whole
    -- point of leaving rules behind.
    "holiday_date" DATE NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tou_holiday_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tou_holiday"
  ADD CONSTRAINT "tou_holiday_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "tou_holiday"
  ADD CONSTRAINT "tou_holiday_set_id_fkey"
  FOREIGN KEY ("utility_id", "tou_holiday_set_id")
  REFERENCES "tou_holiday_set"("utility_id", "id") ON DELETE CASCADE;

-- One row per date. Two names for one day would make "is this a
-- holiday" ambiguous in a set that is supposed to answer exactly that.
CREATE UNIQUE INDEX "tou_holiday_date_per_set"
  ON "tou_holiday" ("utility_id", "tou_holiday_set_id", "holiday_date");

CREATE INDEX "tou_holiday_set_date_idx"
  ON "tou_holiday" ("utility_id", "tou_holiday_set_id", "holiday_date");

-- ─── The calendar names a set ─────────────────────────────────────
-- Nullable: a tariff that does not distinguish holidays names none, and
-- is never asked for holiday hours.
ALTER TABLE "tou_calendar" ADD COLUMN "tou_holiday_set_id" UUID;

ALTER TABLE "tou_calendar"
  ADD CONSTRAINT "tou_calendar_holiday_set_id_fkey"
  FOREIGN KEY ("utility_id", "tou_holiday_set_id")
  REFERENCES "tou_holiday_set"("utility_id", "id") ON DELETE RESTRICT;

CREATE INDEX "tou_calendar_holiday_set_idx"
  ON "tou_calendar" ("utility_id", "tou_holiday_set_id");

-- ─── Row-level security ───────────────────────────────────────────
--
-- The tables the rules machinery had it and these two inherit nothing:
-- a new tenant-scoped table starts with RLS off, which is a table every
-- tenant can read. `schema-invariants.integration.test.ts` is what
-- caught this one missing.
--
-- One-argument `current_setting`, deliberately: with no tenant set this
-- raises 22023 rather than returning nothing. A holiday set that read
-- as empty would price every holiday as an ordinary weekday, which
-- reads as a tariff decision rather than a missing scope.
ALTER TABLE "tou_holiday_set" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tou_holiday_set" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tou_holiday_set"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE "tou_holiday" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tou_holiday" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tou_holiday"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

-- ─── What the rules machinery leaves behind ───────────────────────
-- The old key first, then the tables it pointed at.
ALTER TABLE "tou_calendar" DROP CONSTRAINT "tou_calendar_holiday_list_id_fkey";
ALTER TABLE "tou_calendar" DROP COLUMN "tou_holiday_list_id";

DROP TABLE "tou_holiday_rule";
DROP TABLE "tou_holiday_list";

-- ─── And the flag ─────────────────────────────────────────────────
-- The index goes with it: "at most one holiday day type per calendar"
-- is no longer a rule anybody can break, because `holiday` is one
-- reserved code and `tou_day_type_code_per_calendar` already makes a
-- code unique within a calendar.
DROP INDEX "tou_day_type_one_holiday_per_calendar";
ALTER TABLE "tou_day_type" DROP COLUMN "is_holiday";

-- `holiday` is a reserved code from here on: the system creates that
-- day type when a calendar names a holiday set, and the engine resolves
-- a holiday date to exactly it.
--
-- No CHECK for that, deliberately. A constraint cannot tell a row the
-- system wrote from one a tenant typed, so it could only ban the code
-- outright — which would ban the system's own row — or ban case
-- variants, which is a rule nobody asked for dressed up as a safeguard.
-- The reservation is enforced in `tou-calendar.service.ts`, where the
-- difference is known and the refusal can say why.
--
-- `tou_day_type_code_per_calendar` already makes a code unique within a
-- calendar, so there can only ever be one.
