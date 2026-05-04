import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 task 2 — RateServiceClass per-tenant ref table CRUD.
 *
 * Unlike kind/role, ServiceClass has no globals, so the test starts
 * from an empty table and verifies the per-tenant lifecycle: create,
 * filter by commodity, partial-update label, soft-delete (DELETE
 * flips is_active false instead of removing the row).
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;

let waterCommodityId: string;
let gasCommodityId: string;

const ACTOR_ID = "00000000-0000-4000-8000-aaaa00000001";

function makeToken(utilityId: string, actorId = ACTOR_ID) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: actorId,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const headers = () => ({ authorization: `Bearer ${makeToken(TENANT_A)}` });

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();

  const { prisma } = prismaImports;
  // Two commodities so we can verify the commodityId filter actually
  // narrows the list.
  const water = await prisma.commodity.create({
    data: { utilityId: TENANT_A, code: "water", name: "Water" },
  });
  const gas = await prisma.commodity.create({
    data: { utilityId: TENANT_A, code: "gas", name: "Gas" },
  });
  waterCommodityId = water.id;
  gasCommodityId = gas.id;
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  // Clean slate for each test — this table has no globals, so a
  // straight DELETE leaves it empty.
  await prisma.$executeRawUnsafe("DELETE FROM rate_service_class");

  // Ensure the rate_schedules module is enabled for TENANT_A.
  const existing = await prisma.tenantModule.findFirst({
    where: { utilityId: TENANT_A, moduleKey: "rate_schedules" },
  });
  if (!existing) {
    await prisma.tenantModule.create({
      data: { utilityId: TENANT_A, moduleKey: "rate_schedules" },
    });
  }
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateTenantModulesCache(TENANT_A);
});

describe("/api/v1/rate-service-classes", () => {
  it("POST creates a service class (status 201, fields round-trip)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rate-service-classes",
      headers: headers(),
      payload: {
        commodityId: waterCommodityId,
        code: "single_family",
        label: "Single Family",
        sortOrder: 10,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.commodityId).toBe(waterCommodityId);
    expect(body.code).toBe("single_family");
    expect(body.label).toBe("Single Family");
    expect(body.sortOrder).toBe(10);
    expect(body.isActive).toBe(true);
    expect(body.utilityId).toBe(TENANT_A);
  });

  it("GET filtered by commodityId returns only matching rows", async () => {
    const { prisma } = prismaImports;
    await prisma.rateServiceClass.createMany({
      data: [
        {
          utilityId: TENANT_A,
          commodityId: waterCommodityId,
          code: "single_family",
          label: "Single Family",
          sortOrder: 10,
        },
        {
          utilityId: TENANT_A,
          commodityId: waterCommodityId,
          code: "multi_family",
          label: "Multi-Family",
          sortOrder: 20,
        },
        {
          utilityId: TENANT_A,
          commodityId: gasCommodityId,
          code: "residential",
          label: "Residential",
          sortOrder: 10,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/rate-service-classes?commodityId=${waterCommodityId}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body.every((r: { commodityId: string }) => r.commodityId === waterCommodityId)).toBe(
      true,
    );
    expect(body.map((r: { code: string }) => r.code).sort()).toEqual([
      "multi_family",
      "single_family",
    ]);
  });

  it("PATCH updates the label (status 200, label changed)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/rate-service-classes",
      headers: headers(),
      payload: {
        commodityId: waterCommodityId,
        code: "msu",
        label: "MSU",
      },
    });
    const created = JSON.parse(create.body);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/rate-service-classes/${created.id}`,
      headers: headers(),
      payload: { label: "Master-Sub-Metered Unit" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.label).toBe("Master-Sub-Metered Unit");
    expect(body.code).toBe("msu");
  });

  it("DELETE soft-deletes (status 204, follow-up GET returns 200 with isActive: false)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/rate-service-classes",
      headers: headers(),
      payload: {
        commodityId: waterCommodityId,
        code: "commercial",
        label: "Commercial",
      },
    });
    const created = JSON.parse(create.body);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/rate-service-classes/${created.id}`,
      headers: headers(),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/rate-service-classes/${created.id}`,
      headers: headers(),
    });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body);
    expect(body.isActive).toBe(false);
  });
});
