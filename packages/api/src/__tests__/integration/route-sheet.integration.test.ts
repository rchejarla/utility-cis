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
 * The data half of the printed sheet, against real rows. Every claim is a
 * join (route → stops → premise → service point → meter → register) or a
 * `DISTINCT ON` over reads, so a mocked client would assert the shape of a
 * query this file wrote. The PDF half is a unit test.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/read-route/route-sheet.js");

let fixA: TenantFixture;
let fixB: TenantFixture;

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/read-route/route-sheet.js");
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

const ON = new Date("2026-01-10T00:00:00.000Z");
const sheetFor = (routeId: string, onDate = ON, tenant = TENANT_A) =>
  runAsTenant(tenant, () => svc.buildRouteSheet(tenant, routeId, onDate));

let seq = 0;

async function makeCycle(
  readDayOfMonth: number,
  billDayOfMonth: number,
  frequency: "MONTHLY" | "BIMONTHLY" | "QUARTERLY" = "MONTHLY",
  tenant = TENANT_A,
): Promise<string> {
  const n = ++seq;
  return seedAsPlatform(async () => {
    const c = await prismaImports.prisma.billingCycle.create({
      data: {
        utilityId: tenant,
        name: `Sheet cycle ${n}`,
        cycleCode: `SC-${n}`,
        readDayOfMonth,
        billDayOfMonth,
        frequency,
      },
    });
    return c.id;
  });
}

async function makeRoute(
  billingCycleId: string,
  over: { origin?: "LOCAL" | "EXTERNAL"; tenant?: string; code?: string } = {},
): Promise<string> {
  const n = ++seq;
  return seedAsPlatform(async () => {
    const r = await prismaImports.prisma.readRoute.create({
      data: {
        utilityId: over.tenant ?? TENANT_A,
        code: over.code ?? `RT-${n}`,
        name: `Route ${n}`,
        billingCycleId,
        origin: over.origin ?? "LOCAL",
      },
    });
    return r.id;
  });
}

interface MadeStop {
  premiseId: string;
  meterId: string;
  agreementId: string;
}

/**
 * A premise on a route at a sequence, with a meter assigned through an
 * agreement on the given account (default: the fixture's, on its own cycle).
 */
async function makeStop(
  routeId: string,
  sequence: number,
  addressLine1: string,
  over: { accountId?: string; registers?: number; meterNumber?: string } = {},
): Promise<MadeStop> {
  const n = ++seq;
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const premise = await prisma.premise.create({
      data: {
        utilityId: TENANT_A,
        addressLine1,
        city: "Testville",
        state: "TS",
        zip: "00000",
        premiseType: "RESIDENTIAL",
        commodityIds: [fixA.commodityId],
        status: "ACTIVE",
      },
    });
    const agreement = await prisma.serviceAgreement.create({
      data: {
        utilityId: TENANT_A,
        agreementNumber: `SA-SH-${n}`,
        accountId: over.accountId ?? fixA.accountId,
        commodityId: fixA.commodityId,
        rateServiceClassId: await serviceClassFor(prisma, fixA.utilityId, fixA.commodityId),
        startDate: new Date("2024-01-01"),
        status: "ACTIVE",
      },
    });
    const point = await prisma.servicePoint.create({
      data: {
        utilityId: TENANT_A,
        serviceAgreementId: agreement.id,
        premiseId: premise.id,
        startDate: new Date("2024-01-01"),
      },
    });
    const meter = await prisma.meter.create({
      data: {
        utilityId: TENANT_A,
        premiseId: premise.id,
        commodityId: fixA.commodityId,
        uomId: fixA.uomId,
        meterNumber: over.meterNumber ?? `SH-M-${n}`,
        meterType: "MANUAL",
        status: "ACTIVE",
        installDate: new Date("2024-01-01"),
      },
    });
    await prisma.servicePointMeter.create({
      data: {
        utilityId: TENANT_A,
        servicePointId: point.id,
        meterId: meter.id,
        addedDate: new Date("2024-01-01"),
      },
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO read_route_stop (utility_id, read_route_id, premise_id, sequence)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      TENANT_A,
      routeId,
      premise.id,
      sequence,
    );
    return { premiseId: premise.id, meterId: meter.id, agreementId: agreement.id };
  });
}

/** A premise on the route with no meter at all: a stop that produces no line. */
async function makeBareStop(routeId: string, sequence: number, addressLine1: string): Promise<void> {
  await seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const premise = await prisma.premise.create({
      data: {
        utilityId: TENANT_A,
        addressLine1,
        city: "Testville",
        state: "TS",
        zip: "00000",
        premiseType: "RESIDENTIAL",
        commodityIds: [fixA.commodityId],
        status: "ACTIVE",
      },
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO read_route_stop (utility_id, read_route_id, premise_id, sequence)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      TENANT_A,
      routeId,
      premise.id,
      sequence,
    );
  });
}

async function addRegisters(meterId: string, numbers: number[]): Promise<string[]> {
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const measureType = await prisma.measureTypeDef.findFirstOrThrow({
      where: { OR: [{ utilityId: TENANT_A }, { utilityId: null }] },
      orderBy: { id: "asc" },
    });
    const ids: string[] = [];
    for (const registerNumber of numbers) {
      const reg = await prisma.meterRegister.create({
        data: {
          utilityId: TENANT_A,
          meterId,
          registerNumber,
          uomId: fixA.uomId,
          measureTypeId: measureType.id,
          isActive: true,
        },
      });
      ids.push(reg.id);
    }
    return ids;
  });
}

async function seedRead(
  stop: MadeStop,
  readDate: string,
  reading: number,
  over: { registerId?: string; hour?: number } = {},
): Promise<void> {
  await seedAsPlatform(async () => {
    await prismaImports.prisma.meterRead.create({
      data: {
        utilityId: TENANT_A,
        meterId: stop.meterId,
        serviceAgreementId: stop.agreementId,
        uomId: fixA.uomId,
        readDate: new Date(readDate),
        readDatetime: new Date(`${readDate}T${String(over.hour ?? 12).padStart(2, "0")}:00:00Z`),
        registerId: over.registerId ?? null,
        reading,
        priorReading: 0,
        consumption: reading,
        readType: "ACTUAL",
        readSource: "AMR",
      },
    });
  });
}

describe("the order a reader walks", () => {
  it("orders stops by sequence, not by address", async () => {
    /*
     * Alphabetical is Apple, Mango, Zebra; the sequence is Mango, Zebra,
     * Apple. `readableRowsForPremises` sorts by premise id, a third
     * order, so neither of those is available by accident.
     * Breaks if: the loop in `buildRouteSheet` walks `rows` (premise-id
     * order) instead of `stops` (sequence order).
     */
    const route = await makeRoute(fixA.billingCycleId);
    await makeStop(route, 300, "1 Apple Road");
    await makeStop(route, 100, "2 Mango Road");
    await makeStop(route, 200, "3 Zebra Road");

    const sheet = await sheetFor(route);

    expect(sheet.stops.map((s) => s.sequence)).toEqual([100, 200, 300]);
    expect(sheet.stops.map((s) => s.address)).toEqual([
      "2 Mango Road, Testville",
      "3 Zebra Road, Testville",
      "1 Apple Road, Testville",
    ]);
  });
});

describe("every stop prints", () => {
  it("prints a stop whose account is on another cycle with another bill day", async () => {
    /*
     * §5.1: the route names the walk, the account's cycle does not filter
     * it. The route is on cycle R15 (read 15, bill 20); the second stop's
     * account is on a different cycle (read 3, bill 12).
     * Breaks if: `buildRouteSheet` (or `readableRowsForPremises`) adds an
     * account-cycle filter such as `account: { billingCycleId: route.cycle }`.
     */
    const routeCycle = await makeCycle(15, 20);
    const otherCycle = await makeCycle(3, 12);
    const otherAccountId = await seedAsPlatform(async () => {
      const a = await prismaImports.prisma.account.create({
        data: {
          utilityId: TENANT_A,
          accountNumber: "ACCT-OTHER-CYCLE",
          accountType: "RESIDENTIAL",
          status: "ACTIVE",
          billingCycleId: otherCycle,
          depositAmount: 0,
        },
      });
      return a.id;
    });
    const route = await makeRoute(routeCycle);
    await makeStop(route, 100, "1 Same Cycle Lane");
    await makeStop(route, 200, "2 Other Cycle Lane", { accountId: otherAccountId });

    const sheet = await sheetFor(route);

    expect(sheet.stops).toHaveLength(2);
    expect(sheet.stops[0]!.accountNumber).not.toBe("ACCT-OTHER-CYCLE");
    expect(sheet.stops[1]!.accountNumber).toBe("ACCT-OTHER-CYCLE");
    // The header is the ROUTE's cycle, not either account's.
    expect(sheet.cycleCode).toMatch(/^SC-/);
    expect(sheet.cycleCode).not.toBe(fixA.billingCycleCode);
    expect(sheet.readsDueOn).toBe("2026-01-15");
  });

  it("prints a row per register, labelled, and one unlabelled row for a register-less meter", async () => {
    /*
     * Breaks if: rows are collapsed to one per meter (the two register
     * rows merge), or `registerNumber` is dropped (the rows look alike).
     */
    const route = await makeRoute(fixA.billingCycleId);
    const multi = await makeStop(route, 100, "1 Dial Street", { meterNumber: "M-MULTI" });
    await makeStop(route, 200, "2 Plain Street", { meterNumber: "M-PLAIN" });
    await addRegisters(multi.meterId, [1, 2]);

    const sheet = await sheetFor(route);

    expect(sheet.stops.map((s) => [s.meterNumber, s.registerNumber])).toEqual([
      ["M-MULTI", "1"],
      ["M-MULTI", "2"],
      ["M-PLAIN", null],
    ]);
  });
});

describe("a stop with nothing to read", () => {
  it("is kept off the lines but returned, with its sequence and address", async () => {
    /*
     * §5.1: a stop filtered off a sheet is silent unless somebody is told.
     * Breaks if: the `stopsWithNothingToRead` filter is removed (the list is
     * empty), or the premise's address is not carried.
     */
    const route = await makeRoute(fixA.billingCycleId);
    await makeStop(route, 100, "1 Metered Road");
    await makeBareStop(route, 200, "2 Empty Lot Road");
    await makeStop(route, 300, "3 Metered Road");

    const sheet = await sheetFor(route);

    expect(sheet.stops.map((s) => s.sequence)).toEqual([100, 300]);
    expect(sheet.stopsWithNothingToRead).toEqual([{ sequence: 200, address: "2 Empty Lot Road, Testville" }]);
  });

  it("returns an empty list when every stop has a line", async () => {
    // Breaks if: the filter inverts and returns stops that did print.
    const route = await makeRoute(fixA.billingCycleId);
    await makeStop(route, 100, "1 Metered Road");

    expect((await sheetFor(route)).stopsWithNothingToRead).toEqual([]);
  });
});

describe("a cycle the window logic does not support", () => {
  it("still prints the stops, with no due date", async () => {
    /*
     * `computeBillPeriod` windows MONTHLY only and throws 501 for the rest.
     * Only the header needs a window. Breaks if: the catch in `readsDueOn`
     * is removed (the sheet fails with UNSUPPORTED_FREQUENCY).
     */
    const route = await makeRoute(await makeCycle(15, 20, "QUARTERLY"));
    await makeStop(route, 100, "1 Quarter Road");

    const sheet = await sheetFor(route);

    expect(sheet.readsDueOn).toBeNull();
    expect(sheet.stops).toHaveLength(1);
  });
});

describe("the cycle's read day", () => {
  it("prints it as a due date in the month of the window the sheet is for", async () => {
    // Breaks if: `readsDueOn` returns the bill day, or the window's start,
    // or a span rather than a single date.
    const route = await makeRoute(await makeCycle(15, 20));

    expect((await sheetFor(route, new Date("2026-01-10T00:00:00Z"))).readsDueOn).toBe("2026-01-15");
    // After the bill day the sheet is for the next window, and so the next month's read day.
    expect((await sheetFor(route, new Date("2026-01-25T00:00:00Z"))).readsDueOn).toBe("2026-02-15");
  });

  it("clamps a read day the month does not have", async () => {
    /*
     * Read day 30 with bill day 31, on a date in February: the window ends
     * on the 28th and the read day clamps with it.
     * Breaks if: `billDayIn` is replaced by `new Date(Date.UTC(y, m, 30))`,
     * which rolls over to 2 March.
     */
    const route = await makeRoute(await makeCycle(30, 31));

    expect((await sheetFor(route, new Date("2026-02-20T00:00:00Z"))).readsDueOn).toBe("2026-02-28");
  });
});

describe("the last reading beside each meter", () => {
  it("shows the latest reading before the sheet's date, per register", async () => {
    /*
     * Breaks if: the query drops `register_id` from DISTINCT ON (the two
     * registers share one answer), drops `read_date < onDate` (the 01-10
     * read leaks in), or orders ascending (the older read wins).
     */
    const route = await makeRoute(fixA.billingCycleId);
    const stop = await makeStop(route, 100, "1 Dial Street");
    const [reg1, reg2] = await addRegisters(stop.meterId, [1, 2]);
    await seedRead(stop, "2025-12-08", 90, { registerId: reg1! });
    await seedRead(stop, "2026-01-08", 100.5, { registerId: reg1! });
    await seedRead(stop, "2026-01-08", 7, { registerId: reg2! });
    await seedRead(stop, "2026-01-10", 999, { registerId: reg1! }); // the sheet's own day: not "last"

    const sheet = await sheetFor(route);

    expect(sheet.stops.map((s) => [s.registerNumber, s.lastReading, s.lastReadDate])).toEqual([
      ["1", "100.5", "2026-01-08"],
      ["2", "7", "2026-01-08"],
    ]);
  });

  it("says none for a meter never read", async () => {
    // Breaks if: a missing read is rendered as zero.
    const route = await makeRoute(fixA.billingCycleId);
    await makeStop(route, 100, "1 New Street");

    const sheet = await sheetFor(route);

    expect(sheet.stops[0]).toMatchObject({ lastReading: null, lastReadDate: null });
  });

  it("gives a one-register meter the last read that named no register", async () => {
    /*
     * `createMeterRead` allows a null register on a meter with exactly one
     * active register. Breaks if: the fallback to the null-register read
     * is removed, and the line says "none" for a meter that was read.
     */
    const route = await makeRoute(fixA.billingCycleId);
    const stop = await makeStop(route, 100, "1 Single Dial Street");
    await addRegisters(stop.meterId, [1]);
    await seedRead(stop, "2026-01-08", 55);

    const sheet = await sheetFor(route);

    expect(sheet.stops).toHaveLength(1);
    expect(sheet.stops[0]).toMatchObject({ registerNumber: "1", lastReading: "55" });
  });
});

describe("what is refused", () => {
  it("refuses an EXTERNAL route", async () => {
    // Breaks if: the `origin !== "LOCAL"` guard is removed (an empty sheet prints instead).
    const route = await makeRoute(fixA.billingCycleId, { origin: "EXTERNAL" });

    await expect(sheetFor(route)).rejects.toMatchObject({ statusCode: 400, code: "ROUTE_IS_EXTERNAL" });
  });

  it("does not find another tenant's route", async () => {
    // Breaks if: the route lookup drops `utilityId` from its where.
    const theirs = await makeRoute(fixB.billingCycleId, { tenant: TENANT_B });

    await expect(sheetFor(theirs)).rejects.toMatchObject({ statusCode: 404, code: "ROUTE_NOT_FOUND" });
  });
});
