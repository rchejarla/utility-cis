import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "decimal.js";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";
import { MeterLoader } from "../../lib/rate-engine-loaders/loaders/meter-loader.js";
import { UnsupportedInSlice4Error } from "../../lib/rate-engine-loaders/types.js";

/**
 * Slice 4 task 3 — MeterLoader integration tests.
 *
 * Boots a Postgres container, applies migrations, and exercises the
 * loader's four declared patterns against real rows. `meter:size` and
 * `meter:role` are read out of `customFields`; `meter:reads` is
 * aggregated from real MeterRead rows; `meter:peak_demand` should
 * cleanly throw UnsupportedInSlice4Error.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

const PERIOD = {
  startDate: new Date("2026-01-01"),
  endDate: new Date("2026-01-31"),
};

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  // resetDb truncates the core tables but doesn't list meter_read or
  // service_agreement; clear those explicitly so each test starts
  // from a known empty state.
  await prisma.$executeRawUnsafe("DELETE FROM meter_read");
  await resetDb(prisma);
});

interface MeterReadFixture {
  fix: TenantFixture;
  saId: string;
}

/**
 * Build a tenant fixture and an SA the meter reads can hang off of.
 * Optionally seeds customFields on the meter so size/role tests have
 * something to read.
 */
async function makeMeterFixture(opts: {
  meter1CustomFields?: Record<string, unknown>;
  meter2CustomFields?: Record<string, unknown>;
}): Promise<MeterReadFixture> {
  const { prisma } = prismaImports;
  const fix = await makeTenantFixture(prisma, TENANT_A);

  if (opts.meter1CustomFields) {
    await prisma.meter.update({
      where: { id: fix.meterId },
      data: { customFields: opts.meter1CustomFields as object },
    });
  }
  if (opts.meter2CustomFields) {
    await prisma.meter.update({
      where: { id: fix.meterId2 },
      data: { customFields: opts.meter2CustomFields as object },
    });
  }

  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fix.utilityId,
      agreementNumber: "SA-METER-LOADER-1",
      accountId: fix.accountId,
      commodityId: fix.commodityId,
      billingCycleId: fix.billingCycleId,
      startDate: new Date("2026-01-01"),
      status: "ACTIVE",
    },
  });

  return { fix, saId: sa.id };
}

interface SeedReadOpts {
  meterId: string;
  saId: string;
  uomId: string;
  utilityId: string;
  readDate: Date;
  reading: string;
  priorReading: string;
  consumption: string;
}

async function seedRead(opts: SeedReadOpts): Promise<void> {
  const { prisma } = prismaImports;
  await prisma.meterRead.create({
    data: {
      utilityId: opts.utilityId,
      meterId: opts.meterId,
      serviceAgreementId: opts.saId,
      uomId: opts.uomId,
      readDate: opts.readDate,
      readDatetime: opts.readDate,
      reading: opts.reading,
      priorReading: opts.priorReading,
      consumption: opts.consumption,
      readType: "ACTUAL",
      readSource: "MANUAL",
    },
  });
}

describe("MeterLoader", () => {
  it("meter:size:<id> returns the size from customFields", async () => {
    const { fix } = await makeMeterFixture({
      meter1CustomFields: { size: '5/8"', role: "primary" },
    });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await loader.load([`meter:size:${fix.meterId}`]);
    expect(out.get(`meter:size:${fix.meterId}`)).toBe('5/8"');
  });

  it("meter:role:<id> returns the role, or null when not set", async () => {
    const { fix } = await makeMeterFixture({
      meter1CustomFields: { size: '1"', role: "irrigation" },
      // meter2 left with default {} — role should be null
    });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await loader.load([
      `meter:role:${fix.meterId}`,
      `meter:role:${fix.meterId2}`,
    ]);
    expect(out.get(`meter:role:${fix.meterId}`)).toBe("irrigation");
    expect(out.get(`meter:role:${fix.meterId2}`)).toBeNull();
  });

  it("meter:reads:<id> aggregates consumption across multiple reads in period", async () => {
    const { fix, saId } = await makeMeterFixture({});
    const seedFor = (readDate: Date, consumption: string, reading: string) =>
      seedRead({
        meterId: fix.meterId,
        saId,
        uomId: fix.uomId,
        utilityId: fix.utilityId,
        readDate,
        reading,
        priorReading: "0",
        consumption,
      });

    await seedFor(new Date("2026-01-05"), "10.5000", "10.5000");
    await seedFor(new Date("2026-01-15"), "20.2500", "30.7500");
    await seedFor(new Date("2026-01-25"), "5.1234", "35.8734");

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await loader.load([`meter:reads:${fix.meterId}`]);
    const summary = out.get(`meter:reads:${fix.meterId}`) as {
      quantity: Decimal;
      unit: string;
    };
    expect(summary.unit).toBe("GAL"); // matches the fixture's UoM code
    expect(summary.quantity.toString()).toBe(new Decimal("35.8734").toString());
  });

  it("meter:reads:<id> ignores reads outside the period", async () => {
    const { fix, saId } = await makeMeterFixture({});
    // In-period
    await seedRead({
      meterId: fix.meterId,
      saId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2026-01-15"),
      reading: "100.0000",
      priorReading: "0",
      consumption: "12.0000",
    });
    // Before the period start
    await seedRead({
      meterId: fix.meterId,
      saId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2025-12-15"),
      reading: "50.0000",
      priorReading: "0",
      consumption: "999.0000",
    });
    // After the period end
    await seedRead({
      meterId: fix.meterId,
      saId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2026-02-05"),
      reading: "200.0000",
      priorReading: "0",
      consumption: "888.0000",
    });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await loader.load([`meter:reads:${fix.meterId}`]);
    const summary = out.get(`meter:reads:${fix.meterId}`) as {
      quantity: Decimal;
      unit: string;
    };
    expect(summary.quantity.toString()).toBe(new Decimal("12.0000").toString());
  });

  it("meter:reads:<id> returns 0 quantity when no reads exist (default unit HCF)", async () => {
    const { fix } = await makeMeterFixture({});

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await loader.load([`meter:reads:${fix.meterId}`]);
    const summary = out.get(`meter:reads:${fix.meterId}`) as {
      quantity: Decimal;
      unit: string;
    };
    expect(summary.quantity.toString()).toBe("0");
    expect(summary.unit).toBe("HCF");
  });

  it("batches multiple meters into one Meter query for size+role", async () => {
    const { fix } = await makeMeterFixture({
      meter1CustomFields: { size: '5/8"', role: "primary" },
      meter2CustomFields: { size: '1"', role: "irrigation" },
    });

    const original = prismaImports.prisma.meter.findMany.bind(prismaImports.prisma.meter);
    const spy = vi
      .spyOn(prismaImports.prisma.meter, "findMany")
      .mockImplementation((args) => original(args) as ReturnType<typeof original>);
    try {
      const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
      const out = await loader.load([
        `meter:size:${fix.meterId}`,
        `meter:size:${fix.meterId2}`,
        `meter:role:${fix.meterId}`,
        `meter:role:${fix.meterId2}`,
      ]);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(out.get(`meter:size:${fix.meterId}`)).toBe('5/8"');
      expect(out.get(`meter:size:${fix.meterId2}`)).toBe('1"');
      expect(out.get(`meter:role:${fix.meterId}`)).toBe("primary");
      expect(out.get(`meter:role:${fix.meterId2}`)).toBe("irrigation");
    } finally {
      spy.mockRestore();
    }
  });

  it("meter:peak_demand:* throws UnsupportedInSlice4Error", async () => {
    const { fix } = await makeMeterFixture({});
    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);

    await expect(
      loader.load([`meter:peak_demand:${fix.meterId}:15min`]),
    ).rejects.toBeInstanceOf(UnsupportedInSlice4Error);
  });
});
