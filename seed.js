const { PrismaClient } = require("./packages/shared/src/generated/prisma");
const p = new PrismaClient();
const UID = "00000000-0000-4000-8000-000000000001";

async function main() {
  console.log("Clearing existing data...");
  // Order matters — child tables before their parents. Phase 2 tables
  // (meter_read, service_suspension, meter_event, service_event,
  // container, import_batch) hold FKs into service_agreement and meter,
  // so they must be cleared before those parents can be deleted. The
  // original seed script predates Phase 2 and skipped them, which now
  // blocks reseeding any DB that has accumulated operational data.
  await p.cisUser.deleteMany({});
  await p.role.deleteMany({});
  await p.tenantModule.deleteMany({});

  // Phase 2 operational entities — delete first.
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

  await p.serviceAgreementMeter.deleteMany({});
  await p.serviceAgreement.deleteMany({});
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
  await p.tenantTheme.deleteMany({});
  if (p.tenantConfig) await p.tenantConfig.deleteMany({});
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

  const water = await p.commodity.create({ data: { utilityId: UID, code: "WATER", name: "Potable Water", displayOrder: 1 } });
  const electric = await p.commodity.create({ data: { utilityId: UID, code: "ELECTRIC", name: "Electricity", displayOrder: 2 } });
  const gas = await p.commodity.create({ data: { utilityId: UID, code: "GAS", name: "Natural Gas", displayOrder: 3 } });
  const sewer = await p.commodity.create({ data: { utilityId: UID, code: "SEWER", name: "Sewer", displayOrder: 4 } });
  console.log("  4 commodities");

  const gal = await p.unitOfMeasure.create({ data: { utilityId: UID, code: "GAL", name: "Gallons", commodityId: water.id, conversionFactor: 1, isBaseUnit: true, isActive: true } });
  const kwh = await p.unitOfMeasure.create({ data: { utilityId: UID, code: "KWH", name: "Kilowatt Hours", commodityId: electric.id, conversionFactor: 1, isBaseUnit: true, isActive: true } });
  const kw = await p.unitOfMeasure.create({ data: { utilityId: UID, code: "KW", name: "Kilowatts (Demand)", commodityId: electric.id, conversionFactor: 1, isBaseUnit: false, isActive: true } });
  const mcf = await p.unitOfMeasure.create({ data: { utilityId: UID, code: "MCF", name: "Thousand Cubic Feet", commodityId: gas.id, conversionFactor: 1, isBaseUnit: true, isActive: true } });
  const sgal = await p.unitOfMeasure.create({ data: { utilityId: UID, code: "GAL", name: "Gallons", commodityId: sewer.id, conversionFactor: 1, isBaseUnit: true, isActive: true } });
  console.log("  4 UOMs");

  const c1 = await p.billingCycle.create({ data: { utilityId: UID, name: "Route 1 - North District", cycleCode: "R01", readDayOfMonth: 5, billDayOfMonth: 10, frequency: "MONTHLY" } });
  const c2 = await p.billingCycle.create({ data: { utilityId: UID, name: "Route 2 - South District", cycleCode: "R02", readDayOfMonth: 12, billDayOfMonth: 17, frequency: "MONTHLY" } });
  console.log("  2 billing cycles");

  const rsW = await p.rateSchedule.create({ data: { utilityId: UID, name: "Residential Water Tiered", code: "RS-W-RES", commodityId: water.id, rateType: "TIERED", effectiveDate: new Date("2025-01-01"), rateConfig: { base_charge: 12.50, unit: "GAL", tiers: [{ from: 0, to: 2000, rate: 0.004 }, { from: 2001, to: 5000, rate: 0.006 }, { from: 5001, to: null, rate: 0.009 }] } } });
  const rsS = await p.rateSchedule.create({ data: { utilityId: UID, name: "Sewer Flat Rate", code: "RS-S-FLAT", commodityId: sewer.id, rateType: "FLAT", effectiveDate: new Date("2025-01-01"), rateConfig: { base_charge: 9.00, unit: "MONTH" } } });
  const rsE = await p.rateSchedule.create({ data: { utilityId: UID, name: "Residential Electric Tiered", code: "RS-E-RES", commodityId: electric.id, rateType: "TIERED", effectiveDate: new Date("2025-01-01"), rateConfig: { base_charge: 15.00, unit: "KWH", tiers: [{ from: 0, to: 500, rate: 0.08 }, { from: 501, to: null, rate: 0.12 }] } } });
  const rsG = await p.rateSchedule.create({ data: { utilityId: UID, name: "Residential Gas Flat", code: "RS-G-RES", commodityId: gas.id, rateType: "FLAT", effectiveDate: new Date("2025-01-01"), rateConfig: { base_charge: 18.50, unit: "MONTH" } } });
  console.log("  4 rate schedules");

  const premiseData = [
    { addressLine1: "742 Evergreen Terrace", city: "Springfield", state: "IL", zip: "62704", geoLat: 39.7817, geoLng: -89.6501, premiseType: "RESIDENTIAL", commodityIds: [water.id, sewer.id] },
    { addressLine1: "1600 Pennsylvania Ave NW", city: "Washington", state: "DC", zip: "20500", geoLat: 38.8977, geoLng: -77.0365, premiseType: "COMMERCIAL", commodityIds: [water.id, electric.id, gas.id] },
    { addressLine1: "221B Baker Street", city: "New York", state: "NY", zip: "10001", geoLat: 40.7484, geoLng: -73.9856, premiseType: "RESIDENTIAL", commodityIds: [electric.id, gas.id] },
    { addressLine1: "350 Fifth Avenue", city: "New York", state: "NY", zip: "10118", geoLat: 40.7484, geoLng: -73.9857, premiseType: "INDUSTRIAL", commodityIds: [water.id, electric.id, sewer.id] },
    { addressLine1: "1060 W Addison St", city: "Chicago", state: "IL", zip: "60613", geoLat: 41.9484, geoLng: -87.6553, premiseType: "COMMERCIAL", commodityIds: [water.id, electric.id] },
    { addressLine1: "4059 Mt Lee Dr", city: "Los Angeles", state: "CA", zip: "90068", geoLat: 34.1341, geoLng: -118.3215, premiseType: "RESIDENTIAL", commodityIds: [water.id, electric.id, sewer.id] },
    { addressLine1: "1 Infinite Loop", city: "Cupertino", state: "CA", zip: "95014", geoLat: 37.3318, geoLng: -122.0312, premiseType: "COMMERCIAL", commodityIds: [water.id, electric.id, gas.id, sewer.id] },
    { addressLine1: "233 S Wacker Dr", city: "Chicago", state: "IL", zip: "60606", geoLat: 41.8789, geoLng: -87.6359, premiseType: "COMMERCIAL", commodityIds: [water.id, electric.id, gas.id] },
    { addressLine1: "600 Navarro St", city: "San Antonio", state: "TX", zip: "78205", geoLat: 29.4241, geoLng: -98.4936, premiseType: "MUNICIPAL", commodityIds: [water.id, sewer.id] },
    { addressLine1: "1 Main Street", city: "Smallville", state: "KS", zip: "66002", geoLat: 39.0997, geoLng: -94.5786, premiseType: "RESIDENTIAL", commodityIds: [water.id, electric.id] },
  ];

  const pArr = [];
  for (const pr of premiseData) {
    pArr.push(await p.premise.create({ data: { utilityId: UID, ...pr } }));
  }
  console.log("  " + pArr.length + " premises");

  const accountData = [
    { accountNumber: "0001000-00", accountType: "RESIDENTIAL", creditRating: "EXCELLENT", status: "ACTIVE" },
    { accountNumber: "0001001-00", accountType: "COMMERCIAL", creditRating: "GOOD", status: "ACTIVE", depositAmount: 500 },
    { accountNumber: "0001002-00", accountType: "RESIDENTIAL", creditRating: "GOOD", status: "ACTIVE" },
    { accountNumber: "0001003-00", accountType: "INDUSTRIAL", creditRating: "EXCELLENT", status: "ACTIVE", depositAmount: 2000 },
    { accountNumber: "0001004-00", accountType: "COMMERCIAL", creditRating: "FAIR", status: "ACTIVE", depositAmount: 300 },
    { accountNumber: "0001005-00", accountType: "RESIDENTIAL", creditRating: "GOOD", status: "ACTIVE", paperlessBilling: true },
    { accountNumber: "0001006-00", accountType: "MUNICIPAL", creditRating: "EXCELLENT", status: "ACTIVE" },
    { accountNumber: "0001007-00", accountType: "RESIDENTIAL", creditRating: "POOR", status: "ACTIVE", depositAmount: 200 },
  ];

  const aArr = [];
  for (const ac of accountData) {
    aArr.push(await p.account.create({ data: { utilityId: UID, ...ac } }));
  }
  console.log("  " + aArr.length + " accounts");

  const meterData = [
    { premiseId: pArr[0].id, meterNumber: "WM-001", commodityId: water.id, uomId: gal.id, meterType: "MANUAL", status: "ACTIVE", installDate: new Date("2024-01-15") },
    { premiseId: pArr[0].id, meterNumber: "SM-001", commodityId: sewer.id, uomId: sgal.id, meterType: "MANUAL", status: "ACTIVE", installDate: new Date("2024-01-15") },
    { premiseId: pArr[1].id, meterNumber: "WM-002", commodityId: water.id, uomId: gal.id, meterType: "AMR", status: "ACTIVE", installDate: new Date("2024-02-01") },
    { premiseId: pArr[1].id, meterNumber: "EM-001", commodityId: electric.id, uomId: kwh.id, meterType: "AMI", status: "ACTIVE", installDate: new Date("2024-02-01") },
    { premiseId: pArr[1].id, meterNumber: "GM-001", commodityId: gas.id, uomId: mcf.id, meterType: "AMR", status: "ACTIVE", installDate: new Date("2024-02-01") },
    { premiseId: pArr[2].id, meterNumber: "EM-002", commodityId: electric.id, uomId: kwh.id, meterType: "SMART", status: "ACTIVE", installDate: new Date("2024-03-01") },
    { premiseId: pArr[2].id, meterNumber: "GM-002", commodityId: gas.id, uomId: mcf.id, meterType: "MANUAL", status: "ACTIVE", installDate: new Date("2024-03-01") },
    { premiseId: pArr[3].id, meterNumber: "WM-003", commodityId: water.id, uomId: gal.id, meterType: "AMI", status: "ACTIVE", installDate: new Date("2024-01-20") },
    { premiseId: pArr[3].id, meterNumber: "EM-003", commodityId: electric.id, uomId: kwh.id, meterType: "AMI", status: "ACTIVE", installDate: new Date("2024-01-20") },
    { premiseId: pArr[4].id, meterNumber: "WM-004", commodityId: water.id, uomId: gal.id, meterType: "AMR", status: "ACTIVE", installDate: new Date("2024-04-01") },
    { premiseId: pArr[4].id, meterNumber: "EM-004", commodityId: electric.id, uomId: kwh.id, meterType: "AMR", status: "ACTIVE", installDate: new Date("2024-04-01") },
    { premiseId: pArr[5].id, meterNumber: "WM-005", commodityId: water.id, uomId: gal.id, meterType: "MANUAL", status: "ACTIVE", installDate: new Date("2024-05-01") },
    { premiseId: pArr[5].id, meterNumber: "EM-005", commodityId: electric.id, uomId: kwh.id, meterType: "SMART", status: "ACTIVE", installDate: new Date("2024-05-01") },
    { premiseId: pArr[6].id, meterNumber: "WM-006", commodityId: water.id, uomId: gal.id, meterType: "AMI", status: "ACTIVE", installDate: new Date("2024-06-01") },
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
  // (kW) — captured together on each field visit. This is what the
  // Phase 2.5 read-event grouping is built around.
  const em003 = mArr[8];
  await p.meterRegister.create({ data: { utilityId: UID, meterId: em003.id, registerNumber: 1, description: "Energy usage", uomId: kwh.id, multiplier: 1.0, isActive: true } });
  await p.meterRegister.create({ data: { utilityId: UID, meterId: em003.id, registerNumber: 2, description: "Peak demand", uomId: kw.id, multiplier: 1.0, isActive: true } });
  console.log("  2 registers on EM-003 (multi-register demo)");

  const saData = [
    { agreementNumber: "SA-0001", accountId: aArr[0].id, premiseId: pArr[0].id, commodityId: water.id, rateScheduleId: rsW.id, billingCycleId: c1.id, mIdx: [0] },
    { agreementNumber: "SA-0002", accountId: aArr[0].id, premiseId: pArr[0].id, commodityId: sewer.id, rateScheduleId: rsS.id, billingCycleId: c1.id, mIdx: [1] },
    { agreementNumber: "SA-0003", accountId: aArr[1].id, premiseId: pArr[1].id, commodityId: water.id, rateScheduleId: rsW.id, billingCycleId: c2.id, mIdx: [2] },
    { agreementNumber: "SA-0004", accountId: aArr[1].id, premiseId: pArr[1].id, commodityId: electric.id, rateScheduleId: rsE.id, billingCycleId: c2.id, mIdx: [3] },
    { agreementNumber: "SA-0005", accountId: aArr[1].id, premiseId: pArr[1].id, commodityId: gas.id, rateScheduleId: rsG.id, billingCycleId: c2.id, mIdx: [4] },
    { agreementNumber: "SA-0006", accountId: aArr[2].id, premiseId: pArr[2].id, commodityId: electric.id, rateScheduleId: rsE.id, billingCycleId: c1.id, mIdx: [5] },
    { agreementNumber: "SA-0007", accountId: aArr[3].id, premiseId: pArr[3].id, commodityId: water.id, rateScheduleId: rsW.id, billingCycleId: c1.id, mIdx: [7] },
    { agreementNumber: "SA-0008", accountId: aArr[3].id, premiseId: pArr[3].id, commodityId: electric.id, rateScheduleId: rsE.id, billingCycleId: c1.id, mIdx: [8] },
    { agreementNumber: "SA-0009", accountId: aArr[4].id, premiseId: pArr[4].id, commodityId: water.id, rateScheduleId: rsW.id, billingCycleId: c2.id, mIdx: [9] },
    { agreementNumber: "SA-0010", accountId: aArr[5].id, premiseId: pArr[5].id, commodityId: water.id, rateScheduleId: rsW.id, billingCycleId: c1.id, mIdx: [11] },
  ];

  for (const sa of saData) {
    const { mIdx, ...data } = sa;
    await p.serviceAgreement.create({
      data: {
        utilityId: UID, ...data, startDate: new Date("2025-01-01"), status: "ACTIVE",
        meters: { create: mIdx.map((i, j) => ({ utilityId: UID, meterId: mArr[i].id, isPrimary: j === 0, addedDate: new Date("2025-01-01") })) },
      },
    });
  }
  console.log("  " + saData.length + " service agreements");

  // Seed 12 months of meter reads for SA-0001 (water, WM-001) and SA-0006 (electric, EM-002).
  // These give the portal usage page real data to chart. Each month has one ACTUAL read.
  const saList = await p.serviceAgreement.findMany({
    where: { utilityId: UID },
    include: { meters: { include: { meter: { select: { uomId: true } } } } },
    orderBy: { agreementNumber: "asc" },
  });
  const sa0001 = saList.find(s => s.agreementNumber === "SA-0001");
  const sa0006 = saList.find(s => s.agreementNumber === "SA-0006");
  let readCount = 0;
  for (const { sa, baseReading, monthlyUsage } of [
    { sa: sa0001, baseReading: 1200, monthlyUsage: () => 3500 + Math.floor(Math.random() * 2000) },  // water: gallons
    { sa: sa0006, baseReading: 45000, monthlyUsage: () => 650 + Math.floor(Math.random() * 300) },   // electric: kWh
  ]) {
    if (!sa || !sa.meters[0]) continue;
    const meterId = sa.meters[0].meterId;
    const uomId = sa.meters[0].meter.uomId;
    let running = baseReading;
    for (let m = 11; m >= 0; m--) {
      const d = new Date();
      d.setDate(15);
      d.setMonth(d.getMonth() - m);
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

  // Link customers to accounts
  await p.account.update({ where: { id: aArr[0].id }, data: { customerId: cArr[0].id } });
  await p.account.update({ where: { id: aArr[2].id }, data: { customerId: cArr[1].id } });
  await p.account.update({ where: { id: aArr[1].id }, data: { customerId: cArr[2].id } });
  await p.account.update({ where: { id: aArr[3].id }, data: { customerId: cArr[2].id } });
  console.log("  " + cArr.length + " customers");

  // Link customers as premise owners
  // Jane Smith owns premises 0, 5 (residential)
  await p.premise.update({ where: { id: pArr[0].id }, data: { ownerId: cArr[0].id } });
  await p.premise.update({ where: { id: pArr[5].id }, data: { ownerId: cArr[0].id } });
  // Robert Johnson owns premises 2, 9 (residential)
  await p.premise.update({ where: { id: pArr[2].id }, data: { ownerId: cArr[1].id } });
  await p.premise.update({ where: { id: pArr[9].id }, data: { ownerId: cArr[1].id } });
  // Acme Industries owns premises 1, 3, 4, 6, 7 (commercial/industrial)
  await p.premise.update({ where: { id: pArr[1].id }, data: { ownerId: cArr[2].id } });
  await p.premise.update({ where: { id: pArr[3].id }, data: { ownerId: cArr[2].id } });
  await p.premise.update({ where: { id: pArr[4].id }, data: { ownerId: cArr[2].id } });
  await p.premise.update({ where: { id: pArr[6].id }, data: { ownerId: cArr[2].id } });
  await p.premise.update({ where: { id: pArr[7].id }, data: { ownerId: cArr[2].id } });
  console.log("  9 premises linked to owners");

  const contactData = [
    { accountId: aArr[0].id, customerId: cArr[0].id, role: "PRIMARY", firstName: "Jane", lastName: "Smith", email: "jane.smith@example.com", phone: "555-100-0001", isPrimary: true },
    { accountId: aArr[0].id, role: "AUTHORIZED", firstName: "Tom", lastName: "Smith", email: "tom.smith@example.com", phone: "555-100-0099", isPrimary: false },
    { accountId: aArr[1].id, customerId: cArr[2].id, role: "BILLING", firstName: "Alice", lastName: "Walker", email: "alice@acme.example.com", phone: "555-200-0002", isPrimary: true },
    { accountId: aArr[2].id, customerId: cArr[1].id, role: "PRIMARY", firstName: "Robert", lastName: "Johnson", email: "robert.j@example.com", phone: "555-100-0002", isPrimary: true },
  ];

  for (const ct of contactData) {
    await p.contact.create({ data: { utilityId: UID, ...ct } });
  }
  console.log("  " + contactData.length + " contacts");

  const billingAddressData = [
    { accountId: aArr[0].id, addressLine1: "742 Evergreen Terrace", city: "Springfield", state: "IL", zip: "62704", country: "US", isPrimary: true },
    { accountId: aArr[1].id, addressLine1: "PO Box 1234", city: "Washington", state: "DC", zip: "20500", country: "US", isPrimary: true },
    { accountId: aArr[2].id, addressLine1: "221B Baker Street", city: "New York", state: "NY", zip: "10001", country: "US", isPrimary: true },
  ];

  for (const ba of billingAddressData) {
    await p.billingAddress.create({ data: { utilityId: UID, ...ba } });
  }
  console.log("  " + billingAddressData.length + " billing addresses");

  await p.tenantTheme.create({
    data: {
      utilityId: UID, preset: "midnight",
      colors: { dark: { "bg-deep": "#06080d", "accent-primary": "#3b82f6", "text-primary": "#e8edf5" }, light: { "bg-deep": "#ffffff", "accent-primary": "#0f766e", "text-primary": "#0f172a" } },
      typography: { body: "DM Sans", display: "Fraunces" }, borderRadius: 10,
    },
  });
  console.log("  theme");

  // Seed preset roles — MUST stay in sync with packages/shared/src/modules/constants.ts MODULES
  // When a new module is added there, append it here AND update the permission maps below.
  const allModules = [
    "customers","premises","meters","meter_reads","meter_events",
    "accounts","agreements","commodities","rate_schedules","billing_cycles",
    "containers","service_suspensions","service_events",
    "workflows","search",
    "audit_log","attachments","theme","settings",
    "tenant_profile","tenant_users",
    "notifications","delinquency",
    "service_requests","service_request_slas",
    "portal_accounts","portal_billing","portal_usage","portal_profile"
  ];
  const allPerms = ["VIEW","CREATE","EDIT","DELETE"];

  const roles = [
    {
      name: "System Admin",
      description: "Full access to everything including system settings",
      permissions: {
        ...Object.fromEntries(allModules.map(m => [m, allPerms])),
        service_suspensions: ["VIEW","CREATE","EDIT","DELETE","APPROVE"],
      },
      isSystem: true,
    },
    {
      name: "Utility Admin",
      description: "Full access except system settings modification",
      permissions: {
        ...Object.fromEntries(allModules.map(m => [m, allPerms])),
        service_suspensions: ["VIEW","CREATE","EDIT","DELETE","APPROVE"],
        settings: ["VIEW"],
      },
      isSystem: true,
    },
    {
      name: "CSR",
      description: "Customer service operations",
      permissions: {
        customers: ["VIEW","CREATE","EDIT"], premises: ["VIEW","CREATE","EDIT"],
        meters: ["VIEW"], meter_reads: ["VIEW","CREATE"],
        accounts: ["VIEW","CREATE","EDIT"],
        agreements: ["VIEW","CREATE","EDIT"], commodities: ["VIEW"],
        rate_schedules: ["VIEW"], billing_cycles: ["VIEW"],
        containers: ["VIEW","CREATE","EDIT"],
        service_suspensions: ["VIEW","CREATE","EDIT"],
        service_requests: ["VIEW","CREATE","EDIT"],
        workflows: ["VIEW","CREATE"],
        search: ["VIEW"],
        audit_log: ["VIEW"], attachments: ["VIEW","CREATE","EDIT"],
      },
      isSystem: true,
    },
    {
      name: "Field Technician",
      description: "Meter and premise field operations",
      permissions: {
        customers: ["VIEW"], premises: ["VIEW","EDIT"],
        meters: ["VIEW","EDIT"],
        meter_reads: ["VIEW","CREATE","EDIT"],
        meter_events: ["VIEW","CREATE","EDIT"],
        accounts: ["VIEW"],
        agreements: ["VIEW"], commodities: ["VIEW"],
        containers: ["VIEW","EDIT"],
        service_requests: ["VIEW","EDIT"],
        workflows: ["VIEW"],
        search: ["VIEW"],
        audit_log: ["VIEW"], attachments: ["VIEW","CREATE","EDIT"],
      },
      isSystem: true,
    },
    {
      name: "Read-Only",
      description: "View access to all operational data",
      permissions: Object.fromEntries(
        allModules.filter(m => m !== "settings" && m !== "theme" && !m.startsWith("portal_")).map(m => [m, ["VIEW"]])
      ),
      isSystem: true,
    },
    {
      name: "Portal Customer",
      description: "Self-service portal — view own accounts, bills, usage; edit profile",
      permissions: {
        portal_accounts: ["VIEW"],
        portal_billing: ["VIEW"],
        portal_usage: ["VIEW"],
        portal_profile: ["VIEW","EDIT"],
      },
      isSystem: true,
    },
  ];

  const roleArr = [];
  for (const r of roles) {
    roleArr.push(await p.role.create({ data: { utilityId: UID, ...r } }));
  }
  console.log("  " + roleArr.length + " preset roles");

  const moduleKeys = allModules;
  for (const mk of moduleKeys) {
    await p.tenantModule.create({ data: { utilityId: UID, moduleKey: mk, isEnabled: true } });
  }
  console.log("  " + moduleKeys.length + " tenant modules");

  // Seed global suspension (hold) type codes. utilityId null = visible to
  // every tenant. Tenants can later insert their own rows with a non-null
  // utilityId to add or override codes. Use upsert-by-composite-unique so
  // re-running seed doesn't duplicate.
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
  ];
  for (const t of notifTemplates) {
    const existing = await p.notificationTemplate.findUnique({ where: { utilityId_eventType: { utilityId: UID, eventType: t.eventType } } });
    if (!existing) {
      await p.notificationTemplate.create({ data: { utilityId: UID, ...t } });
    }
  }
  console.log("  " + notifTemplates.length + " notification templates");

  // Seed delinquency rules — 5-tier escalation chain
  const delinqRules = [
    { name: "Past Due Reminder", tier: 1, daysPastDue: 10, minBalance: 25, actionType: "NOTICE_EMAIL", notificationEventType: "delinquency.tier_1", autoApply: true },
    { name: "Formal Past Due Notice", tier: 2, daysPastDue: 20, minBalance: 25, actionType: "NOTICE_EMAIL", notificationEventType: "delinquency.tier_2", autoApply: true },
    { name: "Shut-Off Warning — 48 Hours", tier: 3, daysPastDue: 30, minBalance: 50, actionType: "NOTICE_SMS", notificationEventType: "delinquency.tier_3", autoApply: true },
    { name: "Shut-Off Eligible", tier: 4, daysPastDue: 35, minBalance: 50, actionType: "SHUT_OFF_ELIGIBLE", notificationEventType: null, autoApply: true },
    { name: "Disconnect", tier: 5, daysPastDue: 37, minBalance: 50, actionType: "DISCONNECT", notificationEventType: "delinquency.tier_4", autoApply: false },
  ];
  for (const r of delinqRules) {
    const existing = await p.delinquencyRule.findFirst({ where: { utilityId: UID, tier: r.tier, accountType: null } });
    if (!existing) {
      await p.delinquencyRule.create({ data: { utilityId: UID, ...r, minBalance: r.minBalance, effectiveDate: new Date("2025-01-01") } });
    }
  }
  console.log("  " + delinqRules.length + " delinquency rules");

  // Set balance and lastDueDate on a couple of accounts for delinquency testing
  // aArr[0] = Jane Smith's first account, aArr[1] = Acme's account
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const fifteenDaysAgo = new Date();
  fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

  await p.account.update({ where: { id: aArr[0].id }, data: { balance: 412.80, lastDueDate: thirtyDaysAgo } });
  await p.account.update({ where: { id: aArr[1].id }, data: { balance: 85.50, lastDueDate: fifteenDaysAgo } });
  console.log("  2 accounts with delinquent balances");

  const testUsers = [
    { id: "00000000-0000-4000-8000-000000000091", email: "sysadmin@utility.com", name: "Sarah Mitchell", roleIdx: 0 },  // System Admin
    { id: "00000000-0000-4000-8000-000000000092", email: "admin@utility.com", name: "Michael Chen", roleIdx: 1 },       // Utility Admin
    { id: "00000000-0000-4000-8000-000000000093", email: "csr@utility.com", name: "Jessica Rodriguez", roleIdx: 2 },     // CSR
    { id: "00000000-0000-4000-8000-000000000094", email: "tech@utility.com", name: "David Park", roleIdx: 3 },           // Field Technician
    { id: "00000000-0000-4000-8000-000000000095", email: "viewer@utility.com", name: "Emily Thompson", roleIdx: 4 },     // Read-Only
  ];
  for (const u of testUsers) {
    await p.cisUser.create({
      data: { id: u.id, utilityId: UID, email: u.email, name: u.name, roleId: roleArr[u.roleIdx].id, isActive: true },
    });
  }
  console.log("  " + testUsers.length + " test users (admin)");

  // Seed portal customer logins. Each is a CisUser with the Portal Customer
  // role (roleArr[5]) linked to an existing Customer record via customerId.
  // Login credentials: email from the customer record, no password (dev JWT).
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
        roleId: roleArr[5].id,  // Portal Customer
        customerId: cArr[pu.customerIdx].id,
        isActive: true,
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

  // --- Demo Service Requests (3 rows across different statuses) ---
  // Use the first two accounts we already created. Pull premiseId via
  // the account's first service agreement so the detail page has a
  // premise context to render.
  const [acc1, acc2] = aArr.slice(0, 2);
  const sr1Premise = await p.serviceAgreement.findFirst({ where: { accountId: acc1.id }, select: { premiseId: true } });
  const sr2Premise = await p.serviceAgreement.findFirst({ where: { accountId: acc2.id }, select: { premiseId: true } });
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

  // Counter picks up at 4 so new CSR-created SRs continue the sequence.
  await p.serviceRequestCounter.upsert({
    where: { utilityId_year: { utilityId: UID, year: 2026 } },
    create: { utilityId: UID, year: 2026, nextValue: 4n },
    update: { nextValue: 4n },
  });

  console.log("\nDone! 10 premises, 8 accounts, 15 meters, 10 agreements, 3 customers, 4 contacts, 3 billing addresses, 2 portal users");
}

main().catch(e => { console.error("SEED ERROR:", e); process.exit(1); }).finally(() => p.$disconnect());
