import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  readRouteSchema,
  readRouteListResponseSchema,
  readRouteSummarySchema,
  readRouteStopDetailListSchema,
  unsequencedPremiseListResponseSchema,
  entryOpenResponseSchema,
  entryRowSchema,
  entrySubmitResultSchema,
  readingProgressSchema,
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
  ensurePrincipal,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";

/**
 * The HTTP surface of read routes — the layer the two screens talk to.
 *
 * The services beneath it have their own suites, so this file is about
 * what only the routes decide: that each endpoint exists at the path the
 * plan names, that it parses its input and refuses a bad one, that its
 * body is the shape `@utility-cis/shared` declares (parsed here, as
 * `response-contracts.integration.test.ts` does for the read log — a
 * field the screens read and the API stops sending fails here), and that
 * each is gated on the verb §5.10 assigns it.
 *
 * **The gating tests are the point of the file.** A GET marked `CREATE`
 * locks a clerk out of a list; a submit marked `VIEW` lets a reader post
 * a route. Both compile, both pass every service test, and nothing else
 * in the tree would notice.
 *
 * The fixture cycle is MONTHLY, read day 1, bill day 10, so the window
 * containing 2026-06-05 is 2026-05-11 .. 2026-06-10.
 */

/*
 * Nothing in this path should enqueue — `processBatch` runs inline — but
 * mocked anyway: a job reaching the dev Redis would name rows in a
 * container about to be torn down, which is how 102 unrunnable dev jobs
 * once appeared on the platform console.
 */
vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;

let fixA: TenantFixture;
let fixB: TenantFixture;

const DAY = "2026-06-05";

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  // Registers the meter_read import handler that submit posts through.
  await import("../../imports/handlers/index.js");
  const appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    await resetDb();
    // `resetDb` does not clear the staging tables, and entry batches do
    // not cascade from anything it truncates.
    await prismaImports.prisma.importBatch.deleteMany();
    fixA = await makeTenantFixture(prismaImports.prisma, TENANT_A);
    fixB = await makeTenantFixture(prismaImports.prisma, TENANT_B);
    await ensurePrincipal(prismaImports.prisma, TENANT_A);
    for (const utilityId of [TENANT_A, TENANT_B]) {
      await prismaImports.prisma.utilityModule.create({
        data: { utilityId, moduleKey: "meter_reads" },
      });
    }
    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateTenantModulesCache(TENANT_A);
    await rbac.invalidateTenantModulesCache(TENANT_B);
  }));

/** A signature-free token, as every integration file here mints one. */
function headers(utilityId = TENANT_A) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: ACTOR,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return { authorization: `Bearer ${header}.${payload}.fake-signature` };
}

/**
 * Narrow the actor to exactly these verbs on `meter_reads`, so a route's
 * declared permission can be told apart from "the fixture allows
 * everything". The Redis cache is invalidated, or the middleware answers
 * from the previous test's role.
 */
async function grantOnly(verbs: string[]): Promise<void> {
  await seedAsPlatform(async () => {
    await prismaImports.prisma.role.updateMany({
      where: { utilityId: TENANT_A, name: "Integration Test Admin" },
      data: { permissions: { meter_reads: verbs } },
    });
  });
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateUserRoleCache(ACTOR, TENANT_A);
}

const get = (url: string, utilityId = TENANT_A) =>
  app.inject({ method: "GET", url, headers: headers(utilityId) });
const post = (url: string, payload: unknown, utilityId = TENANT_A) =>
  app.inject({ method: "POST", url, headers: headers(utilityId), payload: payload as object });
const patch = (url: string, payload: unknown, utilityId = TENANT_A) =>
  app.inject({ method: "PATCH", url, headers: headers(utilityId), payload: payload as object });
const del = (url: string, utilityId = TENANT_A) =>
  app.inject({ method: "DELETE", url, headers: headers(utilityId) });

const body = (res: { body: string }) => JSON.parse(res.body);

let seq = 0;

async function makeRoute(
  opts: { origin?: "LOCAL" | "EXTERNAL"; utilityId?: string } = {},
): Promise<{ id: string; code: string }> {
  const utilityId = opts.utilityId ?? TENANT_A;
  const code = `HT-${++seq}`;
  return seedAsPlatform(async () => {
    const row = await prismaImports.prisma.readRoute.create({
      data: {
        utilityId,
        code,
        name: `Route ${code}`,
        billingCycleId: utilityId === TENANT_B ? fixB.billingCycleId : fixA.billingCycleId,
        origin: opts.origin ?? "LOCAL",
      },
      select: { id: true, code: true },
    });
    return row;
  });
}

/**
 * A premise with an agreement, a service point and one MANUAL meter —
 * the chain `readableRowsForPremises` walks. `accountId` is settable so a
 * stop can be put on an account billing to another cycle, which is the
 * data-quality case §5.1 says the route page lists.
 */
async function makePremise(
  opts: { accountId?: string; priorReads?: number[] } = {},
): Promise<{ premiseId: string; meterId: string; meterNumber: string; agreementId: string }> {
  const n = ++seq;
  return seedAsPlatform(async () => {
    const prisma = prismaImports.prisma;
    const premise = await prisma.premise.create({
      data: {
        utilityId: TENANT_A,
        addressLine1: `${n} Willson Avenue`,
        city: "Bozeman",
        state: "MT",
        zip: "59715",
        premiseType: "RESIDENTIAL",
        commodityIds: [fixA.commodityId],
        status: "ACTIVE",
      },
    });
    const agreement = await prisma.serviceAgreement.create({
      data: {
        utilityId: TENANT_A,
        agreementNumber: `SA-HT-${n}`,
        accountId: opts.accountId ?? fixA.accountId,
        commodityId: fixA.commodityId,
        startDate: new Date("2024-01-01"),
        status: "ACTIVE",
      },
    });
    const sp = await prisma.servicePoint.create({
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
        meterNumber: `HT-M-${n}`,
        meterType: "MANUAL",
        status: "ACTIVE",
        installDate: new Date("2024-01-01"),
      },
    });
    await prisma.servicePointMeter.create({
      data: {
        utilityId: TENANT_A,
        servicePointId: sp.id,
        meterId: meter.id,
        addedDate: new Date("2024-01-01"),
      },
    });
    /*
     * Trailing reads, newest last, one month apart ending the month
     * before the sheet's day — what the provisional outlier band is
     * judged from, and what the sheet prints as "last reading".
     *
     * The first read gets a synthetic prior 30 below it, because
     * `meter_read_dial_readings_paired` is both-or-neither: a `reading`
     * with a null `prior_reading` is a row whose consumption cannot be
     * checked against anything, and the database refuses it.
     */
    let month = 0;
    let prior: number | null = null;
    for (const reading of opts.priorReads ?? []) {
      const readDate = new Date(Date.UTC(2026, month++, 3));
      const priorReading = prior ?? reading - 30;
      await prisma.meterRead.create({
        data: {
          utilityId: TENANT_A,
          meterId: meter.id,
          serviceAgreementId: agreement.id,
          uomId: fixA.uomId,
          readDate,
          readDatetime: readDate,
          reading,
          priorReading,
          consumption: reading - priorReading,
          readType: "ACTUAL",
          readSource: "MANUAL",
        },
      });
      prior = reading;
    }
    return {
      premiseId: premise.id,
      meterId: meter.id,
      meterNumber: meter.meterNumber,
      agreementId: agreement.id,
    };
  });
}

async function addStop(routeId: string, premiseId: string, sequence: number): Promise<string> {
  return seedAsPlatform(async () => {
    const row = await prismaImports.prisma.readRouteStop.create({
      data: { utilityId: TENANT_A, readRouteId: routeId, premiseId, sequence },
      select: { id: true },
    });
    return row.id;
  });
}

/** A route with one stop, one meter, and the trailing reads it was given. */
async function routeWithStop(priorReads?: number[]) {
  const route = await makeRoute();
  const premise = await makePremise({ priorReads });
  await addStop(route.id, premise.premiseId, 100);
  return { route, premise };
}

describe("GET /api/v1/read-routes", () => {
  it("lists the tenant's routes with their cycle and stop count", async () => {
    const { route } = await routeWithStop();

    const res = await get("/api/v1/read-routes");

    expect(res.statusCode).toBe(200);
    const parsed = readRouteListResponseSchema.safeParse(body(res));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const row = parsed.data!.data.find((r) => r.id === route.id)!;
    expect(row.stopCount).toBe(1);
    expect(row.cycleCode).toBe(fixA.billingCycleCode);
  });

  it("does not list another tenant's routes", async () => {
    const mine = await makeRoute();
    const theirs = await makeRoute({ utilityId: TENANT_B });

    const ids = readRouteListResponseSchema
      .parse(body(await get("/api/v1/read-routes")))
      .data.map((r) => r.id);

    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it("narrows to one origin", async () => {
    await makeRoute({ origin: "LOCAL" });
    const vendor = await makeRoute({ origin: "EXTERNAL" });

    const page = readRouteListResponseSchema.parse(
      body(await get("/api/v1/read-routes?origin=EXTERNAL")),
    );

    expect(page.data.map((r) => r.id)).toEqual([vendor.id]);
  });

  it("refuses an origin that is not one of the two", async () => {
    expect((await get("/api/v1/read-routes?origin=SOMETHING")).statusCode).toBe(400);
  });
});

describe("POST /api/v1/read-routes", () => {
  it("creates a LOCAL route by default", async () => {
    const res = await post("/api/v1/read-routes", {
      code: "W-04",
      name: "North Willson",
      billingCycleId: fixA.billingCycleId,
    });

    expect(res.statusCode).toBe(201);
    const route = readRouteSchema.parse(body(res));
    expect(route.origin).toBe("LOCAL");
    expect(route.active).toBe(true);
  });

  it("refuses a code the tenant has already used", async () => {
    const existing = await makeRoute();

    const res = await post("/api/v1/read-routes", {
      code: existing.code,
      name: "Second",
      billingCycleId: fixA.billingCycleId,
    });

    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("ROUTE_CODE_TAKEN");
  });

  it("refuses a body with no billing cycle", async () => {
    const res = await post("/api/v1/read-routes", { code: "W-09", name: "No cycle" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/read-routes/:id", () => {
  it("returns the one route, with its cycle code and stop count", async () => {
    const { route } = await routeWithStop();

    const res = await get(`/api/v1/read-routes/${route.id}`);

    expect(res.statusCode).toBe(200);
    const parsed = readRouteSummarySchema.safeParse(body(res));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data!.stopCount).toBe(1);
    expect(parsed.data!.cycleCode).toBe(fixA.billingCycleCode);
  });

  it("answers 404 for another tenant's route", async () => {
    const theirs = await makeRoute({ utilityId: TENANT_B });
    expect((await get(`/api/v1/read-routes/${theirs.id}`)).statusCode).toBe(404);
  });
});

describe("PATCH /api/v1/read-routes/:id", () => {
  it("renames a route", async () => {
    const { route } = await routeWithStop();

    const res = await patch(`/api/v1/read-routes/${route.id}`, { name: "South Willson" });

    expect(res.statusCode).toBe(200);
    expect(readRouteSchema.parse(body(res)).name).toBe("South Willson");
  });

  /*
   * `readRouteUpdateSchema` omits `origin` on purpose — claiming a
   * vendor's route as local is its own operation, not a PATCH field — and
   * the schema is `.strict()`-equivalent here only if the route parses
   * through it, which is what this asserts.
   */
  it("does not let origin be changed through the update body", async () => {
    const vendor = await makeRoute({ origin: "EXTERNAL" });

    await patch(`/api/v1/read-routes/${vendor.id}`, { origin: "LOCAL" });

    const after = readRouteSummarySchema.parse(body(await get(`/api/v1/read-routes/${vendor.id}`)));
    expect(after.origin).toBe("EXTERNAL");
  });
});

describe("the stops of a route", () => {
  it("lists them in sequence order, with the premise and the cycles billed there", async () => {
    const route = await makeRoute();
    const second = await makePremise();
    const first = await makePremise();
    await addStop(route.id, second.premiseId, 200);
    await addStop(route.id, first.premiseId, 100);

    const res = await get(`/api/v1/read-routes/${route.id}/stops`);

    expect(res.statusCode).toBe(200);
    const parsed = readRouteStopDetailListSchema.safeParse(body(res));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const stops = parsed.data!.data;
    expect(stops.map((s) => s.premiseId)).toEqual([first.premiseId, second.premiseId]);
    expect(stops[0]!.premise.city).toBe("Bozeman");
    expect(stops[0]!.accountCycles.map((c) => c.billingCycleId)).toEqual([fixA.billingCycleId]);
  });

  /*
   * §5.1: `Account.billing_cycle_id` is required and nothing makes it
   * agree with the route's, so a stop served by an account on another
   * cycle is real. It still prints; the page lists it as a data-quality
   * item, which it can only do if the endpoint says which cycle.
   */
  it("names the other cycle when a stop's account bills on one", async () => {
    const route = await makeRoute();
    const otherCycle = await seedAsPlatform(async () => {
      const cycle = await prismaImports.prisma.billingCycle.create({
        data: {
          utilityId: TENANT_A,
          name: "Off cycle",
          cycleCode: "C-OFF",
          readDayOfMonth: 20,
          billDayOfMonth: 25,
          frequency: "MONTHLY",
        },
      });
      const account = await prismaImports.prisma.account.create({
        data: {
          utilityId: TENANT_A,
          accountNumber: "ACCT-OFF",
          accountType: "RESIDENTIAL",
          status: "ACTIVE",
          billingCycleId: cycle.id,
          depositAmount: 0,
        },
      });
      return { cycleId: cycle.id, accountId: account.id };
    });
    const premise = await makePremise({ accountId: otherCycle.accountId });
    await addStop(route.id, premise.premiseId, 100);

    const stops = readRouteStopDetailListSchema.parse(
      body(await get(`/api/v1/read-routes/${route.id}/stops`)),
    ).data;

    expect(stops[0]!.accountCycles).toEqual([
      { billingCycleId: otherCycle.cycleId, cycleCode: "C-OFF" },
    ]);
  });

  it("adds a stop at the end and removes it again", async () => {
    const route = await makeRoute();
    const premise = await makePremise();

    const added = await post(`/api/v1/read-routes/${route.id}/stops`, {
      premiseId: premise.premiseId,
    });
    expect(added.statusCode).toBe(201);
    const stopId = body(added).id as string;
    expect(body(added).sequence).toBe(100);

    const removed = await del(`/api/v1/read-routes/${route.id}/stops/${stopId}`);
    expect(removed.statusCode).toBe(204);

    const after = readRouteStopDetailListSchema.parse(
      body(await get(`/api/v1/read-routes/${route.id}/stops`)),
    );
    expect(after.data).toEqual([]);
  });

  it("refuses a stop on a vendor's route", async () => {
    const vendor = await makeRoute({ origin: "EXTERNAL" });
    const premise = await makePremise();

    const res = await post(`/api/v1/read-routes/${vendor.id}/stops`, {
      premiseId: premise.premiseId,
    });

    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("ROUTE_IS_EXTERNAL");
  });

  it("offers the premises that are on no route", async () => {
    const route = await makeRoute();
    const onRoute = await makePremise();
    const free = await makePremise();
    await addStop(route.id, onRoute.premiseId, 100);

    const res = await get(`/api/v1/read-routes/${route.id}/unsequenced`);

    expect(res.statusCode).toBe(200);
    const parsed = unsequencedPremiseListResponseSchema.safeParse(body(res));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const ids = parsed.data!.data.map((p) => p.id);
    expect(ids).toContain(free.premiseId);
    expect(ids).not.toContain(onRoute.premiseId);
  });
});

describe("GET /api/v1/read-routes/:id/sheet", () => {
  it("streams a PDF", async () => {
    const { route } = await routeWithStop([1000, 1030]);

    const res = await get(`/api/v1/read-routes/${route.id}/sheet?onDate=${DAY}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });

  /*
   * `buildRouteSheet` returns the stops it could not print and its own
   * doc comment says "whoever serves the sheet is expected to surface
   * it" — a stop that vanishes without a trace is the silent failure
   * §5.1 forbids, and a PDF body cannot carry the warning.
   */
  it("answers the sheet as JSON, including the stops with nothing to read", async () => {
    const route = await makeRoute();
    const readable = await makePremise({ priorReads: [1000, 1030] });
    const bare = await seedAsPlatform(async () =>
      prismaImports.prisma.premise.create({
        data: {
          utilityId: TENANT_A,
          addressLine1: "9 Empty Lot",
          city: "Bozeman",
          state: "MT",
          zip: "59715",
          premiseType: "RESIDENTIAL",
          commodityIds: [fixA.commodityId],
          status: "ACTIVE",
        },
        select: { id: true },
      }),
    );
    await addStop(route.id, readable.premiseId, 100);
    await addStop(route.id, bare.id, 200);

    const res = await get(`/api/v1/read-routes/${route.id}/sheet?onDate=${DAY}&format=json`);

    expect(res.statusCode).toBe(200);
    const sheet = body(res);
    expect(sheet.stops).toHaveLength(1);
    expect(sheet.stops[0]!.lastReading).toBe("1030");
    expect(sheet.stopsWithNothingToRead).toEqual([{ sequence: 200, address: "9 Empty Lot, Bozeman" }]);
  });

  it("refuses a sheet for a vendor's route", async () => {
    const vendor = await makeRoute({ origin: "EXTERNAL" });

    const res = await get(`/api/v1/read-routes/${vendor.id}/sheet?onDate=${DAY}`);

    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("ROUTE_IS_EXTERNAL");
  });

  it("refuses a date that is not a date", async () => {
    const { route } = await routeWithStop();
    expect((await get(`/api/v1/read-routes/${route.id}/sheet?onDate=yesterday`)).statusCode).toBe(400);
  });
});

describe("entry over HTTP", () => {
  it("opens a batch with a row per readable register, in walking order", async () => {
    const route = await makeRoute();
    const second = await makePremise({ priorReads: [500, 530] });
    const first = await makePremise({ priorReads: [1000, 1030] });
    await addStop(route.id, second.premiseId, 200);
    await addStop(route.id, first.premiseId, 100);

    const res = await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY });

    expect(res.statusCode).toBe(201);
    const parsed = entryOpenResponseSchema.safeParse(body(res));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const opened = parsed.data!;
    expect(opened.rows.map((r) => r.meterId)).toEqual([first.meterId, second.meterId]);
    expect(opened.rows[0]!.sequence).toBe(100);
  });

  /*
   * What the screen shows beside the input, and what it judges a typed
   * number against (§5.7's provisional band). `openEntry` is where it
   * comes from, so it travels in this body rather than being fetched a
   * second time per row.
   */
  it("gives each row its last reading and the band its own history implies", async () => {
    const { route } = await routeWithStop([1000, 1030, 1062, 1090]);

    const opened = entryOpenResponseSchema.parse(
      body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY })),
    );

    const row = opened.rows[0]!;
    expect(row.lastReading).toBe("1090");
    expect(row.lastReadDate).toBe("2026-04-03");
    expect(row.address).toContain("Willson Avenue");
    // Trailing consumptions are 30, 32, 28: the band is half the
    // smallest to twice the largest, added to the last reading.
    expect(row.band).not.toBeNull();
    expect(Number(row.band!.low)).toBeCloseTo(1090 + 14, 4);
    expect(Number(row.band!.high)).toBeCloseTo(1090 + 64, 4);
  });

  it("offers no band for a meter with too little history to judge one", async () => {
    const { route } = await routeWithStop([1000]);

    const opened = entryOpenResponseSchema.parse(
      body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY })),
    );

    expect(opened.rows[0]!.band).toBeNull();
  });

  it("returns the same batch when entry is opened twice", async () => {
    const { route } = await routeWithStop();

    const first = body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY }));
    const again = body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY }));

    expect(again.batchId).toBe(first.batchId);
  });

  it("refuses entry on a vendor's route", async () => {
    const vendor = await makeRoute({ origin: "EXTERNAL" });

    const res = await post(`/api/v1/read-routes/${vendor.id}/entry`, { readDate: DAY });

    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("ROUTE_IS_EXTERNAL");
  });

  it("refuses an open with no read date", async () => {
    const { route } = await routeWithStop();
    expect((await post(`/api/v1/read-routes/${route.id}/entry`, {})).statusCode).toBe(400);
  });

  it("saves a reading as a staged row, writing no meter read", async () => {
    const { route, premise } = await routeWithStop([1000, 1030]);
    const opened = body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY }));

    const res = await patch(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/rows`, {
      meterId: premise.meterId,
      registerId: null,
      reading: 1061,
    });

    expect(res.statusCode).toBe(200);
    const row = entryRowSchema.parse(body(res));
    expect(row.reading).toBe("1061");
    expect(row.status).toBe("PENDING");
    const reads = await seedAsPlatform(async () =>
      prismaImports.prisma.meterRead.count({ where: { readDate: new Date(DAY) } }),
    );
    expect(reads).toBe(0);
  });

  it("refuses a row that is both a reading and a code", async () => {
    const { route, premise } = await routeWithStop();
    const opened = body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY }));

    const res = await patch(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/rows`, {
      meterId: premise.meterId,
      registerId: null,
      reading: 12,
      skipReason: "DOG",
    });

    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("ENTRY_ROW_AMBIGUOUS");
  });

  it("refuses a skip reason that is not one of the seven", async () => {
    const { route, premise } = await routeWithStop();
    const opened = body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY }));

    const res = await patch(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/rows`, {
      meterId: premise.meterId,
      registerId: null,
      skipReason: "RAINING",
    });

    expect(res.statusCode).toBe(400);
  });

  it("posts the sheet on submit, and reports the same counts on a second submit", async () => {
    const { route, premise } = await routeWithStop([1000, 1030]);
    const opened = body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY }));
    await patch(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/rows`, {
      meterId: premise.meterId,
      registerId: null,
      reading: 1061,
    });

    const res = await post(
      `/api/v1/read-routes/${route.id}/entry/${opened.batchId}/submit`,
      {},
    );

    expect(res.statusCode).toBe(200);
    const result = entrySubmitResultSchema.parse(body(res));
    expect(result.importedCount).toBe(1);
    expect(result.alreadySubmitted).toBe(false);

    const again = entrySubmitResultSchema.parse(
      body(await post(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/submit`, {})),
    );
    expect(again.alreadySubmitted).toBe(true);
    expect(again.importedCount).toBe(1);
    const posted = await seedAsPlatform(async () =>
      prismaImports.prisma.meterRead.count({ where: { routeId: route.id } }),
    );
    expect(posted).toBe(1);
  });

  it("records a skip rather than a read for a coded row", async () => {
    const { route, premise } = await routeWithStop();
    const opened = body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY }));
    await patch(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/rows`, {
      meterId: premise.meterId,
      registerId: null,
      skipReason: "LOCKED_GATE",
      notes: "Gate chained",
    });

    const result = entrySubmitResultSchema.parse(
      body(await post(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/submit`, {})),
    );

    expect(result.skipsRecorded).toBe(1);
    const skips = await seedAsPlatform(async () =>
      prismaImports.prisma.readSkip.findMany({ where: { meterId: premise.meterId } }),
    );
    expect(skips).toHaveLength(1);
    expect(skips[0]!.skipReason).toBe("LOCKED_GATE");
  });
});

describe("POST /api/v1/read-routes/:id/entry/reopen", () => {
  /*
   * The path carries no batch id, and that is deliberate:
   * `reopenEntryForCorrections` finds the batch itself from (route, date)
   * under the `read_route` row lock, so a segment naming one would be a
   * lie in the URL. Mirrors POST .../entry, which also takes `readDate`.
   */
  it("takes the refused rows of a posted sheet back to PENDING", async () => {
    const { route, premise } = await routeWithStop([1000, 1030]);
    const opened = body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY }));
    await patch(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/rows`, {
      meterId: premise.meterId,
      registerId: null,
      reading: 1061,
    });
    // Billed since it was typed: submit refuses the row rather than
    // posting a read behind a bill, which is what leaves an ERROR row.
    await seedAsPlatform(async () =>
      prismaImports.prisma.meterRead.create({
        data: {
          utilityId: TENANT_A,
          meterId: premise.meterId,
          serviceAgreementId: premise.agreementId,
          uomId: fixA.uomId,
          readDate: new Date("2026-06-01"),
          readDatetime: new Date("2026-06-01"),
          reading: 1050,
          // Paired, as `meter_read_dial_readings_paired` requires.
          priorReading: 1030,
          consumption: 20,
          readType: "ACTUAL",
          readSource: "MANUAL",
          billedAt: new Date("2026-06-10"),
        },
      }),
    );
    const submitted = entrySubmitResultSchema.parse(
      body(await post(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/submit`, {})),
    );
    expect(submitted.errorCount).toBe(1);

    const res = await post(`/api/v1/read-routes/${route.id}/entry/reopen`, { readDate: DAY });

    expect(res.statusCode).toBe(200);
    const reopened = entryOpenResponseSchema.parse(body(res));
    expect(reopened.batchId).toBe(opened.batchId);
    expect(reopened.rows.every((r) => r.status === "PENDING")).toBe(true);
  });

  it("answers 404 when no entry was ever opened for that day", async () => {
    const { route } = await routeWithStop();

    const res = await post(`/api/v1/read-routes/${route.id}/entry/reopen`, { readDate: DAY });

    expect(res.statusCode).toBe(404);
    expect(body(res).error.code).toBe("ENTRY_NOT_FOUND");
  });

  it("refuses to reopen a sheet that posted cleanly", async () => {
    const { route, premise } = await routeWithStop([1000, 1030]);
    const opened = body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY }));
    await patch(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/rows`, {
      meterId: premise.meterId,
      registerId: null,
      reading: 1061,
    });
    await post(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/submit`, {});

    const res = await post(`/api/v1/read-routes/${route.id}/entry/reopen`, { readDate: DAY });

    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("ENTRY_NOTHING_TO_CORRECT");
  });
});

describe("GET /api/v1/read-routes/:id/progress", () => {
  it("answers for the route's own cycle, scoped to the route's stops", async () => {
    const { route, premise } = await routeWithStop();
    // A second premise on the same cycle but not on the route: a
    // per-route answer must not count it.
    await makePremise();

    const res = await get(`/api/v1/read-routes/${route.id}/progress?asOf=${DAY}`);

    expect(res.statusCode).toBe(200);
    const parsed = readingProgressSchema.safeParse(body(res));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const progress = parsed.data!;
    expect(progress.billingCycleId).toBe(fixA.billingCycleId);
    expect(progress.expected).toBe(1);
    expect(progress.data.map((r) => r.meterId)).toEqual([premise.meterId]);
    expect(progress.data[0]!.routeCode).toBe(route.code);
  });

  /**
   * **This endpoint reports the window containing the day, not the one a
   * run will bill** — the opposite default from
   * `/api/v1/meter-reads/progress`, and the difference is the question.
   *
   * A route is a walk somebody is doing, so its progress is about the
   * window the reads being taken land in. The cycle-wide screen asks
   * whether a run can bill, which is the last period already closed.
   * Asking this one the cycle-wide way reported a period that had
   * already been billed on the page a supervisor opens during the
   * reading week — "2 of 10" beside a route whose sheet has 9 rows
   * today, which is a figure somebody acts on wrongly.
   *
   * The fixture cycle bills on the 10th, so for 2026-06-05 the two
   * windows are 2026-05-11..2026-06-10 and 2026-04-11..2026-05-10.
   */
  it("reports the window containing the day, and the billing one when asked", async () => {
    const { route } = await routeWithStop();

    const reading = readingProgressSchema.parse(
      body(await get(`/api/v1/read-routes/${route.id}/progress?asOf=${DAY}`)),
    );
    expect(reading.windowStart.slice(0, 10)).toBe("2026-05-11");
    expect(reading.windowEnd.slice(0, 10)).toBe("2026-06-10");

    const billing = readingProgressSchema.parse(
      body(await get(`/api/v1/read-routes/${route.id}/progress?asOf=${DAY}&window=billing`)),
    );
    expect(billing.windowStart.slice(0, 10)).toBe("2026-04-11");
    expect(billing.windowEnd.slice(0, 10)).toBe("2026-05-10");
  });

  it("refuses a window that is neither", async () => {
    const { route } = await routeWithStop();
    expect(
      (await get(`/api/v1/read-routes/${route.id}/progress?window=whenever`)).statusCode,
    ).toBe(400);
  });
});

/**
 * §5.10: route maintenance is EDIT, entry is CREATE, sheets and progress
 * are VIEW. Each case holds exactly one verb, so a route declaring the
 * wrong one fails here and nowhere else.
 */
describe("the verb each endpoint is gated on", () => {
  it("lets VIEW read the list, the stops, the sheet and the progress", async () => {
    const { route } = await routeWithStop([1000, 1030]);
    await grantOnly(["VIEW"]);

    expect((await get("/api/v1/read-routes")).statusCode).toBe(200);
    expect((await get(`/api/v1/read-routes/${route.id}`)).statusCode).toBe(200);
    expect((await get(`/api/v1/read-routes/${route.id}/stops`)).statusCode).toBe(200);
    expect((await get(`/api/v1/read-routes/${route.id}/unsequenced`)).statusCode).toBe(200);
    expect((await get(`/api/v1/read-routes/${route.id}/sheet?onDate=${DAY}`)).statusCode).toBe(200);
    expect((await get(`/api/v1/read-routes/${route.id}/progress?asOf=${DAY}`)).statusCode).toBe(200);
  });

  it("refuses VIEW the route and stop maintenance that is EDIT", async () => {
    const { route } = await routeWithStop();
    const premise = await makePremise();
    const stopId = (
      readRouteStopDetailListSchema.parse(body(await get(`/api/v1/read-routes/${route.id}/stops`)))
        .data[0]!
    ).id;
    await grantOnly(["VIEW"]);

    expect(
      (await post("/api/v1/read-routes", {
        code: "W-99",
        name: "Nope",
        billingCycleId: fixA.billingCycleId,
      })).statusCode,
    ).toBe(403);
    expect((await patch(`/api/v1/read-routes/${route.id}`, { name: "Nope" })).statusCode).toBe(403);
    expect(
      (await post(`/api/v1/read-routes/${route.id}/stops`, { premiseId: premise.premiseId }))
        .statusCode,
    ).toBe(403);
    expect((await del(`/api/v1/read-routes/${route.id}/stops/${stopId}`)).statusCode).toBe(403);
  });

  it("refuses VIEW the entry that is CREATE", async () => {
    const { route, premise } = await routeWithStop();
    const opened = body(await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY }));
    await grantOnly(["VIEW"]);

    expect(
      (await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY })).statusCode,
    ).toBe(403);
    expect(
      (await patch(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/rows`, {
        meterId: premise.meterId,
        registerId: null,
        reading: 1,
      })).statusCode,
    ).toBe(403);
    expect(
      (await post(`/api/v1/read-routes/${route.id}/entry/${opened.batchId}/submit`, {})).statusCode,
    ).toBe(403);
    expect(
      (await post(`/api/v1/read-routes/${route.id}/entry/reopen`, { readDate: DAY })).statusCode,
    ).toBe(403);
  });

  /*
   * CREATE alone must not be a licence to rearrange the walk: a clerk
   * typing a sheet in is not the person who decides which addresses are
   * on it.
   */
  it("refuses CREATE the route maintenance that is EDIT", async () => {
    const { route } = await routeWithStop();
    const premise = await makePremise();
    await grantOnly(["VIEW", "CREATE"]);

    expect((await patch(`/api/v1/read-routes/${route.id}`, { name: "Nope" })).statusCode).toBe(403);
    expect(
      (await post(`/api/v1/read-routes/${route.id}/stops`, { premiseId: premise.premiseId }))
        .statusCode,
    ).toBe(403);
    expect(
      (await post(`/api/v1/read-routes/${route.id}/entry`, { readDate: DAY })).statusCode,
    ).toBe(201);
  });
});
