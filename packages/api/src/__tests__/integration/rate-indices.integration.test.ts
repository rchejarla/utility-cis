import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 task 7 — RateIndex CRUD endpoints.
 *
 * Indexes are tenant data with no FK dependencies on other rate tables,
 * so each test wipes `rate_index` between runs and exercises the five
 * CRUD endpoints directly with `app.inject`.
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
  await prisma.$executeRawUnsafe("DELETE FROM rate_index");

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

const facPayload = {
  name: "fac",
  period: "2026Q1",
  value: 0.00125,
  effectiveDate: "2026-01-01",
};

describe("/api/v1/rate-indices", () => {
  it("POST creates a rate index (status 201, fields round-trip)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rate-indices",
      headers: headers(),
      payload: facPayload,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("fac");
    expect(body.period).toBe("2026Q1");
    expect(Number(body.value)).toBe(0.00125);
    expect(body.effectiveDate).toMatch(/^2026-01-01/);
    expect(body.utilityId).toBe(TENANT_A);
  });

  it("POST rejects an invalid name (uppercase or hyphen) → 400", async () => {
    const upper = await app.inject({
      method: "POST",
      url: "/api/v1/rate-indices",
      headers: headers(),
      payload: { ...facPayload, name: "FAC" },
    });
    expect(upper.statusCode).toBe(400);

    const hyphen = await app.inject({
      method: "POST",
      url: "/api/v1/rate-indices",
      headers: headers(),
      payload: { ...facPayload, name: "fuel-adjust" },
    });
    expect(hyphen.statusCode).toBe(400);
  });

  it("GET filtered by name returns only matching rows", async () => {
    // Three indices: two named "fac" (different periods), one named "epcc".
    for (const payload of [
      { name: "fac", period: "2026Q1", value: 0.00125, effectiveDate: "2026-01-01" },
      { name: "fac", period: "2026Q2", value: 0.0014, effectiveDate: "2026-04-01" },
      { name: "epcc", period: "2026Q1", value: 0.07, effectiveDate: "2026-01-01" },
    ]) {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/rate-indices",
        headers: headers(),
        payload,
      });
      expect(create.statusCode).toBe(201);
    }

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/rate-indices?name=fac",
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    const body = JSON.parse(list.body);
    expect(body).toHaveLength(2);
    for (const row of body) {
      expect(row.name).toBe("fac");
    }
    expect(body.map((r: { period: string }) => r.period).sort()).toEqual(["2026Q1", "2026Q2"]);
  });

  it("PATCH updates value (status 200, value changed)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/rate-indices",
      headers: headers(),
      payload: facPayload,
    });
    expect(create.statusCode).toBe(201);
    const created = JSON.parse(create.body);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/rate-indices/${created.id}`,
      headers: headers(),
      payload: { value: 0.00185 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Number(body.value)).toBe(0.00185);
    // Untouched fields stick around.
    expect(body.name).toBe("fac");
    expect(body.period).toBe("2026Q1");
  });

  it("DELETE removes a row (status 204, follow-up GET returns 404)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/rate-indices",
      headers: headers(),
      payload: facPayload,
    });
    const created = JSON.parse(create.body);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/rate-indices/${created.id}`,
      headers: headers(),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/rate-indices/${created.id}`,
      headers: headers(),
    });
    expect(get.statusCode).toBe(404);
  });
});
