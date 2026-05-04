import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * Slice 2 task 1 — `/api/v1/rate-grammar/registered`.
 *
 * Verifies the endpoint returns the closed-grammar atom lists plus
 * the tenant-resolved kinds and roles in a single payload. The
 * configurator UI reads this once on mount to populate every dropdown.
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
  // Each test starts from globals only — drop any tenant overrides
  // accumulated by prior tests.
  await prisma.$executeRawUnsafe(
    "DELETE FROM rate_component_kind WHERE utility_id IS NOT NULL",
  );
  await prisma.$executeRawUnsafe(
    "DELETE FROM rate_assignment_role WHERE utility_id IS NOT NULL",
  );
  // Ensure the rate_schedules module is enabled for TENANT_A so the
  // route's permission check passes.
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

describe("/api/v1/rate-grammar/registered", () => {
  it("returns all 8 expected sections", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/rate-grammar/registered",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("kinds");
    expect(body).toHaveProperty("roles");
    expect(body).toHaveProperty("pricingTypes");
    expect(body).toHaveProperty("predicateOps");
    expect(body).toHaveProperty("quantitySources");
    expect(body).toHaveProperty("transforms");
    expect(body).toHaveProperty("selectorOps");
    expect(body).toHaveProperty("variables");
  });

  it("kinds includes the 11 expected globals", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/rate-grammar/registered",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const codes = body.kinds.map((k: { code: string }) => k.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "service_charge",
        "consumption",
        "derived_consumption",
        "non_meter",
        "item_price",
        "one_time_fee",
        "surcharge",
        "tax",
        "credit",
        "reservation_charge",
        "minimum_bill",
      ]),
    );
  });

  it("roles includes the 5 expected globals", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/rate-grammar/registered",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const codes = body.roles.map((r: { code: string }) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining(["primary", "delivery", "supply", "rider", "opt_in"]),
    );
  });
});
