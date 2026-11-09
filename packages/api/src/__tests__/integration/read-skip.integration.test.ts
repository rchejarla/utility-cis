import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type {
  CorrectMeterReadInput,
  CreateMeterReadEventInput,
  CreateMeterReadInput,
} from "@utility-cis/shared";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  TENANT_B,
  ACTOR,
  type TenantFixture,
  endAdminPool,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";

/**
 * Skips and their resolution, against a real database.
 *
 * The fixture cycle is MONTHLY with bill day 10, so the window that
 * contains 2026-06-05 is 2026-05-11 .. 2026-06-10 (the run on the 10th
 * bills it), the one before it is 2026-04-11 .. 2026-05-10 and the one
 * after 2026-06-11 .. 2026-07-10. Every window test differs from its
 * control in the date alone.
 *
 * Nothing here enqueues: the paths under test (`recordSkips`,
 * `createMeterRead`, `createMeterReadEvent`, the import handler's
 * `processRow`, `correctMeterRead`) are all in-transaction writes, so
 * there is no `enqueueSafely` to mock and no job can be left behind.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let tenancy: typeof import("../../lib/tenant-context.js");
let skips: typeof import("../../services/read-skip.service.js");
let meterReads: typeof import("../../services/meter-read.service.js");
let registry: typeof import("../../imports/registry.js");

let fixA: TenantFixture;
let fixB: TenantFixture;
const actor = { id: ACTOR, name: "Test Actor" };

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  tenancy = await import("../../lib/tenant-context.js");
  skips = await import("../../services/read-skip.service.js");
  meterReads = await import("../../services/meter-read.service.js");
  await import("../../imports/handlers/meter-read.js");
  registry = await import("../../imports/registry.js");
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
    fixB = await makeTenantFixture(prismaImports.prisma, TENANT_B);
  }));

const asA = <T>(fn: () => Promise<T>) => tenancy.runAsTenant(TENANT_A, fn);
const inTx = <T>(fn: (tx: any) => Promise<T>, tenant = TENANT_A) =>
  tenancy.runAsTenant(tenant, () => prismaImports.prisma.$transaction((tx) => fn(tx)));

const IN_WINDOW = "2026-06-05"; // window 05-11 .. 06-10
const SAME_WINDOW_EARLIER = "2026-06-03";
const PREVIOUS_WINDOW = "2026-05-05"; // window 04-11 .. 05-10
const NEXT_WINDOW = "2026-06-20"; // window 06-11 .. 07-10

let seq = 0;

/** A premise with its own agreement and service point on the fixture's account (and so its cycle). */
async function makeStop(fix: TenantFixture = fixA, tenant = TENANT_A) {
  const n = ++seq;
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const premise = await prisma.premise.create({
      data: {
        utilityId: tenant,
        addressLine1: `${n} Skip Street`,
        city: "Testville",
        state: "TS",
        zip: "00000",
        premiseType: "RESIDENTIAL",
        commodityIds: [fix.commodityId],
        status: "ACTIVE",
      },
    });
    const agreement = await prisma.serviceAgreement.create({
      data: {
        utilityId: tenant,
        agreementNumber: `SA-SK-${n}`,
        accountId: fix.accountId,
        commodityId: fix.commodityId,
        startDate: new Date("2024-01-01"),
        status: "ACTIVE",
      },
    });
    const sp = await prisma.servicePoint.create({
      data: {
        utilityId: tenant,
        serviceAgreementId: agreement.id,
        premiseId: premise.id,
        startDate: new Date("2024-01-01"),
      },
    });
    return { premiseId: premise.id, agreementId: agreement.id, servicePointId: sp.id, fix, tenant };
  });
}
type Stop = Awaited<ReturnType<typeof makeStop>>;

async function makeMeter(stop: Stop, over: { registers?: number } = {}) {
  const n = ++seq;
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const meter = await prisma.meter.create({
      data: {
        utilityId: stop.tenant,
        premiseId: stop.premiseId,
        commodityId: stop.fix.commodityId,
        uomId: stop.fix.uomId,
        meterNumber: `SK-M-${n}`,
        meterType: "MANUAL",
        status: "ACTIVE",
        installDate: new Date("2024-01-01"),
      },
    });
    await prisma.servicePointMeter.create({
      data: {
        utilityId: stop.tenant,
        servicePointId: stop.servicePointId,
        meterId: meter.id,
        addedDate: new Date("2024-01-01"),
      },
    });
    const registerIds: string[] = [];
    if (over.registers) {
      const measureType = await prisma.measureTypeDef.findFirstOrThrow({
        where: { OR: [{ utilityId: stop.tenant }, { utilityId: null }] },
        orderBy: { id: "asc" },
      });
      for (let i = 1; i <= over.registers; i++) {
        const reg = await prisma.meterRegister.create({
          data: {
            utilityId: stop.tenant,
            meterId: meter.id,
            registerNumber: i,
            uomId: stop.fix.uomId,
            measureTypeId: measureType.id,
            isActive: true,
          },
        });
        registerIds.push(reg.id);
      }
    }
    return { ...meter, registerIds };
  });
}

/** A skip written straight to the table: setup, not the code under test. */
async function seedSkip(meterId: string, readDate: string, resolved = false) {
  return seedAsPlatform(async () =>
    await prismaImports.prisma.readSkip.create({
      data: {
        utilityId: TENANT_A,
        meterId,
        readDate: new Date(readDate),
        skipReason: "LOCKED_GATE",
        resolvedAt: resolved ? new Date("2026-05-01T00:00:00Z") : null,
      },
    }),
  );
}

const skipRows = (meterId: string) =>
  seedAsPlatform(async () =>
    await prismaImports.prisma.readSkip.findMany({ where: { meterId }, orderBy: { readDate: "asc" } }),
  );

/** A read straight to the table: setup, not the code under test. */
async function seedRead(stop: Stop, meterId: string, readDate: string) {
  return seedAsPlatform(async () =>
    await prismaImports.prisma.meterRead.create({
      data: {
        utilityId: TENANT_A,
        meterId,
        serviceAgreementId: stop.agreementId,
        uomId: stop.fix.uomId,
        readDate: new Date(readDate),
        readDatetime: new Date(`${readDate}T12:00:00Z`),
        reading: 100,
        priorReading: 90,
        consumption: 10,
        readType: "ACTUAL",
        readSource: "MANUAL",
      },
    }),
  );
}

const createRead = (meterId: string, readDate: string) =>
  asA(() => {
    const input: CreateMeterReadInput = {
      meterId,
      readDate,
      readDatetime: `${readDate}T12:00:00.000Z`,
      reading: 100,
      readType: "ACTUAL",
      readSource: "MANUAL",
    };
    return meterReads.createMeterRead(TENANT_A, ACTOR, "Test Actor", input);
  });

const record = (
  meterIds: string[],
  readDate: string,
  over: Partial<{ routeId: string | null; skipReason: any }> = {},
  tenant = TENANT_A,
) =>
  inTx(
    (tx) =>
      skips.recordSkips(tx, tenant, actor, {
        routeId: over.routeId ?? null,
        readDate: new Date(readDate),
        meterIds,
        skipReason: over.skipReason ?? "LOCKED_GATE",
        notes: "gate chained",
      }),
    tenant,
  );

describe("recordSkips", () => {
  it("writes one skip per unread meter at the stop, sharing one reason", async () => {
    // Breaks if: the `meterIds.map` in `createManyAndReturn` is collapsed to one row per call.
    const stop = await makeStop();
    const front = await makeMeter(stop);
    const back = await makeMeter(stop);

    const written = await record([front.id, back.id], IN_WINDOW, { skipReason: "DOG" });

    expect(written).toBe(2);
    const rows = await seedAsPlatform(async () =>
      await prismaImports.prisma.readSkip.findMany({ where: { utilityId: TENANT_A } }),
    );
    expect(rows.map((r) => r.meterId).sort()).toEqual([front.id, back.id].sort());
    expect(rows.every((r) => r.skipReason === "DOG" && r.resolvedAt === null)).toBe(true);
    expect(rows.every((r) => r.readDate.toISOString().startsWith(IN_WINDOW))).toBe(true);
    expect(rows.every((r) => r.readerId === ACTOR && r.notes === "gate chained")).toBe(true);
  });

  it("audits each skip it writes", async () => {
    // Breaks if: the `writeAuditRow` loop is deleted.
    const stop = await makeStop();
    const front = await makeMeter(stop);
    const back = await makeMeter(stop);
    await record([front.id, back.id], IN_WINDOW);
    const audits = await seedAsPlatform(async () =>
      await prismaImports.prisma.auditLog.findMany({ where: { entityType: "ReadSkip" } }),
    );
    expect(audits).toHaveLength(2);
  });

  it("refuses a skip for a meter that already has a read in the window, and writes nothing", async () => {
    // Breaks if: the `meterRead.findFirst` guard is deleted. The second meter is unread, so
    // a guard that skipped the offender and wrote the rest would leave a row and fail here.
    const stop = await makeStop();
    const read = await makeMeter(stop);
    const unread = await makeMeter(stop);
    await seedRead(stop, read.id, "2026-06-01");

    await expect(record([unread.id, read.id], IN_WINDOW)).rejects.toMatchObject({
      statusCode: 409,
      code: "METER_ALREADY_READ",
    });
    expect(await skipRows(unread.id)).toHaveLength(0);
  });

  it("does not refuse when the meter's only read is in the previous window", async () => {
    // The control for the refusal above: identical but for the read's date. Breaks if: the
    // guard drops its date bounds (any read ever would refuse), or uses a span other than the cycle's.
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    await seedRead(stop, meter.id, "2026-05-05");
    expect(await record([meter.id], IN_WINDOW)).toBe(1);
  });

  it("is a no-op for a meter already skipped open that day, so a sheet submitted twice writes once", async () => {
    // Breaks if: `skipDuplicates` is removed (the partial unique index raises instead).
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    expect(await record([meter.id], IN_WINDOW)).toBe(1);
    expect(await record([meter.id], IN_WINDOW)).toBe(0);
    expect(await skipRows(meter.id)).toHaveLength(1);
  });

  it("keeps a resolved skip as history and writes a fresh one for the same day", async () => {
    // Breaks if: the unique index stops being partial (the second insert is refused).
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    await seedSkip(meter.id, IN_WINDOW, true);
    expect(await record([meter.id], IN_WINDOW)).toBe(1);
    expect(await skipRows(meter.id)).toHaveLength(2);
  });

  it("refuses a meter this tenant cannot see", async () => {
    // Breaks if: the `meter.findMany` existence check is deleted (the composite FK error is opaque).
    const stopB = await makeStop(fixB, TENANT_B);
    const meterB = await makeMeter(stopB);
    await expect(record([meterB.id], IN_WINDOW, {}, TENANT_A)).rejects.toMatchObject({
      statusCode: 404,
      code: "METER_NOT_FOUND",
    });
  });

  it("refuses a meter with no assignment on the day", async () => {
    // Breaks if: the `!ws?.length` check is deleted (the window would be unknown and the guard vacuous).
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    await seedAsPlatform(async () =>
      await prismaImports.prisma.servicePointMeter.updateMany({
        where: { meterId: meter.id },
        data: { removedDate: new Date("2026-01-01") },
      }),
    );
    await expect(record([meter.id], IN_WINDOW)).rejects.toMatchObject({
      statusCode: 400,
      code: "METER_NOT_ASSIGNED",
    });
  });
});

describe("resolving a skip when a read lands (the single-read path)", () => {
  it("resolves the skip when a read for that meter lands in the same window", async () => {
    // Breaks if: the `resolveSkipsForRead` call in `createMeterRead` is deleted.
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    await seedSkip(meter.id, SAME_WINDOW_EARLIER);

    await createRead(meter.id, IN_WINDOW);

    const [row] = await skipRows(meter.id);
    expect(row.resolvedAt).not.toBeNull();
  });

  it("leaves the other meters at the premise unresolved", async () => {
    // Both meters at one premise have an open skip; only the front is read. Breaks if: the
    // `meterId` is dropped from the `updateMany` where (resolution becomes per premise/window).
    const stop = await makeStop();
    const front = await makeMeter(stop);
    const back = await makeMeter(stop);
    await seedSkip(front.id, SAME_WINDOW_EARLIER);
    await seedSkip(back.id, SAME_WINDOW_EARLIER);

    await createRead(front.id, IN_WINDOW);

    expect((await skipRows(front.id))[0].resolvedAt).not.toBeNull();
    expect((await skipRows(back.id))[0].resolvedAt).toBeNull();
  });

  it("resolves only the skip in the read's window, leaving earlier and later windows alone", async () => {
    // One meter, three open skips; the read lands in the middle window. It differs from the
    // resolving test above in the skip dates alone. Breaks if: the `readDate` bounds on the
    // `updateMany` are deleted (all three would resolve), or the window is not the cycle's.
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    await seedSkip(meter.id, PREVIOUS_WINDOW);
    await seedSkip(meter.id, SAME_WINDOW_EARLIER);
    await seedSkip(meter.id, NEXT_WINDOW);

    await createRead(meter.id, IN_WINDOW);

    const byDate = Object.fromEntries(
      (await skipRows(meter.id)).map((r) => [r.readDate.toISOString().slice(0, 10), r.resolvedAt]),
    );
    expect(byDate[PREVIOUS_WINDOW]).toBeNull();
    expect(byDate[SAME_WINDOW_EARLIER]).not.toBeNull();
    expect(byDate[NEXT_WINDOW]).toBeNull();
  });

  it("does not reopen or re-stamp a skip that is already resolved", async () => {
    // Breaks if: `resolvedAt: null` is dropped from the `updateMany` where (history is re-stamped).
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    const old = await seedSkip(meter.id, SAME_WINDOW_EARLIER, true);
    await createRead(meter.id, IN_WINDOW);
    const [row] = await skipRows(meter.id);
    expect(row.resolvedAt?.toISOString()).toBe(old.resolvedAt?.toISOString());
  });
});

describe("resolving a skip from the other writers of meter_read", () => {
  it("resolves from a multi-register read event", async () => {
    // Breaks if: the `resolveSkipsForRead` call in `createMeterReadEvent` is deleted.
    const stop = await makeStop();
    const meter = await makeMeter(stop, { registers: 2 });
    await seedSkip(meter.id, SAME_WINDOW_EARLIER);

    const input: CreateMeterReadEventInput = {
      meterId: meter.id,
      readDate: IN_WINDOW,
      readDatetime: `${IN_WINDOW}T12:00:00.000Z`,
      readings: meter.registerIds.map((registerId) => ({ registerId, reading: 50 })),
      skips: [],
      readType: "ACTUAL",
      readSource: "MANUAL",
    };
    await asA(() => meterReads.createMeterReadEvent(TENANT_A, ACTOR, "Test Actor", input));

    expect((await skipRows(meter.id))[0].resolvedAt).not.toBeNull();
  });

  it("resolves from an imported read", async () => {
    // Breaks if: the `resolveSkipsForRead` call in the import handler's `processRow` is deleted.
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    await seedSkip(meter.id, SAME_WINDOW_EARLIER);

    const handler = registry.getKindHandler("meter_read") as any;
    const ctx = { utilityId: TENANT_A, actorId: ACTOR, actorName: "Test Actor", batchId: ACTOR };
    const row = {
      meterNumber: meter.meterNumber,
      readDatetime: `${IN_WINDOW}T12:00:00.000Z`,
      reading: 100,
    };
    const result = await tenancy.runAsTenant(TENANT_A, async () => {
      const batch = await handler.prepareBatch({ ...ctx, source: "MANUAL_UPLOAD" }, [row]);
      return prismaImports.prisma.$transaction((tx) => handler.processRow({ ...ctx, tx }, row, batch));
    });

    expect((result as { ok: boolean }).ok).toBe(true);
    expect((await skipRows(meter.id))[0].resolvedAt).not.toBeNull();
  });

  it("is not fired by a correction: a skip reopened after the original read stays open", async () => {
    // Breaks if: someone adds a `resolveSkipsForRead` call to `correctMeterRead`.
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    const original = await createRead(meter.id, IN_WINDOW);
    // A later visit found the meter unreachable again: an open skip after the read landed.
    await seedSkip(meter.id, SAME_WINDOW_EARLIER);

    const correction: CorrectMeterReadInput = {
      reading: 105,
      exceptionNotes: "transposed digits",
    };
    await asA(() =>
      meterReads.correctMeterRead(TENANT_A, ACTOR, "Test Actor", original.id, correction),
    );

    expect((await skipRows(meter.id))[0].resolvedAt).toBeNull();
  });
});

describe("the window around a bill day", () => {
  // Bill day is the 10th: the window ending on it is 05-11 .. 06-10 and the next starts 06-11.
  // Breaks if: `windowContaining`'s `day <= periodEnd` becomes `<` (06-10 jumps a window), or
  // the +31-day probe is dropped (06-05 lands in the closed window 04-11 .. 05-10).
  it.each([
    ["06-05", "06-09", true],
    ["06-05", "06-10", true], // the bill day itself is the last day of its window
    ["06-05", "06-11", false], // the first day of the next window
    ["06-11", "06-10", false],
    ["06-11", "06-20", true],
  ])("a skip on %s and a read on %s: resolved is %s", async (skipDay, readDay, resolves) => {
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    await seedSkip(meter.id, `2026-${skipDay}`);
    await createRead(meter.id, `2026-${readDay}`);
    expect((await skipRows(meter.id))[0].resolvedAt !== null).toBe(resolves);
  });
});

describe("a billing cycle with no read window (non-monthly)", () => {
  const makeQuarterly = () =>
    seedAsPlatform(async () => {
      await prismaImports.prisma.billingCycle.updateMany({
        where: { utilityId: TENANT_A },
        data: { frequency: "QUARTERLY" },
      });
    });

  it("still records the read, and resolves nothing", async () => {
    // Breaks if: `windowsByMeter` stops catching UNSUPPORTED_FREQUENCY (the 501 rolls the read back).
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    await seedSkip(meter.id, SAME_WINDOW_EARLIER);
    await makeQuarterly();

    await createRead(meter.id, IN_WINDOW);

    const reads = await seedAsPlatform(async () =>
      await prismaImports.prisma.meterRead.count({ where: { meterId: meter.id } }),
    );
    expect(reads).toBe(1);
    expect((await skipRows(meter.id))[0].resolvedAt).toBeNull();
    const resolved = await inTx((tx) =>
      skips.resolveSkipsForRead(tx, TENANT_A, meter.id, new Date(IN_WINDOW)),
    );
    expect(resolved).toBe(0);
  });

  it("refuses to record a skip, by its own code rather than the bill service's", async () => {
    // Breaks if: the `unsupported` check in `recordSkips` is deleted (METER_NOT_ASSIGNED would answer instead).
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    await makeQuarterly();
    await expect(record([meter.id], IN_WINDOW)).rejects.toMatchObject({
      statusCode: 501,
      code: "READ_SKIP_CYCLE_UNSUPPORTED",
    });
  });
});

describe("the route a skip was found on", () => {
  it("is stored and read back", async () => {
    // Breaks if: `readRouteId: input.routeId` in `recordSkips` is hard-coded to null.
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    const route = await seedAsPlatform(async () =>
      await prismaImports.prisma.readRoute.create({
        data: {
          utilityId: TENANT_A,
          code: "R-1",
          name: "Route 1",
          billingCycleId: fixA.billingCycleId,
        },
      }),
    );
    await record([meter.id], IN_WINDOW, { routeId: route.id });
    expect((await skipRows(meter.id))[0].readRouteId).toBe(route.id);
  });
});

describe("one call naming meters on different cycles", () => {
  /*
   * Cycle A bills on the 10th, cycle B on the 20th, so for a skip on 06-12:
   *   A's window is 06-11 .. 07-10, B's is 05-21 .. 06-20.
   * 06-25 is inside A's window only; 05-25 inside B's only. A guard that
   * judged every meter by one shared window gets one of the two cases below
   * wrong whichever window it picks.
   */
  const SKIP_DAY = "2026-06-12";

  async function twoCycles() {
    const accountB = await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const cycleB = await prisma.billingCycle.create({
        data: {
          utilityId: TENANT_A,
          name: "Cycle-B",
          cycleCode: "C-B20",
          readDayOfMonth: 1,
          billDayOfMonth: 20,
          frequency: "MONTHLY",
        },
      });
      return prisma.account.create({
        data: {
          utilityId: TENANT_A,
          accountNumber: "ACCT-B20",
          accountType: "RESIDENTIAL",
          status: "ACTIVE",
          billingCycleId: cycleB.id,
          depositAmount: 0,
        },
      });
    });
    const stopA = await makeStop(fixA);
    const stopB = await makeStop({ ...fixA, accountId: accountB.id });
    return { stopA, stopB, a: await makeMeter(stopA), b: await makeMeter(stopB) };
  }

  it("refuses when the meter on cycle A has a read in A's window, which is outside B's", async () => {
    // Breaks if: the already-read check judges every meter by one shared window (B's here).
    const { stopA, a, b } = await twoCycles();
    await seedRead(stopA, a.id, "2026-06-25");
    await expect(record([a.id, b.id], SKIP_DAY)).rejects.toMatchObject({
      statusCode: 409,
      code: "METER_ALREADY_READ",
    });
    expect(await skipRows(b.id)).toHaveLength(0);
  });

  it("writes both when each meter's only read is in the other's window", async () => {
    // Breaks if: the check judges every meter by one shared window (A's here): B's read on 06-25 would refuse.
    const { stopA, stopB, a, b } = await twoCycles();
    await seedRead(stopB, b.id, "2026-06-25"); // in A's window, outside B's
    await seedRead(stopA, a.id, "2026-05-25"); // in B's window, outside A's
    expect(await record([a.id, b.id], SKIP_DAY)).toBe(2);
  });
});
