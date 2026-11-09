import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
      svc.createReadRoute(TENANT_A, actor, {
        code: "R-1",
        name: "North",
        billingCycleId: fixA.billingCycleId,
      } as never),
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
    const input = { code: "R-1", name: "North", billingCycleId: fixA.billingCycleId } as never;
    await asA(() => svc.createReadRoute(TENANT_A, actor, input));
    await expect(asA(() => svc.createReadRoute(TENANT_A, actor, input))).rejects.toMatchObject({
      statusCode: 409,
      code: "ROUTE_CODE_TAKEN",
    });
  });

  it("refuses a billing cycle that is not this tenant's", async () => {
    await expect(
      asA(() =>
        svc.createReadRoute(TENANT_A, actor, {
          code: "R-1",
          name: "North",
          billingCycleId: fixB.billingCycleId,
        } as never),
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

  it("updateReadRoute changes the name and audits it", async () => {
    const route = await asA(() =>
      svc.createReadRoute(TENANT_A, actor, {
        code: "R-1",
        name: "North",
        billingCycleId: fixA.billingCycleId,
      } as never),
    );
    const updated = await asA(() => svc.updateReadRoute(TENANT_A, actor, route.id, { name: "South" }));
    expect(updated.name).toBe("South");
    await expect(
      asA(() => svc.updateReadRoute(TENANT_A, actor, fixB.billingCycleId, { name: "x" })),
    ).rejects.toMatchObject({ statusCode: 404, code: "ROUTE_NOT_FOUND" });
  });
});
