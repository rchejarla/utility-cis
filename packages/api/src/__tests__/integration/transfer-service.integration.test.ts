import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { runAsTenant } from "../../lib/tenant-context.js";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  ACTOR,
  type TenantFixture,
  endAdminPool,
  seedAsPlatform,
  serviceClassFor,
} from "./_effective-dating-fixtures.js";

/**
 * Real-database verification of `transferService`.
 *
 * **This workflow had no test of any kind until 2026-11-18** — not thin
 * coverage, zero, in either vitest config (spec 05 open item 4). That is
 * why its own doc comment could describe four cloned fields while the
 * code carried one, and why three product decisions sat unnoticed inside
 * it for as long as they did.
 *
 * Against a container rather than the mocked unit config, because every
 * question worth asking here is *which rows exist afterwards*: which
 * premise each new service point sits at, which meters hang off it, and
 * whether a rate-schedule assignment was written. A mocked Prisma can
 * only confirm that this file's author expected `servicePoint.create` to
 * be called twice — which is a test of the test.
 *
 * What each case pins:
 *   1. The ordinary one-premise transfer: one point, its meter, the
 *      source FINAL, the new agreement on the target account.
 *   2. Two premises are mirrored, each keeping its own meter. This is
 *      the case that was silently wrong: before the mirror, premise B's
 *      meter came out attached to a point at premise A.
 *   3. The in-force rate-schedule assignment is carried.
 *   4. `transferCarriesRateSchedule = false` leaves the new agreement
 *      unrated.
 *   5. An assignment that had already expired is NOT carried.
 *   6. A transfer to the account that already holds the agreement is
 *      refused, and nothing is written.
 *   7. A single reading against a two-meter agreement is refused.
 *   8. An agreement with no open service point is refused.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let serviceImports: typeof import("../../services/workflows.service.js");
let fixA: TenantFixture;

/** A second premise, and the account a transfer targets. */
let premiseB: string;
let targetAccountId: string;
let rateScheduleId: string;

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  serviceImports = await import("../../services/workflows.service.js");
}, 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that is
  // the driver-adapter contract — so the pools are ended explicitly.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 after an otherwise green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await resetDb();
  fixA = await makeTenantFixture(prisma, TENANT_A);

  await seedAsPlatform(async () => {
    const premise = await prisma.premise.create({
      data: {
        utilityId: fixA.utilityId,
        addressLine1: "2 Second Street",
        city: "Testville",
        state: "TS",
        zip: "00000",
        premiseType: "RESIDENTIAL",
        commodityIds: [fixA.commodityId],
        status: "ACTIVE",
      },
    });
    premiseB = premise.id;

    const target = await prisma.account.create({
      data: {
        utilityId: fixA.utilityId,
        accountNumber: "ACCT-TARGET",
        accountType: "RESIDENTIAL",
        status: "ACTIVE",
        billingCycleId: fixA.billingCycleId,
        depositAmount: 0,
      },
    });
    targetAccountId = target.id;

    // `makeTenantFixture` creates one schedule but does not return its
    // id, and the assignment cases need it.
    const schedule = await prisma.rateSchedule.findFirstOrThrow({
      where: { utilityId: fixA.utilityId },
      select: { id: true },
    });
    rateScheduleId = schedule.id;
  });
});

/**
 * `transferService` as a route reaches it: inside the acting tenant's
 * scope, which is what `lib/prisma.ts` reads to pick a pool and set
 * `app.current_utility_id`.
 *
 * Called through `serviceImports.` rather than destructured, so a sweep
 * for the module name finds the call sites.
 */
const transferService = (...args: Parameters<typeof serviceImports.transferService>) =>
  runAsTenant(args[0], async () => serviceImports.transferService(...args));

/**
 * An agreement with one service point per premise listed, each holding
 * the meter given for it.
 *
 * Written through the platform role because fixtures are not the thing
 * under test — the call under test re-enters its own tenant scope.
 */
async function makeAgreement(
  points: { premiseId: string; meterId: string }[],
  opts: { number?: string } = {},
) {
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: fixA.utilityId,
        agreementNumber: opts.number ?? "SA-TRANSFER",
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        rateServiceClassId: await serviceClassFor(prisma, fixA.utilityId, fixA.commodityId),
        startDate: new Date("2024-01-01"),
        status: "ACTIVE",
      },
    });

    for (const [index, point] of points.entries()) {
      const sp = await prisma.servicePoint.create({
        data: {
          utilityId: fixA.utilityId,
          serviceAgreementId: sa.id,
          premiseId: point.premiseId,
          type: "METERED",
          status: "ACTIVE",
          // Staggered, so "oldest point first" has something to order
          // by and the mirrored agreement's point order is checkable.
          startDate: new Date(`2024-0${index + 1}-01`),
        },
      });
      await prisma.servicePointMeter.create({
        data: {
          utilityId: fixA.utilityId,
          servicePointId: sp.id,
          meterId: point.meterId,
          addedDate: new Date(`2024-0${index + 1}-01`),
        },
      });
    }

    return sa;
  });
}

/** Two meters on one point — the shape case 7 refuses a reading for. */
async function makeTwoMeterAgreement() {
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: fixA.utilityId,
        agreementNumber: "SA-TWO-METERS",
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        rateServiceClassId: await serviceClassFor(prisma, fixA.utilityId, fixA.commodityId),
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
          addedDate: new Date("2024-02-01"),
        },
      ],
    });
    return sa;
  });
}

/** The points of an agreement, each with its premise and its meters. */
async function pointsOf(agreementId: string) {
  const { prisma } = prismaImports;
  return seedAsPlatform(async () =>
    prisma.servicePoint.findMany({
      where: { serviceAgreementId: agreementId },
      orderBy: { startDate: "asc" },
      include: { meters: { orderBy: { addedDate: "asc" } } },
    }),
  );
}

const TRANSFER_DATE = "2024-07-01";

describe("transferService (real DB)", () => {
  it("transfers a one-premise agreement: new agreement on the target, point at the same premise", async () => {
    const { prisma } = prismaImports;
    const sa = await makeAgreement([{ premiseId: fixA.premiseId, meterId: fixA.meterId }]);

    const result = await transferService(fixA.utilityId, ACTOR, "Tester", sa.id, {
      targetAccountId,
      transferDate: TRANSFER_DATE,
    });

    expect(result.source.status).toBe("FINAL");
    expect(result.source.endDate?.toISOString().slice(0, 10)).toBe(TRANSFER_DATE);
    expect(result.target.accountId).toBe(targetAccountId);
    expect(result.target.status).toBe("ACTIVE");
    expect(result.target.commodityId).toBe(fixA.commodityId);

    const points = await pointsOf(result.target.id);
    expect(points).toHaveLength(1);
    expect(points[0].premiseId).toBe(fixA.premiseId);
    expect(points[0].meters.map((m) => m.meterId)).toEqual([fixA.meterId]);
    expect(points[0].startDate.toISOString().slice(0, 10)).toBe(TRANSFER_DATE);

    // The source's own assignments are closed by the cascade, so its
    // meter does not read as still being served there.
    const sourcePoints = await pointsOf(sa.id);
    for (const spm of sourcePoints.flatMap((p) => p.meters)) {
      expect(spm.removedDate?.toISOString().slice(0, 10)).toBe(TRANSFER_DATE);
    }

    /*
     * `entityType`, not the action: `writeAuditRow` derives `action`
     * from the event-type suffix, and "workflow.transfer_service" ends
     * in none of the four it recognises, so the row's action is a plain
     * UPDATE. The event type itself lives in `metadata.eventType` and
     * the payload in `afterState`.
     */
    await seedAsPlatform(async () => {
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { utilityId: fixA.utilityId, entityType: "Workflow" },
      });
      expect((audit.metadata as Record<string, unknown>).eventType).toBe(
        "workflow.transfer_service",
      );
      const after = audit.afterState as Record<string, unknown>;
      expect(after.servicePointsMirrored).toBe(1);
      expect(after.rateScheduleAssignmentsCarried).toBe(0);
    });
  });

  /*
   * The case the flatten got wrong.
   *
   * Before 2026-11-18 this produced ONE point, at premise A, holding
   * both meters — so meter 2 was recorded as serving an address it is
   * not installed at. The assertion that distinguishes the two outcomes
   * is the premise each meter ends up under, not the number of points:
   * a mirror that put both points at premise A would still make two.
   */
  it("mirrors every open service point, each keeping its own premise and meter", async () => {
    const sa = await makeAgreement([
      { premiseId: fixA.premiseId, meterId: fixA.meterId },
      { premiseId: premiseB, meterId: fixA.meterId2 },
    ]);

    const result = await transferService(fixA.utilityId, ACTOR, "Tester", sa.id, {
      targetAccountId,
      transferDate: TRANSFER_DATE,
    });

    const points = await pointsOf(result.target.id);
    expect(points).toHaveLength(2);

    // Each meter under the premise it is actually installed at.
    const byPremise = new Map(
      points.map((p) => [p.premiseId, p.meters.map((m) => m.meterId)]),
    );
    expect(byPremise.get(fixA.premiseId)).toEqual([fixA.meterId]);
    expect(byPremise.get(premiseB)).toEqual([fixA.meterId2]);
  });

  it("carries the rate-schedule assignment in force on the transfer date", async () => {
    const { prisma } = prismaImports;
    const sa = await makeAgreement([{ premiseId: fixA.premiseId, meterId: fixA.meterId }]);
    await seedAsPlatform(async () => {
      await prisma.sAScheduleAssignment.create({
        data: {
          utilityId: fixA.utilityId,
          serviceAgreementId: sa.id,
          rateScheduleId,
          roleCode: "primary",
          effectiveDate: new Date("2024-01-01"),
          expirationDate: null,
        },
      });
    });

    const result = await transferService(fixA.utilityId, ACTOR, "Tester", sa.id, {
      targetAccountId,
      transferDate: TRANSFER_DATE,
    });

    const carried = await seedAsPlatform(async () =>
      prisma.sAScheduleAssignment.findMany({
        where: { serviceAgreementId: result.target.id },
      }),
    );
    expect(carried).toHaveLength(1);
    expect(carried[0].rateScheduleId).toBe(rateScheduleId);
    expect(carried[0].roleCode).toBe("primary");
    // Dated from the transfer, not from the source's effective date: the
    // new agreement did not exist in January.
    expect(carried[0].effectiveDate.toISOString().slice(0, 10)).toBe(TRANSFER_DATE);
  });

  /*
   * A rate change the source already had booked: the in-force tariff ends
   * in August and the next starts in September. Only the first was carried
   * until 2026-11-27, so the new agreement lost the booked change and
   * stayed on the old tariff. The scheduled one keeps its own start date.
   */
  it("carries a rate change the source had scheduled for after the transfer", async () => {
    const { prisma } = prismaImports;
    const sa = await makeAgreement([{ premiseId: fixA.premiseId, meterId: fixA.meterId }]);
    await seedAsPlatform(async () => {
      await prisma.sAScheduleAssignment.create({
        data: {
          utilityId: fixA.utilityId,
          serviceAgreementId: sa.id,
          rateScheduleId,
          roleCode: "primary",
          effectiveDate: new Date("2024-01-01"),
          expirationDate: new Date("2024-08-31"),
        },
      });
      await prisma.sAScheduleAssignment.create({
        data: {
          utilityId: fixA.utilityId,
          serviceAgreementId: sa.id,
          rateScheduleId,
          roleCode: "primary",
          effectiveDate: new Date("2024-09-01"),
          expirationDate: null,
        },
      });
    });

    const result = await transferService(fixA.utilityId, ACTOR, "Tester", sa.id, {
      targetAccountId,
      transferDate: TRANSFER_DATE,
    });

    const carried = await seedAsPlatform(async () =>
      prisma.sAScheduleAssignment.findMany({
        where: { serviceAgreementId: result.target.id },
        orderBy: { effectiveDate: "asc" },
      }),
    );
    expect(
      carried.map((a) => [
        a.effectiveDate.toISOString().slice(0, 10),
        a.expirationDate?.toISOString().slice(0, 10) ?? null,
      ]),
    ).toEqual([
      [TRANSFER_DATE, "2024-08-31"],
      ["2024-09-01", null],
    ]);
  });

  it("carries nothing when the tenant has turned the carry off", async () => {
    const { prisma } = prismaImports;
    const sa = await makeAgreement([{ premiseId: fixA.premiseId, meterId: fixA.meterId }]);
    await seedAsPlatform(async () => {
      await prisma.sAScheduleAssignment.create({
        data: {
          utilityId: fixA.utilityId,
          serviceAgreementId: sa.id,
          rateScheduleId,
          roleCode: "primary",
          effectiveDate: new Date("2024-01-01"),
        },
      });
      await prisma.utilityConfig.update({
        where: { utilityId: fixA.utilityId },
        data: { transferCarriesRateSchedule: false },
      });
    });

    const result = await transferService(fixA.utilityId, ACTOR, "Tester", sa.id, {
      targetAccountId,
      transferDate: TRANSFER_DATE,
    });

    const carried = await seedAsPlatform(async () =>
      prisma.sAScheduleAssignment.findMany({
        where: { serviceAgreementId: result.target.id },
      }),
    );
    expect(carried).toHaveLength(0);
  });

  it("does not carry an assignment that had already expired", async () => {
    const { prisma } = prismaImports;
    const sa = await makeAgreement([{ premiseId: fixA.premiseId, meterId: fixA.meterId }]);
    await seedAsPlatform(async () => {
      await prisma.sAScheduleAssignment.create({
        data: {
          utilityId: fixA.utilityId,
          serviceAgreementId: sa.id,
          rateScheduleId,
          roleCode: "primary",
          effectiveDate: new Date("2024-01-01"),
          // Ended before the transfer date.
          expirationDate: new Date("2024-03-31"),
        },
      });
    });

    const result = await transferService(fixA.utilityId, ACTOR, "Tester", sa.id, {
      targetAccountId,
      transferDate: TRANSFER_DATE,
    });

    const carried = await seedAsPlatform(async () =>
      prisma.sAScheduleAssignment.findMany({
        where: { serviceAgreementId: result.target.id },
      }),
    );
    expect(carried).toHaveLength(0);
  });

  it("refuses a transfer to the account that already holds the agreement, and writes nothing", async () => {
    const { prisma } = prismaImports;
    const sa = await makeAgreement([{ premiseId: fixA.premiseId, meterId: fixA.meterId }]);

    await expect(
      transferService(fixA.utilityId, ACTOR, "Tester", sa.id, {
        // The account the fixture agreement is already on.
        targetAccountId: fixA.accountId,
        transferDate: TRANSFER_DATE,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "TRANSFER_TO_SAME_ACCOUNT" });

    // Still ACTIVE, still one agreement, no audit row: the refusal has
    // to land before the close, not after it.
    await seedAsPlatform(async () => {
      const after = await prisma.serviceAgreement.findUniqueOrThrow({ where: { id: sa.id } });
      expect(after.status).toBe("ACTIVE");
      expect(after.endDate).toBeNull();
      expect(await prisma.serviceAgreement.count({ where: { utilityId: fixA.utilityId } })).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { utilityId: fixA.utilityId, entityType: "Workflow" },
        }),
      ).toBe(0);
    });
  });

  it("refuses one reading for an agreement with two meters", async () => {
    const sa = await makeTwoMeterAgreement();

    await expect(
      transferService(fixA.utilityId, ACTOR, "Tester", sa.id, {
        targetAccountId,
        transferDate: TRANSFER_DATE,
        finalMeterReading: 4210,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "TRANSFER_READING_AMBIGUOUS" });

    // The same transfer without a reading is fine — the refusal is about
    // the number, not about the agreement.
    const result = await transferService(fixA.utilityId, ACTOR, "Tester", sa.id, {
      targetAccountId,
      transferDate: TRANSFER_DATE,
    });
    const points = await pointsOf(result.target.id);
    expect(points).toHaveLength(1);
    expect(points[0].meters.map((m) => m.meterId).sort()).toEqual(
      [fixA.meterId, fixA.meterId2].sort(),
    );
  });

  it("refuses an agreement with no open service point", async () => {
    const { prisma } = prismaImports;
    const sa = await makeAgreement([{ premiseId: fixA.premiseId, meterId: fixA.meterId }]);
    await seedAsPlatform(async () => {
      await prisma.servicePoint.updateMany({
        where: { serviceAgreementId: sa.id },
        data: { endDate: new Date("2024-06-01") },
      });
    });

    await expect(
      transferService(fixA.utilityId, ACTOR, "Tester", sa.id, {
        targetAccountId,
        transferDate: TRANSFER_DATE,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "SOURCE_AGREEMENT_NO_PREMISE" });
  });
});
