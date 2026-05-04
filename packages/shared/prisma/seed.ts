import { PrismaClient } from "../src/generated/prisma";

const prisma = new PrismaClient();

const UTILITY_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Slice 1 task 10 — v2 rate model seed.
 *
 * Idempotent: every entity check uses upsert / findFirst-then-create so
 * re-running the seed never duplicates rows. The full dev-data seed
 * (with users, customers, SRs, SLAs, etc.) lives in `seed.js` at the
 * repo root and is the canonical fixture for `seed_db.bat`. This script
 * is the Prisma-native variant invoked by `pnpm tsx prisma/seed.ts`,
 * and it focuses on the rate-v2 graph: commodities, classes, indices,
 * schedules + components, SAs wired to schedules via assignments, plus
 * the container / premise attributes needed for rate evaluation.
 */
async function main() {
  console.log("Seeding (v2 rate model)...");

  // Bypass RLS for seeding
  await prisma.$executeRawUnsafe(`SET app.current_utility_id = '${UTILITY_ID}'`);

  // ============ COMMODITIES ============
  const water = await prisma.commodity.upsert({
    where: { utilityId_code: { utilityId: UTILITY_ID, code: "WATER" } },
    update: {},
    create: { utilityId: UTILITY_ID, code: "WATER", name: "Potable Water", displayOrder: 1 },
  });
  const electric = await prisma.commodity.upsert({
    where: { utilityId_code: { utilityId: UTILITY_ID, code: "ELECTRIC" } },
    update: {},
    create: { utilityId: UTILITY_ID, code: "ELECTRIC", name: "Electricity", displayOrder: 2 },
  });
  const gas = await prisma.commodity.upsert({
    where: { utilityId_code: { utilityId: UTILITY_ID, code: "GAS" } },
    update: {},
    create: { utilityId: UTILITY_ID, code: "GAS", name: "Natural Gas", displayOrder: 3 },
  });
  const sewer = await prisma.commodity.upsert({
    where: { utilityId_code: { utilityId: UTILITY_ID, code: "SEWER" } },
    update: {},
    create: { utilityId: UTILITY_ID, code: "SEWER", name: "Sewer", displayOrder: 4 },
  });
  const stormwater = await prisma.commodity.upsert({
    where: { utilityId_code: { utilityId: UTILITY_ID, code: "STORMWATER" } },
    update: {},
    create: { utilityId: UTILITY_ID, code: "STORMWATER", name: "Stormwater", displayOrder: 5 },
  });
  const solidWaste = await prisma.commodity.upsert({
    where: { utilityId_code: { utilityId: UTILITY_ID, code: "SOLID_WASTE" } },
    update: {},
    create: { utilityId: UTILITY_ID, code: "SOLID_WASTE", name: "Solid Waste", displayOrder: 6 },
  });
  console.log("  6 commodities");

  // ============ MEASURE TYPES (seeded by migration; lookup) ============
  const measureUsage = await prisma.measureTypeDef.findFirstOrThrow({
    where: { code: "USAGE", utilityId: null },
  });

  // ============ UNITS OF MEASURE ============
  const gal = await prisma.unitOfMeasure.upsert({
    where: { utilityId_commodityId_code: { utilityId: UTILITY_ID, commodityId: water.id, code: "GAL" } },
    update: {},
    create: {
      utilityId: UTILITY_ID, code: "GAL", name: "Gallons",
      commodityId: water.id, measureTypeId: measureUsage.id,
      conversionFactor: 1, isBaseUnit: true, isActive: true,
    },
  });
  const kwh = await prisma.unitOfMeasure.upsert({
    where: { utilityId_commodityId_code: { utilityId: UTILITY_ID, commodityId: electric.id, code: "KWH" } },
    update: {},
    create: {
      utilityId: UTILITY_ID, code: "KWH", name: "Kilowatt Hours",
      commodityId: electric.id, measureTypeId: measureUsage.id,
      conversionFactor: 1, isBaseUnit: true, isActive: true,
    },
  });
  const mcf = await prisma.unitOfMeasure.upsert({
    where: { utilityId_commodityId_code: { utilityId: UTILITY_ID, commodityId: gas.id, code: "MCF" } },
    update: {},
    create: {
      utilityId: UTILITY_ID, code: "MCF", name: "Thousand Cubic Feet",
      commodityId: gas.id, measureTypeId: measureUsage.id,
      conversionFactor: 1, isBaseUnit: true, isActive: true,
    },
  });
  const sewerUom = await prisma.unitOfMeasure.upsert({
    where: { utilityId_commodityId_code: { utilityId: UTILITY_ID, commodityId: sewer.id, code: "GAL" } },
    update: {},
    create: {
      utilityId: UTILITY_ID, code: "GAL", name: "Gallons",
      commodityId: sewer.id, measureTypeId: measureUsage.id,
      conversionFactor: 1, isBaseUnit: true, isActive: true,
    },
  });

  await prisma.commodity.update({ where: { id: water.id }, data: { defaultUomId: gal.id } });
  await prisma.commodity.update({ where: { id: electric.id }, data: { defaultUomId: kwh.id } });
  await prisma.commodity.update({ where: { id: gas.id }, data: { defaultUomId: mcf.id } });
  await prisma.commodity.update({ where: { id: sewer.id }, data: { defaultUomId: sewerUom.id } });
  console.log("  4 units of measure");

  // ============ BILLING CYCLES ============
  const cycle1 = await prisma.billingCycle.upsert({
    where: { utilityId_cycleCode: { utilityId: UTILITY_ID, cycleCode: "R01" } },
    update: {},
    create: { utilityId: UTILITY_ID, name: "Route 1 — North District", cycleCode: "R01", readDayOfMonth: 5, billDayOfMonth: 10, frequency: "MONTHLY" },
  });
  const cycle2 = await prisma.billingCycle.upsert({
    where: { utilityId_cycleCode: { utilityId: UTILITY_ID, cycleCode: "R02" } },
    update: {},
    create: { utilityId: UTILITY_ID, name: "Route 2 — South District", cycleCode: "R02", readDayOfMonth: 12, billDayOfMonth: 17, frequency: "MONTHLY" },
  });
  console.log("  2 billing cycles");

  // ============ RATE SERVICE CLASSES (v2 — slice 1 task 10) ============
  // Per-commodity classes used by SAs and by RateComponent predicates
  // (`{ class: "single_family" }`).
  const classDefs: Array<{ commodity: { id: string; code: string }, codes: Array<[string, string]> }> = [
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
  const classMap: Record<string, Record<string, { id: string }>> = {};
  let classCount = 0;
  for (const grp of classDefs) {
    classMap[grp.commodity.code] = {};
    let order = 10;
    for (const [code, label] of grp.codes) {
      const c = await prisma.rateServiceClass.upsert({
        where: { utilityId_commodityId_code: { utilityId: UTILITY_ID, commodityId: grp.commodity.id, code } },
        update: {},
        create: { utilityId: UTILITY_ID, commodityId: grp.commodity.id, code, label, sortOrder: order, isActive: true },
      });
      classMap[grp.commodity.code][code] = c;
      order += 10;
      classCount++;
    }
  }
  console.log(`  ${classCount} rate service classes`);

  // ============ RATE INDICES ============
  for (const ix of [
    { name: "fac",                period: "2026-Q2",      value: 0.00125, effectiveDate: new Date("2026-04-01") },
    { name: "epcc",               period: "2026-current", value: 0.00050, effectiveDate: new Date("2026-01-01") },
    { name: "supply_residential", period: "2026-Q2",      value: 0.07000, effectiveDate: new Date("2026-04-01") },
  ]) {
    await prisma.rateIndex.upsert({
      where: { utilityId_name_period: { utilityId: UTILITY_ID, name: ix.name, period: ix.period } },
      update: {},
      create: { utilityId: UTILITY_ID, ...ix },
    });
  }
  console.log("  3 rate indices");

  // ============ RATE SCHEDULES + COMPONENTS ============
  const SLICE1_EFF = new Date("2025-09-15");

  // Helper: upsert a schedule, then (if the components table is empty
  // for that schedule) seed its components. Re-runs leave existing
  // schedules + components intact.
  async function seedSchedule(args: {
    code: string; name: string; commodityId: string; effectiveDate: Date;
    description: string; regulatoryRef: string;
    components: Array<{
      kindCode: string; label: string; sortOrder: number; effectiveDate: Date;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      predicate: any; quantitySource: any; pricing: any;
    }>;
  }) {
    const existing = await prisma.rateSchedule.findFirst({
      where: { utilityId: UTILITY_ID, code: args.code, version: 1 },
    });
    const sched = existing ?? await prisma.rateSchedule.create({
      data: {
        utilityId: UTILITY_ID,
        name: args.name, code: args.code, commodityId: args.commodityId,
        effectiveDate: args.effectiveDate,
        description: args.description, regulatoryRef: args.regulatoryRef,
        version: 1,
      },
    });
    const componentCount = await prisma.rateComponent.count({
      where: { rateScheduleId: sched.id },
    });
    if (componentCount === 0) {
      await prisma.rateComponent.createMany({
        data: args.components.map((c) => ({
          utilityId: UTILITY_ID, rateScheduleId: sched.id, ...c,
        })),
      });
    }
    return sched;
  }

  // ---- Bozeman Water 2025-09 ----
  const rsW = await seedSchedule({
    code: "BZN-WATER", name: "Bozeman Water 2025-09", commodityId: water.id,
    effectiveDate: SLICE1_EFF,
    description: "City of Bozeman water tariff effective 2025-09-15",
    regulatoryRef: "Resolution 5378",
    components: [
      { kindCode: "service_charge", label: "Water Service Charge",
        sortOrder: 10, effectiveDate: SLICE1_EFF,
        predicate: {}, quantitySource: { base: "fixed" },
        pricing: { type: "lookup", by: "meter_size", table: {
          '5/8"': 22.31, '1"': 29.56, '1.5"': 46.52, '2"': 67.64,
          '3"': 116.92, '4"': 187.50, '6"': 349.42, '8"': 552.48,
        }},
      },
      { kindCode: "consumption", label: "Water Usage — Single Family",
        sortOrder: 20, effectiveDate: SLICE1_EFF,
        predicate: { class: "single_family" },
        quantitySource: { base: "metered" },
        pricing: { type: "tiered", tiers: [
          { to: 6, rate: 3.31 }, { to: 25, rate: 4.58 },
          { to: 55, rate: 6.39 }, { to: null, rate: 9.58 },
        ]},
      },
      { kindCode: "consumption", label: "Water Usage — Multi-Family",
        sortOrder: 21, effectiveDate: SLICE1_EFF,
        predicate: { class: "multi_family" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 3.01, unit: "HCF" },
      },
      { kindCode: "consumption", label: "Water Usage — Government",
        sortOrder: 22, effectiveDate: SLICE1_EFF,
        predicate: { class: "government" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 5.74, unit: "HCF" },
      },
      { kindCode: "consumption", label: "Water Usage — MSU",
        sortOrder: 23, effectiveDate: SLICE1_EFF,
        predicate: { class: "msu" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 3.77, unit: "HCF" },
      },
      { kindCode: "consumption", label: "Water Usage — Commercial",
        sortOrder: 24, effectiveDate: SLICE1_EFF,
        predicate: { class: "commercial" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 3.40, unit: "HCF" },
      },
      { kindCode: "minimum_bill", label: "Water Minimum Bill",
        sortOrder: 90, effectiveDate: SLICE1_EFF,
        predicate: { class: "single_family" },
        quantitySource: { base: "fixed" },
        pricing: { type: "floor", amount: 6.62, applies_to_subtotal: true },
      },
      { kindCode: "surcharge", label: "Drought Reserve",
        sortOrder: 80, effectiveDate: SLICE1_EFF,
        predicate: { drought_stage_active: true },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 0.11, unit: "HCF" },
      },
      { kindCode: "surcharge", label: "Drought Stage Surcharge",
        sortOrder: 81, effectiveDate: SLICE1_EFF,
        predicate: { drought_stage_active: true },
        quantitySource: { base: "metered" },
        pricing: { type: "percent_of", selector: { kind: "consumption" }, percent: 25 },
      },
    ],
  });

  // ---- Bozeman Sewer 2025-09 ----
  const rsS = await seedSchedule({
    code: "BZN-SEWER", name: "Bozeman Sewer 2025-09", commodityId: sewer.id,
    effectiveDate: SLICE1_EFF,
    description: "City of Bozeman wastewater tariff effective 2025-09-15",
    regulatoryRef: "Resolution 5378",
    components: [
      { kindCode: "service_charge", label: "Sewer Service Charge — Residential",
        sortOrder: 10, effectiveDate: SLICE1_EFF,
        predicate: { class: "residential" },
        quantitySource: { base: "fixed" },
        pricing: { type: "flat", rate: 24.65, unit: "MONTH" },
      },
      { kindCode: "service_charge", label: "Sewer Service Charge — Mid Class Group",
        sortOrder: 11, effectiveDate: SLICE1_EFF,
        predicate: { class_in: ["multi_family", "commercial", "government", "msu"] },
        quantitySource: { base: "fixed" },
        pricing: { type: "flat", rate: 25.26, unit: "MONTH" },
      },
      { kindCode: "service_charge", label: "Sewer Service Charge — Industrial",
        sortOrder: 12, effectiveDate: SLICE1_EFF,
        predicate: { class: "industrial" },
        quantitySource: { base: "fixed" },
        pricing: { type: "flat", rate: 49.06, unit: "MONTH" },
      },
      { kindCode: "derived_consumption", label: "Sewer Usage — Residential (WQA)",
        sortOrder: 20, effectiveDate: SLICE1_EFF,
        predicate: { class: "residential" },
        quantitySource: { base: "wqa" },
        pricing: { type: "flat", rate: 4.12, unit: "HCF" },
      },
      { kindCode: "derived_consumption", label: "Sewer Usage — Multi-Family (WQA)",
        sortOrder: 21, effectiveDate: SLICE1_EFF,
        predicate: { class: "multi_family" },
        quantitySource: { base: "wqa" },
        pricing: { type: "flat", rate: 4.58, unit: "HCF" },
      },
      { kindCode: "derived_consumption", label: "Sewer Usage — Commercial",
        sortOrder: 22, effectiveDate: SLICE1_EFF,
        predicate: { class: "commercial" },
        quantitySource: { base: "linked_commodity" },
        pricing: { type: "flat", rate: 5.13, unit: "HCF" },
      },
      { kindCode: "derived_consumption", label: "Sewer Usage — Government",
        sortOrder: 23, effectiveDate: SLICE1_EFF,
        predicate: { class: "government" },
        quantitySource: { base: "linked_commodity" },
        pricing: { type: "flat", rate: 4.95, unit: "HCF" },
      },
      { kindCode: "derived_consumption", label: "Sewer Usage — MSU",
        sortOrder: 24, effectiveDate: SLICE1_EFF,
        predicate: { class: "msu" },
        quantitySource: { base: "linked_commodity" },
        pricing: { type: "flat", rate: 5.34, unit: "HCF" },
      },
      { kindCode: "derived_consumption", label: "Sewer Usage — Industrial",
        sortOrder: 25, effectiveDate: SLICE1_EFF,
        predicate: { class: "industrial" },
        quantitySource: { base: "linked_commodity" },
        pricing: { type: "flat", rate: 7.79, unit: "HCF" },
      },
    ],
  });

  // ---- Bozeman Stormwater 2025-09 ----
  const rsSW = await seedSchedule({
    code: "BZN-STORMWATER", name: "Bozeman Stormwater 2025-09", commodityId: stormwater.id,
    effectiveDate: SLICE1_EFF,
    description: "City of Bozeman stormwater tariff effective 2025-09-15",
    regulatoryRef: "Resolution 5378",
    components: [
      { kindCode: "service_charge", label: "Stormwater Flat Charge",
        sortOrder: 10, effectiveDate: SLICE1_EFF,
        predicate: {},
        quantitySource: { base: "fixed" },
        pricing: { type: "flat", rate: 4.81, unit: "MONTH" },
      },
      { kindCode: "non_meter", label: "Stormwater Per-ERU Variable",
        sortOrder: 20, effectiveDate: SLICE1_EFF,
        predicate: {},
        quantitySource: { base: "premise_attribute", source_attr: "premise.eru_count" },
        pricing: { type: "per_unit", rate: 3.99, unit: "ERU" },
      },
      { kindCode: "credit", label: "Stormwater Infrastructure Credit",
        sortOrder: 30, effectiveDate: SLICE1_EFF,
        predicate: { premise_attr: { attr: "has_stormwater_infra", eq: true } },
        quantitySource: { base: "fixed" },
        pricing: { type: "percent_of", selector: { kind: "non_meter" }, percent: -45 },
      },
    ],
  });

  // ---- Bozeman Solid Waste 2025-09 ----
  const rsSolid = await seedSchedule({
    code: "BZN-SOLID-WASTE", name: "Bozeman Solid Waste 2025-09", commodityId: solidWaste.id,
    effectiveDate: SLICE1_EFF,
    description: "City of Bozeman solid waste tariff effective 2025-09-15",
    regulatoryRef: "Resolution 5378",
    components: [
      { kindCode: "item_price", label: "Garbage Cart",
        sortOrder: 10, effectiveDate: SLICE1_EFF,
        predicate: {},
        quantitySource: { base: "item_count" },
        pricing: { type: "catalog", by: ["size", "frequency"], table: {
          "35|weekly":  18.96,  "45|weekly":  18.96,  "45|monthly": 14.11,
          "65|weekly":  27.24,  "100|weekly": 34.91,  "220|weekly": 58.30,
          "300|weekly": 73.09,  "450|weekly": 105.30,
        }},
      },
      { kindCode: "item_price", label: "Recycling Cart",
        sortOrder: 20, effectiveDate: SLICE1_EFF,
        predicate: {},
        quantitySource: { base: "item_count" },
        pricing: { type: "catalog", by: ["size"], table: {
          "65": 12.96, "100": 12.96, "300": 20.17,
        }},
      },
      { kindCode: "item_price", label: "Organics Cart",
        sortOrder: 30, effectiveDate: SLICE1_EFF,
        predicate: {},
        quantitySource: { base: "item_count" },
        pricing: { type: "catalog", by: ["size"], table: {
          "35": 12.00, "95": 12.00,
        }},
      },
    ],
  });

  // ---- NWE Residential Electric — three schedules ----
  const NWE_EFF = new Date("2026-01-01");
  const rsE_REDS = await seedSchedule({
    code: "NWE-REDS-1", name: "NWE Residential Delivery", commodityId: electric.id,
    effectiveDate: NWE_EFF,
    description: "NWE-style residential delivery (REDS-1)",
    regulatoryRef: "Sched REDS-1",
    components: [
      { kindCode: "service_charge", label: "Residential Delivery Service Charge",
        sortOrder: 10, effectiveDate: NWE_EFF,
        predicate: { class: "residential" },
        quantitySource: { base: "fixed" },
        pricing: { type: "flat", rate: 4.20, unit: "MONTH" },
      },
      { kindCode: "consumption", label: "Residential Delivery Energy",
        sortOrder: 20, effectiveDate: NWE_EFF,
        predicate: { class: "residential" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 0.04125, unit: "kWh" },
      },
      { kindCode: "surcharge", label: "Residential Delivery Tax",
        sortOrder: 30, effectiveDate: NWE_EFF,
        predicate: { class: "residential" },
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 0.0117650, unit: "kWh" },
      },
    ],
  });
  const rsE_ESS = await seedSchedule({
    code: "NWE-ESS-1", name: "NWE Default Supply", commodityId: electric.id,
    effectiveDate: NWE_EFF,
    description: "NWE-style default supply (ESS-1) — indexed quarterly",
    regulatoryRef: "Sched ESS-1",
    components: [
      { kindCode: "consumption", label: "Default Supply — Indexed Quarterly",
        sortOrder: 10, effectiveDate: NWE_EFF,
        predicate: { class: "residential" },
        quantitySource: { base: "metered" },
        pricing: { type: "indexed", index_name: "supply_residential",
          period_resolver: "current_quarter", multiplier: 1, unit: "kWh" },
      },
    ],
  });
  const rsE_USBC = await seedSchedule({
    code: "NWE-USBC-1", name: "NWE USBC", commodityId: electric.id,
    effectiveDate: NWE_EFF,
    description: "NWE-style universal system benefits charge",
    regulatoryRef: "Sched USBC",
    components: [
      { kindCode: "surcharge", label: "Universal System Benefits Charge",
        sortOrder: 10, effectiveDate: NWE_EFF,
        predicate: {},
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 0.0024, unit: "kWh" },
      },
    ],
  });
  console.log("  7 rate schedules + components");

  // ============ PREMISES ============
  // Idempotent: keyed on (utility_id, address_line1).
  const premises: Array<{
    addressLine1: string; city: string; state: string; zip: string;
    geoLat: number; geoLng: number;
    premiseType: string;
    commodityIds: string[];
    eruCount?: number;
    hasStormwaterInfra?: boolean;
  }> = [
    { addressLine1: "742 Evergreen Terrace", city: "Springfield", state: "IL", zip: "62704", geoLat: 39.7817, geoLng: -89.6501, premiseType: "RESIDENTIAL", commodityIds: [water.id, sewer.id, stormwater.id, solidWaste.id], eruCount: 1, hasStormwaterInfra: true },
    { addressLine1: "1600 Pennsylvania Ave NW", city: "Washington", state: "DC", zip: "20500", geoLat: 38.8977, geoLng: -77.0365, premiseType: "COMMERCIAL", commodityIds: [water.id, electric.id, gas.id], eruCount: 6 },
    { addressLine1: "221B Baker Street", city: "London", state: "NY", zip: "10001", geoLat: 40.7484, geoLng: -73.9856, premiseType: "RESIDENTIAL", commodityIds: [electric.id, gas.id], eruCount: 1 },
    { addressLine1: "350 Fifth Avenue", city: "New York", state: "NY", zip: "10118", geoLat: 40.7484, geoLng: -73.9857, premiseType: "INDUSTRIAL", commodityIds: [water.id, electric.id, sewer.id], eruCount: 12 },
    { addressLine1: "1060 W Addison St", city: "Chicago", state: "IL", zip: "60613", geoLat: 41.9484, geoLng: -87.6553, premiseType: "COMMERCIAL", commodityIds: [water.id, electric.id], eruCount: 4 },
    { addressLine1: "4059 Mt Lee Dr", city: "Los Angeles", state: "CA", zip: "90068", geoLat: 34.1341, geoLng: -118.3215, premiseType: "RESIDENTIAL", commodityIds: [water.id, electric.id, sewer.id, solidWaste.id], eruCount: 1, hasStormwaterInfra: true },
  ];
  const createdPremises: { id: string }[] = [];
  for (const p of premises) {
    let pr = await prisma.premise.findFirst({
      where: { utilityId: UTILITY_ID, addressLine1: p.addressLine1 },
    });
    if (!pr) {
      pr = await prisma.premise.create({
        data: { utilityId: UTILITY_ID, ...p, status: "ACTIVE" },
      });
    }
    createdPremises.push(pr);
  }
  console.log(`  ${createdPremises.length} premises (with eru_count + has_stormwater_infra)`);

  // ============ ACCOUNTS ============
  const accountSpecs = [
    { accountNumber: "0001000-00", accountType: "RESIDENTIAL" as const, creditRating: "EXCELLENT" as const },
    { accountNumber: "0001001-00", accountType: "COMMERCIAL" as const, creditRating: "GOOD" as const },
    { accountNumber: "0001002-00", accountType: "RESIDENTIAL" as const, creditRating: "GOOD" as const },
    { accountNumber: "0001003-00", accountType: "INDUSTRIAL" as const, creditRating: "EXCELLENT" as const },
    { accountNumber: "0001004-00", accountType: "COMMERCIAL" as const, creditRating: "FAIR" as const },
    { accountNumber: "0001005-00", accountType: "RESIDENTIAL" as const, creditRating: "GOOD" as const },
  ];
  const createdAccounts: { id: string }[] = [];
  for (const a of accountSpecs) {
    let acct = await prisma.account.findFirst({
      where: { utilityId: UTILITY_ID, accountNumber: a.accountNumber },
    });
    if (!acct) {
      acct = await prisma.account.create({
        data: { utilityId: UTILITY_ID, ...a, status: "ACTIVE", depositAmount: 0 },
      });
    }
    createdAccounts.push(acct);
  }
  console.log(`  ${createdAccounts.length} accounts`);

  // ============ METERS ============
  const meterSpecs = [
    { premiseIdx: 0, meterNumber: "WM-001", commodityId: water.id, uomId: gal.id },
    { premiseIdx: 0, meterNumber: "SM-001", commodityId: sewer.id, uomId: sewerUom.id },
    { premiseIdx: 1, meterNumber: "WM-002", commodityId: water.id, uomId: gal.id },
    { premiseIdx: 1, meterNumber: "EM-001", commodityId: electric.id, uomId: kwh.id },
    { premiseIdx: 2, meterNumber: "EM-002", commodityId: electric.id, uomId: kwh.id },
    { premiseIdx: 3, meterNumber: "WM-003", commodityId: water.id, uomId: gal.id },
    { premiseIdx: 3, meterNumber: "EM-003", commodityId: electric.id, uomId: kwh.id },
    { premiseIdx: 4, meterNumber: "WM-004", commodityId: water.id, uomId: gal.id },
    { premiseIdx: 5, meterNumber: "WM-005", commodityId: water.id, uomId: gal.id },
    { premiseIdx: 5, meterNumber: "EM-005", commodityId: electric.id, uomId: kwh.id },
  ];
  const createdMeters: { id: string }[] = [];
  for (const m of meterSpecs) {
    let mt = await prisma.meter.findFirst({
      where: { utilityId: UTILITY_ID, meterNumber: m.meterNumber },
    });
    if (!mt) {
      mt = await prisma.meter.create({
        data: {
          utilityId: UTILITY_ID,
          premiseId: createdPremises[m.premiseIdx].id,
          meterNumber: m.meterNumber,
          commodityId: m.commodityId,
          uomId: m.uomId,
          meterType: "MANUAL",
          status: "ACTIVE",
          installDate: new Date("2024-01-15"),
        },
      });
    }
    createdMeters.push(mt);
  }
  console.log(`  ${createdMeters.length} meters`);

  // ============ SERVICE AGREEMENTS + ASSIGNMENTS ============
  // SA in v2 has no premiseId — premise lives on the ServicePoint.
  // Each SA gets a rateServiceClassId and ≥1 SAScheduleAssignment.
  const W = water.code, S = sewer.code, E = electric.code;
  const saSpecs: Array<{
    agreementNumber: string; accountIdx: number; premiseIdx: number;
    commodityId: string; billingCycleId: string;
    meterIdxs: number[];
    svcClassId: string;
    schedules: Array<{ rs: { id: string }; role: string }>;
  }> = [
    { agreementNumber: "SA-0001", accountIdx: 0, premiseIdx: 0, commodityId: water.id, billingCycleId: cycle1.id,
      meterIdxs: [0], svcClassId: classMap[W].single_family.id,
      schedules: [{ rs: rsW, role: "primary" }] },
    { agreementNumber: "SA-0002", accountIdx: 0, premiseIdx: 0, commodityId: sewer.id, billingCycleId: cycle1.id,
      meterIdxs: [1], svcClassId: classMap[S].residential.id,
      schedules: [{ rs: rsS, role: "primary" }] },
    { agreementNumber: "SA-0003", accountIdx: 1, premiseIdx: 1, commodityId: water.id, billingCycleId: cycle2.id,
      meterIdxs: [2], svcClassId: classMap[W].commercial.id,
      schedules: [{ rs: rsW, role: "primary" }] },
    { agreementNumber: "SA-0004", accountIdx: 1, premiseIdx: 1, commodityId: electric.id, billingCycleId: cycle2.id,
      meterIdxs: [3], svcClassId: classMap[E].small_commercial.id,
      schedules: [
        { rs: rsE_REDS, role: "delivery" },
        { rs: rsE_ESS,  role: "supply" },
        { rs: rsE_USBC, role: "rider" },
      ] },
    { agreementNumber: "SA-0006", accountIdx: 2, premiseIdx: 2, commodityId: electric.id, billingCycleId: cycle1.id,
      meterIdxs: [4], svcClassId: classMap[E].residential.id,
      schedules: [
        { rs: rsE_REDS, role: "delivery" },
        { rs: rsE_ESS,  role: "supply" },
        { rs: rsE_USBC, role: "rider" },
      ] },
    { agreementNumber: "SA-0007", accountIdx: 3, premiseIdx: 3, commodityId: water.id, billingCycleId: cycle1.id,
      meterIdxs: [5], svcClassId: classMap[W].commercial.id,
      schedules: [{ rs: rsW, role: "primary" }] },
    { agreementNumber: "SA-0008", accountIdx: 3, premiseIdx: 3, commodityId: electric.id, billingCycleId: cycle1.id,
      meterIdxs: [6], svcClassId: classMap[E].large_commercial.id,
      schedules: [
        { rs: rsE_REDS, role: "delivery" },
        { rs: rsE_ESS,  role: "supply" },
        { rs: rsE_USBC, role: "rider" },
      ] },
    { agreementNumber: "SA-0009", accountIdx: 4, premiseIdx: 4, commodityId: water.id, billingCycleId: cycle2.id,
      meterIdxs: [7], svcClassId: classMap[W].commercial.id,
      schedules: [{ rs: rsW, role: "primary" }] },
    { agreementNumber: "SA-0010", accountIdx: 5, premiseIdx: 5, commodityId: water.id, billingCycleId: cycle1.id,
      meterIdxs: [8], svcClassId: classMap[W].single_family.id,
      schedules: [{ rs: rsW, role: "primary" }] },
  ];

  let saCount = 0, asCount = 0;
  for (const sa of saSpecs) {
    let created = await prisma.serviceAgreement.findFirst({
      where: { utilityId: UTILITY_ID, agreementNumber: sa.agreementNumber },
    });
    if (!created) {
      created = await prisma.serviceAgreement.create({
        data: {
          utilityId: UTILITY_ID,
          agreementNumber: sa.agreementNumber,
          accountId: createdAccounts[sa.accountIdx].id,
          commodityId: sa.commodityId,
          billingCycleId: sa.billingCycleId,
          rateServiceClassId: sa.svcClassId,
          startDate: new Date("2025-01-01"),
          status: "ACTIVE",
        },
      });
      saCount++;
    } else if (!created.rateServiceClassId) {
      // Backfill the FK on legacy SAs that pre-date task 10.
      await prisma.serviceAgreement.update({
        where: { id: created.id },
        data: { rateServiceClassId: sa.svcClassId },
      });
    }
    // ServicePoint — created if missing.
    let sp = await prisma.servicePoint.findFirst({
      where: { serviceAgreementId: created.id },
    });
    if (!sp) {
      sp = await prisma.servicePoint.create({
        data: {
          utilityId: UTILITY_ID,
          serviceAgreementId: created.id,
          premiseId: createdPremises[sa.premiseIdx].id,
          type: "METERED", status: "ACTIVE",
          startDate: new Date("2025-01-01"),
        },
      });
      for (const mi of sa.meterIdxs) {
        await prisma.servicePointMeter.create({
          data: {
            utilityId: UTILITY_ID,
            servicePointId: sp.id,
            meterId: createdMeters[mi].id,
            addedDate: new Date("2025-01-01"),
          },
        });
      }
    }
    // Assignments — one per (sa, schedule, role). Idempotent.
    for (const { rs, role } of sa.schedules) {
      const existing = await prisma.sAScheduleAssignment.findFirst({
        where: {
          utilityId: UTILITY_ID,
          serviceAgreementId: created.id,
          rateScheduleId: rs.id,
          roleCode: role,
        },
      });
      if (!existing) {
        await prisma.sAScheduleAssignment.create({
          data: {
            utilityId: UTILITY_ID,
            serviceAgreementId: created.id,
            rateScheduleId: rs.id,
            roleCode: role,
            effectiveDate: new Date("2025-01-01"),
          },
        });
        asCount++;
      }
    }
  }
  console.log(`  ${saSpecs.length} service agreements (created ${saCount}, ${asCount} new assignments)`);

  // ============ CONTAINERS (with size/frequency/itemType) ============
  // Premise 0: garbage 65 weekly + recycling 65 weekly + organics 35 weekly
  // Premise 5: garbage 35 weekly + recycling 65 weekly
  const containerSpecs: Array<{
    premiseIdx: number; containerType: "CART_GARBAGE" | "CART_RECYCLING" | "CART_ORGANICS";
    sizeGallons: number; size: string; frequency: string; itemType: string;
  }> = [
    { premiseIdx: 0, containerType: "CART_GARBAGE",   sizeGallons: 65, size: "65", frequency: "weekly", itemType: "garbage_cart" },
    { premiseIdx: 0, containerType: "CART_RECYCLING", sizeGallons: 65, size: "65", frequency: "weekly", itemType: "recycling_cart" },
    { premiseIdx: 0, containerType: "CART_ORGANICS",  sizeGallons: 35, size: "35", frequency: "weekly", itemType: "organics_cart" },
    { premiseIdx: 5, containerType: "CART_GARBAGE",   sizeGallons: 35, size: "35", frequency: "weekly", itemType: "garbage_cart" },
    { premiseIdx: 5, containerType: "CART_RECYCLING", sizeGallons: 65, size: "65", frequency: "weekly", itemType: "recycling_cart" },
  ];
  let containerCount = 0;
  for (const c of containerSpecs) {
    const existing = await prisma.container.findFirst({
      where: {
        utilityId: UTILITY_ID,
        premiseId: createdPremises[c.premiseIdx].id,
        containerType: c.containerType,
        sizeGallons: c.sizeGallons,
      },
    });
    if (!existing) {
      await prisma.container.create({
        data: {
          utilityId: UTILITY_ID,
          premiseId: createdPremises[c.premiseIdx].id,
          containerType: c.containerType,
          sizeGallons: c.sizeGallons,
          quantity: 1,
          status: "ACTIVE",
          deliveryDate: new Date("2025-02-01"),
          size: c.size,
          frequency: c.frequency,
          itemType: c.itemType,
        },
      });
      containerCount++;
    }
  }
  console.log(`  ${containerSpecs.length} containers (created ${containerCount} this run)`);

  // ============ TENANT THEME ============
  await prisma.tenantTheme.upsert({
    where: { utilityId: UTILITY_ID },
    update: {},
    create: {
      utilityId: UTILITY_ID,
      preset: "midnight",
      colors: {
        dark: { "bg-deep": "#06080d", "bg-surface": "#0c1018", "bg-card": "#111722", "accent-primary": "#3b82f6", "text-primary": "#e8edf5" },
        light: { "bg-deep": "#ffffff", "bg-surface": "#f8fafc", "bg-card": "#ffffff", "accent-primary": "#0f766e", "text-primary": "#0f172a" },
      },
      typography: { body: "DM Sans", display: "Fraunces" },
      borderRadius: 10,
    },
  });
  console.log("  tenant theme");

  console.log("\nSeed complete!");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
