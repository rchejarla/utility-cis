import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "decimal.js";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";
import { LinkedCommodityLoader } from "../../lib/rate-engine-loaders/loaders/linked-commodity-loader.js";

/**
 * Slice 4 task 6 — LinkedCommodityLoader integration tests.
 *
 * Exercises `linked:<commodity>:current_period` against real rows.
 * The loader needs:
 *   - One "current" SA on (account, premise) for some commodity X
 *   - One "sibling" SA on the same (account, premise) for commodity Y
 *   - Meter reads against the sibling SA in the period
 * and should aggregate the sibling's reads. UUID and code lookups for
 * the commodity are both supported. 0 or >1 siblings throw.
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
  await prisma.$executeRawUnsafe("DELETE FROM meter_read");
  await prisma.$executeRawUnsafe("DELETE FROM service_point_meter");
  await prisma.$executeRawUnsafe("DELETE FROM service_point");
  await resetDb(prisma);
});

interface LinkedFixture {
  fix: TenantFixture;
  /** "Current" SA — commodity already on the tenant fixture (WATER-...) */
  currentSaId: string;
  /** Sibling SA — uses a second commodity */
  siblingSaId: string;
  siblingCommodityId: string;
  siblingCommodityCode: string;
}

/**
 * Build a tenant fixture, then a second commodity + UoM, then two SAs
 * (current + sibling) tied to the same account+premise via service
 * points. The caller can then attach meter reads to the sibling SA.
 */
async function makeLinkedFixture(opts: {
  siblingStatus?: "ACTIVE" | "PENDING" | "FINAL" | "CLOSED";
  /** Optional second sibling on a different commodity (for the multiple-sibling test) */
  extraSibling?: { code: string };
} = {}): Promise<LinkedFixture> {
  const { prisma } = prismaImports;
  const fix = await makeTenantFixture(prisma, TENANT_A);

  // Second commodity (sewer)
  const sewer = await prisma.commodity.create({
    data: { utilityId: fix.utilityId, code: "SEWER-AA", name: "Sewer" },
  });

  // Current SA — uses fixture's water commodity
  const currentSa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fix.utilityId,
      agreementNumber: "SA-CURRENT-1",
      accountId: fix.accountId,
      commodityId: sewer.id, // current is sewer; sibling will be water
      billingCycleId: fix.billingCycleId,
      startDate: new Date("2026-01-01"),
      status: "ACTIVE",
    },
  });
  await prisma.servicePoint.create({
    data: {
      utilityId: fix.utilityId,
      serviceAgreementId: currentSa.id,
      premiseId: fix.premiseId,
      type: "METERED",
      status: "ACTIVE",
      startDate: new Date("2026-01-01"),
    },
  });

  // Sibling SA — water commodity
  const siblingSa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fix.utilityId,
      agreementNumber: "SA-SIBLING-1",
      accountId: fix.accountId,
      commodityId: fix.commodityId,
      billingCycleId: fix.billingCycleId,
      startDate: new Date("2026-01-01"),
      status: opts.siblingStatus ?? "ACTIVE",
    },
  });
  await prisma.servicePoint.create({
    data: {
      utilityId: fix.utilityId,
      serviceAgreementId: siblingSa.id,
      premiseId: fix.premiseId,
      type: "METERED",
      status: "ACTIVE",
      startDate: new Date("2026-01-01"),
    },
  });

  if (opts.extraSibling) {
    const extraComm = await prisma.commodity.create({
      data: { utilityId: fix.utilityId, code: opts.extraSibling.code, name: "Extra" },
    });
    const extraSa = await prisma.serviceAgreement.create({
      data: {
        utilityId: fix.utilityId,
        agreementNumber: "SA-SIBLING-EXTRA",
        accountId: fix.accountId,
        commodityId: extraComm.id,
        billingCycleId: fix.billingCycleId,
        startDate: new Date("2026-01-01"),
        status: "ACTIVE",
      },
    });
    await prisma.servicePoint.create({
      data: {
        utilityId: fix.utilityId,
        serviceAgreementId: extraSa.id,
        premiseId: fix.premiseId,
        type: "METERED",
        status: "ACTIVE",
        startDate: new Date("2026-01-01"),
      },
    });
  }

  // Get the actual water commodity code from the fixture
  const waterComm = await prisma.commodity.findUniqueOrThrow({
    where: { id: fix.commodityId },
    select: { code: true, id: true },
  });

  return {
    fix,
    currentSaId: currentSa.id,
    siblingSaId: siblingSa.id,
    siblingCommodityId: waterComm.id,
    siblingCommodityCode: waterComm.code,
  };
}

async function seedRead(opts: {
  meterId: string;
  saId: string;
  uomId: string;
  utilityId: string;
  readDate: Date;
  consumption: string;
}): Promise<void> {
  const { prisma } = prismaImports;
  await prisma.meterRead.create({
    data: {
      utilityId: opts.utilityId,
      meterId: opts.meterId,
      serviceAgreementId: opts.saId,
      uomId: opts.uomId,
      readDate: opts.readDate,
      readDatetime: opts.readDate,
      reading: "0",
      priorReading: "0",
      consumption: opts.consumption,
      readType: "ACTUAL",
      readSource: "MANUAL",
    },
  });
}

describe("LinkedCommodityLoader", () => {
  it("aggregates sibling SA's meter reads for the period (commodity by code)", async () => {
    const { fix, currentSaId, siblingSaId, siblingCommodityCode } =
      await makeLinkedFixture();

    await seedRead({
      meterId: fix.meterId,
      saId: siblingSaId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2026-01-05"),
      consumption: "10.0000",
    });
    await seedRead({
      meterId: fix.meterId,
      saId: siblingSaId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2026-01-20"),
      consumption: "12.5000",
    });

    const loader = new LinkedCommodityLoader(
      prismaImports.prisma,
      TENANT_A,
      PERIOD,
      { id: currentSaId, accountId: fix.accountId, premiseId: fix.premiseId },
    );
    const key = `linked:${siblingCommodityCode}:current_period`;
    const out = await loader.load([key]);
    const v = out.get(key) as Decimal;
    expect(v.toString()).toBe(new Decimal("22.5").toString());
  });

  it("resolves the sibling commodity by UUID as well as by code", async () => {
    const { fix, currentSaId, siblingSaId, siblingCommodityId } =
      await makeLinkedFixture();
    await seedRead({
      meterId: fix.meterId,
      saId: siblingSaId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2026-01-15"),
      consumption: "7.0000",
    });

    const loader = new LinkedCommodityLoader(
      prismaImports.prisma,
      TENANT_A,
      PERIOD,
      { id: currentSaId, accountId: fix.accountId, premiseId: fix.premiseId },
    );
    const key = `linked:${siblingCommodityId}:current_period`;
    const out = await loader.load([key]);
    expect((out.get(key) as Decimal).toString()).toBe(
      new Decimal("7.0").toString(),
    );
  });

  it("ignores meter reads outside the period", async () => {
    const { fix, currentSaId, siblingSaId, siblingCommodityCode } =
      await makeLinkedFixture();
    // In-period
    await seedRead({
      meterId: fix.meterId,
      saId: siblingSaId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2026-01-15"),
      consumption: "8.0000",
    });
    // Before period
    await seedRead({
      meterId: fix.meterId,
      saId: siblingSaId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2025-12-15"),
      consumption: "999.0000",
    });
    // After period
    await seedRead({
      meterId: fix.meterId,
      saId: siblingSaId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2026-02-15"),
      consumption: "888.0000",
    });

    const loader = new LinkedCommodityLoader(
      prismaImports.prisma,
      TENANT_A,
      PERIOD,
      { id: currentSaId, accountId: fix.accountId, premiseId: fix.premiseId },
    );
    const key = `linked:${siblingCommodityCode}:current_period`;
    const out = await loader.load([key]);
    expect((out.get(key) as Decimal).toString()).toBe(
      new Decimal("8.0").toString(),
    );
  });

  it("throws a clear error when no sibling SA exists for the commodity", async () => {
    const { fix, currentSaId } = await makeLinkedFixture();

    const loader = new LinkedCommodityLoader(
      prismaImports.prisma,
      TENANT_A,
      PERIOD,
      { id: currentSaId, accountId: fix.accountId, premiseId: fix.premiseId },
    );
    await expect(
      loader.load(["linked:NONEXISTENT-COMMODITY:current_period"]),
    ).rejects.toThrow(/No sibling SA/);
  });

  it("throws when multiple sibling SAs match the same commodity", async () => {
    // Build the standard fixture, then add a SECOND water SA on the
    // same account+premise. The loader should refuse rather than
    // silently picking one.
    const { fix, currentSaId, siblingCommodityCode } = await makeLinkedFixture();
    const secondSibling = await prismaImports.prisma.serviceAgreement.create({
      data: {
        utilityId: fix.utilityId,
        agreementNumber: "SA-SIBLING-DUP",
        accountId: fix.accountId,
        commodityId: fix.commodityId, // same water commodity
        billingCycleId: fix.billingCycleId,
        startDate: new Date("2026-01-01"),
        status: "ACTIVE",
      },
    });
    await prismaImports.prisma.servicePoint.create({
      data: {
        utilityId: fix.utilityId,
        serviceAgreementId: secondSibling.id,
        premiseId: fix.premiseId,
        type: "METERED",
        status: "ACTIVE",
        startDate: new Date("2026-01-01"),
      },
    });

    const loader = new LinkedCommodityLoader(
      prismaImports.prisma,
      TENANT_A,
      PERIOD,
      { id: currentSaId, accountId: fix.accountId, premiseId: fix.premiseId },
    );
    await expect(
      loader.load([`linked:${siblingCommodityCode}:current_period`]),
    ).rejects.toThrow(/Multiple sibling SAs/);
  });

  it("returns 0 when sibling exists but has no reads in the period", async () => {
    const { fix, currentSaId, siblingCommodityCode } = await makeLinkedFixture();

    const loader = new LinkedCommodityLoader(
      prismaImports.prisma,
      TENANT_A,
      PERIOD,
      { id: currentSaId, accountId: fix.accountId, premiseId: fix.premiseId },
    );
    const key = `linked:${siblingCommodityCode}:current_period`;
    const out = await loader.load([key]);
    expect((out.get(key) as Decimal).toString()).toBe("0");
  });
});
