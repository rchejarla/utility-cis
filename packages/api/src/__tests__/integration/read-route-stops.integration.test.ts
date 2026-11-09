import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readRouteInputSchema, unsequencedPremiseQuerySchema } from "@utility-cis/shared";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
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
 * Stops in order, against a real database. The duplicate-premise refusal
 * rests on a unique key, the "no renumbering" claim is about which rows
 * were written, and the tray is a tenant-scoped anti-join, so a mocked
 * client would assert our own stubs.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/read-route.service.js");
let tenancy: typeof import("../../lib/tenant-context.js");

let fixA: TenantFixture;
let fixB: TenantFixture;
const actor = { id: ACTOR, name: "Test Actor" };

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  tenancy = await import("../../lib/tenant-context.js");
  svc = await import("../../services/read-route.service.js");
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

async function makeRoute(code: string, origin: "LOCAL" | "EXTERNAL" = "LOCAL"): Promise<string> {
  const route = await asA(() =>
    svc.createReadRoute(
      TENANT_A,
      actor,
      readRouteInputSchema.parse({ code, name: code, billingCycleId: fixA.billingCycleId, origin }),
    ),
  );
  return route.id;
}

/** A further premise in tenant A (the fixture supplies one already). */
async function makePremise(
  tag: string,
  tenant = TENANT_A,
  over: { status?: "ACTIVE" | "INACTIVE" | "CONDEMNED"; city?: string } = {},
): Promise<string> {
  return seedAsPlatform(async () => {
    const p = await prismaImports.prisma.premise.create({
      data: {
        utilityId: tenant,
        addressLine1: `${tag} Elm Street`,
        city: over.city ?? "Testville",
        state: "TS",
        zip: "00000",
        premiseType: "RESIDENTIAL",
        commodityIds: [],
        status: over.status ?? "ACTIVE",
      },
    });
    return p.id;
  });
}

/** Stops written straight to the table, bypassing the service and its lock. */
async function rawStops(routeId: string, stops: [string, number][]): Promise<void> {
  await seedAsPlatform(async () => {
    for (const [premiseId, sequence] of stops) {
      await prismaImports.prisma.$executeRawUnsafe(
        `INSERT INTO read_route_stop (utility_id, read_route_id, premise_id, sequence)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        TENANT_A,
        routeId,
        premiseId,
        sequence,
      );
    }
  });
}

const add = (routeId: string, premiseId: string, afterSequence?: number) =>
  asA(() => svc.addStop(TENANT_A, actor, routeId, { premiseId, afterSequence }));

const sequences = async (routeId: string) =>
  (await asA(() => svc.listStops(TENANT_A, routeId))).map((s) => s.sequence);

describe("stops in order", () => {
  it("appends a stop at the end when no position is given", async () => {
    const route = await makeRoute("R-1");
    const p2 = await makePremise("2");
    const p3 = await makePremise("3");
    const first = await add(route, fixA.premiseId);
    await add(route, p2);
    await add(route, p3);
    expect(first.sequence).toBe(100);
    expect(await sequences(route)).toEqual([100, 200, 300]);
  });

  it("inserts between two stops without renumbering them", async () => {
    const route = await makeRoute("R-1");
    const p2 = await makePremise("2");
    const p3 = await makePremise("3");
    const a = await add(route, fixA.premiseId);
    const b = await add(route, p2);
    const mid = await add(route, p3, a.sequence);

    expect(mid.sequence).toBe(150);
    const stops = await asA(() => svc.listStops(TENANT_A, route));
    expect(stops.map((s) => s.premiseId)).toEqual([fixA.premiseId, p3, p2]);
    // The neighbours are the same rows at the same sequences: one row was written.
    expect(stops.find((s) => s.id === a.id)!.sequence).toBe(100);
    expect(stops.find((s) => s.id === b.id)!.sequence).toBe(200);
  });

  it("inserts at the front with afterSequence 0", async () => {
    const route = await makeRoute("R-1");
    const p2 = await makePremise("2");
    await add(route, fixA.premiseId);
    const front = await add(route, p2, 0);
    expect(front.sequence).toBe(50);
    expect((await asA(() => svc.listStops(TENANT_A, route))).map((s) => s.premiseId)).toEqual([p2, fixA.premiseId]);
  });

  it("refuses an insert when no integer fits, rather than renumbering", async () => {
    const route = await makeRoute("R-1");
    const premises = [fixA.premiseId, await makePremise("2"), await makePremise("3")];
    // Adjacent integers: the gap between 100 and 101 holds nothing.
    await seedAsPlatform(async () => {
      await prismaImports.prisma.$executeRawUnsafe(
        `INSERT INTO read_route_stop (utility_id, read_route_id, premise_id, sequence)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 100), ($1::uuid, $2::uuid, $4::uuid, 101)`,
        TENANT_A,
        route,
        premises[0],
        premises[1],
      );
    });
    await expect(add(route, premises[2]!, 100)).rejects.toMatchObject({
      statusCode: 409,
      code: "SEQUENCE_FULL",
    });
    expect(await sequences(route)).toEqual([100, 101]);
  });

  it("inserts when exactly one integer fits (neighbours 100 and 102)", async () => {
    const route = await makeRoute("R-1");
    const [p1, p2, p3] = [fixA.premiseId, await makePremise("2"), await makePremise("3")];
    await rawStops(route, [[p1, 100], [p2, 102]]);
    const mid = await add(route, p3, 100);
    expect(mid.sequence).toBe(101);
    expect(await sequences(route)).toEqual([100, 101, 102]);
  });

  it("appends at afterSequence + 100 when it is past the last stop", async () => {
    const route = await makeRoute("R-1");
    await add(route, fixA.premiseId);
    const far = await add(route, await makePremise("2"), 5000);
    expect(far.sequence).toBe(5100);
  });

  it("refuses a premise that is not ACTIVE", async () => {
    const route = await makeRoute("R-1");
    const gone = await makePremise("2", TENANT_A, { status: "INACTIVE" });
    await expect(add(route, gone)).rejects.toMatchObject({ statusCode: 400, code: "PREMISE_NOT_ACTIVE" });
    expect(await sequences(route)).toEqual([]);
  });

  it("refuses a premise already on another route", async () => {
    const route = await makeRoute("R-1");
    const other = await makeRoute("R-2");
    await add(other, fixA.premiseId);
    await expect(add(route, fixA.premiseId)).rejects.toMatchObject({
      statusCode: 409,
      code: "PREMISE_ALREADY_ON_ROUTE",
    });
  });

  it("holds one-route-per-premise in the database, not only in addStop", async () => {
    const route = await makeRoute("R-1");
    const other = await makeRoute("R-2");
    await rawStops(route, [[fixA.premiseId, 100]]);
    await expect(rawStops(other, [[fixA.premiseId, 100]])).rejects.toThrow(
      /read_route_stop_one_route_per_premise_key/,
    );
  });

  it("refuses the same premise twice on one route", async () => {
    const route = await makeRoute("R-1");
    await add(route, fixA.premiseId);
    await expect(add(route, fixA.premiseId)).rejects.toMatchObject({
      statusCode: 409,
      code: "PREMISE_ALREADY_ON_ROUTE",
    });
    expect(await sequences(route)).toEqual([100]);
  });

  it("refuses a stop on an EXTERNAL route", async () => {
    const route = await makeRoute("V-1", "EXTERNAL");
    await expect(add(route, fixA.premiseId)).rejects.toMatchObject({
      statusCode: 400,
      code: "ROUTE_IS_EXTERNAL",
    });
  });

  it("refuses a route or premise that is not this tenant's", async () => {
    const route = await makeRoute("R-1");
    await expect(add("00000000-0000-4000-8000-00000000dead", fixA.premiseId)).rejects.toMatchObject({
      statusCode: 404,
      code: "ROUTE_NOT_FOUND",
    });
    await expect(add(route, fixB.premiseId)).rejects.toMatchObject({
      statusCode: 404,
      code: "PREMISE_NOT_FOUND",
    });
  });

  it("serialises appends racing on one route", async () => {
    const route = await makeRoute("R-1");
    const premises = [fixA.premiseId];
    for (let i = 2; i <= 8; i++) premises.push(await makePremise(String(i)));
    await Promise.all(premises.map((p) => add(route, p)));
    // Without the route lock several would read the same max and collide.
    expect(await sequences(route)).toEqual([100, 200, 300, 400, 500, 600, 700, 800]);
  });

  it("removes a stop, leaves the others where they are, and audits both changes", async () => {
    const route = await makeRoute("R-1");
    const p2 = await makePremise("2");
    const a = await add(route, fixA.premiseId);
    const b = await add(route, p2);
    await asA(() => svc.removeStop(TENANT_A, actor, route, a.id));
    expect(await sequences(route)).toEqual([200]);

    const audit = await seedAsPlatform(async () =>
      await prismaImports.prisma.auditLog.findMany({
        where: { utilityId: TENANT_A, entityId: { in: [a.id, b.id] } },
      }),
    );
    const types = audit.map((r) => (r.metadata as { eventType: string }).eventType).sort();
    expect(types).toEqual(["read_route_stop.created", "read_route_stop.created", "read_route_stop.deleted"]);
  });

  it("refuses to remove a stop that is not on that route", async () => {
    const route = await makeRoute("R-1");
    const other = await makeRoute("R-2");
    const a = await add(route, fixA.premiseId);
    await expect(asA(() => svc.removeStop(TENANT_A, actor, other, a.id))).rejects.toMatchObject({
      statusCode: 404,
      code: "STOP_NOT_FOUND",
    });
    expect(await sequences(route)).toEqual([100]);
  });

  it("lists premises in this tenant that are on no route", async () => {
    const route = await makeRoute("R-1");
    const other = await makeRoute("R-2");
    const onThis = fixA.premiseId;
    const onOther = await makePremise("2");
    const free = await makePremise("3");
    await makePremise("4", TENANT_B);
    await add(route, onThis);
    await add(other, onOther);

    const { data, meta } = await asA(() =>
      svc.listUnsequencedPremises(TENANT_A, route, unsequencedPremiseQuerySchema.parse({})),
    );
    // A premise on ANOTHER route is not offered either: a reader visits an address once.
    expect(data.map((p) => p.id)).toEqual([free]);
    expect(meta).toMatchObject({ total: 1, page: 1 });
  });

  it("leaves non-ACTIVE premises out of the tray", async () => {
    const route = await makeRoute("R-1");
    await makePremise("2", TENANT_A, { status: "INACTIVE" });
    await makePremise("3", TENANT_A, { status: "CONDEMNED" });
    const active = await makePremise("4");
    const { data } = await asA(() =>
      svc.listUnsequencedPremises(TENANT_A, route, unsequencedPremiseQuerySchema.parse({})),
    );
    // fixA's own premise is ACTIVE and on no route, so it is offered too.
    expect(data.map((p) => p.id).sort()).toEqual([fixA.premiseId, active].sort());
  });

  it("filters the tray by search on address and city", async () => {
    const route = await makeRoute("R-1");
    const maple = await makePremise("Maple", TENANT_A, { city: "Springfield" });
    const oak = await makePremise("Oak", TENANT_A, { city: "Shelbyville" });
    const tray = (search: string) =>
      asA(() => svc.listUnsequencedPremises(TENANT_A, route, unsequencedPremiseQuerySchema.parse({ search })));
    expect((await tray("maple")).data.map((p) => p.id)).toEqual([maple]);
    expect((await tray("shelby")).data.map((p) => p.id)).toEqual([oak]);
    expect((await tray("nowhere")).data).toEqual([]);
  });

  it("refuses the tray for an EXTERNAL route", async () => {
    const route = await makeRoute("V-1", "EXTERNAL");
    await expect(
      asA(() => svc.listUnsequencedPremises(TENANT_A, route, unsequencedPremiseQuerySchema.parse({}))),
    ).rejects.toMatchObject({ statusCode: 400, code: "ROUTE_IS_EXTERNAL" });
  });
});
