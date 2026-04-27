/**
 * Shared fixture helpers for the Slice 1 effective-dating integration
 * tests. Boots a Postgres container, applies migrations, and gives
 * tests a small, predictable graph (utility config, commodity, UOM,
 * billing cycle, rate schedule, account, premise, meter) they can
 * compose service agreements over.
 *
 * The helpers are NOT a test file — they live in this directory but
 * the integration runner's `*.integration.test.ts` glob excludes
 * them. Tests import the named helpers explicitly.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

export const TENANT_A = "00000000-0000-4000-8000-0000000000aa";
export const TENANT_B = "00000000-0000-4000-8000-0000000000bb";
export const ACTOR = "00000000-0000-4000-8000-aaaa00000001";

export interface BootedContainer {
  container: StartedPostgreSqlContainer;
  dbUrl: string;
}

export async function bootPostgres(): Promise<BootedContainer> {
  const container = await new PostgreSqlContainer("timescale/timescaledb:latest-pg16")
    .withDatabase("utility_cis_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  const dbUrl = container.getConnectionUri();
  process.env.DATABASE_URL = dbUrl;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "error";

  execSync("pnpm prisma migrate deploy", {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  return { container, dbUrl };
}

export interface TenantFixture {
  utilityId: string;
  commodityId: string;
  uomId: string;
  billingCycleId: string;
  rateScheduleId: string;
  accountId: string;
  premiseId: string;
  meterId: string;
  meterId2: string;
  meterId3: string;
}

/**
 * Reset DB to a clean slate by truncating every table the tests touch
 * (audit_log first, then leaf tables, then root tables). RESTART
 * IDENTITY ensures sequence-based identifiers don't drift across runs.
 */
export async function resetDb(prisma: {
  $executeRawUnsafe: (sql: string) => Promise<unknown>;
}) {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_log,
      service_agreement_meter,
      service_agreement,
      meter,
      account,
      premise,
      rate_schedule,
      billing_cycle,
      unit_of_measure,
      measure_type_def,
      commodity,
      tenant_module,
      tenant_config
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Create a fresh tenant fixture: one of every entity needed to spin
 * up service agreements + meter assignments. Returns the IDs the
 * tests will use.
 */
// Untyped to keep this fixture decoupled from generated Prisma types
// (which are heavy and would force every consumer to import them
// just to call the helper). Tests pass the real prisma client; the
// `data` payload below is validated by Postgres at insert time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function makeTenantFixture(
  prisma: any,
  utilityId: string,
  opts: { suffix?: string } = {},
): Promise<TenantFixture> {
  const suffix = opts.suffix ?? utilityId.slice(-4);

  await prisma.tenantConfig.create({ data: { utilityId } });

  const commodity = await prisma.commodity.create({
    data: { utilityId, code: `WATER-${suffix}`, name: "Water" },
  });

  // MeasureTypeDef is referenced by UnitOfMeasure with a NOT NULL FK.
  // Reuse a shared one across test runs if it already exists (e.g.,
  // the test sets up two tenants in one beforeEach).
  let measureType = await prisma.measureTypeDef.findFirst({
    where: { code: "VOLUME" },
  });
  if (!measureType) {
    measureType = await prisma.measureTypeDef.create({
      data: { code: "VOLUME", label: "Volume" },
    });
  }

  const uom = await prisma.unitOfMeasure.create({
    data: {
      utilityId,
      commodityId: commodity.id,
      measureTypeId: measureType.id,
      code: "GAL",
      name: "Gallons",
      conversionFactor: 1,
      isBaseUnit: true,
      isActive: true,
    },
  });

  const billingCycle = await prisma.billingCycle.create({
    data: {
      utilityId,
      name: `Cycle-${suffix}`,
      cycleCode: `C-${suffix}`,
      readDayOfMonth: 5,
      billDayOfMonth: 10,
      frequency: "MONTHLY",
    },
  });

  const rateSchedule = await prisma.rateSchedule.create({
    data: {
      utilityId,
      name: `Rate-${suffix}`,
      code: `RATE-${suffix}`,
      commodityId: commodity.id,
      rateType: "FLAT",
      effectiveDate: new Date("2024-01-01"),
      version: 1,
      rateConfig: { base_charge: 10, unit: "MONTH" },
    },
  });

  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: `ACCT-${suffix}`,
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      depositAmount: 0,
    },
  });

  const premise = await prisma.premise.create({
    data: {
      utilityId,
      addressLine1: `1 Test Lane ${suffix}`,
      city: "Testville",
      state: "TS",
      zip: "00000",
      premiseType: "RESIDENTIAL",
      commodityIds: [commodity.id],
      status: "ACTIVE",
    },
  });

  const meter = await prisma.meter.create({
    data: {
      utilityId,
      premiseId: premise.id,
      commodityId: commodity.id,
      uomId: uom.id,
      meterNumber: `MTR-${suffix}-1`,
      meterType: "MANUAL",
      status: "ACTIVE",
      installDate: new Date("2024-01-01"),
    },
  });

  const meter2 = await prisma.meter.create({
    data: {
      utilityId,
      premiseId: premise.id,
      commodityId: commodity.id,
      uomId: uom.id,
      meterNumber: `MTR-${suffix}-2`,
      meterType: "MANUAL",
      status: "ACTIVE",
      installDate: new Date("2024-01-01"),
    },
  });

  const meter3 = await prisma.meter.create({
    data: {
      utilityId,
      premiseId: premise.id,
      commodityId: commodity.id,
      uomId: uom.id,
      meterNumber: `MTR-${suffix}-3`,
      meterType: "MANUAL",
      status: "ACTIVE",
      installDate: new Date("2024-01-01"),
    },
  });

  return {
    utilityId,
    commodityId: commodity.id,
    uomId: uom.id,
    billingCycleId: billingCycle.id,
    rateScheduleId: rateSchedule.id,
    accountId: account.id,
    premiseId: premise.id,
    meterId: meter.id,
    meterId2: meter2.id,
    meterId3: meter3.id,
  };
}
