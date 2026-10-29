const { execSync } = require("node:child_process");
const path = require("node:path");
const { createRequire } = require("node:module");

const { PrismaClient } = require("./packages/shared/src/generated/prisma");
const { seedDelinquencyLadder } = require("./seed/delinquency-ladder.js");
const { seedPaymentPlan } = require("./seed/payment-plan.js");

/*
 * `@prisma/adapter-pg` and `pg` are declared by `packages/shared`, and
 * pnpm does not hoist a workspace package's dependencies into the root
 * `node_modules` — which holds only the root's own `turbo` and
 * `typescript`. A bare `require` from this file therefore walks out of
 * the repository and fails with MODULE_NOT_FOUND.
 *
 * It fails on *line 2*, before `main()` and before a single delete, so
 * the symptom is a seed that never runs rather than a database left half
 * written. That is why it went unnoticed from the Prisma 7 upgrade
 * (which introduced both requires — Prisma 7 has no engine of its own,
 * so a client is always built over a driver adapter) until someone
 * wondered why fresh seed data was not appearing.
 *
 * Resolved from the package that declares them. The generated client
 * above needs no such help: it is required by relative path.
 */
const sharedRequire = createRequire(
  path.join(__dirname, "packages", "shared", "package.json"),
);
const { PrismaPg } = sharedRequire("@prisma/adapter-pg");
const pg = sharedRequire("pg");

/*
 * The same upgrade's other half: under Prisma 6 the client read `.env`
 * itself, which is what `seed_db.bat` means when it says
 * "packages/shared/.env is authoritative for this script". Prisma 7
 * builds the pool here instead, from `process.env.DATABASE_URL`, and
 * nothing loads that file — so with the stray-override guard having
 * cleared the variable, the connection string was `undefined` and `pg`
 * failed on a missing password rather than on a missing URL
 * ("SASL: client password must be a string").
 *
 * Only when it is not already set, which keeps the documented
 * precedence: `seed_db.bat` clears the variable so this file wins, while
 * a direct `node seed.js` still honours a DATABASE_URL the caller meant.
 * That is also the hazard the batch file exists to guard — this seeder
 * deletes before it inserts, so a shell carrying another project's URL
 * would wipe that project. Prefer the batch file.
 */
if (!process.env.DATABASE_URL) {
  process.loadEnvFile(path.join(__dirname, "packages", "shared", ".env"));
}
// Prisma 7 has no engine of its own, so a client is always built over a
// driver adapter. There is no no-argument form any more.
const p = new PrismaClient({
  adapter: new PrismaPg(new pg.Pool({ connectionString: process.env.DATABASE_URL })),
});
const UID = "00000000-0000-4000-8000-000000000001";

async function main() {
  console.log("Clearing existing data...");
  // Order matters — child tables before their parents. Phase 2 tables
  // (meter_read, service_suspension, meter_event, service_event,
  // container, import_batch) hold FKs into service_agreement and meter,
  // so they must be cleared before those parents can be deleted. The
  // original seed script predates Phase 2 and skipped them, which now
  // blocks reseeding any DB that has accumulated operational data.
  // Scoped to the dev tenant, unlike the clear-down below it. These four
  // are exactly what provisionTenant creates, and since 2026-10-18 a
  // second tenant can exist — provisioned at /dev/tenants or by the
  // script. Unscoped, a reseed left every other tenant a utility row with
  // no modules, roles or users: a tenant that exists, answers 403
  // MODULE_DISABLED on every gated route, and cannot administer itself.
  // That is the half-provisioned tenant the one-transaction rule exists
  // to prevent, arrived at through the seed instead of a crash.
  if (p.userRole) await p.userRole.deleteMany({ where: { utilityId: UID } });
  /*
   * Plans before users. `payment_plan.approved_by` is a RESTRICT key to
   * `cis_user`, so a plan left by the previous run blocks the user
   * delete — and Prisma reports that with the same constraint name it
   * would use on an insert, which reads as if the new plan could not be
   * written. Child first within the pair, too.
   */
  if (p.paymentPlanDebit) await p.paymentPlanDebit.deleteMany({});
  if (p.paymentPlan) await p.paymentPlan.deleteMany({});
  await p.cisUser.deleteMany({ where: { utilityId: UID } });
  await p.role.deleteMany({ where: { utilityId: UID } });
  await p.utilityModule.deleteMany({ where: { utilityId: UID } });

  // Phase 2 operational entities — delete first.
  //
  // `delinquency_action` points at account and is written by a worker
  // rather than by anything here, so a database only has rows once the
  // delinquency cron has run against it — which is why this delete was
  // missing for as long as nobody left a worker attached overnight. Same
  // family as bill_document and billing_run below: a RESTRICT parent
  // that the seed itself never creates and therefore never thought to
  // clear.
  //
  // The fee links go first: they RESTRICT both the action and the ledger
  // entry, so a second seed run would fail on the delete below — and now
  // that the seed itself writes them, it would fail on every run rather
  // than only after a worker had been left attached.
  if (p.delinquencyActionFee) await p.delinquencyActionFee.deleteMany({});
  if (p.delinquencyAction) await p.delinquencyAction.deleteMany({});
  // And the rules, after the actions that RESTRICT them. A charging tier
  // holds `fee_reason_id -> ledger_reason_def` under RESTRICT, and this
  // file deletes the reasons further down, so rules left standing from a
  // previous run would refuse that delete. They used to survive on
  // purpose — the create below was a findFirst-then-create — but a
  // surviving rule now pins a reason the seed is about to recreate, and
  // "idempotent" and "clears what it owns" cannot both be true here.
  if (p.delinquencyRule) await p.delinquencyRule.deleteMany({});
  if (p.serviceSuspension) await p.serviceSuspension.deleteMany({});
  if (p.serviceEvent) await p.serviceEvent.deleteMany({});
  if (p.meterEvent) await p.meterEvent.deleteMany({});
  if (p.container) await p.container.deleteMany({});
  if (p.importBatch) await p.importBatch.deleteMany({});
  if (p.serviceRequest) await p.serviceRequest.deleteMany({});
  if (p.serviceRequestCounter) await p.serviceRequestCounter.deleteMany({});
  if (p.sla) await p.sla.deleteMany({});
  await p.meterRead.deleteMany({});
  if (p.attachment) await p.attachment.deleteMany({});

  // AR ledger + bills. Four RESTRICT parents, so this block has to precede
  // all of them: ledger_entry -> account and bill; bill_segment ->
  // service_agreement; bill -> account and billing_cycle; and
  // bill_segment_line -> rate_component, which is why this sits above the
  // rate v2 cleanup rather than below it. Getting that last one wrong puts
  // a delete here that can never run on a DB holding a rated segment.
  // A billing run's items point at account and bill, and the run itself
  // at billing_cycle — so both precede every one of those. Same blind
  // spot as bill_document: this cleanup was written before runs existed
  // and no seeded database had a row here until one was started by hand.
  if (p.billingRunItem) await p.billingRunItem.deleteMany({});
  if (p.billingRun) await p.billingRun.deleteMany({});
  if (p.ledgerApplication) await p.ledgerApplication.deleteMany({});
  if (p.ledgerEntry) await p.ledgerEntry.deleteMany({});
  if (p.ledgerReasonDef) await p.ledgerReasonDef.deleteMany({});
  if (p.billSegmentLine) await p.billSegmentLine.deleteMany({});
  if (p.billSegment) await p.billSegment.deleteMany({});
  // bill_document -> bill is a fifth RESTRICT parent. It went unnoticed
  // until a bill PDF was generated for the first time, because a
  // database with no rendered bill has no row here and the delete below
  // succeeds. The object in storage is left where it is: apptor-connect
  // owns that bucket, the pointer is what lives in this database, and a
  // reseed is not a licence to reach into someone else's store.
  if (p.billDocument) await p.billDocument.deleteMany({});
  if (p.bill) await p.bill.deleteMany({});

  // Rate v2 cleanup (slice 1 task 10) — sa_rate_schedule_assignment
  // points at service_agreement and rate_schedule; rate_component points
  // at rate_schedule. Clear them before SAs and schedules.
  if (p.sAScheduleAssignment) await p.sAScheduleAssignment.deleteMany({});
  if (p.rateComponent) await p.rateComponent.deleteMany({});
  if (p.rateIndex) await p.rateIndex.deleteMany({});

  // SAM table dropped in slice 1 migration; SP/SPM cascade from SA deletion.
  await p.serviceAgreement.deleteMany({});
  if (p.rateServiceClass) await p.rateServiceClass.deleteMany({});
  await p.meterRegister.deleteMany({});
  await p.contact.deleteMany({});
  await p.billingAddress.deleteMany({});
  await p.meter.deleteMany({});
  await p.account.deleteMany({});
  await p.premise.deleteMany({});
  await p.rateSchedule.deleteMany({});
  await p.billingCycle.deleteMany({});
  await p.unitOfMeasure.deleteMany({});
  await p.commodity.deleteMany({});
  await p.customer.deleteMany({});
  await p.utilityTheme.deleteMany({});
  if (p.utilityConfig) await p.utilityConfig.deleteMany({});
  await p.auditLog.deleteMany({});
  await p.userPreference.deleteMany({});
  // Tenant-scoped suspension type defs only — do NOT delete global
  // (utility_id IS NULL) rows because re-seeding re-inserts them below.
  if (p.suspensionTypeDef) {
    await p.suspensionTypeDef.deleteMany({ where: { utilityId: { not: null } } });
  }
  // Re-seed globals from scratch so the list stays canonical.
  if (p.serviceRequestTypeDef) {
    await p.serviceRequestTypeDef.deleteMany({});
  }
  console.log("  Cleared.");

  console.log("Seeding...");

  // The tenant itself, before anything that carries its id. Upserted
  // rather than created so a reseed does not have to delete it — once
  // utility_id is a foreign key, deleting this row would be blocked by
  // every child table not on the clear-down list above.
  // The tenant, its modules and its preset roles come from
  // provisionTenant — the one definition of what a tenant starts as.
  // This file carried its own copy of the roles and module list until
  // 2026-10-18; the two drifted four modules apart once already, which
  // is the whole reason that duplicate was deleted.
  //
  // Shelled out rather than imported because seed.js is CommonJS and the
  // service is TypeScript. Six integration files already invoke
  // prisma/seed.ts this way, so tsx is not a new dependency of seeding.
  // It is idempotent, so a reseed re-runs it harmlessly.
  const TSX_BIN = path.join(
    __dirname, "node_modules", ".pnpm", "node_modules", ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  execSync(`"${TSX_BIN}" scripts/provision-tenant.ts --utility-id ${UID} --name "City of Bozeman"`, {
    cwd: __dirname,
    stdio: "pipe",
  });
  console.log("  tenant provisioned (utility, 32 modules, 6 preset roles)");

  // The platform operator: a user belonging to no tenant (Q2), which is
  // the one identity that sits above tenants. It holds no user_role row
  // — being the platform actor is the authority, and there is no tenant
  // for it to hold a role in.
  //
  // Created only when absent rather than deleted and remade, because the
  // clear-down above is scoped to the dev tenant and so leaves this row
  // alone. There is no upsert for it either: the unique key is a partial
  // index on email WHERE utility_id IS NULL, which Prisma cannot target.
  const platformEmail = "platform@utility.com";
  const existingOperator = await p.cisUser.findFirst({
    where: { utilityId: null, email: platformEmail },
  });
  if (existingOperator) {
    console.log("  platform operator already present");
  } else {
    await p.cisUser.create({
      data: {
        utilityId: null,
        email: platformEmail,
        name: "Platform Operator",
        isActive: true,
      },
    });
    console.log("  platform operator created");
  }

  const water = await p.commodity.create({ data: { utilityId: UID, code: "WATER", name: "Potable Water", displayOrder: 1 } });
  const electric = await p.commodity.create({ data: { utilityId: UID, code: "ELECTRIC", name: "Electricity", displayOrder: 2 } });
  const gas = await p.commodity.create({ data: { utilityId: UID, code: "GAS", name: "Natural Gas", displayOrder: 3 } });
  const sewer = await p.commodity.create({ data: { utilityId: UID, code: "SEWER", name: "Sewer", displayOrder: 4 } });
  const stormwater = await p.commodity.create({ data: { utilityId: UID, code: "STORMWATER", name: "Stormwater", displayOrder: 5 } });
  const solidWaste = await p.commodity.create({ data: { utilityId: UID, code: "SOLID_WASTE", name: "Solid Waste", displayOrder: 6 } });
  console.log("  6 commodities");

  // Global measure types are seeded by migration
  // 20260424161251_add_measure_type_def; look them up by code.
  const measureUsage = await p.measureTypeDef.findFirstOrThrow({ where: { code: "USAGE", utilityId: null } });
  const measureDemand = await p.measureTypeDef.findFirstOrThrow({ where: { code: "DEMAND", utilityId: null } });

  // Each UOM carries its measure type (USAGE / DEMAND / TOU / ...).
  // Conversions + base-unit flags are now scoped per (commodity,
  // measure_type), so KW is its own base for electric DEMAND while
  // KWH stays the base for electric USAGE.
  const gal = await p.unitOfMeasure.create({ data: { utilityId: UID, code: "GAL", name: "Gallons", commodityId: water.id, measureTypeId: measureUsage.id, conversionFactor: 1, isBaseUnit: true, isActive: true } });
  const kwh = await p.unitOfMeasure.create({ data: { utilityId: UID, code: "KWH", name: "Kilowatt Hours", commodityId: electric.id, measureTypeId: measureUsage.id, conversionFactor: 1, isBaseUnit: true, isActive: true } });
  const kw = await p.unitOfMeasure.create({ data: { utilityId: UID, code: "KW", name: "Kilowatts (Demand)", commodityId: electric.id, measureTypeId: measureDemand.id, conversionFactor: 1, isBaseUnit: true, isActive: true } });
  const mcf = await p.unitOfMeasure.create({ data: { utilityId: UID, code: "MCF", name: "Thousand Cubic Feet", commodityId: gas.id, measureTypeId: measureUsage.id, conversionFactor: 1, isBaseUnit: true, isActive: true } });
  const sgal = await p.unitOfMeasure.create({ data: { utilityId: UID, code: "GAL", name: "Gallons", commodityId: sewer.id, measureTypeId: measureUsage.id, conversionFactor: 1, isBaseUnit: true, isActive: true } });
  console.log("  5 UOMs");

  const c1 = await p.billingCycle.create({ data: { utilityId: UID, name: "Route 1 - North District", cycleCode: "R01", readDayOfMonth: 8, billDayOfMonth: 10, frequency: "MONTHLY" } });
  const c2 = await p.billingCycle.create({ data: { utilityId: UID, name: "Route 2 - South District", cycleCode: "R02", readDayOfMonth: 15, billDayOfMonth: 17, frequency: "MONTHLY" } });
  console.log("  2 billing cycles");

  // ============ RATE SERVICE CLASSES (v2 — slice 1 task 10) ============
  // Per-commodity classes used by SAs (rate_service_class_id) and by
  // RateComponent predicates (`{ class: "single_family" }`).
  const classDefs = [
    { commodity: water, codes: [
      ["single_family", "Single Family"], ["multi_family", "Multi-Family"],
      ["government", "Government"], ["msu", "MSU"], ["commercial", "Commercial"],
    ]},
    { commodity: sewer, codes: [
      ["residential", "Residential"], ["multi_family", "Multi-Family"],
      ["commercial", "Commercial"], ["government", "Government"],
      ["msu", "MSU"], ["industrial", "Industrial"],
    ]},
    { commodity: stormwater, codes: [
      ["residential", "Residential"], ["commercial", "Commercial"],
    ]},
    { commodity: solidWaste, codes: [
      ["residential", "Residential"], ["commercial", "Commercial"],
    ]},
    { commodity: electric, codes: [
      ["residential", "Residential"], ["small_commercial", "Small Commercial"],
      ["large_commercial", "Large Commercial"], ["irrigation", "Irrigation"],
      ["lighting", "Lighting"],
    ]},
  ];
  /** @type {Record<string, Record<string, { id: string }>>} */
  const classMap = {};
  let classCount = 0;
  for (const grp of classDefs) {
    classMap[grp.commodity.code] = {};
    let order = 10;
    for (const [code, label] of grp.codes) {
      const c = await p.rateServiceClass.create({
        data: { utilityId: UID, commodityId: grp.commodity.id, code, label, sortOrder: order, isActive: true },
      });
      classMap[grp.commodity.code][code] = c;
      order += 10;
      classCount++;
    }
  }
  console.log("  " + classCount + " rate service classes");

  // ============ RATE INDICES (v2 — slice 1 task 10) ============
  await p.rateIndex.create({ data: { utilityId: UID, name: "fac",                period: "2026-Q2",      value: 0.00125, effectiveDate: new Date("2026-04-01") } });
  await p.rateIndex.create({ data: { utilityId: UID, name: "epcc",               period: "2026-current", value: 0.00050, effectiveDate: new Date("2026-01-01") } });
  /*
   * `supply_residential` is published every quarter, because NWE's
   * default-supply component is `indexed` with a `current_quarter`
   * resolver: it reads `index:supply_residential:<quarter of the
   * service period's start>` and throws if that exact quarter is
   * missing. One quarter's row only bills the one quarter.
   *
   * The span starts at 2025-Q1 because that is when the seeded service
   * agreements start, and a first bill runs from the agreement's own
   * start date; it runs to 2026-Q4 to cover the seeded reads. Values
   * drift a little so a bill's supply charge changes between
   * quarters the way a real indexed rate does.
   */
  const SUPPLY_BY_QUARTER = {
    "2025-Q1": 0.06100, "2025-Q2": 0.06250, "2025-Q3": 0.06800, "2025-Q4": 0.06400,
    "2026-Q1": 0.06650, "2026-Q2": 0.07000, "2026-Q3": 0.07350, "2026-Q4": 0.07100,
  };
  for (const [period, value] of Object.entries(SUPPLY_BY_QUARTER)) {
    const [y, q] = period.split("-Q");
    await p.rateIndex.create({
      data: {
        utilityId: UID,
        name: "supply_residential",
        period,
        value,
        effectiveDate: new Date(Date.UTC(Number(y), (Number(q) - 1) * 3, 1)),
      },
    });
  }
  console.log("  " + (2 + Object.keys(SUPPLY_BY_QUARTER).length) + " rate indices");

  // ============ RATE SCHEDULES + COMPONENTS (v2 — slice 1 task 10) ============
  // Schedules are metadata-only; pricing lives in rate_component rows.
  // Components carry effective_date independently of the schedule.
  const SLICE1_EFF = new Date("2025-09-15");

  // ---- Bozeman Water 2025-09 ----
  const rsW = await p.rateSchedule.create({
    data: {
      utilityId: UID,
      name: "Bozeman Water 2025-09",
      code: "BZN-WATER",
      commodityId: water.id,
      effectiveDate: SLICE1_EFF,
      description: "City of Bozeman water tariff effective 2025-09-15",
      regulatoryRef: "Resolution 5378",
      version: 1,
    },
  });
  await p.rateComponent.createMany({
    data: [
      // Service charge — same for all classes, keyed to meter size.
      { utilityId: UID, rateScheduleId: rsW.id, kindCode: "service_charge",
        label: "Water Service Charge", sortOrder: 10, effectiveDate: SLICE1_EFF,
        predicate: {}, quantitySource: { base: "fixed" },
        // MONTH like every other service charge: the amount varies by
        // meter size but the charge is one month of service, and a bill
        // line reading a bare "1" says nothing.
        pricing: { type: "lookup", by: "meter_size", unit: "MONTH", table: {
          '5/8"': 22.31, '1"': 29.56, '1.5"': 46.52, '2"': 67.64,
          '3"': 116.92, '4"': 187.50, '6"': 349.42, '8"': 552.48,
        }},
      },
      // SFR — inclining-block tiers. `unit` because both the rates and
      // the thresholds are per HCF while the meters are GAL: without it
      // 3,515 gallons priced as 3,515 HCF and billed $33,445.38 of
      // usage on one house for one month.
      { utilityId: UID, rateScheduleId: rsW.id, kindCode: "consumption",
        label: "Water Usage — Single Family", sortOrder: 20, effectiveDate: SLICE1_EFF,
        predicate: { class: "single_family" },
        quantitySource: { base: "metered" },
        pricing: { type: "tiered", unit: "HCF", tiers: [
          { to: 6, rate: 3.31 }, { to: 25, rate: 4.58 },
          { to: 55, rate: 6.39 }, { to: null, rate: 9.58 },
        ]},
      },
      // Multi-Family flat per HCF.
      { utilityId: UID, rateScheduleId: rsW.id, kindCode: "consumption",
        label: "Water Usage — Multi-Family", sortOrder: 21, effectiveDate: SLICE1_EFF,
        predicate: { class: "multi_family" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 3.01, unit: "HCF" },
      },
      { utilityId: UID, rateScheduleId: rsW.id, kindCode: "consumption",
        label: "Water Usage — Government", sortOrder: 22, effectiveDate: SLICE1_EFF,
        predicate: { class: "government" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 5.74, unit: "HCF" },
      },
      { utilityId: UID, rateScheduleId: rsW.id, kindCode: "consumption",
        label: "Water Usage — MSU", sortOrder: 23, effectiveDate: SLICE1_EFF,
        predicate: { class: "msu" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 3.77, unit: "HCF" },
      },
      { utilityId: UID, rateScheduleId: rsW.id, kindCode: "consumption",
        label: "Water Usage — Commercial", sortOrder: 24, effectiveDate: SLICE1_EFF,
        predicate: { class: "commercial" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 3.40, unit: "HCF" },
      },
      // SFR minimum bill — applies as floor on subtotal.
      { utilityId: UID, rateScheduleId: rsW.id, kindCode: "minimum_bill",
        label: "Water Minimum Bill", sortOrder: 90, effectiveDate: SLICE1_EFF,
        predicate: { class: "single_family" },
        quantitySource: { base: "fixed" },
        pricing: { type: "floor", amount: 6.62, applies_to_subtotal: true },
      },
      // Drought reserve — flat per HCF, predicate-gated.
      { utilityId: UID, rateScheduleId: rsW.id, kindCode: "surcharge",
        label: "Drought Reserve", sortOrder: 80, effectiveDate: SLICE1_EFF,
        predicate: { drought_stage_active: true },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 0.11, unit: "HCF" },
      },
      // Drought stage surcharge — 25% of consumption when stage active.
      { utilityId: UID, rateScheduleId: rsW.id, kindCode: "surcharge",
        label: "Drought Stage Surcharge", sortOrder: 81, effectiveDate: SLICE1_EFF,
        predicate: { drought_stage_active: true },
        quantitySource: { base: "metered" },
        pricing: { type: "percent_of", selector: { kind: "consumption" }, percent: 25 },
      },
    ],
  });

  // ---- Bozeman Sewer 2025-09 ----
  const rsS = await p.rateSchedule.create({
    data: {
      utilityId: UID,
      name: "Bozeman Sewer 2025-09",
      code: "BZN-SEWER",
      commodityId: sewer.id,
      effectiveDate: SLICE1_EFF,
      description: "City of Bozeman wastewater tariff effective 2025-09-15",
      regulatoryRef: "Resolution 5378",
      version: 1,
    },
  });
  await p.rateComponent.createMany({
    data: [
      // Service charge — three brackets (Residential, mid group, Industrial).
      { utilityId: UID, rateScheduleId: rsS.id, kindCode: "service_charge",
        label: "Sewer Service Charge — Residential", sortOrder: 10, effectiveDate: SLICE1_EFF,
        predicate: { class: "residential" },
        quantitySource: { base: "fixed" },
        pricing: { type: "flat", rate: 24.65, unit: "MONTH" },
      },
      { utilityId: UID, rateScheduleId: rsS.id, kindCode: "service_charge",
        label: "Sewer Service Charge — Mid Class Group", sortOrder: 11, effectiveDate: SLICE1_EFF,
        predicate: { class_in: ["multi_family", "commercial", "government", "msu"] },
        quantitySource: { base: "fixed" },
        pricing: { type: "flat", rate: 25.26, unit: "MONTH" },
      },
      { utilityId: UID, rateScheduleId: rsS.id, kindCode: "service_charge",
        label: "Sewer Service Charge — Industrial", sortOrder: 12, effectiveDate: SLICE1_EFF,
        predicate: { class: "industrial" },
        quantitySource: { base: "fixed" },
        pricing: { type: "flat", rate: 49.06, unit: "MONTH" },
      },
      // Consumption — Residential / Multi-Family use WQA, others use linked-commodity (water).
      { utilityId: UID, rateScheduleId: rsS.id, kindCode: "derived_consumption",
        label: "Sewer Usage — Residential (WQA)", sortOrder: 20, effectiveDate: SLICE1_EFF,
        predicate: { class: "residential" },
        quantitySource: { base: "wqa" },
        pricing: { type: "flat", rate: 4.12, unit: "HCF" },
      },
      { utilityId: UID, rateScheduleId: rsS.id, kindCode: "derived_consumption",
        label: "Sewer Usage — Multi-Family (WQA)", sortOrder: 21, effectiveDate: SLICE1_EFF,
        predicate: { class: "multi_family" },
        quantitySource: { base: "wqa" },
        pricing: { type: "flat", rate: 4.58, unit: "HCF" },
      },
      { utilityId: UID, rateScheduleId: rsS.id, kindCode: "derived_consumption",
        label: "Sewer Usage — Commercial", sortOrder: 22, effectiveDate: SLICE1_EFF,
        predicate: { class: "commercial" },
        quantitySource: { base: "linked_commodity" },
        pricing: { type: "flat", rate: 5.13, unit: "HCF" },
      },
      { utilityId: UID, rateScheduleId: rsS.id, kindCode: "derived_consumption",
        label: "Sewer Usage — Government", sortOrder: 23, effectiveDate: SLICE1_EFF,
        predicate: { class: "government" },
        quantitySource: { base: "linked_commodity" },
        pricing: { type: "flat", rate: 4.95, unit: "HCF" },
      },
      { utilityId: UID, rateScheduleId: rsS.id, kindCode: "derived_consumption",
        label: "Sewer Usage — MSU", sortOrder: 24, effectiveDate: SLICE1_EFF,
        predicate: { class: "msu" },
        quantitySource: { base: "linked_commodity" },
        pricing: { type: "flat", rate: 5.34, unit: "HCF" },
      },
      { utilityId: UID, rateScheduleId: rsS.id, kindCode: "derived_consumption",
        label: "Sewer Usage — Industrial", sortOrder: 25, effectiveDate: SLICE1_EFF,
        predicate: { class: "industrial" },
        quantitySource: { base: "linked_commodity" },
        pricing: { type: "flat", rate: 7.79, unit: "HCF" },
      },
    ],
  });

  // ---- Bozeman Stormwater 2025-09 ----
  const rsSW = await p.rateSchedule.create({
    data: {
      utilityId: UID,
      name: "Bozeman Stormwater 2025-09",
      code: "BZN-STORMWATER",
      commodityId: stormwater.id,
      effectiveDate: SLICE1_EFF,
      description: "City of Bozeman stormwater tariff effective 2025-09-15",
      regulatoryRef: "Resolution 5378",
      version: 1,
    },
  });
  await p.rateComponent.createMany({
    data: [
      { utilityId: UID, rateScheduleId: rsSW.id, kindCode: "service_charge",
        label: "Stormwater Flat Charge", sortOrder: 10, effectiveDate: SLICE1_EFF,
        predicate: {},
        quantitySource: { base: "fixed" },
        pricing: { type: "flat", rate: 4.81, unit: "MONTH" },
      },
      { utilityId: UID, rateScheduleId: rsSW.id, kindCode: "non_meter",
        label: "Stormwater Per-ERU Variable", sortOrder: 20, effectiveDate: SLICE1_EFF,
        predicate: {},
        quantitySource: { base: "premise_attribute", source_attr: "premise.eru_count" },
        pricing: { type: "per_unit", rate: 3.99, unit: "ERU" },
      },
      // 45% credit applies only to the variable portion, only when the
      // premise has approved on-site stormwater infra.
      { utilityId: UID, rateScheduleId: rsSW.id, kindCode: "credit",
        label: "Stormwater Infrastructure Credit", sortOrder: 30, effectiveDate: SLICE1_EFF,
        predicate: { premise_attr: { attr: "has_stormwater_infra", eq: true } },
        quantitySource: { base: "fixed" },
        pricing: { type: "percent_of", selector: { kind: "non_meter" }, percent: -45 },
      },
    ],
  });

  // ---- Bozeman Solid Waste 2025-09 ----
  const rsSolid = await p.rateSchedule.create({
    data: {
      utilityId: UID,
      name: "Bozeman Solid Waste 2025-09",
      code: "BZN-SOLID-WASTE",
      commodityId: solidWaste.id,
      effectiveDate: SLICE1_EFF,
      description: "City of Bozeman solid waste tariff effective 2025-09-15",
      regulatoryRef: "Resolution 5378",
      version: 1,
    },
  });
  await p.rateComponent.createMany({
    data: [
      // Garbage cart — catalog by (size, frequency). Keys are
      // pipe-joined to keep the lookup table flat. The engine resolves
      // (size, frequency) from the container row at billing time.
      { utilityId: UID, rateScheduleId: rsSolid.id, kindCode: "item_price",
        label: "Garbage Cart", sortOrder: 10, effectiveDate: SLICE1_EFF,
        predicate: {},
        quantitySource: { base: "item_count" },
        pricing: { type: "catalog", by: ["size", "frequency"], table: {
          "35|weekly":  18.96,  "45|weekly":  18.96,  "45|monthly": 14.11,
          "65|weekly":  27.24,  "100|weekly": 34.91,  "220|weekly": 58.30,
          "300|weekly": 73.09,  "450|weekly": 105.30,
        }},
      },
      // Recycling cart — keyed by size only.
      { utilityId: UID, rateScheduleId: rsSolid.id, kindCode: "item_price",
        label: "Recycling Cart", sortOrder: 20, effectiveDate: SLICE1_EFF,
        predicate: {},
        quantitySource: { base: "item_count" },
        pricing: { type: "catalog", by: ["size"], table: {
          "65": 12.96, "100": 12.96, "300": 20.17,
        }},
      },
      // Organics cart — keyed by size only.
      { utilityId: UID, rateScheduleId: rsSolid.id, kindCode: "item_price",
        label: "Organics Cart", sortOrder: 30, effectiveDate: SLICE1_EFF,
        predicate: {},
        quantitySource: { base: "item_count" },
        pricing: { type: "catalog", by: ["size"], table: {
          "35": 12.00, "95": 12.00,
        }},
      },
    ],
  });

  // ---- NWE Residential Electric — three schedules (delivery + supply + rider) ----
  // Demonstrates multi-assignment: one electric SA holds three schedules,
  // each with its own role (delivery / supply / rider).
  const rsE_REDS = await p.rateSchedule.create({
    data: {
      utilityId: UID,
      name: "NWE Residential Delivery",
      code: "NWE-REDS-1",
      commodityId: electric.id,
      effectiveDate: new Date("2026-01-01"),
      description: "NWE-style residential delivery (REDS-1)",
      regulatoryRef: "Sched REDS-1",
      version: 1,
    },
  });
  await p.rateComponent.createMany({
    data: [
      { utilityId: UID, rateScheduleId: rsE_REDS.id, kindCode: "service_charge",
        label: "Residential Delivery Service Charge", sortOrder: 10, effectiveDate: new Date("2026-01-01"),
        predicate: { class: "residential" },
        quantitySource: { base: "fixed" },
        pricing: { type: "flat", rate: 4.20, unit: "MONTH" },
      },
      { utilityId: UID, rateScheduleId: rsE_REDS.id, kindCode: "consumption",
        label: "Residential Delivery Energy", sortOrder: 20, effectiveDate: new Date("2026-01-01"),
        predicate: { class: "residential" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 0.04125, unit: "kWh" },
      },
      { utilityId: UID, rateScheduleId: rsE_REDS.id, kindCode: "surcharge",
        label: "Residential Delivery Tax", sortOrder: 30, effectiveDate: new Date("2026-01-01"),
        predicate: { class: "residential" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 0.0117650, unit: "kWh" },
      },
    ],
  });

  const rsE_ESS = await p.rateSchedule.create({
    data: {
      utilityId: UID,
      name: "NWE Default Supply",
      code: "NWE-ESS-1",
      commodityId: electric.id,
      effectiveDate: new Date("2026-01-01"),
      description: "NWE-style default supply (ESS-1) — indexed quarterly",
      regulatoryRef: "Sched ESS-1",
      version: 1,
    },
  });
  await p.rateComponent.create({
    data: {
      utilityId: UID, rateScheduleId: rsE_ESS.id, kindCode: "consumption",
      label: "Default Supply — Indexed Quarterly", sortOrder: 10,
      effectiveDate: new Date("2026-01-01"),
      predicate: { class: "residential" },
      quantitySource: { base: "metered" },
      pricing: { type: "indexed", index_name: "supply_residential",
        period_resolver: "current_quarter", multiplier: 1, unit: "kWh" },
    },
  });

  const rsE_USBC = await p.rateSchedule.create({
    data: {
      utilityId: UID,
      name: "NWE USBC",
      code: "NWE-USBC-1",
      commodityId: electric.id,
      effectiveDate: new Date("2026-01-01"),
      description: "NWE-style universal system benefits charge",
      regulatoryRef: "Sched USBC",
      version: 1,
    },
  });
  await p.rateComponent.create({
    data: {
      utilityId: UID, rateScheduleId: rsE_USBC.id, kindCode: "surcharge",
      label: "Universal System Benefits Charge", sortOrder: 10,
      effectiveDate: new Date("2026-01-01"),
      predicate: {},
      quantitySource: { base: "metered" },
      pricing: { type: "flat", rate: 0.0024, unit: "kWh" },
    },
  });

  // Published, because a draft schedule cannot be billed against:
  // `bill-segment.service` picks assignments by their own date window
  // and then refuses any schedule with no publishedAt
  // (SCHEDULE_NOT_PUBLISHED). Left as drafts, a seeded database could
  // not complete a single billing run — which is what happened on
  // 2026-10-22: a run over four accounts failed two on this and skipped
  // the other two, so nothing billed.
  //
  // The seed writes publishedAt directly rather than calling
  // publishRateSchedule, in keeping with how it writes its bills: it
  // does not go through the services. These are the golden-test tariffs
  // and each carries its components, so publishing them is not
  // publishing an empty schedule — the thing utility-readiness warns
  // about separately.
  await p.rateSchedule.updateMany({
    where: { utilityId: UID, publishedAt: null },
    data: { publishedAt: new Date() },
  });

  console.log("  7 rate schedules with components, published");

  const premiseData = [
    { addressLine1: "742 Evergreen Terrace", city: "Springfield", state: "IL", zip: "62704", geoLat: 39.7817, geoLng: -89.6501, premiseType: "RESIDENTIAL", commodityIds: [water.id, sewer.id, stormwater.id, solidWaste.id], eruCount: 1, hasStormwaterInfra: true },
    { addressLine1: "1600 Pennsylvania Ave NW", city: "Washington", state: "DC", zip: "20500", geoLat: 38.8977, geoLng: -77.0365, premiseType: "COMMERCIAL", commodityIds: [water.id, electric.id, gas.id], eruCount: 6 },
    { addressLine1: "221B Baker Street", city: "New York", state: "NY", zip: "10001", geoLat: 40.7484, geoLng: -73.9856, premiseType: "RESIDENTIAL", commodityIds: [electric.id, gas.id], eruCount: 1 },
    { addressLine1: "350 Fifth Avenue", city: "New York", state: "NY", zip: "10118", geoLat: 40.7484, geoLng: -73.9857, premiseType: "INDUSTRIAL", commodityIds: [water.id, electric.id, sewer.id], eruCount: 12 },
    { addressLine1: "1060 W Addison St", city: "Chicago", state: "IL", zip: "60613", geoLat: 41.9484, geoLng: -87.6553, premiseType: "COMMERCIAL", commodityIds: [water.id, electric.id], eruCount: 4 },
    { addressLine1: "4059 Mt Lee Dr", city: "Los Angeles", state: "CA", zip: "90068", geoLat: 34.1341, geoLng: -118.3215, premiseType: "RESIDENTIAL", commodityIds: [water.id, electric.id, sewer.id, solidWaste.id], eruCount: 1, hasStormwaterInfra: true },
    { addressLine1: "1 Infinite Loop", city: "Cupertino", state: "CA", zip: "95014", geoLat: 37.3318, geoLng: -122.0312, premiseType: "COMMERCIAL", commodityIds: [water.id, electric.id, gas.id, sewer.id], eruCount: 8 },
    { addressLine1: "233 S Wacker Dr", city: "Chicago", state: "IL", zip: "60606", geoLat: 41.8789, geoLng: -87.6359, premiseType: "COMMERCIAL", commodityIds: [water.id, electric.id, gas.id], eruCount: 10 },
    { addressLine1: "600 Navarro St", city: "San Antonio", state: "TX", zip: "78205", geoLat: 29.4241, geoLng: -98.4936, premiseType: "MUNICIPAL", commodityIds: [water.id, sewer.id], eruCount: 3 },
    { addressLine1: "1 Main Street", city: "Smallville", state: "KS", zip: "66002", geoLat: 39.0997, geoLng: -94.5786, premiseType: "RESIDENTIAL", commodityIds: [water.id, electric.id], eruCount: 1 },
  ];

  const pArr = [];
  for (const pr of premiseData) {
    pArr.push(await p.premise.create({ data: { utilityId: UID, ...pr } }));
  }
  console.log("  " + pArr.length + " premises (with eru_count + has_stormwater_infra)");

  // Slice 5b.1 — billing cycle moved from SA to Account.
  const accountData = [
    { accountNumber: "0001000-00", accountType: "RESIDENTIAL", creditRating: "EXCELLENT", status: "ACTIVE", billingCycleId: c1.id },
    { accountNumber: "0001001-00", accountType: "COMMERCIAL",  creditRating: "GOOD",      status: "ACTIVE", depositAmount: 500,  billingCycleId: c2.id },
    { accountNumber: "0001002-00", accountType: "RESIDENTIAL", creditRating: "GOOD",      status: "ACTIVE", billingCycleId: c1.id },
    { accountNumber: "0001003-00", accountType: "INDUSTRIAL",  creditRating: "EXCELLENT", status: "ACTIVE", depositAmount: 2000, billingCycleId: c1.id },
    { accountNumber: "0001004-00", accountType: "COMMERCIAL",  creditRating: "FAIR",      status: "ACTIVE", depositAmount: 300,  billingCycleId: c2.id },
    { accountNumber: "0001005-00", accountType: "RESIDENTIAL", creditRating: "GOOD",      status: "ACTIVE", paperlessBilling: true, billingCycleId: c1.id },
    { accountNumber: "0001006-00", accountType: "MUNICIPAL",   creditRating: "EXCELLENT", status: "ACTIVE", billingCycleId: c1.id },
    { accountNumber: "0001007-00", accountType: "RESIDENTIAL", creditRating: "POOR",      status: "ACTIVE", depositAmount: 200,  billingCycleId: c1.id },
  ];

  // Deterministic ids, like the test users below. Accounts are the thing
  // a developer bookmarks and links to, and a random id per run means
  // every reseed turns every open tab into a 404 "Record not found" from
  // Prisma's P2025. The number in the account number is the suffix, so
  // 0001000-00 is always ...-000000000a00.
  const aArr = [];
  for (let i = 0; i < accountData.length; i++) {
    const ac = accountData[i];
    aArr.push(
      await p.account.create({
        data: {
          // "ac" for account, so these cannot be mistaken for the
          // cis_user ids below, which already use ...0000a1 and ...0000a2
          // for the two portal customers.
          id: `00000000-0000-4000-8000-00000000ac0${i.toString(16)}`,
          utilityId: UID,
          /*
           * Backdated to the agreements' own start, or nothing can be
           * billed. `computeBillPeriod` clamps a window's start to
           * `account.createdAt` — an account created today gets a
           * window whose start is after its end, finds no segments and
           * skips with NO_SEGMENTS_TO_BILL. That clamp is right (an
           * account cannot be billed for a window predating it); what
           * was wrong was seeding every account as created today and
           * then billing it for last month. The billing-run integration
           * fixture had to undo this in raw SQL to test anything.
           */
          createdAt: new Date("2025-01-01T00:00:00Z"),
          ...ac,
        },
      }),
    );
  }
  console.log("  " + aArr.length + " accounts");

  /*
   * Water and sewer meters carry a size, because Bozeman's water
   * service charge is priced by one: `lookup` pricing reads
   * `meter:size:<id>` from `customFields.size` and the tariff's table
   * is keyed `5/8"`, `1"`, `1.5"` … A meter without it does not bill —
   * the component throws rather than guessing a size, and a run
   * reports the account as failed. Electric and gas meters have no
   * size in inches and no tariff asks for one.
   *
   * The sizes below follow the premise: residential 5/8", commercial
   * and industrial larger, so more than one row of the table is ever
   * exercised.
   */
  const meterData = [
    { premiseId: pArr[0].id, meterNumber: "WM-001", commodityId: water.id, uomId: gal.id, meterType: "MANUAL", status: "ACTIVE", installDate: new Date("2024-01-15"), customFields: { size: '5/8"' } },
    { premiseId: pArr[0].id, meterNumber: "SM-001", commodityId: sewer.id, uomId: sgal.id, meterType: "MANUAL", status: "ACTIVE", installDate: new Date("2024-01-15"), customFields: { size: '5/8"' } },
    { premiseId: pArr[1].id, meterNumber: "WM-002", commodityId: water.id, uomId: gal.id, meterType: "AMR", status: "ACTIVE", installDate: new Date("2024-02-01"), customFields: { size: '2"' } },
    { premiseId: pArr[1].id, meterNumber: "EM-001", commodityId: electric.id, uomId: kwh.id, meterType: "AMI", status: "ACTIVE", installDate: new Date("2024-02-01") },
    { premiseId: pArr[1].id, meterNumber: "GM-001", commodityId: gas.id, uomId: mcf.id, meterType: "AMR", status: "ACTIVE", installDate: new Date("2024-02-01") },
    { premiseId: pArr[2].id, meterNumber: "EM-002", commodityId: electric.id, uomId: kwh.id, meterType: "SMART", status: "ACTIVE", installDate: new Date("2024-03-01") },
    { premiseId: pArr[2].id, meterNumber: "GM-002", commodityId: gas.id, uomId: mcf.id, meterType: "MANUAL", status: "ACTIVE", installDate: new Date("2024-03-01") },
    { premiseId: pArr[3].id, meterNumber: "WM-003", commodityId: water.id, uomId: gal.id, meterType: "AMI", status: "ACTIVE", installDate: new Date("2024-01-20"), customFields: { size: '4"' } },
    { premiseId: pArr[3].id, meterNumber: "EM-003", commodityId: electric.id, uomId: kwh.id, meterType: "AMI", status: "ACTIVE", installDate: new Date("2024-01-20") },
    { premiseId: pArr[4].id, meterNumber: "WM-004", commodityId: water.id, uomId: gal.id, meterType: "AMR", status: "ACTIVE", installDate: new Date("2024-04-01"), customFields: { size: '1.5"' } },
    { premiseId: pArr[4].id, meterNumber: "EM-004", commodityId: electric.id, uomId: kwh.id, meterType: "AMR", status: "ACTIVE", installDate: new Date("2024-04-01") },
    { premiseId: pArr[5].id, meterNumber: "WM-005", commodityId: water.id, uomId: gal.id, meterType: "MANUAL", status: "ACTIVE", installDate: new Date("2024-05-01"), customFields: { size: '5/8"' } },
    { premiseId: pArr[5].id, meterNumber: "EM-005", commodityId: electric.id, uomId: kwh.id, meterType: "SMART", status: "ACTIVE", installDate: new Date("2024-05-01") },
    { premiseId: pArr[6].id, meterNumber: "WM-006", commodityId: water.id, uomId: gal.id, meterType: "AMI", status: "ACTIVE", installDate: new Date("2024-06-01"), customFields: { size: '1"' } },
    { premiseId: pArr[6].id, meterNumber: "EM-006", commodityId: electric.id, uomId: kwh.id, meterType: "AMI", status: "ACTIVE", installDate: new Date("2024-06-01") },
  ];

  const mArr = [];
  for (const mt of meterData) {
    mArr.push(await p.meter.create({ data: { utilityId: UID, ...mt } }));
  }
  console.log("  " + mArr.length + " meters");

  // EM-003 at 350 Fifth Avenue (industrial) is the multi-register test
  // fixture. Commercial/industrial electric meters typically expose two
  // registers — one for energy consumption (kWh) and one for peak demand
  // (kW) — captured together on each field visit.
  const em003 = mArr[8];
  await p.meterRegister.create({ data: { utilityId: UID, meterId: em003.id, registerNumber: 1, description: "Energy usage", uomId: kwh.id, measureTypeId: measureUsage.id, multiplier: 1.0, isActive: true } });
  await p.meterRegister.create({ data: { utilityId: UID, meterId: em003.id, registerNumber: 2, description: "Peak demand", uomId: kw.id, measureTypeId: measureDemand.id, multiplier: 1.0, isActive: true } });
  console.log("  2 registers on EM-003 (multi-register demo)");

  // SAs now carry rate_service_class_id (slice 1 task 10). The class
  // depends on (commodity, account_type / premise_type). Assign sensible
  // defaults and let later edits override.
  const W = water.code, S = sewer.code, E = electric.code;
  const saData = [
    { agreementNumber: "SA-0001", accountId: aArr[0].id, premiseId: pArr[0].id, commodityId: water.id, mIdx: [0], svcClass: classMap[W].single_family.id, schedules: [{ rs: rsW, role: "primary" }] },
    { agreementNumber: "SA-0002", accountId: aArr[0].id, premiseId: pArr[0].id, commodityId: sewer.id, mIdx: [1], svcClass: classMap[S].residential.id, schedules: [{ rs: rsS, role: "primary" }] },
    { agreementNumber: "SA-0003", accountId: aArr[1].id, premiseId: pArr[1].id, commodityId: water.id, mIdx: [2], svcClass: classMap[W].commercial.id, schedules: [{ rs: rsW, role: "primary" }] },
    { agreementNumber: "SA-0004", accountId: aArr[1].id, premiseId: pArr[1].id, commodityId: electric.id, mIdx: [3], svcClass: classMap[E].small_commercial.id, schedules: [
      { rs: rsE_REDS, role: "delivery" }, { rs: rsE_ESS, role: "supply" }, { rs: rsE_USBC, role: "rider" },
    ]},
    { agreementNumber: "SA-0006", accountId: aArr[2].id, premiseId: pArr[2].id, commodityId: electric.id, mIdx: [5], svcClass: classMap[E].residential.id, schedules: [
      { rs: rsE_REDS, role: "delivery" }, { rs: rsE_ESS, role: "supply" }, { rs: rsE_USBC, role: "rider" },
    ]},
    { agreementNumber: "SA-0007", accountId: aArr[3].id, premiseId: pArr[3].id, commodityId: water.id, mIdx: [7], svcClass: classMap[W].commercial.id, schedules: [{ rs: rsW, role: "primary" }] },
    { agreementNumber: "SA-0008", accountId: aArr[3].id, premiseId: pArr[3].id, commodityId: electric.id, mIdx: [8], svcClass: classMap[E].large_commercial.id, schedules: [
      { rs: rsE_REDS, role: "delivery" }, { rs: rsE_ESS, role: "supply" }, { rs: rsE_USBC, role: "rider" },
    ]},
    { agreementNumber: "SA-0009", accountId: aArr[4].id, premiseId: pArr[4].id, commodityId: water.id, mIdx: [9], svcClass: classMap[W].commercial.id, schedules: [{ rs: rsW, role: "primary" }] },
    { agreementNumber: "SA-0010", accountId: aArr[5].id, premiseId: pArr[5].id, commodityId: water.id, mIdx: [11], svcClass: classMap[W].single_family.id, schedules: [{ rs: rsW, role: "primary" }] },
  ];

  const saCreated = [];
  let assignmentCount = 0;
  for (const sa of saData) {
    const { mIdx, schedules, svcClass, premiseId, ...data } = sa;
    const created = await p.serviceAgreement.create({
      data: {
        utilityId: UID, ...data,
        rateServiceClassId: svcClass,
        startDate: new Date("2025-01-01"),
        status: "ACTIVE",
      },
    });
    saCreated.push({ ...created, _premiseId: premiseId });
    const sp = await p.servicePoint.create({
      data: {
        utilityId: UID,
        serviceAgreementId: created.id,
        premiseId,
        type: "METERED",
        status: "ACTIVE",
        startDate: new Date("2025-01-01"),
      },
    });
    for (const i of mIdx) {
      await p.servicePointMeter.create({
        data: {
          utilityId: UID,
          servicePointId: sp.id,
          meterId: mArr[i].id,
          addedDate: new Date("2025-01-01"),
        },
      });
    }
    // SAScheduleAssignment rows — one per (sa, schedule, role).
    for (const { rs, role } of schedules) {
      await p.sAScheduleAssignment.create({
        data: {
          utilityId: UID,
          serviceAgreementId: created.id,
          rateScheduleId: rs.id,
          roleCode: role,
          effectiveDate: new Date("2025-01-01"),
        },
      });
      assignmentCount++;
    }
  }
  console.log("  " + saData.length + " service agreements");
  console.log("  " + assignmentCount + " SA -> rate schedule assignments");

  // ============ Solid-waste containers (with size/frequency/itemType for v2 catalog lookup) ============
  // Premise 0 (single-family, has all four utilities incl. solid waste):
  // garbage 65 weekly + recycling 65 + organics 35.
  // Premise 5 (Hollywood residential): garbage 35 weekly + recycling 65.
  await p.container.create({ data: {
    utilityId: UID, premiseId: pArr[0].id, containerType: "CART_GARBAGE",
    sizeGallons: 65, quantity: 1, status: "ACTIVE",
    deliveryDate: new Date("2025-01-15"),
    size: "65", frequency: "weekly", itemType: "garbage_cart",
  }});
  await p.container.create({ data: {
    utilityId: UID, premiseId: pArr[0].id, containerType: "CART_RECYCLING",
    sizeGallons: 65, quantity: 1, status: "ACTIVE",
    deliveryDate: new Date("2025-01-15"),
    size: "65", frequency: "weekly", itemType: "recycling_cart",
  }});
  await p.container.create({ data: {
    utilityId: UID, premiseId: pArr[0].id, containerType: "CART_ORGANICS",
    sizeGallons: 35, quantity: 1, status: "ACTIVE",
    deliveryDate: new Date("2025-03-01"),
    size: "35", frequency: "weekly", itemType: "organics_cart",
  }});
  await p.container.create({ data: {
    utilityId: UID, premiseId: pArr[5].id, containerType: "CART_GARBAGE",
    sizeGallons: 35, quantity: 1, status: "ACTIVE",
    deliveryDate: new Date("2025-02-01"),
    size: "35", frequency: "weekly", itemType: "garbage_cart",
  }});
  await p.container.create({ data: {
    utilityId: UID, premiseId: pArr[5].id, containerType: "CART_RECYCLING",
    sizeGallons: 65, quantity: 1, status: "ACTIVE",
    deliveryDate: new Date("2025-02-01"),
    size: "65", frequency: "weekly", itemType: "recycling_cart",
  }});
  console.log("  5 containers (with size/frequency/item_type)");

  // Seed 12 months of meter reads for SA-0001 (water, WM-001) and SA-0006 (electric, EM-002).
  // These give the portal usage page real data to chart. Each month has one ACTUAL read.
  //
  /*
   * Read dates are built in UTC, on the 15th.
   *
   * `read_date` is a `@db.Date`, so a local-midnight Date lands on the
   * 16th once stored anywhere west of Greenwich, and every date derived
   * from it downstream — which period a run may close on, which bill
   * covers it — was then a day out from what this file says.
   */
  const READ_DAY_UTC = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    15,
  ));
  const saList = await p.serviceAgreement.findMany({
    where: { utilityId: UID },
    include: { servicePoints: { include: { meters: { include: { meter: { select: { uomId: true } } } } } } },
    orderBy: { agreementNumber: "asc" },
  });
  const sa0001 = saList.find(s => s.agreementNumber === "SA-0001");
  const sa0006 = saList.find(s => s.agreementNumber === "SA-0006");
  let readCount = 0;
  for (const { sa, baseReading, monthlyUsage } of [
    { sa: sa0001, baseReading: 1200, monthlyUsage: () => 3500 + Math.floor(Math.random() * 2000) },
    { sa: sa0006, baseReading: 45000, monthlyUsage: () => 650 + Math.floor(Math.random() * 300) },
  ]) {
    const firstSpm = sa && sa.servicePoints[0] && sa.servicePoints[0].meters[0];
    if (!firstSpm) continue;
    const meterId = firstSpm.meterId;
    const uomId = firstSpm.meter.uomId;
    let running = baseReading;
    for (let m = 11; m >= 0; m--) {
      const d = new Date(Date.UTC(
        READ_DAY_UTC.getUTCFullYear(),
        READ_DAY_UTC.getUTCMonth() - m,
        15,
      ));
      const usage = monthlyUsage();
      const prior = running;
      running += usage;
      await p.meterRead.create({
        data: {
          utilityId: UID,
          meterId,
          serviceAgreementId: sa.id,
          uomId,
          readDate: d,
          readDatetime: d,
          reading: running,
          priorReading: prior,
          consumption: usage,
          readType: "ACTUAL",
          readSource: "AMR",
          isFrozen: false,
        },
      });
      readCount++;
    }
  }
  console.log("  " + readCount + " meter reads");

  const customerData = [
    { customerType: "INDIVIDUAL", firstName: "Jane", lastName: "Smith", email: "jane.smith@example.com", phone: "555-100-0001", status: "ACTIVE" },
    { customerType: "INDIVIDUAL", firstName: "Robert", lastName: "Johnson", email: "robert.j@example.com", phone: "555-100-0002", status: "ACTIVE" },
    { customerType: "ORGANIZATION", organizationName: "Acme Industries LLC", email: "billing@acme.example.com", phone: "555-200-0001", taxId: "12-3456789", status: "ACTIVE" },
  ];

  const cArr = [];
  for (const cu of customerData) {
    cArr.push(await p.customer.create({ data: { utilityId: UID, ...cu } }));
  }

  // Link customers to accounts.
  //
  // Every account that gets a bill below needs one, and a billing
  // address: a bill has to say who it is for and where it goes, and bill
  // generation refuses with a 422 without both. Accounts 0001004-00 and
  // 0001005-00 had bills but no customer, so half the seeded bills could
  // not be turned into a PDF — the data said they were billable and they
  // were not.
  await p.account.update({ where: { id: aArr[0].id }, data: { customerId: cArr[0].id } });
  await p.account.update({ where: { id: aArr[2].id }, data: { customerId: cArr[1].id } });
  await p.account.update({ where: { id: aArr[1].id }, data: { customerId: cArr[2].id } });
  await p.account.update({ where: { id: aArr[3].id }, data: { customerId: cArr[2].id } });
  await p.account.update({ where: { id: aArr[4].id }, data: { customerId: cArr[2].id } });
  // Jane's second account, so the portal account list has more than one
  // row and paperless billing has a customer attached to it.
  await p.account.update({ where: { id: aArr[5].id }, data: { customerId: cArr[0].id } });
  console.log("  " + cArr.length + " customers");

  // Link customers as premise owners
  await p.premise.update({ where: { id: pArr[0].id }, data: { ownerId: cArr[0].id } });
  await p.premise.update({ where: { id: pArr[5].id }, data: { ownerId: cArr[0].id } });
  await p.premise.update({ where: { id: pArr[2].id }, data: { ownerId: cArr[1].id } });
  await p.premise.update({ where: { id: pArr[9].id }, data: { ownerId: cArr[1].id } });
  await p.premise.update({ where: { id: pArr[1].id }, data: { ownerId: cArr[2].id } });
  await p.premise.update({ where: { id: pArr[3].id }, data: { ownerId: cArr[2].id } });
  await p.premise.update({ where: { id: pArr[4].id }, data: { ownerId: cArr[2].id } });
  await p.premise.update({ where: { id: pArr[6].id }, data: { ownerId: cArr[2].id } });
  await p.premise.update({ where: { id: pArr[7].id }, data: { ownerId: cArr[2].id } });
  console.log("  9 premises linked to owners");

  const contactData = [
    { accountId: aArr[0].id, firstName: "Tom", lastName: "Smith", email: "tom.smith@example.com", phone: "555-100-0099", notes: "Spouse — authorized to discuss billing" },
    { accountId: aArr[1].id, customerId: cArr[2].id, firstName: "Alice", lastName: "Walker", email: "alice@acme.example.com", phone: "555-200-0002", notes: "Office manager" },
  ];

  for (const ct of contactData) {
    await p.contact.create({ data: { utilityId: UID, ...ct } });
  }
  console.log("  " + contactData.length + " contacts");

  // One per billed account, for the reason given at the customer links
  // above: a bill with no recipient address cannot be produced.
  const billingAddressData = [
    { accountId: aArr[0].id, addressLine1: "742 Evergreen Terrace", city: "Springfield", state: "IL", zip: "62704", country: "US", isPrimary: true },
    { accountId: aArr[1].id, addressLine1: "PO Box 1234", city: "Washington", state: "DC", zip: "20500", country: "US", isPrimary: true },
    { accountId: aArr[2].id, addressLine1: "221B Baker Street", city: "New York", state: "NY", zip: "10001", country: "US", isPrimary: true },
    { accountId: aArr[3].id, addressLine1: "1400 Industrial Way", addressLine2: "Receiving Dock B", city: "Bozeman", state: "MT", zip: "59718", country: "US", isPrimary: true },
    { accountId: aArr[4].id, addressLine1: "88 Commerce Plaza", city: "Bozeman", state: "MT", zip: "59715", country: "US", isPrimary: true },
    { accountId: aArr[5].id, addressLine1: "19 Willow Creek Road", city: "Bozeman", state: "MT", zip: "59715", country: "US", isPrimary: true },
  ];

  for (const ba of billingAddressData) {
    await p.billingAddress.create({ data: { utilityId: UID, ...ba } });
  }
  console.log("  " + billingAddressData.length + " billing addresses");

  await p.utilityTheme.create({
    data: {
      utilityId: UID, preset: "midnight",
      colors: { dark: { "bg-deep": "#06080d", "accent-primary": "#3b82f6", "text-primary": "#e8edf5" }, light: { "bg-deep": "#ffffff", "accent-primary": "#0f766e", "text-primary": "#0f172a" } },
      typography: { body: "DM Sans", display: "Fraunces" }, borderRadius: 10,
    },
  });
  console.log("  theme");

  // Bill production needs two pieces of per-tenant configuration, and
  // without them a posted bill answers 422 rather than producing: the
  // apptor-connect integration its PDFs are written to, and the five
  // issuer fields that make a bill a valid document
  // (REQUIRED_ISSUER_FIELDS in packages/shared/src/validators/
  // tenant-settings.ts).
  //
  // This block exists because the wipe above deletes `utility_config`
  // and nothing recreated it, so every reseed silently took bill
  // production away from a database where it had been configured by
  // hand — the failure then reads as "storage is not configured",
  // which sounds like an apptor-connect problem and is not.
  //
  // `dev-files` is deliberate: it is both the integration name on the
  // local apptor-connect instance and just a directory name to
  // scripts/fake-files-plane.mjs, so the same value works whichever of
  // the two is running.
  //
  // Other readers of this table do not need the row — getAutomationConfig
  // upserts on read and posting falls back to its column defaults — so
  // this is here for bill production specifically, and the issuer values
  // are demo data like everything else in this file.
  await p.utilityConfig.create({
    data: {
      utilityId: UID,
      settings: {
        billDocuments: { storageIntegration: "dev-files" },
        issuer: {
          utilityName: "City of Bozeman Utilities",
          remittanceAddressLine1: "PO Box 1230",
          remittanceCity: "Bozeman",
          remittanceState: "MT",
          remittancePostalCode: "59771",
          billingPhone: "406-582-2000",
        },
      },
    },
  });
  console.log("  utility config (bill storage + issuer identity)");

  // Seed preset roles — MUST stay in sync with packages/shared/src/modules/constants.ts MODULES
  // Must stay in step with MODULES in packages/shared/src/modules/constants.ts.
  // A module missing here is enabled for no tenant, so its routes answer
  // 403 MODULE_DISABLED on every seeded database while their own tests
  // pass, because those create the utility_module row themselves.
  // The six preset roles and the 32 module rows used to be declared
  // here, in a 110-line array that had to be kept in step with
  // packages/shared/src/modules/constants.ts by hand — and wasn't: the
  // two drifted four modules apart. provisionTenant above creates both
  // from PRESET_ROLES, so there is one definition and nothing to sync.
  //
  // The five dev-login admin users below stay: they are demo data, not
  // provisioning. A real tenant gets one admin, named at provisioning
  // time; these five exist so a developer can switch roles in /dev.
  // Ordered as PRESET_ROLES declares them, NOT alphabetically: the dev
  // users below index this array by position — roleArr[5] is Portal
  // Customer — so an alphabetical sort would silently hand the portal
  // customers the Utility Admin role.
  const PRESET_ORDER = [
    "System Admin", "Utility Admin", "CSR", "Field Technician", "Read-Only", "Portal Customer",
  ];
  const rolesByName = new Map(
    (await p.role.findMany({ where: { utilityId: UID } })).map((r) => [r.name, r]),
  );
  const roleArr = PRESET_ORDER.map((n) => rolesByName.get(n));
  if (roleArr.some((r) => !r)) {
    throw new Error("provisionTenant did not create the expected preset roles");
  }
  console.log("  " + roleArr.length + " preset roles (from provisionTenant)");


  // Seed global suspension (hold) type codes.
  const suspensionTypes = [
    { code: "VACATION_HOLD", label: "Vacation hold", description: "Customer is out of town for a short period", sortOrder: 10, defaultBillingSuspended: true },
    { code: "SEASONAL",      label: "Seasonal",      description: "Seasonal property closed part of the year",  sortOrder: 20, defaultBillingSuspended: true },
    { code: "TEMPORARY",     label: "Temporary",     description: "General short-term suspension",              sortOrder: 30, defaultBillingSuspended: true },
    { code: "DISPUTE",       label: "Dispute",       description: "Service paused pending dispute resolution",  sortOrder: 40, defaultBillingSuspended: true },
    { code: "UNAVAILABLE",   label: "Unavailable",   description: "Service physically unavailable at premise",  sortOrder: 50, defaultBillingSuspended: true },
    { code: "REGULATORY",    label: "Regulatory",    description: "Legally mandated pause",                     sortOrder: 60, defaultBillingSuspended: false },
  ];
  for (const t of suspensionTypes) {
    const existing = await p.suspensionTypeDef.findFirst({ where: { utilityId: null, code: t.code } });
    if (!existing) {
      await p.suspensionTypeDef.create({ data: { utilityId: null, ...t } });
    }
  }
  console.log("  " + suspensionTypes.length + " suspension type defs");

  // Seed notification templates
  const notifTemplates = [
    {
      name: "Past Due Reminder",
      eventType: "delinquency.tier_1",
      description: "First notice — friendly reminder that the account is past due.",
      channels: {
        email: {
          subject: "Reminder: Your utility account {{account.accountNumber}} is past due",
          body: "Dear {{customer.firstName}},\n\nThis is a friendly reminder that your account {{account.accountNumber}} has a balance of {{delinquency.balance}} that is {{delinquency.daysPastDue}} days past due.\n\nPlease make a payment at your earliest convenience.\n\nThank you,\n{{utility.name}}",
        },
        sms: { body: "{{customer.firstName}}, your utility account {{account.accountNumber}} is {{delinquency.daysPastDue}} days past due. Balance: {{delinquency.balance}}." },
      },
      variables: [
        { key: "customer.firstName", label: "Customer first name", sample: "Jane" },
        { key: "account.accountNumber", label: "Account number", sample: "AC-00001" },
        { key: "delinquency.balance", label: "Balance due", sample: "$412.80" },
        { key: "delinquency.daysPastDue", label: "Days past due", sample: "10" },
        { key: "utility.name", label: "Utility name", sample: "Bozeman Utilities" },
      ],
    },
    {
      name: "Formal Past Due Notice",
      eventType: "delinquency.tier_2",
      description: "Second notice — formal letter warning of potential shut-off.",
      channels: {
        email: {
          subject: "IMPORTANT: Past due notice for account {{account.accountNumber}}",
          body: "Dear {{customer.firstName}},\n\nYour account {{account.accountNumber}} has an outstanding balance of {{delinquency.balance}}, now {{delinquency.daysPastDue}} days past due.\n\nIf payment is not received within 10 days, your service may be subject to disconnection.\n\nPlease contact us at {{utility.email}} to discuss payment options.\n\n{{utility.name}}",
        },
      },
      variables: [
        { key: "customer.firstName", label: "Customer first name", sample: "Jane" },
        { key: "account.accountNumber", label: "Account number", sample: "AC-00001" },
        { key: "delinquency.balance", label: "Balance due", sample: "$412.80" },
        { key: "delinquency.daysPastDue", label: "Days past due", sample: "20" },
        { key: "utility.email", label: "Utility email", sample: "billing@bozeman.gov" },
        { key: "utility.name", label: "Utility name", sample: "Bozeman Utilities" },
      ],
    },
    {
      name: "Shut-Off Warning — 48 Hours",
      eventType: "delinquency.tier_3",
      description: "Final warning before shut-off eligibility.",
      channels: {
        email: {
          subject: "URGENT: Service disconnection warning — {{account.accountNumber}}",
          body: "Dear {{customer.firstName}},\n\nThis is your final notice. Your account {{account.accountNumber}} has an unpaid balance of {{delinquency.balance}}, now {{delinquency.daysPastDue}} days past due.\n\nYour service will be eligible for disconnection in 48 hours unless payment is received.\n\nPay now: {{portal.paymentUrl}}\n\n{{utility.name}}",
        },
        sms: { body: "URGENT: {{customer.firstName}}, your utility service may be disconnected in 48 hours. Balance: {{delinquency.balance}}. Pay now: {{portal.paymentUrl}}" },
      },
      variables: [
        { key: "customer.firstName", label: "Customer first name", sample: "Jane" },
        { key: "account.accountNumber", label: "Account number", sample: "AC-00001" },
        { key: "delinquency.balance", label: "Balance due", sample: "$412.80" },
        { key: "delinquency.daysPastDue", label: "Days past due", sample: "30" },
        { key: "portal.paymentUrl", label: "Payment URL", sample: "https://portal.example.com/bills" },
        { key: "utility.name", label: "Utility name", sample: "Bozeman Utilities" },
      ],
    },
    {
      name: "Service Disconnection Notice",
      eventType: "delinquency.tier_4",
      description: "Notice that service has been or will be disconnected.",
      channels: {
        email: {
          subject: "Service disconnection — Account {{account.accountNumber}}",
          body: "Dear {{customer.firstName}},\n\nYour service on account {{account.accountNumber}} has been scheduled for disconnection due to an unpaid balance of {{delinquency.balance}}.\n\nTo restore service, please pay the full balance and contact us to schedule reconnection.\n\n{{utility.name}}\n{{utility.email}}",
        },
        sms: { body: "{{customer.firstName}}, your utility service on account {{account.accountNumber}} is being disconnected. Balance: {{delinquency.balance}}. Contact us to resolve." },
      },
      variables: [
        { key: "customer.firstName", label: "Customer first name", sample: "Jane" },
        { key: "account.accountNumber", label: "Account number", sample: "AC-00001" },
        { key: "delinquency.balance", label: "Balance due", sample: "$412.80" },
        { key: "utility.name", label: "Utility name", sample: "Bozeman Utilities" },
        { key: "utility.email", label: "Utility email", sample: "billing@bozeman.gov" },
      ],
    },
    {
      name: "Portal Welcome",
      eventType: "portal.welcome",
      description: "Sent when a customer registers for portal access.",
      channels: {
        email: {
          subject: "Welcome to {{utility.name}} Customer Portal",
          body: "Dear {{customer.firstName}},\n\nYour customer portal account has been created. You can now view your bills, monitor usage, and manage your account online.\n\nLog in: {{portal.loginUrl}}\n\nWelcome aboard!\n{{utility.name}}",
        },
      },
      variables: [
        { key: "customer.firstName", label: "Customer first name", sample: "Jane" },
        { key: "portal.loginUrl", label: "Portal login URL", sample: "https://portal.example.com/login" },
        { key: "utility.name", label: "Utility name", sample: "Bozeman Utilities" },
      ],
    },
    {
      name: "High Usage Alert",
      eventType: "meter.high_usage",
      description: "Sent when consumption exceeds a threshold.",
      channels: {
        email: {
          subject: "High usage alert — {{meter.meterNumber}} at {{premise.addressLine1}}",
          body: "Dear {{customer.firstName}},\n\nWe detected unusually high consumption on meter {{meter.meterNumber}} at {{premise.addressLine1}}, {{premise.city}}.\n\nPlease check for leaks or unexpected usage. View your usage: {{portal.usageUrl}}\n\n{{utility.name}}",
        },
        sms: { body: "{{customer.firstName}}, high usage detected on meter {{meter.meterNumber}} at {{premise.addressLine1}}. Check for leaks. Details: {{portal.usageUrl}}" },
      },
      variables: [
        { key: "customer.firstName", label: "Customer first name", sample: "Jane" },
        { key: "meter.meterNumber", label: "Meter number", sample: "WM-001" },
        { key: "premise.addressLine1", label: "Address", sample: "123 Main St" },
        { key: "premise.city", label: "City", sample: "Bozeman" },
        { key: "portal.usageUrl", label: "Usage URL", sample: "https://portal.example.com/usage" },
        { key: "utility.name", label: "Utility name", sample: "Bozeman Utilities" },
      ],
    },
    {
      name: "Possible Leak Detected",
      eventType: "meter.leak_detected",
      description: "Sent when continuous non-zero usage is detected during off-hours.",
      channels: {
        email: {
          subject: "Possible leak detected at {{premise.addressLine1}}",
          body: "Dear {{customer.firstName}},\n\nMeter {{meter.meterNumber}} at {{premise.addressLine1}} is showing continuous consumption during hours when usage is typically zero. This may indicate a leak.\n\nPlease investigate or contact us for assistance.\n\n{{utility.name}}",
        },
        sms: { body: "{{customer.firstName}}, possible leak detected at {{premise.addressLine1}} (meter {{meter.meterNumber}}). Please investigate." },
      },
      variables: [
        { key: "customer.firstName", label: "Customer first name", sample: "Jane" },
        { key: "meter.meterNumber", label: "Meter number", sample: "WM-001" },
        { key: "premise.addressLine1", label: "Address", sample: "123 Main St" },
        { key: "utility.name", label: "Utility name", sample: "Bozeman Utilities" },
      ],
    },
    {
      name: "Move-In Confirmation",
      eventType: "service.move_in_confirmation",
      description: "Sent after a successful move-in workflow.",
      channels: {
        email: {
          subject: "Service activated at {{premise.addressLine1}} — Account {{account.accountNumber}}",
          body: "Dear {{customer.firstName}},\n\nYour utility service has been activated at {{premise.addressLine1}}, {{premise.city}}, {{premise.state}} {{premise.zip}}.\n\nAccount number: {{account.accountNumber}}\n\nView your account: {{portal.loginUrl}}\n\n{{utility.name}}",
        },
      },
      variables: [
        { key: "customer.firstName", label: "Customer first name", sample: "Jane" },
        { key: "account.accountNumber", label: "Account number", sample: "AC-00001" },
        { key: "premise.addressLine1", label: "Address", sample: "123 Main St" },
        { key: "premise.city", label: "City", sample: "Bozeman" },
        { key: "premise.state", label: "State", sample: "MT" },
        { key: "premise.zip", label: "ZIP", sample: "59715" },
        { key: "portal.loginUrl", label: "Portal URL", sample: "https://portal.example.com/login" },
        { key: "utility.name", label: "Utility name", sample: "Bozeman Utilities" },
      ],
    },
    {
      name: "Move-Out Confirmation",
      eventType: "service.move_out_confirmation",
      description: "Sent after a successful move-out workflow.",
      channels: {
        email: {
          subject: "Service closed at {{premise.addressLine1}} — Final bill pending",
          body: "Dear {{customer.firstName}},\n\nYour utility service at {{premise.addressLine1}} has been closed as of your requested date.\n\nA final bill will be generated and sent to you shortly.\n\nThank you for being a customer.\n{{utility.name}}",
        },
      },
      variables: [
        { key: "customer.firstName", label: "Customer first name", sample: "Jane" },
        { key: "premise.addressLine1", label: "Address", sample: "123 Main St" },
        { key: "utility.name", label: "Utility name", sample: "Bozeman Utilities" },
      ],
    },
    {
      name: "Bill Ready",
      // The event `deliverBill` sends on. Without an active template for
      // it, pressing Send answers 422 rather than reporting success and
      // delivering nothing — see bill-delivery.service.ts.
      eventType: "billing.bill_ready",
      description: "Sent when a posted bill is delivered to the customer.",
      channels: {
        email: {
          subject: "Your {{utility.name}} bill is ready",
          body: "Dear {{customer.firstName}},\n\nYour bill {{billNumber}} is ready. You can view and download it by signing in to the customer portal.\n\nThank you,\n{{utility.name}}",
        },
      },
      variables: [
        { key: "customer.firstName", label: "Customer first name", sample: "Jane" },
        { key: "billNumber", label: "Bill number", sample: "BILL-202610-0001000-00" },
        { key: "utility.name", label: "Utility name", sample: "Bozeman Utilities" },
      ],
    },
  ];
  for (const t of notifTemplates) {
    const existing = await p.notificationTemplate.findUnique({ where: { utilityId_eventType: { utilityId: UID, eventType: t.eventType } } });
    if (!existing) {
      await p.notificationTemplate.create({ data: { utilityId: UID, ...t } });
    }
  }
  console.log("  " + notifTemplates.length + " notification templates");

  // Set balance and lastDueDate on a couple of accounts for delinquency testing
  /*
   * An opening balance is loaded at conversion, so it predates the
   * account's first bill — one month before the oldest seeded one.
   *
   * It used to be 30 and 15 days ago, chosen when these accounts had no
   * bills. Dated inside a billing period it lands in the next bill's
   * fees window and prints under *Fees and adjustments* as though the
   * utility had just charged it: a demo bill for $41.54 of water asking
   * for $489.34, with a $412.80 "adjustment" nobody could explain.
   * Before the first bill it is what it says it is — a balance brought
   * across — and the arrears are old, which is what a conversion looks
   * like.
   */
  const conversionDate = new Date(Date.UTC(
    READ_DAY_UTC.getUTCFullYear(),
    READ_DAY_UTC.getUTCMonth() - 3,
    15,
  ));

  // AR reason codes (module 23 slice 3). Mirrors DEFAULT_REASON_CODES in
  // packages/shared/src/validators/ledger.ts — seed.js runs as plain
  // `node seed.js` and cannot import the TypeScript constant, so the list
  // is duplicated here, the way the module list used to be before the
  // seed started delegating to scripts/provision-tenant.ts.
  // The fourth element is isPenalty: whether an entry citing the reason
  // is itself a penalty, which decides whether a percentage late fee may
  // be charged on that money. The fifth is allowsDelinquencyFee: whether
  // a delinquency tier may book its fee here at all. Only the late-fee
  // reason may — the others answer to their own event (a payment
  // bouncing, a tap being cut) rather than to time passing.
  const reasonCodes = [
    ["LATE_FEE", "Late payment fee", "FEE", true, true],
    ["NSF_FEE", "Returned payment fee", "FEE", true, false],
    ["RECONNECT_FEE", "Reconnection fee", "FEE", false, false],
    ["TAP_FEE", "Tap fee", "FEE", false, false],
    ["METER_TEST_FEE", "Meter test fee", "FEE", false, false],
    ["OPENING_BALANCE", "Opening balance", "ADJUSTMENT_DEBIT", false, false],
    ["BILLING_CORRECTION_DEBIT", "Billing correction — charge", "ADJUSTMENT_DEBIT", false, false],
    ["COURTESY_WAIVER", "Courtesy waiver", "ADJUSTMENT_CREDIT", false, false],
    ["GOODWILL", "Goodwill credit", "ADJUSTMENT_CREDIT", false, false],
    ["BILLING_CORRECTION_CREDIT", "Billing correction — credit", "ADJUSTMENT_CREDIT", false, false],
    ["BAD_DEBT", "Written off — uncollectable", "WRITE_OFF", false, false],
    ["SMALL_BALANCE", "Written off — small balance", "WRITE_OFF", false, false],
  ];
  const reasonByCode = {};
  for (const [code, label, appliesToType, isPenalty, allowsDelinquencyFee] of reasonCodes) {
    const r = await p.ledgerReasonDef.create({
      data: { utilityId: UID, code, label, appliesToType, isPenalty, allowsDelinquencyFee },
    });
    reasonByCode[code] = r.id;
  }
  console.log("  " + reasonCodes.length + " AR reason codes");

  /*
   * Delinquency rules — a 5-tier escalation chain, the first three of
   * which charge money.
   *
   * After the reason codes, not before, because a tier that charges has
   * to name the reason its fee books to and there is no code this
   * codebase could hardcode: reason codes are the tenant's own. Only
   * LATE_FEE carries `allowsDelinquencyFee`, and the API refuses a tier
   * pointed at any other — booking late fees under "Returned payment
   * fee" is a silent accounting error the customer's bill would print.
   *
   * **Both fee modes, so a fresh database shows each.** Tier 1 charges a
   * flat $10 and accumulates. Tier 2 **replaces** it: it reverses what
   * the ladder charged below it on the same bill and raises $25, so the
   * account ends at $25 rather than $35 and the next bill prints the
   * reversal as its own credit line beside the new charge. Tier 3
   * accumulates a percentage on top of whatever stands.
   *
   * ACCUMULATE is the column's default and what every tier did before
   * the mode existed, so configuring a fee changes nobody's bill until
   * someone asks for replacement. Seeding one of each is a demo choice,
   * not a recommendation — a utility whose tariff says fees compound
   * wants ACCUMULATE throughout.
   *
   * Tiers 4 and 5 charge nothing. Being eligible for shut-off is not a
   * billable event; the reconnection fee that follows one is raised when
   * service is actually restored.
   */
  const delinqRules = [
    { name: "Past Due Reminder", tier: 1, daysPastDue: 10, minBalance: 25, actionType: "NOTICE_EMAIL", notificationEventType: "delinquency.tier_1", autoApply: true,
      feeType: "FLAT_FEE", feeAmount: "10.0000", maxFee: null, feeMode: "ACCUMULATE" },
    { name: "Formal Past Due Notice", tier: 2, daysPastDue: 20, minBalance: 25, actionType: "NOTICE_EMAIL", notificationEventType: "delinquency.tier_2", autoApply: true,
      feeType: "FLAT_FEE", feeAmount: "25.0000", maxFee: null, feeMode: "REPLACE_LOWER_TIERS" },
    // The percentage tier, so both fee types exist in a fresh database.
    // 1.5% of what is left of the bill, capped — a cap is only legal on
    // a percentage, and a CHECK refuses it on a flat fee.
    { name: "Shut-Off Warning — 48 Hours", tier: 3, daysPastDue: 30, minBalance: 50, actionType: "NOTICE_SMS", notificationEventType: "delinquency.tier_3", autoApply: true,
      feeType: "PERCENT_OF_BALANCE", feeAmount: "0.0150", maxFee: "50.00", feeMode: "ACCUMULATE" },
    { name: "Shut-Off Eligible", tier: 4, daysPastDue: 35, minBalance: 50, actionType: "SHUT_OFF_ELIGIBLE", notificationEventType: null, autoApply: true,
      feeType: null, feeAmount: null, maxFee: null, feeMode: "ACCUMULATE" },
    { name: "Disconnect", tier: 5, daysPastDue: 37, minBalance: 50, actionType: "DISCONNECT", notificationEventType: "delinquency.tier_4", autoApply: false,
      feeType: null, feeAmount: null, maxFee: null, feeMode: "ACCUMULATE" },
  ];
  const ruleRows = [];
  for (const r of delinqRules) {
    ruleRows.push(
      await p.delinquencyRule.create({
        data: {
          utilityId: UID,
          ...r,
          minBalance: r.minBalance,
          // A tier whose fee has no reason is dead configuration, which
          // a CHECK refuses — so the two arrive together or not at all.
          feeReasonId: r.feeType ? reasonByCode["LATE_FEE"] : null,
          effectiveDate: new Date("2025-01-01"),
        },
      }),
    );
  }
  console.log(
    "  " + delinqRules.length + " delinquency rules (" +
      delinqRules.filter((r) => r.feeType).length + " charging a late fee)",
  );

  // Opening balances come from real ledger entries, not typed-in numbers.
  // GET /api/v1/ar/reconciliation compares account.balance against
  // SUM(ledger_entry.open_amount), so a balance with nothing behind it
  // shows as drift on every fresh seed.
  for (const [acct, amount, dueDate] of [
    [aArr[0], "412.80", conversionDate],
    [aArr[1], "85.50", conversionDate],
  ]) {
    await p.ledgerEntry.create({
      data: {
        utilityId: UID,
        accountId: acct.id,
        type: "ADJUSTMENT_DEBIT",
        amount,
        openAmount: amount,
        dueDate,
        effectiveDate: dueDate,
        // ledger_entry_reason_required (slice 3): a reasoned type must
        // cite a reason or name the bill it came from, and this has no bill.
        reasonId: reasonByCode["OPENING_BALANCE"],
        memo: "Seeded opening balance for delinquency demo",
      },
    });
    await p.account.update({
      where: { id: acct.id },
      data: { balance: amount, lastDueDate: dueDate },
    });
  }
  console.log("  2 accounts with delinquent balances");

  // Deposits are ledger entries now, not a bare column. account.deposit_amount
  // survives as their cache, the way balance caches the receivable, and
  // GET /api/v1/ar/reconciliation proves both -- so a seeded deposit
  // without an entry behind it would show as drift on every fresh seed.
  //
  // Stored as a CREDIT and kept out of `balance`: the utility holds this
  // money, the customer does not owe it. Netting it in would take an
  // account owing $169 against a $500 deposit down to -$330 and hide it
  // from the delinquency sweep, which looks for balance > 0.
  let depositCount = 0;
  for (const acct of aArr) {
    const held = Number(acct.depositAmount ?? 0);
    if (held <= 0) continue;
    await p.ledgerEntry.create({
      data: {
        utilityId: UID,
        accountId: acct.id,
        type: "DEPOSIT",
        amount: (-held).toFixed(2),
        openAmount: (-held).toFixed(2),
        dueDate: null, // a credit has nothing to fall due
        effectiveDate: acct.createdAt ?? new Date(),
        tender: "CHECK",
        memo: "Security deposit taken at account opening",
      },
    });
    depositCount++;
  }
  console.log("  " + depositCount + " security deposits");

  // A late fee and a partial courtesy waiver on the first delinquent
  // account, so the slice 3 acts are visible in a fresh database rather
  // than only reachable by HTTP. Written directly, like the opening
  // balances above and for the same reason: seed.js does not import the
  // TypeScript services. The cache is then set to the figure the ledger
  // implies, so GET /api/v1/ar/reconciliation stays clean.
  const feeDue = new Date();
  feeDue.setDate(feeDue.getDate() + 10);
  const lateFee = await p.ledgerEntry.create({
    data: {
      utilityId: UID,
      accountId: aArr[0].id,
      type: "FEE",
      amount: "15.00",
      openAmount: "10.00", // 5.00 of it waived below
      dueDate: feeDue,
      effectiveDate: new Date(),
      reasonId: reasonByCode["LATE_FEE"],
      memo: "Late payment fee on the seeded opening balance",
    },
  });
  const waiver = await p.ledgerEntry.create({
    data: {
      utilityId: UID,
      accountId: aArr[0].id,
      type: "ADJUSTMENT_CREDIT",
      amount: "-5.00",
      openAmount: "0.00", // fully applied to the fee
      effectiveDate: new Date(),
      reasonId: reasonByCode["COURTESY_WAIVER"],
      memo: "Partial courtesy waiver of the late fee",
    },
  });
  await p.ledgerApplication.create({
    data: { utilityId: UID, creditId: waiver.id, debitId: lateFee.id, amount: "5.00" },
  });
  // 412.80 opening + 10.00 of the fee still open. lastDueDate stays on the
  // opening balance, which is older than the fee.
  await p.account.update({
    where: { id: aArr[0].id },
    data: { balance: "422.80", lastDueDate: conversionDate },
  });
  console.log("  1 late fee, partially waived");


  // Two bills, so both the Bills tab and the AR tab have something real
  // to show and the Post action has something to act on. Written directly
  // rather than generated: going through the rate engine would need
  // meter reads and published schedules lined up for a specific period,
  // which is the bill-creation integration test's job, not the seeder's.
  //
  //   - a POSTED bill on 0001001-00, with its BILL_CHARGE, so the AR tab
  //     shows a charge that names its bill;
  //   - an UNPOSTED bill on 0001002-00, so GET unposted-bills is not
  //     always empty and the operator has something to post.
  const billSaFor = (accountId) => saCreated.find((sa) => sa.accountId === accountId);
  /*
   * The demo bill covers a period that has already been billed and
   * closed — two read-months back, not the most recent one.
   *
   * It used to cover [last month's 16th, this month's 15th], which is
   * the period a run started today would bill: the run's own bill then
   * overlapped it and was refused, and before that the two disagreed
   * about who owned the reads. Leaving the last two reads alone gives a
   * run real work on a period nothing else claims.
   *
   * Two rather than one because a cycle's bill day can precede its read
   * day — R01 bills on the 10th and the meters are read on the 15th, so
   * a run on the 10th closes on the *previous* month's read. Leave only
   * one and that cycle has nothing it is allowed to bill.
   */
  const billPeriodEnd = new Date(Date.UTC(READ_DAY_UTC.getUTCFullYear(), READ_DAY_UTC.getUTCMonth() - 2, 15));
  const billPeriodStart = new Date(Date.UTC(billPeriodEnd.getUTCFullYear(), billPeriodEnd.getUTCMonth() - 1, 16));
  const billDue = new Date(billPeriodEnd);
  billDue.setUTCDate(billDue.getUTCDate() + 30);

  // One segment per service agreement, each with real line items, because
  // that is what a bill actually is: generateBillForAccount aggregates the
  // account's unbilled BillSegments, and the rate engine puts a line on
  // each one per rate component it applied. A bill with one empty segment
  // renders as a total with nothing behind it, which is exactly what the
  // statement view (§7.1) exists to avoid.
  //
  // The amounts are plausible rather than computed: deriving them would
  // mean running the rate engine, which needs meter reads aligned to the
  // period and is the bill-creation integration test's job.
  const componentsBySchedule = {};
  for (const rc of await p.rateComponent.findMany({
    where: { utilityId: UID },
    select: { id: true, rateScheduleId: true, kindCode: true, label: true },
  })) {
    (componentsBySchedule[rc.rateScheduleId] ||= []).push(rc);
  }

  /** The lines one segment gets, keyed off what the schedule actually has. */
  function linesFor(scheduleId, base) {
    const available = componentsBySchedule[scheduleId] ?? [];
    if (available.length === 0) return [];
    // Prefer a fixed charge plus a usage charge, which is the shape of
    // almost every utility bill line set.
    const fixed = available.find((c) => c.kindCode === "service_charge");
    const usage = available.find((c) =>
      ["consumption", "derived_consumption", "item_price", "non_meter"].includes(c.kindCode),
    );
    const picked = [fixed, usage].filter(Boolean);
    if (picked.length === 0) picked.push(available[0]);

    // Split the segment total across the picked components: the fixed part
    // first, the remainder on usage, so the lines sum to the segment.
    const cents = Math.round(base * 100);
    const out = [];
    if (picked.length === 1) {
      out.push({ c: picked[0], cents });
    } else {
      const fixedCents = Math.round(cents * 0.35);
      out.push({ c: picked[0], cents: fixedCents });
      out.push({ c: picked[1], cents: cents - fixedCents });
    }
    return out.map((x, i) => ({
      component: x.c,
      amount: (x.cents / 100).toFixed(4),
      sortOrder: (i + 1) * 100,
    }));
  }

  /** Shared across the seeded bills, since they share a bill date. */
  let seededBillCounter = 0;

  async function seedBill(account, { posted }) {
    const agreements = saCreated.filter((sa) => sa.accountId === account.id);
    if (agreements.length === 0) return null;

    // Build the segments first so the bill's total is the sum of them,
    // rather than a figure the segments are then forced to match.
    const segments = [];
    for (let i = 0; i < agreements.length; i++) {
      const sa = agreements[i];
      const assignment = await p.sAScheduleAssignment.findFirst({
        where: { utilityId: UID, serviceAgreementId: sa.id },
        select: { rateScheduleId: true },
      });
      if (!assignment) continue;
      const base = 32.5 + i * 18.75 + (account.accountNumber.charCodeAt(6) % 7) * 2.25;
      const lines = linesFor(assignment.rateScheduleId, base);
      if (lines.length === 0) continue;
      const total = lines.reduce((t, l) => t + Math.round(parseFloat(l.amount) * 100), 0);
      segments.push({ sa, assignment, lines, cents: total });
    }
    if (segments.length === 0) return null;

    const billCents = segments.reduce((t, sg) => t + sg.cents, 0);
    const billTotal = (billCents / 100).toFixed(4);

    const bill = await p.bill.create({
      data: {
        utilityId: UID,
        accountId: account.id,
        billingCycleId: account.billingCycleId,
        periodStart: billPeriodStart,
        periodEnd: billPeriodEnd,
        billDate: billPeriodEnd,
        dueDate: billDue,
        subtotal: billTotal,
        taxes: "0.0000",
        credits: "0.0000",
        total: billTotal,
        /*
         * The format `nextBillNumber` produces: `BILL-YYYYMM-<counter>`
         * from the bill date, UTC.
         *
         * It used to append the account number, which the application
         * never does — so a fresh database showed two shapes of bill
         * number and nothing said which was real. Spec 23 records that a
         * real number carries neither the account nor the customer, and
         * that bill search was widened past the number because of it;
         * seeding a richer format papered over the very limitation the
         * spec documents.
         *
         * Counted rather than derived, like the real one, so the
         * sequence a reader sees in a seeded database behaves the way a
         * run's would.
         */
        billNumber: `BILL-${billPeriodEnd.getUTCFullYear()}${String(billPeriodEnd.getUTCMonth() + 1).padStart(2, "0")}-${++seededBillCounter}`,
        postedAt: posted ? new Date() : null,
      },
    });

    for (let i = 0; i < segments.length; i++) {
      const sg = segments[i];
      await p.billSegment.create({
        data: {
          utilityId: UID,
          serviceAgreementId: sg.sa.id,
          billId: bill.id,
          periodStart: billPeriodStart,
          periodEnd: billPeriodEnd,
          subtotal: (sg.cents / 100).toFixed(4),
          taxes: "0.0000",
          credits: "0.0000",
          total: (sg.cents / 100).toFixed(4),
          minimumFloorApplied: false,
          segmentNumber: `SEG-${account.accountNumber}-${i + 1}-${billPeriodEnd.getFullYear()}${String(billPeriodEnd.getMonth() + 1).padStart(2, "0")}`,
          lines: {
            create: sg.lines.map((l) => ({
              utilityId: UID,
              label: l.component.label ?? l.component.kindCode,
              kindCode: l.component.kindCode,
              amount: l.amount,
              sourceScheduleId: sg.assignment.rateScheduleId,
              sourceComponentId: l.component.id,
              sortOrder: l.sortOrder,
            })),
          },
        },
      });
    }

    if (posted) {
      // The ledger is Decimal(14,2) and bill.total is Decimal(14,4), so the
      // charge is the total rounded to cents. It MUST be derived from the
      // bill: an amount that disagrees with the bill it names still
      // reconciles, because the balance is the sum of open amounts either
      // way, and nothing would catch it.
      const charge = (billCents / 100).toFixed(2);
      await p.ledgerEntry.create({
        data: {
          utilityId: UID,
          accountId: account.id,
          type: "BILL_CHARGE",
          amount: charge,
          openAmount: charge,
          dueDate: billDue,
          effectiveDate: billPeriodEnd,
          billId: bill.id,
        },
      });
    }
    return bill;
  }

  // Every account that has service gets a bill, so whichever account is
  // opened first has something to show. The last one is left UNPOSTED on
  // purpose: GET unposted-bills must not always be empty, or the Post
  // action has nothing to act on.
  const billableAccounts = aArr.filter((a) => billSaFor(a.id));
  let postedBills = 0;
  let unpostedBills = 0;
  for (let i = 0; i < billableAccounts.length; i++) {
    const account = billableAccounts[i];
    const posted = i < billableAccounts.length - 1;
    const bill = await seedBill(account, { posted });
    if (!bill) continue;
    if (posted) {
      postedBills++;
      // Fold the new receivable into the cached balance. Anything already
      // open on the account stays open, so read it back rather than
      // assuming — two of these accounts carry seeded opening balances.
      const open = await p.ledgerEntry.aggregate({
        // NOT NOT a deposit: `balance` is the receivable. A deposit is
        // money held, and netting it in would hide arrears from the
        // delinquency sweep, which looks for balance > 0.
        where: { utilityId: UID, accountId: account.id, type: { not: "DEPOSIT" } },
        _sum: { openAmount: true },
      });
      const oldest = await p.ledgerEntry.findFirst({
        where: { utilityId: UID, accountId: account.id, openAmount: { gt: 0 }, dueDate: { not: null } },
        orderBy: { dueDate: "asc" },
        select: { dueDate: true },
      });
      await p.account.update({
        where: { id: account.id },
        data: {
          balance: (open._sum.openAmount ?? 0).toString(),
          lastDueDate: oldest?.dueDate ?? null,
        },
      });
    } else {
      unpostedBills++;
    }
  }
  console.log(
    "  " + postedBills + " posted bills with receivables, " + unpostedBills + " unposted"
  );

  /*
   * The reads the demo bills cover are spent, and say so.
   *
   * Billing is one-way: a segment stamps `billed_at` on the reads in its
   * period, and `resolveServicePeriod` starts the next period the day
   * after the last read already billed. The bills above are written
   * straight to the tables rather than rated, so they stamped nothing —
   * and the first genuine run then found twelve months of unbilled reads
   * behind bills that claimed to have covered them. It opened at the
   * agreement's start date and swept the lot into one 21-month segment:
   * on a fresh seed, a $530,257.75 water bill for a single house, over a
   * period two of the demo bills already said was billed.
   *
   * Stamping them here is what makes the seeded history true. The reads
   * after this date are left alone deliberately — they are the work a
   * first run is supposed to find.
   */
  const spent = await p.meterRead.updateMany({
    where: { utilityId: UID, billedAt: null, readDate: { lte: billPeriodEnd } },
    data: { billedAt: billPeriodEnd },
  });
  console.log(
    "  " + spent.count + " reads marked billed through " +
      billPeriodEnd.toISOString().slice(0, 10) +
      " (the rest are a run's to find)"
  );

  // Payments, so the Payments screen opens on something real rather than
  // an empty range, and so the AR tab shows a charge that has been part
  // paid. Written directly for the same reason as everything above --
  // seed.js does not import the TypeScript services -- and the cache is
  // recomputed from the ledger afterwards, so Settings -> Ledger
  // Integrity stays clean.
  //
  // Deliberately placed AFTER the bills: a payment wants a real charge to
  // land on, and a PARTIAL one keeps the arithmetic honest. Paying more
  // than a debit holds would drive its open_amount negative, which breaks
  // the §5 invariant rather than modelling an overpayment -- allocation
  // caps each application at what the debit still owes and leaves the
  // excess open on the credit.
  const payTarget = await p.ledgerEntry.findFirst({
    where: { utilityId: UID, type: "BILL_CHARGE", openAmount: { gt: 20 } },
    orderBy: { effectiveDate: "asc" },
  });
  if (payTarget) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    // Half the charge, to the cent, so something stays owed on it.
    const owed = Number(payTarget.openAmount);
    const paid = (Math.round(owed * 50) / 100).toFixed(2);

    const payment = await p.ledgerEntry.create({
      data: {
        utilityId: UID,
        accountId: payTarget.accountId,
        type: "PAYMENT",
        amount: "-" + paid,
        openAmount: "0.00", // fully applied to the charge below
        dueDate: null, // a credit has nothing to fall due
        effectiveDate: sevenDaysAgo,
        tender: "CHECK",
        externalRef: "CHQ-100417",
        memo: "Seeded counter payment",
      },
    });
    await p.ledgerApplication.create({
      data: { utilityId: UID, creditId: payment.id, debitId: payTarget.id, amount: paid },
    });
    await p.ledgerEntry.update({
      where: { id: payTarget.id },
      data: { openAmount: (owed - Number(paid)).toFixed(2) },
    });

    // And one that bounced, so the reversed state is visible on the
    // Payments screen. Modelled as received and returned before
    // allocation touched it: the reversal consumes the payment in full,
    // both open amounts land on zero, and the balance is therefore
    // unmoved -- which is what an NSF on an unallocated payment does.
    const bounced = await p.ledgerEntry.create({
      data: {
        utilityId: UID,
        accountId: payTarget.accountId,
        type: "PAYMENT",
        amount: "-50.00",
        openAmount: "0.00", // consumed by its reversal
        dueDate: null,
        effectiveDate: threeDaysAgo,
        tender: "CHECK",
        externalRef: "CHQ-100418",
        memo: "Seeded payment, returned unpaid",
      },
    });
    const nsf = await p.ledgerEntry.create({
      data: {
        utilityId: UID,
        accountId: payTarget.accountId,
        type: "REVERSAL",
        amount: "50.00",
        openAmount: "0.00", // settled against the payment it reverses
        dueDate: null,
        effectiveDate: new Date(),
        reversesId: bounced.id,
        memo: "Returned unpaid (NSF)",
      },
    });
    await p.ledgerApplication.create({
      data: { utilityId: UID, creditId: bounced.id, debitId: nsf.id, amount: "50.00" },
    });

    // Recompute from the ledger rather than adjusting by hand, exactly as
    // the posting path does.
    const open = await p.ledgerEntry.aggregate({
      // Excludes deposits, for the same reason as the bills loop above.
      where: { utilityId: UID, accountId: payTarget.accountId, type: { not: "DEPOSIT" } },
      _sum: { openAmount: true },
    });
    const oldest = await p.ledgerEntry.findFirst({
      where: { utilityId: UID, accountId: payTarget.accountId, openAmount: { gt: 0 }, dueDate: { not: null } },
      orderBy: { dueDate: "asc" },
      select: { dueDate: true },
    });
    await p.account.update({
      where: { id: payTarget.accountId },
      data: {
        balance: (open._sum.openAmount ?? 0).toString(),
        lastDueDate: oldest?.dueDate ?? null,
      },
    });
    console.log("  2 payments (one part-paying a bill, one reversed NSF)");
  }

  /*
   * The late-fee ladder, already run on the oldest unpaid bill.
   *
   * Last, after the bills and the payments, because it reads the open
   * overdue charge they leave behind and writes the account's balance
   * cache from the finished ledger.
   *
   * `aArr[0]` because it owns SA-0001, the one agreement with twelve
   * months of reads — so a billing run can actually produce its next
   * bill, which is where these fees print.
   */
  const ladder = await seedDelinquencyLadder({
    p,
    utilityId: UID,
    accountId: aArr[0].id,
    rules: ruleRows,
  });
  if (ladder.skipped) {
    console.log("  [skip] late-fee ladder: " + ladder.skipped);
  } else {
    console.log(
      "  " + ladder.raised.length + " late fees on bill " + ladder.billNumber +
        " (account " + ladder.accountNumber + ", due " +
        ladder.dueDate.toISOString().slice(0, 10) + "): " +
        ladder.raised.map((f) => "tier " + f.tier + " $" + f.amount).join(", "),
    );
    console.log(
      "       they print on the next bill for this cycle, dated " +
        ladder.printsOnBillDated.toISOString().slice(0, 10) +
        " — run Billing > Billing Runs for cycle R01",
    );
  }

  const testUsers = [
    { id: "00000000-0000-4000-8000-000000000091", email: "sysadmin@utility.com", name: "Sarah Mitchell", roleIdx: 0 },
    { id: "00000000-0000-4000-8000-000000000092", email: "admin@utility.com", name: "Michael Chen", roleIdx: 1 },
    { id: "00000000-0000-4000-8000-000000000093", email: "csr@utility.com", name: "Jessica Rodriguez", roleIdx: 2 },
    { id: "00000000-0000-4000-8000-000000000094", email: "tech@utility.com", name: "David Park", roleIdx: 3 },
    { id: "00000000-0000-4000-8000-000000000095", email: "viewer@utility.com", name: "Emily Thompson", roleIdx: 4 },
  ];
  for (const u of testUsers) {
    await p.cisUser.create({
      data: { id: u.id, utilityId: UID, email: u.email, name: u.name, isActive: true },
    });
    await p.userRole.create({
      data: { utilityId: UID, userId: u.id, accountId: null, roleId: roleArr[u.roleIdx].id },
    });
  }
  console.log("  " + testUsers.length + " test users (admin)");

  /*
   * A payment plan the demo account is keeping to, so slice 1's two
   * screens can be opened on a fresh database. After the test users,
   * because `payment_plan.approved_by` is a real key to `cis_user` —
   * a plan with no record of who agreed it is what the audit
   * discipline here exists to prevent. Attributed to the CSR, who is
   * who agrees one at the counter.
   */
  const plan = await seedPaymentPlan({
    p,
    utilityId: UID,
    accountId: aArr[0].id,
    approvedBy: testUsers[2].id,
  });
  if (plan.skipped) {
    console.log("  [skip] payment plan: " + plan.skipped);
  } else {
    console.log(
      "  payment plan on account " + aArr[0].accountNumber + ": $" +
        plan.totalBalance + " over " + plan.installmentCount +
        " monthly payments of $" + plan.installmentAmount +
        ", $" + plan.downPayment + " down (paid)",
    );
    console.log("       covering " + plan.covered.join(", "));
  }

  const portalUsers = [
    { id: "00000000-0000-4000-8000-0000000000a1", email: "jane.smith@example.com", name: "Jane Smith", customerIdx: 0 },
    { id: "00000000-0000-4000-8000-0000000000a2", email: "robert.j@example.com", name: "Robert Johnson", customerIdx: 1 },
  ];
  for (const pu of portalUsers) {
    await p.cisUser.create({
      data: {
        id: pu.id,
        utilityId: UID,
        email: pu.email,
        name: pu.name,
        customerId: cArr[pu.customerIdx].id,
        isActive: true,
      },
    });
    await p.userRole.create({
      data: {
        utilityId: UID,
        userId: pu.id,
        accountId: null,
        roleId: roleArr[5].id,
      },
    });
  }
  console.log("  " + portalUsers.length + " portal customer users");

  // --- Service Request Type Definitions (globals — utility_id null) ---
  const srTypes = [
    { code: "LEAK_REPORT",      label: "Leak report",        sortOrder: 10 },
    { code: "DISCONNECT",       label: "Service disconnect", sortOrder: 20 },
    { code: "RECONNECT",        label: "Service reconnect",  sortOrder: 30 },
    { code: "START_SERVICE",    label: "Start service",      sortOrder: 40 },
    { code: "STOP_SERVICE",     label: "Stop service",       sortOrder: 50 },
    { code: "BILLING_DISPUTE",  label: "Billing dispute",    sortOrder: 60 },
    { code: "METER_ISSUE",      label: "Meter issue",        sortOrder: 70 },
    { code: "OTHER",            label: "Other",              sortOrder: 900 },
  ];
  for (const t of srTypes) {
    await p.serviceRequestTypeDef.create({ data: { utilityId: null, ...t } });
  }
  console.log("  " + srTypes.length + " service request type-defs (global)");

  // --- SLAs for the dev tenant ---
  const slaRows = [
    { requestType: "LEAK_REPORT",     priority: "EMERGENCY", responseHours: 0.5, resolutionHours: 6 },
    { requestType: "LEAK_REPORT",     priority: "HIGH",      responseHours: 2,   resolutionHours: 12 },
    { requestType: "LEAK_REPORT",     priority: "NORMAL",    responseHours: 4,   resolutionHours: 24 },
    { requestType: "LEAK_REPORT",     priority: "LOW",       responseHours: 24,  resolutionHours: 72 },
    { requestType: "DISCONNECT",      priority: "HIGH",      responseHours: 2,   resolutionHours: 8 },
    { requestType: "DISCONNECT",      priority: "NORMAL",    responseHours: 4,   resolutionHours: 24 },
    { requestType: "DISCONNECT",      priority: "LOW",       responseHours: 24,  resolutionHours: 48 },
    { requestType: "BILLING_DISPUTE", priority: "NORMAL",    responseHours: 8,   resolutionHours: 72 },
  ];
  for (const s of slaRows) {
    await p.sla.create({ data: { utilityId: UID, ...s } });
  }
  console.log("  " + slaRows.length + " SLAs");

  const [acc1, acc2] = aArr.slice(0, 2);
  // SA no longer holds premiseId — fetch it through the first ServicePoint.
  const sr1Sa = await p.serviceAgreement.findFirst({
    where: { accountId: acc1.id },
    include: { servicePoints: { take: 1, select: { premiseId: true } } },
  });
  const sr2Sa = await p.serviceAgreement.findFirst({
    where: { accountId: acc2.id },
    include: { servicePoints: { take: 1, select: { premiseId: true } } },
  });
  const sr1Premise = { premiseId: sr1Sa?.servicePoints[0]?.premiseId ?? null };
  const sr2Premise = { premiseId: sr2Sa?.servicePoints[0]?.premiseId ?? null };
  const now = new Date();
  const hoursAgo = (h) => new Date(now.getTime() - h * 60 * 60 * 1000);

  const sla1 = await p.sla.findFirst({ where: { utilityId: UID, requestType: "LEAK_REPORT", priority: "EMERGENCY" } });
  await p.serviceRequest.create({
    data: {
      utilityId: UID,
      requestNumber: "SR-2026-000001",
      accountId: acc1.id,
      premiseId: sr1Premise?.premiseId ?? null,
      requestType: "LEAK_REPORT",
      priority: "EMERGENCY",
      status: "IN_PROGRESS",
      source: "CSR",
      description: "Water pooling near sidewalk, suspected main line.",
      slaId: sla1?.id ?? null,
      slaDueAt: sla1 ? new Date(hoursAgo(10).getTime() + Number(sla1.resolutionHours) * 60 * 60 * 1000) : null,
      createdAt: hoursAgo(10),
    },
  });

  const sla2 = await p.sla.findFirst({ where: { utilityId: UID, requestType: "DISCONNECT", priority: "NORMAL" } });
  await p.serviceRequest.create({
    data: {
      utilityId: UID,
      requestNumber: "SR-2026-000002",
      accountId: acc2.id,
      premiseId: sr2Premise?.premiseId ?? null,
      requestType: "DISCONNECT",
      priority: "NORMAL",
      status: "NEW",
      source: "CSR",
      description: "Customer requested disconnect after move-out.",
      slaId: sla2?.id ?? null,
      slaDueAt: sla2 ? new Date(now.getTime() + Number(sla2.resolutionHours) * 60 * 60 * 1000) : null,
    },
  });

  await p.serviceRequest.create({
    data: {
      utilityId: UID,
      requestNumber: "SR-2026-000003",
      accountId: acc1.id,
      requestType: "METER_ISSUE",
      priority: "LOW",
      status: "COMPLETED",
      source: "CSR",
      description: "Reported stuck register; tested and cleared.",
      resolutionNotes: "Register reseated, reads normal.",
      completedAt: hoursAgo(48),
      createdAt: hoursAgo(72),
    },
  });
  console.log("  3 demo service requests");

  await p.serviceRequestCounter.upsert({
    where: { utilityId_year: { utilityId: UID, year: 2026 } },
    create: { utilityId: UID, year: 2026, nextValue: 4n },
    update: { nextValue: 4n },
  });

  console.log("\nDone! 10 premises, 8 accounts, 15 meters, " + saData.length + " agreements, " + assignmentCount + " assignments, 3 customers");
}

main().catch(e => { console.error("SEED ERROR:", e); process.exit(1); }).finally(() => p.$disconnect());
