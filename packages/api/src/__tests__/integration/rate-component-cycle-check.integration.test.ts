import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * Slice 2 task 2 — POST /api/v1/rate-schedules/:scheduleId/cycle-check.
 *
 * Validates a proposed RateComponent against the schedule's existing
 * components by running the rate engine's `detectCycles`. Returns
 * 200 + `{ valid: true }` when adding/editing the component does not
 * introduce a `percent_of` cycle, or 400 + `{ valid: false, cycle }`
 * when it does.
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
  await prisma.$executeRawUnsafe("DELETE FROM rate_component");
  await prisma.$executeRawUnsafe("DELETE FROM rate_schedule");

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

const flatConsumption = {
  kindCode: "consumption",
  label: "Volumetric Charge",
  predicate: { class: "single_family" },
  quantitySource: { base: "metered", transforms: [] },
  pricing: { type: "flat", rate: 5.25 },
  sortOrder: 100,
  effectiveDate: "2026-01-01",
};

const flatTax = {
  kindCode: "tax",
  label: "Sales Tax",
  predicate: { class: "single_family" },
  quantitySource: { base: "metered", transforms: [] },
  pricing: { type: "flat", rate: 0.5 },
  sortOrder: 200,
  effectiveDate: "2026-01-01",
};

async function postComponent(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/rate-schedules/${scheduleId}/components`,
    headers: headers(),
    payload,
  });
  if (res.statusCode !== 201) {
    throw new Error(`failed to create component: ${res.statusCode} ${res.body}`);
  }
  return JSON.parse(res.body);
}

describe("POST /api/v1/rate-schedules/:scheduleId/cycle-check", () => {
  it("returns 200 with valid:true when proposed component does not introduce a cycle", async () => {
    // Existing schedule already has a flat consumption component.
    await postComponent(flatConsumption);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${scheduleId}/cycle-check`,
      headers: headers(),
      payload: {
        componentId: null,
        kindCode: "surcharge",
        label: "Surcharge on Consumption",
        predicate: { class: "single_family" },
        quantitySource: { base: "metered", transforms: [] },
        pricing: {
          type: "percent_of",
          percent: 10,
          selector: { kind: "consumption" },
        },
        sortOrder: 150,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.valid).toBe(true);
    expect(body.cycle).toBeUndefined();
  });

  it("returns 400 with valid:false and cycle path when proposed component creates a cycle", async () => {
    // Seed an existing "consumption" component whose pricing already
    // depends on tax. Then propose a "tax" component that depends on
    // consumption — that closes the loop.
    await postComponent({
      ...flatConsumption,
      pricing: {
        type: "percent_of",
        percent: 50,
        selector: { kind: "tax" },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${scheduleId}/cycle-check`,
      headers: headers(),
      payload: {
        componentId: null,
        kindCode: "tax",
        label: "Sales Tax",
        predicate: { class: "single_family" },
        quantitySource: { base: "metered", transforms: [] },
        pricing: {
          type: "percent_of",
          percent: 10,
          selector: { kind: "consumption" },
        },
        sortOrder: 200,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.valid).toBe(false);
    expect(Array.isArray(body.cycle)).toBe(true);
    expect(body.cycle.length).toBeGreaterThan(0);
  });

  it("returns 200 when editing an existing component (its old definition is replaced, not added)", async () => {
    // Two flat-pricing components already on the schedule. Editing
    // one of them with a still-flat pricing must not be flagged as
    // a cycle.
    const c1 = await postComponent(flatConsumption);
    await postComponent(flatTax);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${scheduleId}/cycle-check`,
      headers: headers(),
      payload: {
        componentId: c1.id,
        kindCode: "consumption",
        label: "Volumetric Charge (revised)",
        predicate: { class: "single_family" },
        quantitySource: { base: "metered", transforms: [] },
        pricing: { type: "flat", rate: 6.5 },
        sortOrder: 100,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.valid).toBe(true);
  });
});
