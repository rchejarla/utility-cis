-- Seasons become a tenant's configuration (spec 26, TOU-SEA-1 – 3).
--
-- `seasonOf()` in the rate engine returned summer for May–October, for
-- every tenant on earth, judged on the service period's start date. It
-- has exactly one caller — the `season` predicate — and it is wrong
-- twice over: a utility in a different climate has different seasons,
-- and TOU needs seasons it can classify an *interval* by, not a period.
--
-- A season is a month/day range that repeats every year and may wrap
-- the year end (Nov 1 – Mar 31). A set must cover every day of the year
-- exactly once, which `lib/rate-engine/seasons.ts` enforces — including
-- 29 February, since a set that ends one season on the 28th and starts
-- the next on 1 March tiles 365 days and loses a day every fourth year.
--
-- Effective-dated and published like a rate schedule, because the same
-- thing is true of both: changing when summer starts changes what a
-- bill costs, so it is a new version with a date, never an edit to the
-- one that billed. A published set is immutable.
--
-- **Every existing tenant is seeded with today's behaviour** — summer
-- 1 May – 31 October, winter the rest — so no tariff changes meaning
-- and every `bozeman-*` golden test passes unchanged. That is the point
-- of the seed: this migration is a widening, not a correction, and the
-- correction is the tenant's to make afterwards.

CREATE TABLE "season_set" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "effective_date" DATE NOT NULL,
    "published_at" TIMESTAMPTZ,
    -- How a *non-TOU* period spanning two seasons is decided
    -- (TOU-SEA-5). Only START_DATE is implemented, which is today's
    -- behaviour; MAJORITY and PRORATE are in the spec as Shoulds and
    -- the column exists so adopting one is not a migration. Recorded on
    -- the set rather than the tenant because it is part of what a
    -- published set means.
    "span_rule" VARCHAR(20) NOT NULL DEFAULT 'START_DATE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "season_set_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "season_set"
  ADD CONSTRAINT "season_set_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

ALTER TABLE "season_set"
  ADD CONSTRAINT "season_set_span_rule_known"
  CHECK ("span_rule" IN ('START_DATE', 'MAJORITY', 'PRORATE'));

-- One set per name per tenant. Versioning is by effective date rather
-- than a version column: a set is small enough that "the set in force
-- on this date" is the only question anyone asks of it.
CREATE UNIQUE INDEX "season_set_name_per_tenant"
  ON "season_set" ("utility_id", "name");

-- The lookup the engine's loader makes: the published set in force for
-- a period.
CREATE INDEX "season_set_in_force_idx"
  ON "season_set" ("utility_id", "effective_date" DESC)
  WHERE ("published_at" IS NOT NULL);

-- The composite target the tenant-scoped key on `season` needs. Created
-- before that table, because a foreign key cannot reference a uniqueness
-- that does not yet exist — which is how the first run of this
-- migration failed with 42830.
CREATE UNIQUE INDEX "season_set_tenant_id_key" ON "season_set" ("utility_id", "id");

CREATE TABLE "season" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "season_set_id" UUID NOT NULL,
    -- What a tariff's `season` predicate compares against. Two seasons
    -- sharing a code would make that comparison meaningless, hence the
    -- unique index below.
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "start_month" SMALLINT NOT NULL,
    "start_day" SMALLINT NOT NULL,
    "end_month" SMALLINT NOT NULL,
    "end_day" SMALLINT NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "season_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "season"
  ADD CONSTRAINT "season_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

-- Tenant-scoped, like every key between two tenant-scoped tables: a
-- season cannot belong to another tenant's set.
ALTER TABLE "season"
  ADD CONSTRAINT "season_season_set_id_fkey"
  FOREIGN KEY ("utility_id", "season_set_id") REFERENCES "season_set"("utility_id", "id")
  ON DELETE CASCADE;

-- Range sanity at the storage layer. The tiling rule — every day
-- covered exactly once — cannot be a CHECK, because it is a property of
-- the set rather than the row; `validateSeasons` owns that.
ALTER TABLE "season"
  ADD CONSTRAINT "season_months_are_months"
  CHECK ("start_month" BETWEEN 1 AND 12 AND "end_month" BETWEEN 1 AND 12);

ALTER TABLE "season"
  ADD CONSTRAINT "season_days_are_days"
  CHECK ("start_day" BETWEEN 1 AND 31 AND "end_day" BETWEEN 1 AND 31);

CREATE UNIQUE INDEX "season_code_per_set"
  ON "season" ("utility_id", "season_set_id", "code");

CREATE INDEX "season_set_idx" ON "season" ("utility_id", "season_set_id", "sort_order");

-- One-argument `current_setting`, deliberately: with no tenant set this
-- raises 22023 rather than returning nothing. A season set that reads
-- as empty would make every seasonal tariff resolve to no season.
ALTER TABLE "season_set" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "season_set" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "season_set"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE "season" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "season" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "season"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

-- ─── Seed today's behaviour for every existing tenant ──────────────
--
-- Published immediately and dated at the epoch of this system, so it is
-- in force for every period any existing bill could cover. Without
-- this, the first rating pass after deploy finds no season set and
-- every seasonal tariff resolves to no season.
INSERT INTO "season_set" ("id", "utility_id", "name", "effective_date", "published_at", "updated_at")
SELECT gen_random_uuid(), u."id", 'Default', DATE '2000-01-01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "utility" u;

INSERT INTO "season" ("id", "utility_id", "season_set_id", "code", "label",
                      "start_month", "start_day", "end_month", "end_day", "sort_order", "updated_at")
SELECT gen_random_uuid(), ss."utility_id", ss."id", 'summer', 'Summer',
       5, 1, 10, 31, 1, CURRENT_TIMESTAMP
FROM "season_set" ss WHERE ss."name" = 'Default';

INSERT INTO "season" ("id", "utility_id", "season_set_id", "code", "label",
                      "start_month", "start_day", "end_month", "end_day", "sort_order", "updated_at")
SELECT gen_random_uuid(), ss."utility_id", ss."id", 'winter', 'Winter',
       11, 1, 4, 30, 2, CURRENT_TIMESTAMP
FROM "season_set" ss WHERE ss."name" = 'Default';
