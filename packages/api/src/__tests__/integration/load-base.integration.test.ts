import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "decimal.js";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
} from "./_effective-dating-fixtures.js";
import { loadBase } from "../../lib/rate-engine-loaders/load-base.js";

/**
 * Slice 4 task 7 — `loadBase(saId, period)` integration tests.
 *
 * Boots a Postgres container, applies migrations, and exercises the
 * helper end-to-end against a real SA + ServicePoint + RateSchedule
 * graph. Covers the documented BaseContext shape, period filtering on
 * assignments, the missing-active-SP throw, and component sort order.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

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
  await resetDb(prisma);
  // resetDb's truncate list pre-dates the rate model v2 tables; wipe
  // the v2 leaves explicitly so each test starts from a known state.
  await prisma.$executeRawUnsafe("DELETE FROM sa_rate_schedule_assignment");
  await prisma.$executeRawUnsafe("DELETE FROM rate_component");
});

const PERIOD = {
  startDate: new Date("2026-03-01"),
  endDate: new Date("2026-03-31"),
};

interface SaFixture {
  saId: string;
  scheduleId: string;
}

async function makeSaWithSchedule(opts: {
  endServicePoint?: boolean;
  agreementNumber?: string;
} = {}): Promise<SaFixture> {
  const { prisma } = prismaImports;
  const fix = await makeTenantFixture(prisma, TENANT_A);

  const schedule = await prisma.rateSchedule.create({
    data: {
      utilityId: fix.utilityId,
      name: "Residential Delivery",
      code: "LB-RES-DELIV",
      commodityId: fix.commodityId,
      effectiveDate: new Date("2026-01-01"),
      version: 1,
    },
  });

  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fix.utilityId,
      agreementNumber: opts.agreementNumber ?? "SA-LB-1",
      accountId: fix.accountId,
      commodityId: fix.commodityId,
      billingCycleId: fix.billingCycleId,
      startDate: new Date("2026-01-01"),
      status: "ACTIVE",
    },
  });

  await prisma.servicePoint.create({
    data: {
      utilityId: fix.utilityId,
      serviceAgreementId: sa.id,
      premiseId: fix.premiseId,
      type: "METERED",
      status: opts.endServicePoint ? "FINAL" : "ACTIVE",
      startDate: new Date("2026-01-01"),
      endDate: opts.endServicePoint ? new Date("2026-02-15") : null,
    },
  });

  return { saId: sa.id, scheduleId: schedule.id };
}

async function addComponent(
  utilityId: string,
  rateScheduleId: string,
  sortOrder: number,
  label = `comp-${sortOrder}`,
) {
  const { prisma } = prismaImports;
  return prisma.rateComponent.create({
    data: {
      utilityId,
      rateScheduleId,
      kindCode: "fixed_charge",
      label,
      predicate: { type: "always" },
      quantitySource: { type: "constant", value: 1 },
      pricing: { type: "flat", amount: "10.00" },
      sortOrder,
      effectiveDate: new Date("2026-01-01"),
    },
  });
}

describe("loadBase", () => {
  it("returns the documented BaseContext shape for an SA with one assignment + 3 components", async () => {
    const { saId, scheduleId } = await makeSaWithSchedule();
    const { prisma } = prismaImports;

    await addComponent(TENANT_A, scheduleId, 100);
    await addComponent(TENANT_A, scheduleId, 200);
    await addComponent(TENANT_A, scheduleId, 300);

    await prisma.sAScheduleAssignment.create({
      data: {
        utilityId: TENANT_A,
        serviceAgreementId: saId,
        rateScheduleId: scheduleId,
        roleCode: "delivery",
        effectiveDate: new Date("2026-01-01"),
      },
    });

    // Set a premise eruCount so the Decimal coercion is exercised.
    const sa = await prisma.serviceAgreement.findUniqueOrThrow({
      where: { id: saId },
      include: { servicePoints: true },
    });
    await prisma.premise.update({
      where: { id: sa.servicePoints[0]!.premiseId },
      data: { eruCount: "1.50" },
    });

    const base = await loadBase(prisma, saId, PERIOD, TENANT_A);

    expect(base.sa.id).toBe(saId);
    expect(base.sa.utilityId).toBe(TENANT_A);
    expect(base.sa.commodityId).toBeTruthy();

    expect(base.account.id).toBeTruthy();
    expect(base.account.accountNumber).toMatch(/^ACCT-/);

    expect(base.premise.id).toBe(sa.servicePoints[0]!.premiseId);
    expect(base.premise.premiseType).toBe("RESIDENTIAL");
    expect(base.premise.eruCount).toBeInstanceOf(Decimal);
    expect((base.premise.eruCount as Decimal).toString()).toBe(
      new Decimal("1.5").toString(),
    );

    expect(base.period).toEqual(PERIOD);

    expect(base.assignments).toHaveLength(1);
    const a = base.assignments[0]!;
    expect(a.rateScheduleId).toBe(scheduleId);
    expect(a.roleCode).toBe("delivery");
    expect(a.schedule.components).toHaveLength(3);
    // Components ordered ascending by sortOrder.
    expect(a.schedule.components[0]!.sortOrder).toBeLessThanOrEqual(
      a.schedule.components[1]!.sortOrder,
    );
    expect(a.schedule.components[1]!.sortOrder).toBeLessThanOrEqual(
      a.schedule.components[2]!.sortOrder,
    );
  });

  it("filters out assignments that are outside the period", async () => {
    const { saId, scheduleId } = await makeSaWithSchedule();
    const { prisma } = prismaImports;

    // Expired before the period — must be excluded.
    await prisma.sAScheduleAssignment.create({
      data: {
        utilityId: TENANT_A,
        serviceAgreementId: saId,
        rateScheduleId: scheduleId,
        roleCode: "delivery",
        effectiveDate: new Date("2025-01-01"),
        expirationDate: new Date("2025-12-31"),
      },
    });

    // In-period — must be returned.
    const inPeriod = await prisma.sAScheduleAssignment.create({
      data: {
        utilityId: TENANT_A,
        serviceAgreementId: saId,
        rateScheduleId: scheduleId,
        roleCode: "supply",
        effectiveDate: new Date("2026-02-01"),
      },
    });

    const base = await loadBase(prisma, saId, PERIOD, TENANT_A);
    expect(base.assignments).toHaveLength(1);
    expect(base.assignments[0]!.id).toBe(inPeriod.id);
    expect(base.assignments[0]!.roleCode).toBe("supply");
  });

  it("throws when the SA has no active service point", async () => {
    const { saId } = await makeSaWithSchedule({ endServicePoint: true });
    await expect(
      loadBase(prismaImports.prisma, saId, PERIOD, TENANT_A),
    ).rejects.toThrow(/no active service point/);
  });

  it("returns components ordered by sortOrder ascending even if seeded out of order", async () => {
    const { saId, scheduleId } = await makeSaWithSchedule();
    const { prisma } = prismaImports;

    // Seed in deliberately reversed order — orderBy must sort them.
    await addComponent(TENANT_A, scheduleId, 300, "third");
    await addComponent(TENANT_A, scheduleId, 100, "first");
    await addComponent(TENANT_A, scheduleId, 200, "second");

    await prisma.sAScheduleAssignment.create({
      data: {
        utilityId: TENANT_A,
        serviceAgreementId: saId,
        rateScheduleId: scheduleId,
        roleCode: "delivery",
        effectiveDate: new Date("2026-01-01"),
      },
    });

    const base = await loadBase(prisma, saId, PERIOD, TENANT_A);
    const components = base.assignments[0]!.schedule.components;
    expect(components.map((c) => c.sortOrder)).toEqual([100, 200, 300]);
    expect(components.map((c) => c.label)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
