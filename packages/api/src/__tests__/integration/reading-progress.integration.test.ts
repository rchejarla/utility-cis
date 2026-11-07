import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  TENANT_B,
  type TenantFixture,
  endAdminPool,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/**
 * How far along a cycle's reading is (spec 08).
 *
 * **A list of reads cannot answer this.** The rows you want are the
 * ones that do not exist, so the read log is structurally incapable of
 * it — and it is the question that decides whether a cycle can bill.
 * Before this the only way to find out was to start a run and read the
 * skips, one `NO_READ_IN_WINDOW` per account, after the run had been
 * created and the window closed behind it.
 *
 * Asserted against real rows rather than a mocked client because every
 * part of it is a join: the cycle lives on the account, the account on
 * the agreement, the agreement on a service point, and the meter on an
 * assignment to that point. A mock would prove the shape of a query I
 * wrote, not that it finds the right meters.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/reading-progress.service.js");

let fixA: TenantFixture;

/** The 10th is R01's bill day in the fixture, so this window is Jan 11 – Feb 10. */
const AS_OF = "2026-02-15";
const WINDOW_START = new Date("2026-01-11T00:00:00.000Z");

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/reading-progress.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    await resetDb();
    fixA = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  }));

/**
 * One service: an agreement, a point, and a meter assigned to it — the
 * chain the progress query walks.
 */
async function service(opts: {
  utilityId?: string;
  fix?: TenantFixture;
  agreementNumber: string;
  meterId: string;
  status?: "PENDING" | "ACTIVE" | "FINAL" | "CLOSED";
  endDate?: Date | null;
  removedDate?: Date | null;
}): Promise<string> {
  const fix = opts.fix ?? fixA;
  const utilityId = opts.utilityId ?? fix.utilityId;
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const agreement = await prisma.serviceAgreement.create({
      data: {
        utilityId,
        agreementNumber: opts.agreementNumber,
        accountId: fix.accountId,
        commodityId: fix.commodityId,
        startDate: new Date("2025-01-01"),
        endDate: opts.endDate ?? null,
        status: opts.status ?? "ACTIVE",
      },
      select: { id: true },
    });
    const point = await prisma.servicePoint.create({
      data: {
        utilityId,
        serviceAgreementId: agreement.id,
        premiseId: fix.premiseId,
        startDate: new Date("2025-01-01"),
      },
      select: { id: true },
    });
    await prisma.servicePointMeter.create({
      data: {
        utilityId,
        servicePointId: point.id,
        meterId: opts.meterId,
        addedDate: new Date("2025-01-01"),
        removedDate: opts.removedDate ?? null,
      },
    });
    return agreement.id;
  });
}

async function seedRead(meterId: string, saId: string, readDate: string): Promise<void> {
  await seedAsPlatform(async () => {
    await prismaImports.prisma.meterRead.create({
      data: {
        utilityId: TENANT_A,
        meterId,
        serviceAgreementId: saId,
        uomId: fixA.uomId,
        readDate: new Date(readDate),
        readDatetime: new Date(readDate),
        reading: 100,
        priorReading: 50,
        consumption: 50,
        readType: "ACTUAL",
        readSource: "AMR",
      },
    });
  });
}

const progress = (over: Record<string, unknown> = {}) =>
  runAsTenant(TENANT_A, () =>
    svc.getReadingProgress(TENANT_A, {
      billingCycleId: fixA.billingCycleId,
      page: 1,
      limit: 50,
      asOf: AS_OF,
      ...over,
    } as Parameters<typeof svc.getReadingProgress>[1]),
  );

describe("a cycle nobody has read yet", () => {
  it("counts every service it expects a read for, and names them", async () => {
    await service({ agreementNumber: "SA-P1", meterId: fixA.meterId });
    await service({ agreementNumber: "SA-P2", meterId: fixA.meterId2 });

    const p = await progress();

    expect(p).toMatchObject({ expected: 2, read: 0, outstanding: 2 });
    expect(p.data.map((r) => r.agreementNumber).sort()).toEqual(["SA-P1", "SA-P2"]);
  });

  it("states the window it is talking about, from the cycle's own bill day", async () => {
    await service({ agreementNumber: "SA-P1", meterId: fixA.meterId });

    const p = await progress();

    // The same window `planBillingRun` would pick for this date, which
    // is the point of sharing `computeBillPeriod`: a progress screen
    // that measured a different month would be worse than none.
    expect(p.windowStart.toISOString()).toBe(WINDOW_START.toISOString());
    expect(p.windowEnd.toISOString()).toBe("2026-02-10T00:00:00.000Z");
  });

  it("carries the premise and the last read, which say new or stuck", async () => {
    const sa = await service({ agreementNumber: "SA-P1", meterId: fixA.meterId });
    await seedRead(fixA.meterId, sa, "2025-11-08");

    const p = await progress();

    expect(p.outstanding).toBe(1);
    expect(p.data[0]!.premise).toContain(",");
    expect(p.data[0]!.lastReadDate?.toISOString().slice(0, 10)).toBe("2025-11-08");
  });

  it("says nothing was ever read when nothing was", async () => {
    await service({ agreementNumber: "SA-P1", meterId: fixA.meterId });

    const p = await progress();

    expect(p.data[0]!.lastReadDate).toBeNull();
  });
});

describe("what counts as read", () => {
  it("drops a service whose meter was read inside the window", async () => {
    const sa = await service({ agreementNumber: "SA-P1", meterId: fixA.meterId });
    await service({ agreementNumber: "SA-P2", meterId: fixA.meterId2 });
    await seedRead(fixA.meterId, sa, "2026-02-08");

    const p = await progress();

    expect(p).toMatchObject({ expected: 2, read: 1, outstanding: 1 });
    expect(p.data[0]!.agreementNumber).toBe("SA-P2");
  });

  it("keeps one whose only read predates the window", async () => {
    const sa = await service({ agreementNumber: "SA-P1", meterId: fixA.meterId });
    // Three days before the window opens: last month's reading, which
    // says nothing about whether this month's has been taken.
    await seedRead(fixA.meterId, sa, "2026-01-08");

    const p = await progress();

    expect(p.outstanding).toBe(1);
  });

  it("counts an interval meter as read when it has intervals and no read row", async () => {
    /*
     * An AMI meter has no `meter_read` until the roll-up runs inside a
     * billing run. Asking only about reads would list every interval
     * meter as outstanding — hundreds of rows needing no action, which
     * is how a readiness screen teaches people to ignore it.
     */
    await service({ agreementNumber: "SA-AMI", meterId: fixA.meterId });
    await seedAsPlatform(async () => {
      await prismaImports.prisma.meterReadInterval.create({
        data: {
          utilityId: TENANT_A,
          meterId: fixA.meterId,
          uomId: fixA.uomId,
          intervalStart: new Date("2026-02-01T00:00:00.000Z"),
          lengthMinutes: 60,
          quantity: "1.2500",
          quality: "actual",
        },
      });
    });

    const p = await progress();

    expect(p).toMatchObject({ expected: 1, read: 1, outstanding: 0 });
  });
});

describe("what a cycle is not expected to read", () => {
  it("ignores a meter whose assignment has been removed", async () => {
    await service({
      agreementNumber: "SA-GONE",
      meterId: fixA.meterId,
      removedDate: new Date("2025-06-01"),
    });

    expect(await progress()).toMatchObject({ expected: 0, outstanding: 0 });
  });

  it("ignores one that ended before the window opened", async () => {
    await service({
      agreementNumber: "SA-ENDED",
      meterId: fixA.meterId,
      endDate: new Date("2025-12-31"),
    });

    expect(await progress()).toMatchObject({ expected: 0 });
  });

  /*
   * Mirrors the run rather than correcting it.
   *
   * `billOneAccount` bills agreements still open at the window's *end*,
   * so one that closed on the 20th of a window ending on the 10th of
   * the next month is never billed by a cycle run — and listing it as
   * an outstanding read would send somebody to read a meter for a bill
   * that is not coming.
   *
   * It is also a defect, recorded in spec 08 and not fixed here: that
   * service used water from the 11th to the 20th, `findRunBlockers`
   * checks it (`endDate >= windowStart`) while the executor skips it
   * (`>= windowEnd`), and the two cannot both be right.
   */
  it("does not expect one that closed mid-window, because no run will bill it", async () => {
    await service({
      agreementNumber: "SA-CLOSING",
      meterId: fixA.meterId,
      endDate: new Date("2026-01-20"),
    });

    expect(await progress()).toMatchObject({ expected: 0, outstanding: 0 });
  });

  it("refuses a cycle that is not this tenant's", async () => {
    const otherFix = await seedAsPlatform(() =>
      makeTenantFixture(prismaImports.prisma, TENANT_B),
    );

    await expect(progress({ billingCycleId: otherFix.billingCycleId })).rejects.toMatchObject({
      statusCode: 404,
      code: "CYCLE_NOT_FOUND",
    });
  });
});
