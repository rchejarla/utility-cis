import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 task 1 — RateComponentKind ref table CRUD.
 *
 * Verifies the global+tenant-shadow resolution: a fresh tenant sees
 * the 11 seeded globals, can override a global by POSTing the same
 * code, and the override wins on the next list. DELETE on a tenant
 * override removes only that row, exposing the global again.
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
  // Clear tenant overrides between tests so each one starts from a
  // clean global-only slate. Globals (utility_id IS NULL) are
  // preserved — they were seeded by the migration and live for the
  // life of the container.
  await prisma.$executeRawUnsafe(
    "DELETE FROM rate_component_kind WHERE utility_id IS NOT NULL",
  );
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

describe("/api/v1/rate-component-kinds", () => {
  it("GET returns 11 globals for a fresh tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/rate-component-kinds",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(11);
    expect(body.every((k: { isGlobal: boolean }) => k.isGlobal)).toBe(true);
    expect(body.map((k: { code: string }) => k.code)).toContain("service_charge");
  });

  it("POST creates a tenant override and the override wins on next GET", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/rate-component-kinds",
      headers: headers(),
      payload: { code: "service_charge", label: "Monthly Service Fee" },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/rate-component-kinds",
      headers: headers(),
    });
    const body = JSON.parse(list.body);
    const sc = body.find((k: { code: string }) => k.code === "service_charge");
    expect(sc.label).toBe("Monthly Service Fee");
    expect(sc.isGlobal).toBe(false);
  });

  it("POST rejects an unregistered code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rate-component-kinds",
      headers: headers(),
      payload: { code: "weather_surcharge", label: "Weather" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE on a tenant override removes it; the global re-emerges", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/rate-component-kinds",
      headers: headers(),
      payload: { code: "tax", label: "Tax (override)" },
    });
    const created = JSON.parse(create.body);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/rate-component-kinds/${created.id}`,
      headers: headers(),
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/rate-component-kinds",
      headers: headers(),
    });
    const body = JSON.parse(list.body);
    const tax = body.find((k: { code: string }) => k.code === "tax");
    expect(tax.isGlobal).toBe(true);
  });
});
