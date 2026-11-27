import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readRouteInputSchema, readRouteUpdateSchema } from "@utility-cis/shared";
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
 * Route maintenance against a real database. Two of these are database
 * behaviours — the duplicate-code refusal rests on the unique key and the
 * cross-tenant cycle on a tenant-scoped lookup — so a mocked client
 * would assert our own stubs.
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

describe("read route maintenance", () => {
  it("creates a LOCAL route by default", async () => {
    const route = await asA(() =>
      svc.createReadRoute(
        TENANT_A,
        actor,
        readRouteInputSchema.parse({ code: "R-1", name: "North", billingCycleId: fixA.billingCycleId }),
      ),
    );
    expect(route.origin).toBe("LOCAL");
    expect(route.active).toBe(true);
    const audit = await seedAsPlatform(async () =>
      await prismaImports.prisma.auditLog.findMany({ where: { entityId: route.id } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ eventType: "read_route.created" });
  });

  it("refuses a duplicate code on the same tenant", async () => {
    const input = readRouteInputSchema.parse({
      code: "R-1",
      name: "North",
      billingCycleId: fixA.billingCycleId,
    });
    await asA(() => svc.createReadRoute(TENANT_A, actor, input));
    await expect(asA(() => svc.createReadRoute(TENANT_A, actor, input))).rejects.toMatchObject({
      statusCode: 409,
      code: "ROUTE_CODE_TAKEN",
    });
  });

  it("refuses a billing cycle that is not this tenant's", async () => {
    await expect(
      asA(() =>
        svc.createReadRoute(
          TENANT_A,
          actor,
          readRouteInputSchema.parse({ code: "R-1", name: "North", billingCycleId: fixB.billingCycleId }),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "CYCLE_NOT_FOUND" });
  });

  it("upsertExternalRoute creates a route with no stops and origin EXTERNAL", async () => {
    const id = await asA(() =>
      prismaImports.prisma.$transaction((tx) =>
        svc.upsertExternalRoute(tx, TENANT_A, "V-77", fixA.billingCycleId),
      ),
    );
    const list = await asA(() => svc.listReadRoutes(TENANT_A, {}));
    const row = list.data.find((r) => r.id === id)!;
    expect(row.origin).toBe("EXTERNAL");
    expect(row.code).toBe("V-77");
    expect(row.stopCount).toBe(0);
    expect(row.cycleCode).toBe(fixA.billingCycleCode);
  });

  it("upsertExternalRoute returns the existing id on a second call", async () => {
    const call = () =>
      asA(() =>
        prismaImports.prisma.$transaction((tx) =>
          svc.upsertExternalRoute(tx, TENANT_A, "V-77", fixA.billingCycleId),
        ),
      );
    const first = await call();
    const second = await call();
    expect(second).toBe(first);
    const list = await asA(() => svc.listReadRoutes(TENANT_A, {}));
    expect(list.data).toHaveLength(1);
  });

  async function makeRoute() {
    return asA(() =>
      svc.createReadRoute(
        TENANT_A,
        actor,
        readRouteInputSchema.parse({ code: "R-1", name: "North", billingCycleId: fixA.billingCycleId }),
      ),
    );
  }

  const inTx = (code: string, cycleId: string) =>
    asA(() =>
      prismaImports.prisma.$transaction((tx) => svc.upsertExternalRoute(tx, TENANT_A, code, cycleId)),
    );

  it("updateReadRoute changes the name and writes an update audit row", async () => {
    const route = await makeRoute();
    const updated = await asA(() => svc.updateReadRoute(TENANT_A, actor, route.id, { name: "South" }));
    expect(updated.name).toBe("South");
    const audit = await seedAsPlatform(async () =>
      await prismaImports.prisma.auditLog.findMany({
        where: { entityId: route.id },
        orderBy: { createdAt: "asc" },
      }),
    );
    expect(audit).toHaveLength(2);
    expect(audit[1]!.metadata).toMatchObject({ eventType: "read_route.updated" });
    expect(audit[1]!.beforeState).toMatchObject({ name: "North" });
    expect(audit[1]!.afterState).toMatchObject({ name: "South" });
  });

  it("updateReadRoute refuses an unknown route", async () => {
    await expect(
      asA(() => svc.updateReadRoute(TENANT_A, actor, "00000000-0000-4000-8000-00000000dead", { name: "x" })),
    ).rejects.toMatchObject({ statusCode: 404, code: "ROUTE_NOT_FOUND" });
  });

  it("the update schema drops origin, so a PATCH cannot change it", () => {
    expect(readRouteUpdateSchema.parse({ origin: "EXTERNAL", name: "x" })).toEqual({ name: "x" });
  });

  it("upsertExternalRoute refuses a LOCAL route", async () => {
    await makeRoute();
    await expect(inTx("R-1", fixA.billingCycleId)).rejects.toMatchObject({
      statusCode: 409,
      code: "ROUTE_IS_LOCAL",
    });
  });

  it("upsertExternalRoute refuses another tenant's cycle with a clean 404", async () => {
    await expect(inTx("V-1", fixB.billingCycleId)).rejects.toMatchObject({
      statusCode: 404,
      code: "CYCLE_NOT_FOUND",
    });
  });

  it("upsertExternalRoute audits a creation with no actor, named Import, and not a second call", async () => {
    const id = await inTx("V-9", fixA.billingCycleId);
    await inTx("V-9", fixA.billingCycleId);
    const audit = await seedAsPlatform(async () =>
      await prismaImports.prisma.auditLog.findMany({ where: { entityId: id } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: null, actorName: "Import", entityType: "ReadRoute", action: "CREATE" });
    expect(audit[0]!.metadata).toMatchObject({ eventType: "read_route.created" });
  });

  it("upsertExternalRoute: two concurrent first inserts of one code get the same id", async () => {
    const [a, b] = await Promise.all([inTx("V-C", fixA.billingCycleId), inTx("V-C", fixA.billingCycleId)]);
    expect(a).toBe(b);
  });
});
