-- Measure Type catalog + required FK on UnitOfMeasure + MeterRegister
--
-- Introduces `measure_type_def` as a global-or-tenant reference table
-- (same shape as suspension_type_def). The seeded globals define the
-- semantic category each UOM/register reports — USAGE, DEMAND,
-- TOU_PEAK, TOU_OFFPEAK, REACTIVE, OTHER — so the commodities UI can
-- group UOMs correctly, base-unit uniqueness can be scoped per
-- (commodity, measure_type) instead of per commodity, and meter
-- reads carry forward their semantic meaning through the register.
--
-- Backfill strategy: existing UOMs default to USAGE except code 'KW'
-- (or other demand-style codes) which becomes DEMAND; meter registers
-- inherit from their UOM.
--
-- As in prior migrations, the auto-generated diff included shadow-DB
-- drift (DROP INDEX for FTS GIN, DROP DEFAULT on generated tsvector
-- columns, the hypertable index) which has been stripped so FTS and
-- partial indexes don't get undone on every new migration.

-- CreateTable
CREATE TABLE "measure_type_def" (
    "id" UUID NOT NULL,
    "utility_id" UUID,
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "measure_type_def_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "measure_type_def_utility_id_code_key"
  ON "measure_type_def" ("utility_id", "code");
CREATE INDEX "measure_type_def_is_active_sort_order_idx"
  ON "measure_type_def" ("is_active", "sort_order");

-- Row Level Security — globals (utility_id IS NULL) visible to every
-- tenant; tenant rows isolated to their own utility. Mirrors
-- suspension_type_def.
ALTER TABLE "measure_type_def" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "measure_type_def"
  USING (
    utility_id IS NULL
    OR utility_id = current_setting('app.current_utility_id', true)::uuid
  );

-- Seed the global measure types. Fixed UUIDs so the backfill below
-- and downstream seed/code can refer to them without a lookup.
INSERT INTO "measure_type_def"
  ("id", "utility_id", "code", "label", "description", "sort_order", "is_active", "created_at", "updated_at")
VALUES
  ('00000000-0000-4000-8000-0000000aaa01', NULL, 'USAGE',       'Usage',          'Total consumption over a period (e.g. kWh, gallons, therms).',    10, true, NOW(), NOW()),
  ('00000000-0000-4000-8000-0000000aaa02', NULL, 'DEMAND',      'Demand',         'Instantaneous or peak draw over an interval (e.g. kW).',          20, true, NOW(), NOW()),
  ('00000000-0000-4000-8000-0000000aaa03', NULL, 'TOU_PEAK',    'TOU — Peak',     'Time-of-use consumption during peak periods.',                    30, true, NOW(), NOW()),
  ('00000000-0000-4000-8000-0000000aaa04', NULL, 'TOU_OFFPEAK', 'TOU — Off-peak', 'Time-of-use consumption during off-peak periods.',                40, true, NOW(), NOW()),
  ('00000000-0000-4000-8000-0000000aaa05', NULL, 'REACTIVE',    'Reactive',       'Reactive power (kVARh) — typically only on large accounts.',     50, true, NOW(), NOW()),
  ('00000000-0000-4000-8000-0000000aaa06', NULL, 'OTHER',       'Other',          'Escape hatch for unusual measurement types.',                     900, true, NOW(), NOW());

-- Add the FK columns nullable first so we can backfill, then lock
-- them down after.
ALTER TABLE "unit_of_measure" ADD COLUMN "measure_type_id" UUID;
ALTER TABLE "meter_register"  ADD COLUMN "measure_type_id" UUID;

-- Backfill UOMs: demand-style unit codes → DEMAND; everything else
-- defaults to USAGE. Admins can reassign after the fact via the new
-- measure-type UI.
UPDATE "unit_of_measure"
   SET "measure_type_id" = '00000000-0000-4000-8000-0000000aaa02'
 WHERE "code" IN ('KW', 'MW', 'KVA', 'KVAR');
UPDATE "unit_of_measure"
   SET "measure_type_id" = '00000000-0000-4000-8000-0000000aaa01'
 WHERE "measure_type_id" IS NULL;

-- Backfill meter registers from their UOM.
UPDATE "meter_register" mr
   SET "measure_type_id" = uom."measure_type_id"
  FROM "unit_of_measure" uom
 WHERE mr."uom_id" = uom."id";

-- Lock both down and add FKs.
ALTER TABLE "unit_of_measure" ALTER COLUMN "measure_type_id" SET NOT NULL;
ALTER TABLE "meter_register"  ALTER COLUMN "measure_type_id" SET NOT NULL;

ALTER TABLE "unit_of_measure"
  ADD CONSTRAINT "unit_of_measure_measure_type_id_fkey"
  FOREIGN KEY ("measure_type_id") REFERENCES "measure_type_def"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "meter_register"
  ADD CONSTRAINT "meter_register_measure_type_id_fkey"
  FOREIGN KEY ("measure_type_id") REFERENCES "measure_type_def"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "unit_of_measure_measure_type_id_idx"
  ON "unit_of_measure" ("measure_type_id");
CREATE INDEX "meter_register_measure_type_id_idx"
  ON "meter_register" ("measure_type_id");

-- Partial unique index: at most one base unit per (tenant, commodity,
-- measure_type). Prisma can't express partial unique indexes in the
-- schema DSL, so it lives here. Enforces the conversion-anchor
-- invariant we couldn't enforce before this migration (two base-units
-- under one commodity would have been silently valid).
CREATE UNIQUE INDEX "unit_of_measure_base_unit_per_group_idx"
  ON "unit_of_measure" ("utility_id", "commodity_id", "measure_type_id")
  WHERE "is_base_unit" = true;
