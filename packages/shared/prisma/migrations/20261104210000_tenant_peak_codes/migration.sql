-- Peak codes are defined once per tenant, not once per calendar
-- (spec 26, TOU-CAL-1 and TOU-CAL-3).
--
-- WHAT WAS WRONG
--
-- One fact was stored twice. A calendar declared its periods as
-- `tou_period` rows and every span pointed at one by key — while
-- `meter_register.peak_code`, `meter_read.peak_code` and a rate
-- component's `quantitySource.peak_code` all carried the same thing as
-- a plain string. `tou_slot` was the only keyed reference in the system,
-- which made the per-calendar rows the exception rather than the rule.
--
-- The cost of the duplication was paid every time: a new calendar had to
-- re-declare off_peak/mid_peak/peak, which is why `createTouCalendar`
-- seeds three defaults — that code exists only to paper over the
-- retyping. And two validation rules existed purely to keep the copies
-- in step ("every period defined is used somewhere", "every period
-- referenced is defined").
--
-- WHAT THIS KEEPS
--
-- `tou_period` keeps its name and loses `tou_calendar_id`. The spec
-- already called these "the tenant's" ("Period names are the tenant's —
-- on_peak, mid_peak, off_peak, …"), so a tenant-scoped `tou_period` is
-- closer to TOU-CAL-1 than the per-calendar table was. Keeping the name
-- also keeps the RLS policy, the FORCE and the tenant foreign key that
-- the `tou_calendar` migration already put on it.
--
-- THE CODE IS STORED IN THE SLOT, NOT A KEY TO IT
--
-- This is the condition that makes a tenant-level list safe at all.
-- A published calendar is immutable so that nothing can move under it —
-- it names a season-set *version* and a holiday-set *version* for
-- exactly that reason — and a tenant-level list is unversioned. Storing
-- the code as a string means a published calendar's hours literally say
-- `peak`, and the rate component prices `peak`, so editing the tenant
-- list changes a display label and the editor's picker, never what a
-- bill meant. Had the slot kept a key, the list would have been
-- unversioned config gating versioned work.
--
-- The foreign key is therefore on the **code**, not the id:
-- `tou_slot (utility_id, peak_code) -> tou_period (utility_id,
-- peak_code)`, ON DELETE RESTRICT and no ON UPDATE CASCADE. That buys
-- two guards for nothing: a span cannot name a code the tenant has not
-- defined, and a code cannot be deleted or renamed while any calendar
-- uses it. The second is what a service guard would otherwise have to
-- do, and a rename being refused is correct — the code travels into
-- rate components and meter registers, so renaming it would break them.
--
-- `meter_register.peak_code` and `meter_read.peak_code` stay bare
-- strings. The register could now carry the same key cheaply and
-- probably should when TOU-REG-1 grows a write path; `meter_read` must
-- not, for the volume reason the `tou_registers` migration gives.

-- ─── The slot carries the code ────────────────────────────────────
ALTER TABLE "tou_slot" ADD COLUMN "peak_code" VARCHAR(50);

UPDATE "tou_slot" s
   SET "peak_code" = p."peak_code"
  FROM "tou_period" p
 WHERE p."id" = s."tou_period_id"
   AND p."utility_id" = s."utility_id";

-- ─── The tenant's list, from whatever the calendars already said ──
--
-- Collapsed per tenant: several calendars declaring `peak` become one
-- row. The label and sort order are taken from the lowest sort order
-- seen, which is the earliest-declared of the duplicates — any choice
-- is arbitrary where they disagree, and they only disagree because the
-- fact was stored twice.
CREATE TABLE "tou_period_tenant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "utility_id" UUID NOT NULL,
    "peak_code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tou_period_tenant_pkey" PRIMARY KEY ("id")
);

INSERT INTO "tou_period_tenant" ("utility_id", "peak_code", "label", "sort_order")
SELECT DISTINCT ON ("utility_id", "peak_code")
       "utility_id", "peak_code", "label", "sort_order"
  FROM "tou_period"
 ORDER BY "utility_id", "peak_code", "sort_order", "created_at";

-- ─── Out with the per-calendar table ──────────────────────────────
-- The slot's key to it goes first; the column follows once nothing
-- reads it.
ALTER TABLE "tou_slot" DROP CONSTRAINT "tou_slot_period_id_fkey";
ALTER TABLE "tou_slot" DROP COLUMN "tou_period_id";

DROP TABLE "tou_period";

ALTER TABLE "tou_period_tenant" RENAME TO "tou_period";
ALTER TABLE "tou_period" RENAME CONSTRAINT "tou_period_tenant_pkey" TO "tou_period_pkey";

-- ─── The reshaped table's own keys and guards ─────────────────────
ALTER TABLE "tou_period"
  ADD CONSTRAINT "tou_period_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

-- One row per code per tenant. This is also the key the slots
-- reference, which is why it is on the code and not the id.
CREATE UNIQUE INDEX "tou_period_peak_code_per_tenant"
  ON "tou_period" ("utility_id", "peak_code");

ALTER TABLE "tou_slot" ALTER COLUMN "peak_code" SET NOT NULL;

ALTER TABLE "tou_slot"
  ADD CONSTRAINT "tou_slot_peak_code_fkey"
  FOREIGN KEY ("utility_id", "peak_code")
  REFERENCES "tou_period" ("utility_id", "peak_code") ON DELETE RESTRICT;

-- ─── Row-level security, which the table had and must keep ────────
--
-- The rename carried the policy with it on the old table only — this is
-- a new table wearing the old name, and a new tenant-scoped table
-- starts with RLS off, which is a table every tenant can read. The
-- holiday-set migration shipped without this and
-- `schema-invariants.integration.test.ts` caught it; stating it here
-- rather than finding out twice.
ALTER TABLE "tou_period" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tou_period" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tou_period"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);

-- ─── Every tenant gets the three nearly every TOU tariff has ─────
--
-- So the calendar editor opens on a vocabulary rather than an empty
-- list. A tenant that already declared its own keeps them: this only
-- adds a code the tenant has not got. `provision-tenant.ts` does the
-- same for a tenant created from now on.
INSERT INTO "tou_period" ("utility_id", "peak_code", "label", "sort_order")
SELECT u."id", d."peak_code", d."label", d."sort_order"
  FROM "utility" u
 CROSS JOIN (VALUES
         ('off_peak', 'Off-peak', 0),
         ('mid_peak', 'Mid-peak', 1),
         ('peak',     'On-peak',  2)
       ) AS d("peak_code", "label", "sort_order")
 WHERE NOT EXISTS (
         SELECT 1 FROM "tou_period" p
          WHERE p."utility_id" = u."id" AND p."peak_code" = d."peak_code"
       );
