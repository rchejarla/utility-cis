import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 task 5 — RateComponent CRUD endpoints.
 *
 * Components are scoped to a RateSchedule. We create the schedule once
 * per beforeEach (after wiping rate_component) and exercise the
 * scheduled-scoped POST/GET-list endpoints plus the per-id PATCH/DELETE
 * endpoints.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;

let waterCommodityId: string;
let scheduleId: string;

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
  // Use an existing commodity if the fixture suite already seeded one
  // for TENANT_A; otherwise create our own. We don't want to compete
  // with rate-service-classes' fixture for the same code.
  const water = await prisma.commodity.upsert({
    where: { utilityId_code: { utilityId: TENANT_A, code: "water" } },
    create: { utilityId: TENANT_A, code: "water", name: "Water" },
    update: {},
  });
  waterCommodityId = water.id;
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  // Wipe components first (FK to schedule), then schedules so each
  // test starts from an empty state with a freshly-created schedule.
  await prisma.$executeRawUnsafe("DELETE FROM rate_component");
  await prisma.$executeRawUnsafe("DELETE FROM rate_schedule");

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

  // Create the parent schedule via the API so the route stack is the
  // same one a real client would hit. Capture its ID for use below.
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/rate-schedules",
    headers: headers(),
    payload: {
      name: "Residential Water",
      code: "RES-WATER",
      commodityId: waterCommodityId,
      effectiveDate: "2026-01-01",
    },
  });
  if (created.statusCode !== 201) {
    throw new Error(
      `failed to create fixture schedule: ${created.statusCode} ${created.body}`,
    );
  }
  scheduleId = JSON.parse(created.body).id;
});

const flatConsumptionPayload = {
  kindCode: "consumption",
  label: "Volumetric Charge",
  predicate: { class: "single_family" },
  quantitySource: { base: "metered", transforms: [] },
  pricing: { type: "flat", rate: 5.25 },
  sortOrder: 100,
  effectiveDate: "2026-01-01",
};

describe("/api/v1/rate-schedules/:scheduleId/components and /api/v1/rate-components/:id", () => {
  it("POST creates a flat consumption component (status 201, fields round-trip)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${scheduleId}/components`,
      headers: headers(),
      payload: flatConsumptionPayload,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.rateScheduleId).toBe(scheduleId);
    expect(body.kindCode).toBe("consumption");
    expect(body.label).toBe("Volumetric Charge");
    expect(body.predicate).toEqual({ class: "single_family" });
    expect(body.quantitySource).toEqual({ base: "metered", transforms: [] });
    expect(body.pricing).toEqual({ type: "flat", rate: 5.25 });
    expect(body.sortOrder).toBe(100);
    expect(body.utilityId).toBe(TENANT_A);
  });

  it("POST rejects an unknown kindCode (status 400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${scheduleId}/components`,
      headers: headers(),
      payload: {
        ...flatConsumptionPayload,
        kindCode: "weather_surcharge",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET list returns components for a schedule, ordered by sort_order ascending", async () => {
    // Insert three out-of-order components so the orderBy is doing work.
    for (const so of [300, 100, 200]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/rate-schedules/${scheduleId}/components`,
        headers: headers(),
        payload: {
          ...flatConsumptionPayload,
          label: `Component ${so}`,
          sortOrder: so,
        },
      });
      expect(res.statusCode).toBe(201);
    }

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/rate-schedules/${scheduleId}/components`,
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    const body = JSON.parse(list.body);
    expect(body).toHaveLength(3);
    expect(body.map((c: { sortOrder: number }) => c.sortOrder)).toEqual([100, 200, 300]);
  });

  it("PATCH updates pricing and sort_order (status 200, both fields changed)", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${scheduleId}/components`,
      headers: headers(),
      payload: flatConsumptionPayload,
    });
    const created = JSON.parse(create.body);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/rate-components/${created.id}`,
      headers: headers(),
      payload: {
        pricing: { type: "flat", rate: 7.5 },
        sortOrder: 250,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pricing).toEqual({ type: "flat", rate: 7.5 });
    expect(body.sortOrder).toBe(250);
    // Untouched fields stick around.
    expect(body.label).toBe("Volumetric Charge");
    expect(body.kindCode).toBe("consumption");
  });

  it("DELETE removes a component (status 204, follow-up GET returns 404)", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${scheduleId}/components`,
      headers: headers(),
      payload: flatConsumptionPayload,
    });
    const created = JSON.parse(create.body);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/rate-components/${created.id}`,
      headers: headers(),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/rate-components/${created.id}`,
      headers: headers(),
    });
    expect(get.statusCode).toBe(404);
  });
});
