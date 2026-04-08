import { PrismaClient } from "../src/generated/prisma";

const prisma = new PrismaClient();

const UTILITY_ID = "00000000-0000-4000-8000-000000000001";

async function main() {
  console.log("Seeding database...");

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

  console.log("  ✓ 4 commodities");

  // ============ UNITS OF MEASURE ============
  const gal = await prisma.unitOfMeasure.upsert({
    where: { utilityId_commodityId_code: { utilityId: UTILITY_ID, commodityId: water.id, code: "GAL" } },
    update: {},
    create: { utilityId: UTILITY_ID, code: "GAL", name: "Gallons", commodityId: water.id, conversionFactor: 1, isBaseUnit: true },
  });

  const ccf = await prisma.unitOfMeasure.upsert({
    where: { utilityId_commodityId_code: { utilityId: UTILITY_ID, commodityId: water.id, code: "CCF" } },
    update: {},
    create: { utilityId: UTILITY_ID, code: "CCF", name: "Hundred Cubic Feet", commodityId: water.id, conversionFactor: 748.052, isBaseUnit: false },
  });

  const kwh = await prisma.unitOfMeasure.upsert({
    where: { utilityId_commodityId_code: { utilityId: UTILITY_ID, commodityId: electric.id, code: "KWH" } },
    update: {},
    create: { utilityId: UTILITY_ID, code: "KWH", name: "Kilowatt Hours", commodityId: electric.id, conversionFactor: 1, isBaseUnit: true },
  });

  const mcf = await prisma.unitOfMeasure.upsert({
    where: { utilityId_commodityId_code: { utilityId: UTILITY_ID, commodityId: gas.id, code: "MCF" } },
    update: {},
    create: { utilityId: UTILITY_ID, code: "MCF", name: "Thousand Cubic Feet", commodityId: gas.id, conversionFactor: 1, isBaseUnit: true },
  });

  const sewerUom = await prisma.unitOfMeasure.upsert({
    where: { utilityId_commodityId_code: { utilityId: UTILITY_ID, commodityId: sewer.id, code: "GAL" } },
    update: {},
    create: { utilityId: UTILITY_ID, code: "GAL", name: "Gallons", commodityId: sewer.id, conversionFactor: 1, isBaseUnit: true },
  });

  // Update commodities with default UOM
  await prisma.commodity.update({ where: { id: water.id }, data: { defaultUomId: gal.id } });
  await prisma.commodity.update({ where: { id: electric.id }, data: { defaultUomId: kwh.id } });
  await prisma.commodity.update({ where: { id: gas.id }, data: { defaultUomId: mcf.id } });
  await prisma.commodity.update({ where: { id: sewer.id }, data: { defaultUomId: sewerUom.id } });

  console.log("  ✓ 5 units of measure");

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

  const cycle3 = await prisma.billingCycle.upsert({
    where: { utilityId_cycleCode: { utilityId: UTILITY_ID, cycleCode: "R03" } },
    update: {},
    create: { utilityId: UTILITY_ID, name: "Route 3 — Commercial", cycleCode: "R03", readDayOfMonth: 20, billDayOfMonth: 25, frequency: "MONTHLY" },
  });

  console.log("  ✓ 3 billing cycles");

  // ============ RATE SCHEDULES ============
  const rsWaterRes = await prisma.rateSchedule.upsert({
    where: { utilityId_code_version: { utilityId: UTILITY_ID, code: "RS-W-RES", version: 1 } },
    update: {},
    create: {
      utilityId: UTILITY_ID, name: "Residential Water — Tiered", code: "RS-W-RES", commodityId: water.id,
      rateType: "TIERED", effectiveDate: new Date("2025-01-01"), version: 1,
      rateConfig: {
        base_charge: 12.50, unit: "GAL",
        tiers: [
          { from: 0, to: 2000, rate: 0.004 },
          { from: 2001, to: 5000, rate: 0.006 },
          { from: 5001, to: null, rate: 0.009 },
        ],
      },
    },
  });

  const rsSewerFlat = await prisma.rateSchedule.upsert({
    where: { utilityId_code_version: { utilityId: UTILITY_ID, code: "RS-S-FLAT", version: 1 } },
    update: {},
    create: {
      utilityId: UTILITY_ID, name: "Sewer — Flat Rate", code: "RS-S-FLAT", commodityId: sewer.id,
      rateType: "FLAT", effectiveDate: new Date("2025-01-01"), version: 1,
      rateConfig: { base_charge: 9.00, unit: "MONTH" },
    },
  });

  const rsElecRes = await prisma.rateSchedule.upsert({
    where: { utilityId_code_version: { utilityId: UTILITY_ID, code: "RS-E-RES", version: 1 } },
    update: {},
    create: {
      utilityId: UTILITY_ID, name: "Residential Electric — Tiered", code: "RS-E-RES", commodityId: electric.id,
      rateType: "TIERED", effectiveDate: new Date("2025-01-01"), version: 1,
      rateConfig: {
        base_charge: 15.00, unit: "KWH",
        tiers: [
          { from: 0, to: 500, rate: 0.08 },
          { from: 501, to: 1000, rate: 0.12 },
          { from: 1001, to: null, rate: 0.18 },
        ],
      },
    },
  });

  const rsGasRes = await prisma.rateSchedule.upsert({
    where: { utilityId_code_version: { utilityId: UTILITY_ID, code: "RS-G-RES", version: 1 } },
    update: {},
    create: {
      utilityId: UTILITY_ID, name: "Residential Gas — Flat", code: "RS-G-RES", commodityId: gas.id,
      rateType: "FLAT", effectiveDate: new Date("2025-01-01"), version: 1,
      rateConfig: { base_charge: 18.50, unit: "MONTH" },
    },
  });

  console.log("  ✓ 4 rate schedules");

  // ============ PREMISES ============
  const premises = [
    { addressLine1: "742 Evergreen Terrace", city: "Springfield", state: "IL", zip: "62704", geoLat: 39.7817, geoLng: -89.6501, premiseType: "RESIDENTIAL" as const, commodityIds: [water.id, sewer.id] },
    { addressLine1: "1600 Pennsylvania Ave NW", city: "Washington", state: "DC", zip: "20500", geoLat: 38.8977, geoLng: -77.0365, premiseType: "COMMERCIAL" as const, commodityIds: [water.id, electric.id, gas.id] },
    { addressLine1: "221B Baker Street", city: "London", state: "NY", zip: "10001", geoLat: 40.7484, geoLng: -73.9856, premiseType: "RESIDENTIAL" as const, commodityIds: [electric.id, gas.id] },
    { addressLine1: "350 Fifth Avenue", city: "New York", state: "NY", zip: "10118", geoLat: 40.7484, geoLng: -73.9857, premiseType: "INDUSTRIAL" as const, commodityIds: [water.id, electric.id, sewer.id] },
    { addressLine1: "1060 W Addison St", city: "Chicago", state: "IL", zip: "60613", geoLat: 41.9484, geoLng: -87.6553, premiseType: "COMMERCIAL" as const, commodityIds: [water.id, electric.id] },
    { addressLine1: "4059 Mt Lee Dr", city: "Los Angeles", state: "CA", zip: "90068", geoLat: 34.1341, geoLng: -118.3215, premiseType: "RESIDENTIAL" as const, commodityIds: [water.id, electric.id, sewer.id] },
    { addressLine1: "1 Infinite Loop", city: "Cupertino", state: "CA", zip: "95014", geoLat: 37.3318, geoLng: -122.0312, premiseType: "COMMERCIAL" as const, commodityIds: [water.id, electric.id, gas.id, sewer.id] },
    { addressLine1: "233 S Wacker Dr", city: "Chicago", state: "IL", zip: "60606", geoLat: 41.8789, geoLng: -87.6359, premiseType: "COMMERCIAL" as const, commodityIds: [water.id, electric.id, gas.id] },
    { addressLine1: "600 Navarro St", city: "San Antonio", state: "TX", zip: "78205", geoLat: 29.4241, geoLng: -98.4936, premiseType: "MUNICIPAL" as const, commodityIds: [water.id, sewer.id] },
    { addressLine1: "1 Main Street", city: "Smallville", state: "KS", zip: "66002", geoLat: 39.0997, geoLng: -94.5786, premiseType: "RESIDENTIAL" as const, commodityIds: [water.id, electric.id] },
    { addressLine1: "12 Grimmauld Place", city: "Islington", state: "NY", zip: "10002", geoLat: 40.7158, geoLng: -73.9862, premiseType: "RESIDENTIAL" as const, commodityIds: [gas.id], status: "CONDEMNED" as const },
    { addressLine1: "2001 Odyssey Way", city: "Houston", state: "TX", zip: "77058", geoLat: 29.5519, geoLng: -95.0920, premiseType: "INDUSTRIAL" as const, commodityIds: [water.id, electric.id, gas.id, sewer.id] },
  ];

  const createdPremises = [];
  for (const p of premises) {
    const premise = await prisma.premise.create({
      data: { utilityId: UTILITY_ID, ...p, status: p.status || "ACTIVE" },
    });
    createdPremises.push(premise);
  }
  console.log(`  ✓ ${createdPremises.length} premises`);

  // ============ ACCOUNTS ============
  const accounts = [
    { accountNumber: "0001000-00", accountType: "RESIDENTIAL" as const, creditRating: "EXCELLENT" as const, depositAmount: 0 },
    { accountNumber: "0001001-00", accountType: "COMMERCIAL" as const, creditRating: "GOOD" as const, depositAmount: 500 },
    { accountNumber: "0001002-00", accountType: "RESIDENTIAL" as const, creditRating: "GOOD" as const, depositAmount: 0 },
    { accountNumber: "0001003-00", accountType: "INDUSTRIAL" as const, creditRating: "EXCELLENT" as const, depositAmount: 2000 },
    { accountNumber: "0001004-00", accountType: "COMMERCIAL" as const, creditRating: "FAIR" as const, depositAmount: 300 },
    { accountNumber: "0001005-00", accountType: "RESIDENTIAL" as const, creditRating: "GOOD" as const, depositAmount: 0, paperlessBilling: true },
    { accountNumber: "0001006-00", accountType: "COMMERCIAL" as const, creditRating: "EXCELLENT" as const, depositAmount: 0, budgetBilling: true },
    { accountNumber: "0001007-00", accountType: "RESIDENTIAL" as const, creditRating: "POOR" as const, depositAmount: 200 },
    { accountNumber: "0001008-00", accountType: "MUNICIPAL" as const, creditRating: "EXCELLENT" as const, depositAmount: 0 },
    { accountNumber: "0001009-00", accountType: "INDUSTRIAL" as const, creditRating: "GOOD" as const, depositAmount: 1500 },
  ];

  const createdAccounts = [];
  for (const a of accounts) {
    const account = await prisma.account.create({
      data: { utilityId: UTILITY_ID, ...a },
    });
    createdAccounts.push(account);
  }
  console.log(`  ✓ ${createdAccounts.length} accounts`);

  // ============ METERS ============
  const meters = [
    // Premise 0: 742 Evergreen — water + sewer
    { premiseId: createdPremises[0].id, meterNumber: "WM-001", commodityId: water.id, uomId: gal.id, meterType: "MANUAL" as const },
    { premiseId: createdPremises[0].id, meterNumber: "SM-001", commodityId: sewer.id, uomId: sewerUom.id, meterType: "MANUAL" as const },
    // Premise 1: 1600 Penn — water + electric + gas
    { premiseId: createdPremises[1].id, meterNumber: "WM-002", commodityId: water.id, uomId: gal.id, meterType: "AMR" as const },
    { premiseId: createdPremises[1].id, meterNumber: "EM-001", commodityId: electric.id, uomId: kwh.id, meterType: "AMI" as const },
    { premiseId: createdPremises[1].id, meterNumber: "GM-001", commodityId: gas.id, uomId: mcf.id, meterType: "AMR" as const },
    // Premise 2: 221B Baker — electric + gas
    { premiseId: createdPremises[2].id, meterNumber: "EM-002", commodityId: electric.id, uomId: kwh.id, meterType: "SMART" as const },
    { premiseId: createdPremises[2].id, meterNumber: "GM-002", commodityId: gas.id, uomId: mcf.id, meterType: "MANUAL" as const },
    // Premise 3: 350 Fifth — water + electric + sewer
    { premiseId: createdPremises[3].id, meterNumber: "WM-003", commodityId: water.id, uomId: ccf.id, meterType: "AMI" as const },
    { premiseId: createdPremises[3].id, meterNumber: "EM-003", commodityId: electric.id, uomId: kwh.id, meterType: "AMI" as const },
    { premiseId: createdPremises[3].id, meterNumber: "EM-004", commodityId: electric.id, uomId: kwh.id, meterType: "AMI" as const }, // sub-meter
    { premiseId: createdPremises[3].id, meterNumber: "SM-002", commodityId: sewer.id, uomId: sewerUom.id, meterType: "MANUAL" as const },
    // Premise 4: Wrigley — water + electric
    { premiseId: createdPremises[4].id, meterNumber: "WM-004", commodityId: water.id, uomId: gal.id, meterType: "AMR" as const },
    { premiseId: createdPremises[4].id, meterNumber: "EM-005", commodityId: electric.id, uomId: kwh.id, meterType: "AMR" as const },
    // Premise 5: Hollywood — water + electric + sewer
    { premiseId: createdPremises[5].id, meterNumber: "WM-005", commodityId: water.id, uomId: gal.id, meterType: "MANUAL" as const },
    { premiseId: createdPremises[5].id, meterNumber: "EM-006", commodityId: electric.id, uomId: kwh.id, meterType: "SMART" as const },
    // Premise 6: Infinite Loop — all 4
    { premiseId: createdPremises[6].id, meterNumber: "WM-006", commodityId: water.id, uomId: gal.id, meterType: "AMI" as const },
    { premiseId: createdPremises[6].id, meterNumber: "EM-007", commodityId: electric.id, uomId: kwh.id, meterType: "AMI" as const },
    { premiseId: createdPremises[6].id, meterNumber: "GM-003", commodityId: gas.id, uomId: mcf.id, meterType: "AMR" as const },
    { premiseId: createdPremises[6].id, meterNumber: "SM-003", commodityId: sewer.id, uomId: sewerUom.id, meterType: "MANUAL" as const },
    // Premise 7: Willis Tower
    { premiseId: createdPremises[7].id, meterNumber: "WM-007", commodityId: water.id, uomId: gal.id, meterType: "AMR" as const },
    { premiseId: createdPremises[7].id, meterNumber: "EM-008", commodityId: electric.id, uomId: kwh.id, meterType: "AMI" as const },
  ];

  const createdMeters = [];
  for (const m of meters) {
    const meter = await prisma.meter.create({
      data: { utilityId: UTILITY_ID, installDate: new Date("2024-01-15"), ...m },
    });
    createdMeters.push(meter);
  }
  console.log(`  ✓ ${createdMeters.length} meters`);

  // ============ SERVICE AGREEMENTS ============
  const agreements = [
    // Account 0 at Premise 0: water + sewer
    { agreementNumber: "SA-0001", accountId: createdAccounts[0].id, premiseId: createdPremises[0].id, commodityId: water.id, rateScheduleId: rsWaterRes.id, billingCycleId: cycle1.id, meterIndices: [0] },
    { agreementNumber: "SA-0002", accountId: createdAccounts[0].id, premiseId: createdPremises[0].id, commodityId: sewer.id, rateScheduleId: rsSewerFlat.id, billingCycleId: cycle1.id, meterIndices: [1] },
    // Account 1 at Premise 1: water + electric + gas
    { agreementNumber: "SA-0003", accountId: createdAccounts[1].id, premiseId: createdPremises[1].id, commodityId: water.id, rateScheduleId: rsWaterRes.id, billingCycleId: cycle3.id, meterIndices: [2] },
    { agreementNumber: "SA-0004", accountId: createdAccounts[1].id, premiseId: createdPremises[1].id, commodityId: electric.id, rateScheduleId: rsElecRes.id, billingCycleId: cycle3.id, meterIndices: [3] },
    { agreementNumber: "SA-0005", accountId: createdAccounts[1].id, premiseId: createdPremises[1].id, commodityId: gas.id, rateScheduleId: rsGasRes.id, billingCycleId: cycle3.id, meterIndices: [4] },
    // Account 2 at Premise 2: electric + gas
    { agreementNumber: "SA-0006", accountId: createdAccounts[2].id, premiseId: createdPremises[2].id, commodityId: electric.id, rateScheduleId: rsElecRes.id, billingCycleId: cycle1.id, meterIndices: [5] },
    { agreementNumber: "SA-0007", accountId: createdAccounts[2].id, premiseId: createdPremises[2].id, commodityId: gas.id, rateScheduleId: rsGasRes.id, billingCycleId: cycle1.id, meterIndices: [6] },
    // Account 3 at Premise 3: water + electric (2 sub-meters!) + sewer
    { agreementNumber: "SA-0008", accountId: createdAccounts[3].id, premiseId: createdPremises[3].id, commodityId: water.id, rateScheduleId: rsWaterRes.id, billingCycleId: cycle2.id, meterIndices: [7] },
    { agreementNumber: "SA-0009", accountId: createdAccounts[3].id, premiseId: createdPremises[3].id, commodityId: electric.id, rateScheduleId: rsElecRes.id, billingCycleId: cycle2.id, meterIndices: [8, 9] }, // multi-meter!
    { agreementNumber: "SA-0010", accountId: createdAccounts[3].id, premiseId: createdPremises[3].id, commodityId: sewer.id, rateScheduleId: rsSewerFlat.id, billingCycleId: cycle2.id, meterIndices: [10] },
    // Account 4 at Premise 4
    { agreementNumber: "SA-0011", accountId: createdAccounts[4].id, premiseId: createdPremises[4].id, commodityId: water.id, rateScheduleId: rsWaterRes.id, billingCycleId: cycle2.id, meterIndices: [11] },
    { agreementNumber: "SA-0012", accountId: createdAccounts[4].id, premiseId: createdPremises[4].id, commodityId: electric.id, rateScheduleId: rsElecRes.id, billingCycleId: cycle2.id, meterIndices: [12] },
    // Account 5 at Premise 5
    { agreementNumber: "SA-0013", accountId: createdAccounts[5].id, premiseId: createdPremises[5].id, commodityId: water.id, rateScheduleId: rsWaterRes.id, billingCycleId: cycle1.id, meterIndices: [13] },
    { agreementNumber: "SA-0014", accountId: createdAccounts[5].id, premiseId: createdPremises[5].id, commodityId: electric.id, rateScheduleId: rsElecRes.id, billingCycleId: cycle1.id, meterIndices: [14] },
  ];

  for (const sa of agreements) {
    const { meterIndices, ...saData } = sa;
    await prisma.serviceAgreement.create({
      data: {
        utilityId: UTILITY_ID,
        ...saData,
        startDate: new Date("2025-01-01"),
        status: "ACTIVE",
        meters: {
          create: meterIndices.map((idx, i) => ({
            utilityId: UTILITY_ID,
            meterId: createdMeters[idx].id,
            isPrimary: i === 0,
            addedDate: new Date("2025-01-01"),
          })),
        },
      },
    });
  }
  console.log(`  ✓ ${agreements.length} service agreements (1 with multi-meter)`);

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
  console.log("  ✓ tenant theme");

  console.log("\nSeed complete!");
  console.log("  Tenant ID: " + UTILITY_ID);
  console.log("  12 premises, 10 accounts, 21 meters, 14 service agreements");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
