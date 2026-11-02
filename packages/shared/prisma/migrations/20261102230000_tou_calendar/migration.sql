-- The TOU calendar (spec 26, TOU-CAL-1 – 9).
--
-- Seven tables carrying what `lib/rate-engine/tou-calendar.ts` already
-- classifies with: a calendar names its season set, its time zone and
-- its clock basis; its day types say which weekdays they cover; its
-- spans say which hours cost which period; and a holiday list, shared
-- across the tenant's calendars, generates the dates that make a day a
-- holiday.
--
-- Effective-dated, versioned and published like a rate schedule
-- (TOU-CAL-5), for the same reason a season set is: changing which
-- hours are on-peak changes what a bill costs, so it is a new version
-- with a date, never an edit to the one that billed.
--
-- ─── Three decisions this schema makes ─────────────────────────────
--
-- **`is_holiday` is a flag, not a code match.** TOU-CAL-2 makes the
-- day-type vocabulary open: at least weekday, weekend and holiday, and
-- a tenant may add Saturday and say which weekdays each covers. So
-- `day_type_code` is the tenant's own string and nothing in code may
-- match a literal `'holiday'` — a tenant coding theirs
-- `observed_holiday` would have every holiday classified as an ordinary
-- weekday with nothing raised. The flag says which day type a resolved
-- holiday takes, and a partial unique index allows one per calendar.
--
-- **Weekday coverage is a child table, not seven booleans.** TOU-CAL-2
-- makes it one-to-many, and seven boolean columns is the repeated
-- column group this codebase already decided against on
-- `utility_config` — where three such groups made adding the fourth
-- cost a migration and seven files. The child table also carries
-- `tou_calendar_id`, which buys a real constraint: a unique index on
-- (utility, calendar, weekday) makes "no weekday is claimed by two day
-- types" a database guarantee. "All seven claimed" cannot be, being a
-- property of the set, so `validateCalendar` owns that half — the same
-- division as `validateSeasons` and the tiling rule.
--
-- **A span references its period and day type, and names its season.**
-- The first two are children of the same calendar, so a three-column
-- key makes TOU-CAL-3's "every period referenced is defined" a database
-- guarantee *and* pins it to this calendar. A season is not: it lives in
-- a separately versioned set, the code has to travel to the engine
-- anyway, and making it a key would mean carrying `season_set_id` on
-- every span. A span naming a season the set does not have is refused
-- by `validateCalendar` at save, and fails loudly at rating time if it
-- somehow lands — `resolvePeak` answers "no period covers 17:15", not a
-- plausible price.

-- ─── Holiday lists ────────────────────────────────────────────────
--
-- Shared across the tenant's calendars (TOU-UI-2a), each calendar
-- naming the list it uses, so adding a holiday does not mean editing
-- three calendars and missing one.
CREATE TABLE "tou_holiday_list" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tou_holiday_list_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tou_holiday_list"
  ADD CONSTRAINT "tou_holiday_list_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "tou_holiday_list_name_per_tenant"
  ON "tou_holiday_list" ("utility_id", "name");

-- The composite target the tenant-scoped keys below need. Created
-- before the referencing tables: a foreign key cannot reference a
-- uniqueness that does not yet exist, which is how the season_sets
-- migration first failed with 42830.
CREATE UNIQUE INDEX "tou_holiday_list_tenant_id_key"
  ON "tou_holiday_list" ("utility_id", "id");

-- ─── Holiday rules ────────────────────────────────────────────────
--
-- Rules rather than a list of dates (Rao, 2026-11-02), because a
-- published calendar is immutable (TOU-CAL-5) and a list of dates
-- expires: a calendar published in 2026 would hold no holidays for
-- 2029, so either somebody re-enters dates every year forever or the
-- dates live outside the version and publishing stops fixing what the
-- calendar means. A missed year does not raise — the holiday day type
-- silently stops applying and every TOU bill for those days misprices.
-- `lib/rate-engine/holidays.ts` resolves these, including the
-- observance rules, which is where the surprises live: a Saturday
-- holiday observed on the Friday moves which day is off-peak.
--
-- One-off dates are not forced into a rule; `tou_day_override` below
-- is TOU-CAL-9's mechanism for those.
CREATE TABLE "tou_holiday_rule" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "tou_holiday_list_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    -- FIXED is a date (4 July); NTH_WEEKDAY is a count (fourth Thursday
    -- of November, last Monday of May).
    "kind" VARCHAR(20) NOT NULL,
    "month" SMALLINT NOT NULL,
    -- FIXED only.
    "day" SMALLINT,
    -- NTH_WEEKDAY only. ISO weekday: Monday is 1.
    "weekday" SMALLINT,
    -- NTH_WEEKDAY only. 1–5, or -1 for the last in the month. A rule
    -- naming an nth the month has not got resolves to nothing for that
    -- year rather than shifting — a calendar that quietly moved a
    -- holiday would misprice a day and say nothing.
    "nth" SMALLINT,
    "observance" VARCHAR(20) NOT NULL DEFAULT 'NONE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tou_holiday_rule_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tou_holiday_rule"
  ADD CONSTRAINT "tou_holiday_rule_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "tou_holiday_rule"
  ADD CONSTRAINT "tou_holiday_rule_list_id_fkey"
  FOREIGN KEY ("utility_id", "tou_holiday_list_id")
  REFERENCES "tou_holiday_list"("utility_id", "id") ON DELETE CASCADE;

ALTER TABLE "tou_holiday_rule"
  ADD CONSTRAINT "tou_holiday_rule_kind_known"
  CHECK ("kind" IN ('FIXED', 'NTH_WEEKDAY'));

ALTER TABLE "tou_holiday_rule"
  ADD CONSTRAINT "tou_holiday_rule_observance_known"
  CHECK ("observance" IN ('NONE', 'NEAREST_WEEKDAY', 'FOLLOWING_MONDAY'));

ALTER TABLE "tou_holiday_rule"
  ADD CONSTRAINT "tou_holiday_rule_month_is_month"
  CHECK ("month" BETWEEN 1 AND 12);

-- Each kind carries its own columns and not the other's. A FIXED rule
-- with a stray `nth`, or an NTH_WEEKDAY rule with a `day`, reads as
-- meaning something it does not — and the resolver ignores the wrong
-- one, so the row would look configured and resolve elsewhere.
ALTER TABLE "tou_holiday_rule"
  ADD CONSTRAINT "tou_holiday_rule_fields_match_kind"
  CHECK (
    ("kind" = 'FIXED'
      AND "day" IS NOT NULL AND "day" BETWEEN 1 AND 31
      AND "weekday" IS NULL AND "nth" IS NULL)
    OR
    ("kind" = 'NTH_WEEKDAY'
      AND "weekday" IS NOT NULL AND "weekday" BETWEEN 1 AND 7
      AND "nth" IS NOT NULL AND ("nth" BETWEEN 1 AND 5 OR "nth" = -1)
      AND "day" IS NULL)
  );

CREATE UNIQUE INDEX "tou_holiday_rule_code_per_list"
  ON "tou_holiday_rule" ("utility_id", "tou_holiday_list_id", "code");

-- ─── Calendars ────────────────────────────────────────────────────
CREATE TABLE "tou_calendar" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "effective_date" DATE NOT NULL,
    "published_at" TIMESTAMPTZ,
    -- The set whose season codes this calendar's spans are keyed on.
    -- Named rather than taken from whichever set is in force, because a
    -- published calendar is immutable: if the in-force set changed, its
    -- spans would reference codes that no longer exist and the hours
    -- they price would resolve to nothing. The tariff's seasons are
    -- part of the tariff (TOU-CAL-10).
    "season_set_id" UUID NOT NULL,
    -- Nullable: a tenant whose tariff does not distinguish holidays has
    -- no list to name, and `resolveDayType` then answers from the
    -- weekday coverage.
    "tou_holiday_list_id" UUID,
    -- IANA name, e.g. America/Denver (TOU-CAL-6). Belongs to the
    -- tariff, not the customer: a utility spanning two zones still
    -- publishes each calendar in one, and where a customer lives never
    -- changes which hours are on-peak.
    "time_zone" VARCHAR(64) NOT NULL,
    -- `prevailing` follows daylight saving (the common case);
    -- `standard` means standard time all year, so a "4–9 pm" peak runs
    -- 5–10 pm by the summer clock.
    "clock_basis" VARCHAR(20) NOT NULL DEFAULT 'prevailing',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tou_calendar_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tou_calendar"
  ADD CONSTRAINT "tou_calendar_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "tou_calendar"
  ADD CONSTRAINT "tou_calendar_season_set_id_fkey"
  FOREIGN KEY ("utility_id", "season_set_id")
  REFERENCES "season_set"("utility_id", "id") ON DELETE RESTRICT;

ALTER TABLE "tou_calendar"
  ADD CONSTRAINT "tou_calendar_holiday_list_id_fkey"
  FOREIGN KEY ("utility_id", "tou_holiday_list_id")
  REFERENCES "tou_holiday_list"("utility_id", "id") ON DELETE RESTRICT;

ALTER TABLE "tou_calendar"
  ADD CONSTRAINT "tou_calendar_clock_basis_known"
  CHECK ("clock_basis" IN ('prevailing', 'standard'));

-- Not a list of valid zones: the IANA database is the authority and it
-- changes. The shape is checked here and the name is resolved by Intl
-- at save, which refuses one it does not know — a typo would otherwise
-- fall back to UTC and shift every peak by hours with nothing raised.
ALTER TABLE "tou_calendar"
  ADD CONSTRAINT "tou_calendar_time_zone_shaped"
  CHECK ("time_zone" ~ '^[A-Za-z][A-Za-z0-9_+./-]*$');

CREATE UNIQUE INDEX "tou_calendar_version_per_tenant"
  ON "tou_calendar" ("utility_id", "name", "effective_date");

-- The lookup a rate component's loader makes: the published version in
-- force for a period.
CREATE INDEX "tou_calendar_in_force_idx"
  ON "tou_calendar" ("utility_id", "name", "effective_date" DESC)
  WHERE ("published_at" IS NOT NULL);

CREATE UNIQUE INDEX "tou_calendar_tenant_id_key"
  ON "tou_calendar" ("utility_id", "id");

-- ─── Periods ──────────────────────────────────────────────────────
--
-- The table keeps the industry's word — "TOU period" is what the spec
-- and every tariff document say — and the column keeps the one that is
-- unambiguous in code. `period` is already taken three times here (the
-- service period, the billing period, and BaseContext.period with its
-- startDate/endDate), so a `periodCode` beside `period.startDate` in
-- the resolver would reintroduce exactly the ambiguity qualification
-- removes. A period and a peak are the same thing in this table.
CREATE TABLE "tou_period" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "tou_calendar_id" UUID NOT NULL,
    "peak_code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tou_period_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tou_period"
  ADD CONSTRAINT "tou_period_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "tou_period"
  ADD CONSTRAINT "tou_period_calendar_id_fkey"
  FOREIGN KEY ("utility_id", "tou_calendar_id")
  REFERENCES "tou_calendar"("utility_id", "id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "tou_period_peak_code_per_calendar"
  ON "tou_period" ("utility_id", "tou_calendar_id", "peak_code");

-- The three-column target a span's key needs, so a span cannot name a
-- period belonging to a different calendar.
CREATE UNIQUE INDEX "tou_period_calendar_id_key"
  ON "tou_period" ("utility_id", "tou_calendar_id", "id");

-- ─── Day types ────────────────────────────────────────────────────
CREATE TABLE "tou_day_type" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "tou_calendar_id" UUID NOT NULL,
    -- The tenant's own name. Open vocabulary (TOU-CAL-2), so no code
    -- path may match a literal value — see `is_holiday`.
    "day_type_code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "is_holiday" BOOLEAN NOT NULL DEFAULT FALSE,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tou_day_type_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tou_day_type"
  ADD CONSTRAINT "tou_day_type_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "tou_day_type"
  ADD CONSTRAINT "tou_day_type_calendar_id_fkey"
  FOREIGN KEY ("utility_id", "tou_calendar_id")
  REFERENCES "tou_calendar"("utility_id", "id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "tou_day_type_code_per_calendar"
  ON "tou_day_type" ("utility_id", "tou_calendar_id", "day_type_code");

-- One holiday day type per calendar. Partial, so the other day types
-- are unconstrained; Prisma cannot express the predicate, so this index
-- lives only here and `migrate dev` would propose dropping it.
CREATE UNIQUE INDEX "tou_day_type_one_holiday_per_calendar"
  ON "tou_day_type" ("utility_id", "tou_calendar_id")
  WHERE ("is_holiday");

CREATE UNIQUE INDEX "tou_day_type_calendar_id_key"
  ON "tou_day_type" ("utility_id", "tou_calendar_id", "id");

-- ─── Weekday coverage ─────────────────────────────────────────────
CREATE TABLE "tou_day_type_weekday" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    -- Carried so the unique index below can span the calendar. The one
    -- denormalisation in this migration, and it is what makes "no
    -- weekday is claimed by two day types" a database guarantee rather
    -- than a save-time check.
    "tou_calendar_id" UUID NOT NULL,
    "tou_day_type_id" UUID NOT NULL,
    -- ISO weekday: Monday is 1, Sunday is 7.
    "iso_weekday" SMALLINT NOT NULL,

    CONSTRAINT "tou_day_type_weekday_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tou_day_type_weekday"
  ADD CONSTRAINT "tou_day_type_weekday_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "tou_day_type_weekday"
  ADD CONSTRAINT "tou_day_type_weekday_day_type_id_fkey"
  FOREIGN KEY ("utility_id", "tou_calendar_id", "tou_day_type_id")
  REFERENCES "tou_day_type"("utility_id", "tou_calendar_id", "id") ON DELETE CASCADE;

ALTER TABLE "tou_day_type_weekday"
  ADD CONSTRAINT "tou_day_type_weekday_is_weekday"
  CHECK ("iso_weekday" BETWEEN 1 AND 7);

-- Each weekday claimed at most once per calendar. The other half —
-- every weekday claimed at least once — is a property of the set and
-- cannot be a constraint, so `validateCalendar` reports it: an
-- unclaimed weekday leaves every such date unpriced, and a doubly
-- claimed one makes the answer depend on row order, which is the
-- failure that reads as a working calendar.
CREATE UNIQUE INDEX "tou_day_type_weekday_once_per_calendar"
  ON "tou_day_type_weekday" ("utility_id", "tou_calendar_id", "iso_weekday");

-- ─── Spans ────────────────────────────────────────────────────────
--
-- Half-open minute ranges from local midnight. Stored as spans rather
-- than 96 cells a day because a span is what a tariff document says
-- ("on-peak 4–9 pm") and what a published diff has to read back
-- (TOU-UI-1d) — a painted grid cannot be summarised for a regulator.
CREATE TABLE "tou_slot" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "tou_calendar_id" UUID NOT NULL,
    "season_code" VARCHAR(50) NOT NULL,
    "tou_day_type_id" UUID NOT NULL,
    "tou_period_id" UUID NOT NULL,
    -- Inclusive. A multiple of 15 (TOU-CAL-1's granularity).
    "start_minute" SMALLINT NOT NULL,
    -- Exclusive; 1440 is the end of the day. Half-open is what lets two
    -- adjacent spans tile without the boundary minute being either
    -- double-counted or lost.
    "end_minute" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tou_slot_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tou_slot"
  ADD CONSTRAINT "tou_slot_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "tou_slot"
  ADD CONSTRAINT "tou_slot_calendar_id_fkey"
  FOREIGN KEY ("utility_id", "tou_calendar_id")
  REFERENCES "tou_calendar"("utility_id", "id") ON DELETE CASCADE;

-- Three-column, so a span cannot reference a day type or a period
-- belonging to another calendar. This is TOU-CAL-3's "every period
-- referenced is defined", made a database guarantee.
ALTER TABLE "tou_slot"
  ADD CONSTRAINT "tou_slot_day_type_id_fkey"
  FOREIGN KEY ("utility_id", "tou_calendar_id", "tou_day_type_id")
  REFERENCES "tou_day_type"("utility_id", "tou_calendar_id", "id") ON DELETE CASCADE;

ALTER TABLE "tou_slot"
  ADD CONSTRAINT "tou_slot_period_id_fkey"
  FOREIGN KEY ("utility_id", "tou_calendar_id", "tou_period_id")
  REFERENCES "tou_period"("utility_id", "tou_calendar_id", "id") ON DELETE RESTRICT;

ALTER TABLE "tou_slot"
  ADD CONSTRAINT "tou_slot_is_a_span_of_one_day"
  CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute");

-- A boundary off the 15-minute grid would tile arithmetically and be
-- unreachable from any interval, so the hours it appears to price
-- would be priced by its neighbour.
ALTER TABLE "tou_slot"
  ADD CONSTRAINT "tou_slot_on_the_quarter_hour"
  CHECK ("start_minute" % 15 = 0 AND "end_minute" % 15 = 0);

-- Overlap, enforced. Half of TOU-CAL-3 is a row-pair property, so the
-- database can hold it: no two spans of the same (calendar, season, day
-- type) may share a minute. The other half — no gaps — is a property of
-- the set, which `validateCalendar` owns, the same division as
-- `validateSeasons` and the tiling rule.
--
-- An expression rather than a stored range column, so the bounds and
-- the range cannot disagree. Equality on uuid and varchar inside a gist
-- index is what btree_gist is for, installed by the database_features
-- migration for `spm_no_double_install`. Prisma cannot express an
-- exclusion constraint, so this lives only here.
ALTER TABLE "tou_slot"
  ADD CONSTRAINT "tou_slot_no_overlap"
  EXCLUDE USING gist (
    "utility_id" WITH =,
    "tou_calendar_id" WITH =,
    "season_code" WITH =,
    "tou_day_type_id" WITH =,
    int4range("start_minute"::int, "end_minute"::int) WITH &&
  );

-- The classification read: one calendar's spans for a (season, day
-- type), ordered so the covering span is found by scan.
CREATE INDEX "tou_slot_lookup_idx"
  ON "tou_slot" ("utility_id", "tou_calendar_id", "season_code", "tou_day_type_id", "start_minute");

-- ─── Dated day-type overrides ─────────────────────────────────────
--
-- TOU-CAL-9. One named date taking a different day type: the narrowest
-- statement a tenant can make, so it outranks both the holiday list and
-- the weekday coverage. This is the shape critical peak pricing will
-- use for event days, with no schema change.
CREATE TABLE "tou_day_override" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "tou_calendar_id" UUID NOT NULL,
    "override_date" DATE NOT NULL,
    "tou_day_type_id" UUID NOT NULL,
    -- Why this date is not an ordinary day. Shown beside the date in the
    -- editor and in a bill's footnote: "15 July was a called peak event".
    "reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tou_day_override_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tou_day_override"
  ADD CONSTRAINT "tou_day_override_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "tou_day_override"
  ADD CONSTRAINT "tou_day_override_calendar_id_fkey"
  FOREIGN KEY ("utility_id", "tou_calendar_id")
  REFERENCES "tou_calendar"("utility_id", "id") ON DELETE CASCADE;

ALTER TABLE "tou_day_override"
  ADD CONSTRAINT "tou_day_override_day_type_id_fkey"
  FOREIGN KEY ("utility_id", "tou_calendar_id", "tou_day_type_id")
  REFERENCES "tou_day_type"("utility_id", "tou_calendar_id", "id") ON DELETE CASCADE;

-- One override per date per calendar. Two would make the day type
-- depend on row order, which is the same failure the weekday index
-- closes.
CREATE UNIQUE INDEX "tou_day_override_date_per_calendar"
  ON "tou_day_override" ("utility_id", "tou_calendar_id", "override_date");

-- ─── Row-level security ───────────────────────────────────────────
--
-- One-argument `current_setting`, deliberately: with no tenant set this
-- raises 22023 rather than returning nothing. A calendar that read as
-- empty would classify every hour as unpriced, which reads as a tariff
-- problem rather than a missing scope.
ALTER TABLE "tou_holiday_list" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tou_holiday_list" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tou_holiday_list"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE "tou_holiday_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tou_holiday_rule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tou_holiday_rule"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE "tou_calendar" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tou_calendar" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tou_calendar"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE "tou_period" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tou_period" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tou_period"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE "tou_day_type" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tou_day_type" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tou_day_type"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE "tou_day_type_weekday" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tou_day_type_weekday" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tou_day_type_weekday"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE "tou_slot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tou_slot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tou_slot"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE "tou_day_override" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tou_day_override" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tou_day_override"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);
