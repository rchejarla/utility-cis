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
async function makePremise(tag: string, tenant = TENANT_A): Promise<string> {
  return seedAsPlatform(async () => {
    const p = await prismaImports.prisma.premise.create({
      data: {
        utilityId: tenant,
        addressLine1: `${tag} Elm Street`,
        city: "Testville",
        state: "TS",
        zip: "00000",
        premiseType: "RESIDENTIAL",
        commodityIds: [],
        status: "ACTIVE",
      },
    });
    return p.id;
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

  it("serialises two appends racing on one route", async () => {
    const route = await makeRoute("R-1");
    const p2 = await makePremise("2");
    const results = await Promise.all([add(route, fixA.premiseId), add(route, p2)]);
    expect(results.map((r) => r.sequence).sort((x, y) => x - y)).toEqual([100, 200]);
  });

  it("removes a stop, leaves the others where they are, and audits both changes", async () => {
    const route = await makeRoute("R-1");
    const p2 = await makePremise("2");
    const a = await add(route, fixA.premiseId);
    const b = await add(route, p2);
    await asA(() => svc.removeStop(TENANT_A, actor, route, a.id));
    expect(await sequences(route)).toEqual([200]);

    const audit = await seedAsPlatform(async () =>
      await prismaImports.prisma.auditLog.findMany({ where: { entityId: { in: [a.id, b.id] } } }),
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

  it("refuses the tray for an EXTERNAL route", async () => {
    const route = await makeRoute("V-1", "EXTERNAL");
    await expect(
      asA(() => svc.listUnsequencedPremises(TENANT_A, route, unsequencedPremiseQuerySchema.parse({}))),
    ).rejects.toMatchObject({ statusCode: 400, code: "ROUTE_IS_EXTERNAL" });
  });
});
