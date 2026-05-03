import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 task 1 — RateAssignmentRole ref table CRUD.
 *
 * Mirrors rate-component-kinds.integration.test.ts: 5 globals seeded
 * by the migration, tenant overrides win per code, DELETE on an
 * override exposes the global again.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;

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
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.$executeRawUnsafe(
    "DELETE FROM rate_assignment_role WHERE utility_id IS NOT NULL",
  );
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

describe("/api/v1/rate-assignment-roles", () => {
  it("GET returns 5 globals for a fresh tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/rate-assignment-roles",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(5);
    expect(body.every((r: { isGlobal: boolean }) => r.isGlobal)).toBe(true);
    expect(body.map((r: { code: string }) => r.code)).toContain("primary");
  });

  it("POST creates a tenant override and the override wins on next GET", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/rate-assignment-roles",
      headers: headers(),
      payload: { code: "primary", label: "Primary Charge" },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/rate-assignment-roles",
      headers: headers(),
    });
    const body = JSON.parse(list.body);
    const primary = body.find((r: { code: string }) => r.code === "primary");
    expect(primary.label).toBe("Primary Charge");
    expect(primary.isGlobal).toBe(false);
  });

  it("POST rejects an unregistered code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rate-assignment-roles",
      headers: headers(),
      payload: { code: "auxiliary", label: "Auxiliary" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE on a tenant override removes it; the global re-emerges", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/rate-assignment-roles",
      headers: headers(),
      payload: { code: "rider", label: "Rider (override)" },
    });
    const created = JSON.parse(create.body);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/rate-assignment-roles/${created.id}`,
      headers: headers(),
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/rate-assignment-roles",
      headers: headers(),
    });
    const body = JSON.parse(list.body);
    const rider = body.find((r: { code: string }) => r.code === "rider");
    expect(rider.isGlobal).toBe(true);
  });
});
