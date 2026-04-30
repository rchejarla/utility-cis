import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  ACTOR,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";

/**
 * Real-database verification of `closeServiceAgreement`'s atomicity
 * guarantees. The unit suite mocks Prisma; the cascade itself, the
 * audit-row co-emission, and the rollback-on-mid-tx-failure all need
 * a real Postgres to be meaningful tests.
 *
 * Scenarios:
 *   1. Happy path: 3 open SPMs all get `removed_date = endDate`; SA
 *      ends up FINAL with the supplied endDate; 4 audit rows emitted
 *      (1 SA + 3 SPMs).
 *   2. Idempotent re-close: same terminal status + endDate is a no-op;
 *      no extra audit rows; counts unchanged.
 *   3. Pre-closed SPMs are left alone — already-removed assignments
 *      are skipped by the cascade (selector filters `removedDate IS NULL`).
 *   4. Mid-tx failure rolls back: forcing a failure inside the same
 *      transaction leaves SA in original ACTIVE state and SPMs open.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let serviceImports: typeof import("../../services/effective-dating.service.js");
let fixA: TenantFixture;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  serviceImports = await import("../../services/effective-dating.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await resetDb(prisma);
  fixA = await makeTenantFixture(prisma, TENANT_A);
});

async function makeSaWithThreeMeters() {
  const { prisma } = prismaImports;
  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fixA.utilityId,
      agreementNumber: "SA-CASCADE",
      accountId: fixA.accountId,
      premiseId: fixA.premiseId,
      commodityId: fixA.commodityId,
      rateScheduleId: fixA.rateScheduleId,
      billingCycleId: fixA.billingCycleId,
      startDate: new Date("2024-01-01"),
      status: "ACTIVE",
    },
  });

  const sp = await prisma.servicePoint.create({
    data: {
      utilityId: fixA.utilityId,
      serviceAgreementId: sa.id,
      premiseId: fixA.premiseId,
      type: "METERED",
      status: "ACTIVE",
      startDate: new Date("2024-01-01"),
    },
  });

  await prisma.servicePointMeter.createMany({
    data: [
      {
        utilityId: fixA.utilityId,
        servicePointId: sp.id,
        meterId: fixA.meterId,
        addedDate: new Date("2024-01-01"),
      },
      {
        utilityId: fixA.utilityId,
        servicePointId: sp.id,
        meterId: fixA.meterId2,
        addedDate: new Date("2024-01-01"),
      },
      {
        utilityId: fixA.utilityId,
        servicePointId: sp.id,
        meterId: fixA.meterId3,
        addedDate: new Date("2024-01-01"),
      },
    ],
  });

  return sa;
}

describe("closeServiceAgreement (real DB)", () => {
  it("happy path: cascades removed_date onto all 3 open SPMs and emits 4 audit rows", async () => {
    const { prisma } = prismaImports;
    const { closeServiceAgreement } = serviceImports;

    const sa = await makeSaWithThreeMeters();
    const endDate = new Date("2024-12-31");

    const result = await closeServiceAgreement(fixA.utilityId, ACTOR, "Tester", {
      saId: sa.id,
      endDate,
      status: "FINAL",
      reason: "End-to-end test",
    });

    expect(result.metersClosed).toBe(3);

    const reloaded = await prisma.serviceAgreement.findUniqueOrThrow({ where: { id: sa.id } });
    expect(reloaded.status).toBe("FINAL");
    expect(reloaded.endDate?.toISOString().slice(0, 10)).toBe("2024-12-31");

    const spms = await prisma.servicePointMeter.findMany({
      where: { servicePoint: { serviceAgreementId: sa.id } },
    });
    expect(spms).toHaveLength(3);
    for (const spm of spms) {
      expect(spm.removedDate?.toISOString().slice(0, 10)).toBe("2024-12-31");
    }

    const audits = await prisma.auditLog.findMany({
      where: { utilityId: fixA.utilityId },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(4);
    expect(audits.filter((a) => a.entityType === "ServiceAgreement")).toHaveLength(1);
    expect(audits.filter((a) => a.entityType === "ServicePointMeter")).toHaveLength(3);
  });

  it("is idempotent: re-closing with the same terminal status + endDate is a no-op (no extra audits)", async () => {
    const { prisma } = prismaImports;
    const { closeServiceAgreement } = serviceImports;

    const sa = await makeSaWithThreeMeters();
    const endDate = new Date("2024-12-31");

    await closeServiceAgreement(fixA.utilityId, ACTOR, "Tester", {
      saId: sa.id, endDate, status: "FINAL",
    });
    const auditsAfterFirst = await prisma.auditLog.count({ where: { utilityId: fixA.utilityId } });

    const second = await closeServiceAgreement(fixA.utilityId, ACTOR, "Tester", {
      saId: sa.id, endDate, status: "FINAL",
    });
    expect(second.metersClosed).toBe(0);

    const auditsAfterSecond = await prisma.auditLog.count({ where: { utilityId: fixA.utilityId } });
    expect(auditsAfterSecond).toBe(auditsAfterFirst);
  });

  it("supports FINAL → CLOSED as a status-only step (final bill issued; no further cascade)", async () => {
    const { prisma } = prismaImports;
    const { closeServiceAgreement } = serviceImports;

    const sa = await makeSaWithThreeMeters();
    const endDate = new Date("2024-12-31");

    await closeServiceAgreement(fixA.utilityId, ACTOR, "Tester", {
      saId: sa.id, endDate, status: "FINAL",
    });
    const auditsAfterFinal = await prisma.auditLog.count({ where: { utilityId: fixA.utilityId } });

    const result = await closeServiceAgreement(fixA.utilityId, ACTOR, "Tester", {
      saId: sa.id, endDate, status: "CLOSED",
    });
    expect(result.metersClosed).toBe(0); // already cascaded at FINAL

    const reloaded = await prisma.serviceAgreement.findUniqueOrThrow({ where: { id: sa.id } });
    expect(reloaded.status).toBe("CLOSED");
    expect(reloaded.endDate?.toISOString().slice(0, 10)).toBe("2024-12-31");

    // Exactly one new audit row for the CLOSED transition.
    const auditsAfterClosed = await prisma.auditLog.count({ where: { utilityId: fixA.utilityId } });
    expect(auditsAfterClosed - auditsAfterFinal).toBe(1);
  });

  it("rejects re-closing an already-CLOSED SA", async () => {
    const { closeServiceAgreement } = serviceImports;

    const sa = await makeSaWithThreeMeters();
    const endDate = new Date("2024-12-31");

    await closeServiceAgreement(fixA.utilityId, ACTOR, "Tester", {
      saId: sa.id, endDate, status: "FINAL",
    });
    await closeServiceAgreement(fixA.utilityId, ACTOR, "Tester", {
      saId: sa.id, endDate, status: "CLOSED",
    });

    await expect(
      closeServiceAgreement(fixA.utilityId, ACTOR, "Tester", {
        saId: sa.id, endDate, status: "CLOSED",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SA_ALREADY_TERMINAL" });
  });

  it("skips already-removed SPMs (cascade only touches removedDate IS NULL rows)", async () => {
    const { prisma } = prismaImports;
    const { closeServiceAgreement } = serviceImports;

    const sa = await makeSaWithThreeMeters();
    // Pre-close meter1 with an earlier removedDate.
    const spm1 = await prisma.servicePointMeter.findFirstOrThrow({
      where: { servicePoint: { serviceAgreementId: sa.id }, meterId: fixA.meterId },
    });
    await prisma.servicePointMeter.update({
      where: { id: spm1.id },
      data: { removedDate: new Date("2024-06-30") },
    });

    const result = await closeServiceAgreement(fixA.utilityId, ACTOR, "Tester", {
      saId: sa.id,
      endDate: new Date("2024-12-31"),
      status: "FINAL",
    });

    // Only the 2 still-open SPMs got cascaded.
    expect(result.metersClosed).toBe(2);

    const spm1After = await prisma.servicePointMeter.findUniqueOrThrow({
      where: { id: spm1.id },
    });
    // The pre-closed meter retains its earlier removedDate, NOT 2024-12-31.
    expect(spm1After.removedDate?.toISOString().slice(0, 10)).toBe("2024-06-30");
  });

  it("mid-tx failure rolls everything back (SA stays ACTIVE, all SPMs stay open)", async () => {
    const { prisma } = prismaImports;
    const { closeServiceAgreement } = serviceImports;

    const sa = await makeSaWithThreeMeters();

    // Provide an existingTx that throws AFTER closeServiceAgreement
    // returns. Postgres rolls back the whole outer transaction.
    await expect(
      prisma.$transaction(async (tx) => {
        await closeServiceAgreement(
          fixA.utilityId,
          ACTOR,
          "Tester",
          { saId: sa.id, endDate: new Date("2024-12-31"), status: "FINAL" },
          tx,
        );
        throw new Error("forced rollback after cascade");
      }),
    ).rejects.toThrow("forced rollback after cascade");

    // Post-rollback: SA still ACTIVE, no endDate, all SPMs still open,
    // no audit rows written for the SA or its SPMs.
    const reloaded = await prisma.serviceAgreement.findUniqueOrThrow({ where: { id: sa.id } });
    expect(reloaded.status).toBe("ACTIVE");
    expect(reloaded.endDate).toBeNull();

    const spms = await prisma.servicePointMeter.findMany({
      where: { servicePoint: { serviceAgreementId: sa.id } },
    });
    for (const spm of spms) {
      expect(spm.removedDate).toBeNull();
    }

    const audits = await prisma.auditLog.count({ where: { utilityId: fixA.utilityId } });
    expect(audits).toBe(0);
  });

  it("DB-level lifecycle trigger blocks a generic UPDATE that tries to bypass the helper", async () => {
    const { prisma } = prismaImports;

    const sa = await makeSaWithThreeMeters();

    // A caller that bypasses closeServiceAgreement and tries the
    // unsafe direct UPDATE path is rejected by the trigger. This
    // confirms the second line of defense actually fires.
    await expect(
      prisma.serviceAgreement.update({
        where: { id: sa.id },
        data: { status: "FINAL" }, // no endDate
      }),
    ).rejects.toThrow(/SA_LIFECYCLE_INVARIANT_VIOLATION/);
  });
});
