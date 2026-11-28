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
  serviceClassFor,
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
  /** Default to the fixture's premise and account. */
  premiseId?: string;
  accountId?: string;
}): Promise<string> {
  const fix = opts.fix ?? fixA;
  const utilityId = opts.utilityId ?? fix.utilityId;
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const agreement = await prisma.serviceAgreement.create({
      data: {
        utilityId,
        agreementNumber: opts.agreementNumber,
        accountId: opts.accountId ?? fix.accountId,
        commodityId: fix.commodityId,
        rateServiceClassId: await serviceClassFor(prisma, utilityId, fix.commodityId),
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
        premiseId: opts.premiseId ?? fix.premiseId,
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

async function seedRead(
  meterId: string,
  saId: string,
  readDate: string,
  over: { routeId?: string; registerId?: string } = {},
): Promise<void> {
  await seedAsPlatform(async () => {
    await prismaImports.prisma.meterRead.create({
      data: {
        utilityId: TENANT_A,
        meterId,
        serviceAgreementId: saId,
        uomId: fixA.uomId,
        readDate: new Date(readDate),
        readDatetime: new Date(readDate),
        routeId: over.routeId ?? null,
        registerId: over.registerId ?? null,
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
    // Its own premise: two live agreements for one commodity at one
    // premise is what `one_live_service_per_premise` refuses.
    await service({ agreementNumber: "SA-P2", meterId: fixA.meterId2, premiseId: await extraPremise("P2") });

    const p = await progress();

    expect(p).toMatchObject({ expected: 2, read: 0, outstanding: 2 });
    expect(p.data.map((r) => r.agreementNumber).sort()).toEqual(["SA-P1", "SA-P2"]);
  });

  it("states the window it is talking about, from the cycle's own bill day", async () => {
    await service({ agreementNumber: "SA-P1", meterId: fixA.meterId });

    const p = await progress();

    /*
     * The same window `planBillingRun` would pick for this date, which
     * is the point of sharing `computeBillPeriod`: a progress screen
     * measuring a different month would be worse than none.
     *
     * As ISO strings, because that is what the service returns — its
     * type is the shared wire schema's, so what this asserts is what
     * the browser will actually receive.
     */
    expect(p.windowStart).toBe(WINDOW_START.toISOString());
    expect(p.windowEnd).toBe("2026-02-10T00:00:00.000Z");
  });

  it("carries the premise and the last read, which say new or stuck", async () => {
    const sa = await service({ agreementNumber: "SA-P1", meterId: fixA.meterId });
    await seedRead(fixA.meterId, sa, "2025-11-08");

    const p = await progress();

    expect(p.outstanding).toBe(1);
    expect(p.data[0]!.premise).toContain(",");
    expect(p.data[0]!.lastReadDate?.slice(0, 10)).toBe("2025-11-08");
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
    await service({ agreementNumber: "SA-P2", meterId: fixA.meterId2, premiseId: await extraPremise("P2") });
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
   * Mirrors the run — which changed on 2026-11-08, so this assertion
   * turned over with it.
   *
   * A service that closed on the 20th of a window ending on the 10th of
   * the next month used water from the 11th to the 20th, and no run
   * would bill it: the executor wanted an agreement still open at the
   * window's *end* while the planner only wanted an overlap, so the
   * account came back `SKIPPED` with `NO_ACTIVE_ASSIGNMENTS`. This test
   * asserted that behaviour, and its own comment called it a defect.
   *
   * The run bills it now, from one shared filter
   * (`billing-run/window.ts`), so a read for that service is genuinely
   * outstanding — and saying which reads a run is waiting on is the
   * whole job of this screen. The coupling held: fixing the run flipped
   * this screen without anybody editing it, which is why it mirrors the
   * run rather than keeping its own opinion.
   */
  it("expects one that closed mid-window, because the run bills it now", async () => {
    await service({
      agreementNumber: "SA-CLOSING",
      meterId: fixA.meterId,
      endDate: new Date("2026-01-20"),
    });

    expect(await progress()).toMatchObject({ expected: 1, outstanding: 1 });
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

/*
 * ─── Per route (read routes design §5.9) ─────────────────────────────
 *
 * Window for AS_OF is Jan 11 – Feb 10, so the previous one, which an
 * EXTERNAL route's membership is learned from, is Dec 11 – Jan 10.
 */

/** A second premise in the fixture's tenant. */
async function extraPremise(label: string): Promise<string> {
  return seedAsPlatform(async () => {
    const p = await prismaImports.prisma.premise.create({
      data: {
        utilityId: TENANT_A,
        addressLine1: `9 ${label} Road`,
        city: "Testville",
        state: "TS",
        zip: "00000",
        premiseType: "RESIDENTIAL",
        commodityIds: [fixA.commodityId],
        status: "ACTIVE",
      },
    });
    return p.id;
  });
}

async function route(opts: {
  code: string;
  origin?: "LOCAL" | "EXTERNAL";
  stops?: string[];
  billingCycleId?: string;
}): Promise<string> {
  return seedAsPlatform(async () => {
    const r = await prismaImports.prisma.readRoute.create({
      data: {
        utilityId: TENANT_A,
        code: opts.code,
        name: opts.code,
        billingCycleId: opts.billingCycleId ?? fixA.billingCycleId,
        origin: opts.origin ?? "LOCAL",
      },
    });
    for (const [i, premiseId] of (opts.stops ?? []).entries()) {
      await prismaImports.prisma.readRouteStop.create({
        data: { utilityId: TENANT_A, readRouteId: r.id, premiseId, sequence: i + 1 },
      });
    }
    return r.id;
  });
}

async function skip(meterId: string, reason: string, resolved = false): Promise<void> {
  await seedAsPlatform(async () => {
    await prismaImports.prisma.readSkip.create({
      data: {
        utilityId: TENANT_A,
        meterId,
        readDate: new Date("2026-02-05"),
        skipReason: reason,
        resolvedAt: resolved ? new Date("2026-02-06T00:00:00Z") : null,
      },
    });
  });
}

describe("progress for one LOCAL route", () => {
  it("counts only the stops on the named route, not the whole cycle", async () => {
    /*
     * Fails if the stop scoping (`readableRowsForPremises(..., stopPremiseIds, ...)`)
     * is deleted: the off-route service on the same cycle would count.
     */
    const offRoute = await extraPremise("Off");
    await service({ agreementNumber: "SA-ON", meterId: fixA.meterId });
    await service({
      agreementNumber: "SA-OFF",
      meterId: fixA.meterId2,
      premiseId: offRoute,
    });
    const r = await route({ code: "R-ON", stops: [fixA.premiseId] });

    const perRoute = await progress({ readRouteId: r });
    const cycleWide = await progress();

    expect(perRoute).toMatchObject({ expected: 1, read: 0, outstanding: 1 });
    expect(perRoute.data.map((d) => d.agreementNumber)).toEqual(["SA-ON"]);
    expect(perRoute.data[0]!.routeCode).toBe("R-ON");
    // The control: without the filter the same data is two.
    expect(cycleWide.expected).toBe(2);
  });

  it("ignores the account's cycle when the route names stops", async () => {
    /*
     * §5.1: the sheet prints every stop, so the count must match the
     * sheet. Fails if the `account: { billingCycleId }` clause is kept on
     * the route branch: this account is on another cycle.
     */
    const stop = await extraPremise("OtherCycle");
    const otherAccountId = await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const cycle2 = await prisma.billingCycle.create({
        data: {
          utilityId: TENANT_A,
          name: "Cycle-other",
          cycleCode: "C-OTHER",
          readDayOfMonth: 1,
          billDayOfMonth: 20,
          frequency: "MONTHLY",
        },
      });
      const a = await prisma.account.create({
        data: {
          utilityId: TENANT_A,
          accountNumber: "ACCT-OTHER",
          accountType: "RESIDENTIAL",
          status: "ACTIVE",
          billingCycleId: cycle2.id,
          depositAmount: 0,
        },
      });
      return a.id;
    });
    await service({
      agreementNumber: "SA-ELSEWHERE",
      meterId: fixA.meterId,
      premiseId: stop,
      accountId: otherAccountId,
    });
    const r = await route({ code: "R-X", stops: [stop] });

    expect((await progress({ readRouteId: r })).expected).toBe(1);
    expect((await progress()).expected).toBe(0);
  });

  it("counts a register as a row, so the number matches the sheet", async () => {
    /*
     * Trap 4: per-route is register-grained (readableRowsForPremises),
     * the cycle-wide path assignment-grained. Fails if the route branch
     * counts assignments instead.
     */
    const sa = await service({ agreementNumber: "SA-REG", meterId: fixA.meterId });
    const regs = await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const measureType = await prisma.measureTypeDef.findFirstOrThrow({
        where: { OR: [{ utilityId: TENANT_A }, { utilityId: null }] },
        orderBy: { id: "asc" },
      });
      const ids: string[] = [];
      for (const n of [1, 2]) {
        const reg = await prisma.meterRegister.create({
          data: {
            utilityId: TENANT_A,
            meterId: fixA.meterId,
            registerNumber: n,
            uomId: fixA.uomId,
            measureTypeId: measureType.id,
            isActive: true,
          },
        });
        ids.push(reg.id);
      }
      return ids;
    });
    const r = await route({ code: "R-REG", stops: [fixA.premiseId] });
    await seedRead(fixA.meterId, sa, "2026-02-08", { registerId: regs[0]! });

    const p = await progress({ readRouteId: r });

    expect(p).toMatchObject({ expected: 2, read: 1, outstanding: 1 });
    expect((await progress()).expected).toBe(1);
    // The unread register is named, so two rows are not identical on screen
    // (fails if registerNumber is not forwarded), and the internal
    // registerId is not on the wire (fails if the row is spread outward).
    expect(p.data.map((d) => d.registerNumber)).toEqual(["2"]);
    expect(Object.keys(p.data[0]!)).not.toContain("registerId");
  });

  it("clears a one-register meter's row with a read that names no register", async () => {
    /*
     * `createMeterRead` allows a null register on a meter with exactly
     * one active register. Fails if `held.has(null)` is not honoured: the
     * row would stay outstanding for ever.
     */
    const sa = await service({ agreementNumber: "SA-ONE", meterId: fixA.meterId });
    await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const measureType = await prisma.measureTypeDef.findFirstOrThrow({
        where: { OR: [{ utilityId: TENANT_A }, { utilityId: null }] },
        orderBy: { id: "asc" },
      });
      await prisma.meterRegister.create({
        data: {
          utilityId: TENANT_A,
          meterId: fixA.meterId,
          registerNumber: 1,
          uomId: fixA.uomId,
          measureTypeId: measureType.id,
          isActive: true,
        },
      });
    });
    const r = await route({ code: "R-ONE", stops: [fixA.premiseId] });
    expect(await progress({ readRouteId: r })).toMatchObject({ expected: 1, outstanding: 1 });
    // The cycle-wide row is the meter itself: no register named.
    expect((await progress()).data[0]!.registerNumber).toBeNull();

    await seedRead(fixA.meterId, sa, "2026-02-08");

    expect(await progress({ readRouteId: r })).toMatchObject({
      expected: 1,
      read: 1,
      outstanding: 0,
    });
  });

  it("lists outstanding rows in the order the route is walked", async () => {
    /*
     * Stop 1's meter has the HIGHER meter number. Fails if the list is
     * sorted by meter number instead of stop sequence.
     */
    const second = await extraPremise("Second");
    await service({ agreementNumber: "SA-FIRST", meterId: fixA.meterId2 });
    await service({ agreementNumber: "SA-SECOND", meterId: fixA.meterId, premiseId: second });
    const r = await route({ code: "R-ORD", stops: [fixA.premiseId, second] });

    const p = await progress({ readRouteId: r });

    expect(p.data.map((d) => d.agreementNumber)).toEqual(["SA-FIRST", "SA-SECOND"]);
  });

  it("refuses a route that exists but belongs to another cycle", async () => {
    /*
     * Fails if `billingCycleId: cycle.id` is deleted from the route
     * lookup: this route is real and this tenant's.
     */
    const otherCycleId = await seedAsPlatform(async () => {
      const c = await prismaImports.prisma.billingCycle.create({
        data: {
          utilityId: TENANT_A,
          name: "Cycle-elsewhere",
          cycleCode: "C-ELSE",
          readDayOfMonth: 1,
          billDayOfMonth: 20,
          frequency: "MONTHLY",
        },
      });
      return c.id;
    });
    const r = await route({ code: "R-ELSE", billingCycleId: otherCycleId });

    await expect(progress({ readRouteId: r })).rejects.toMatchObject({
      statusCode: 404,
      code: "ROUTE_NOT_FOUND",
    });
    await expect(
      progress({ readRouteId: "00000000-0000-4000-8000-0000000000aa" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "ROUTE_NOT_FOUND" });
  });
});

describe("progress for an EXTERNAL route", () => {
  it("expects the meters whose latest read in the previous window carried the route", async () => {
    /*
     * §5.4: membership is learned. m1 read on the route last window: in.
     * m2 read on it only before last window (Dec 1): out - fails if the
     * previous-window bound is deleted. m3 read on it, then moved to
     * another route later in the same window: out - fails if "latest read
     * carries it" is weakened to "any read carried it".
     */
    const sa1 = await service({ agreementNumber: "SA-M1", meterId: fixA.meterId });
    // One premise each: one live service per premise and commodity.
    const sa2 = await service({ agreementNumber: "SA-M2", meterId: fixA.meterId2, premiseId: await extraPremise("M2") });
    const sa3 = await service({ agreementNumber: "SA-M3", meterId: fixA.meterId3, premiseId: await extraPremise("M3") });
    const ext = await route({ code: "VENDOR-7", origin: "EXTERNAL" });
    const other = await route({ code: "VENDOR-8", origin: "EXTERNAL" });
    await seedRead(fixA.meterId, sa1, "2026-01-05", { routeId: ext });
    await seedRead(fixA.meterId2, sa2, "2025-12-01", { routeId: ext });
    await seedRead(fixA.meterId3, sa3, "2026-01-03", { routeId: ext });
    await seedRead(fixA.meterId3, sa3, "2026-01-09", { routeId: other });

    const p = await progress({ readRouteId: ext });

    expect(p).toMatchObject({ expected: 1, read: 0, outstanding: 1 });
    expect(p.data.map((d) => d.meterId)).toEqual([fixA.meterId]);
    expect(p.data[0]!.routeCode).toBe("VENDOR-7");

    // And it is read once the vendor's file lands inside this window.
    await seedRead(fixA.meterId, sa1, "2026-02-08", { routeId: ext });
    // A meter first seen on the route this window does NOT raise expected:
    // the current-window fallback is for a route with no prior window only
    // (fails if it is applied on every window).
    await seedRead(fixA.meterId2, sa2, "2026-02-08", { routeId: ext });
    expect(await progress({ readRouteId: ext })).toMatchObject({
      expected: 1,
      read: 1,
      outstanding: 0,
    });
  });

  it("reports received-only for a route with no prior reads", async () => {
    /*
     * A first-ever route has nothing to learn from, so what has been
     * received is the whole list: expected = read, nothing outstanding.
     * Fails if the current-window fallback is deleted (it would report
     * 0 expected and 0 read with a read in hand).
     */
    const sa = await service({ agreementNumber: "SA-NEW", meterId: fixA.meterId });
    const ext = await route({ code: "VENDOR-NEW", origin: "EXTERNAL" });
    await seedRead(fixA.meterId, sa, "2026-02-08", { routeId: ext });

    expect(await progress({ readRouteId: ext })).toMatchObject({
      expected: 1,
      read: 1,
      outstanding: 0,
      data: [],
    });
    // Truly nothing received and nothing prior: nothing to say.
    const empty = await route({ code: "VENDOR-EMPTY", origin: "EXTERNAL" });
    expect(await progress({ readRouteId: empty })).toMatchObject({ expected: 0, read: 0 });
  });
});

describe("why an outstanding row is outstanding", () => {
  it("names the open skip's reason, and nothing for a resolved or absent one", async () => {
    /*
     * Fails if the skip lookup is deleted, or if it stops filtering on
     * `resolvedAt: null` (the resolved one on meter2 would name a reason).
     */
    // One premise each (one live service per premise and commodity), and
    // all three are stops, so the route still covers the same services.
    const p2 = await extraPremise("S2");
    const p3 = await extraPremise("S3");
    await service({ agreementNumber: "SA-S1", meterId: fixA.meterId });
    await service({ agreementNumber: "SA-S2", meterId: fixA.meterId2, premiseId: p2 });
    await service({ agreementNumber: "SA-S3", meterId: fixA.meterId3, premiseId: p3 });
    await skip(fixA.meterId, "LOCKED_GATE");
    await skip(fixA.meterId2, "DOG", true);
    const r = await route({ code: "R-SK", stops: [fixA.premiseId, p2, p3] });

    const byRoute = await progress({ readRouteId: r });
    const reason = (p: typeof byRoute, n: string) =>
      p.data.find((d) => d.agreementNumber === n)!.skipReason;

    expect(reason(byRoute, "SA-S1")).toBe("LOCKED_GATE");
    expect(reason(byRoute, "SA-S2")).toBeNull();
    expect(reason(byRoute, "SA-S3")).toBeNull();
    // The cycle-wide path states the same fact, and no route code.
    const cycleWide = await progress();
    expect(cycleWide.data.find((d) => d.agreementNumber === "SA-S1")!.skipReason).toBe(
      "LOCKED_GATE",
    );
    expect(cycleWide.data.every((d) => d.routeCode === null)).toBe(true);
  });
});

/**
 * Which window the answer is about.
 *
 * Two different questions share this function, and until 2026-11-17 only
 * one of them could be asked.
 *
 * **`billing` (the default) is the window a run will bill**, which is the
 * last period already *closed* on the day — `computeBillPeriod`, the
 * identical call `planBillingRun` makes (`planning.ts:100`). Design §5.9
 * requires that sharing and says so twice; the case above at "closed
 * mid-window" is what it buys, and neither moves.
 *
 * **`reading` is the window containing the day**, which is where the
 * reads somebody is taking *now* land. A sheet typed today belongs to the
 * period that has not closed yet, so against the billing window it is
 * invisible — which is what a route's own progress screen was reporting
 * before this existed, a period already billed.
 *
 * The fixture cycle bills on the 10th and `AS_OF` is 2026-02-15, so the
 * two windows are 2026-01-11..2026-02-10 and 2026-02-11..2026-03-10. A
 * day between two bill days is the whole point: on a bill day itself the
 * two agree, because `periodEnd` is inclusive.
 */
describe("which window the progress is about", () => {
  it("reports the window a run will bill, by default", async () => {
    await service({ agreementNumber: "SA-WIN-1", meterId: fixA.meterId });

    const p = await progress();

    expect(p.windowStart.slice(0, 10)).toBe("2026-01-11");
    expect(p.windowEnd.slice(0, 10)).toBe("2026-02-10");
  });

  it("reports the window containing the day when asked for the reading week", async () => {
    await service({ agreementNumber: "SA-WIN-2", meterId: fixA.meterId });

    const p = await progress({ window: "reading" });

    expect(p.windowStart.slice(0, 10)).toBe("2026-02-11");
    expect(p.windowEnd.slice(0, 10)).toBe("2026-03-10");
  });

  /*
   * The fact that made this worth a parameter: the same read is outstanding
   * in one window and read in the other, and a reading screen that asks the
   * wrong one tells a reader their morning's work never happened.
   */
  it("counts a read taken on the day as read in the reading window and absent from the billing one", async () => {
    const sa = await service({ agreementNumber: "SA-WIN-3", meterId: fixA.meterId });
    await seedRead(fixA.meterId, sa, AS_OF);

    expect(await progress({ window: "reading" })).toMatchObject({
      expected: 1,
      read: 1,
      outstanding: 0,
    });
    expect(await progress()).toMatchObject({ expected: 1, read: 0, outstanding: 1 });
  });

  /*
   * §5.12, per route: the expected figure is the row set the printed sheet
   * prints, so the count in front of the person and the paper in their hand
   * cannot disagree. Proven until now only by a browser run.
   *
   * **The assignment closes inside the reading window, and that is the
   * whole fixture.** A route's rows are asked for at the day the sheet is
   * printed for, not at the window's last day — which for a reading
   * question is the *next* bill day, weeks ahead. With `removedDate`
   * between the two, the two dates give different answers: open on
   * `AS_OF` (so the sheet prints it and the count must be 1), closed by
   * `periodEnd` 2026-03-10 (so asking there drops it and the count would
   * be 0). Without a date in that gap the test passes either way, which
   * is how the first version of it asserted nothing.
   */
  it("per route, the reading window expects exactly the rows the sheet would print", async () => {
    const sa = await service({
      agreementNumber: "SA-WIN-4",
      meterId: fixA.meterId,
      removedDate: new Date("2026-02-20"),
    });
    const r = await route({ code: "RT-WIN", stops: [fixA.premiseId] });

    const p = await progress({ readRouteId: r, window: "reading" });

    expect(p.expected).toBe(1);
    expect(p.data.map((d) => d.meterNumber)).toEqual([
      await seedAsPlatform(async () => {
        const m = await prismaImports.prisma.meter.findFirstOrThrow({
          where: { id: fixA.meterId },
          select: { meterNumber: true },
        });
        return m.meterNumber;
      }),
    ]);
    expect(p.data[0]!.routeCode).toBe("RT-WIN");
    // Read it on the day, and the route is done — in this window.
    await seedRead(fixA.meterId, sa, AS_OF, { routeId: r });
    expect(await progress({ readRouteId: r, window: "reading" })).toMatchObject({
      expected: 1,
      read: 1,
      outstanding: 0,
    });
  });
});
