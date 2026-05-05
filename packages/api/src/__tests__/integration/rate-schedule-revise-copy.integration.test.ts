import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * `reviseRateSchedule` must carry forward every still-active component
 * (expirationDate IS NULL) onto the new revision so operators don't have
 * to re-enter a 30-component tariff to change one rate. Two slices of
 * coverage:
 *
 *   1. A simple flat component is copied — same kindCode/label/pricing,
 *      different id, parented to the new schedule, effectiveDate = new
 *      schedule's effectiveDate.
 *   2. A `pricing.percent_of.selector.component_id` reference between
 *      two components is rewritten to point at the new ids.
 *   3. Components on the predecessor that already carry an explicit
 *      expirationDate are treated as retired and NOT copied.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;

let waterCommodityId: string;

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
  await prisma.$executeRawUnsafe("UPDATE rate_schedule SET superseded_by_id = NULL, supersedes_id = NULL");
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
});

async function createDraftSchedule(code = "RES-WATER", name = "Residential Water") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/rate-schedules",
    headers: headers(),
    payload: {
      name,
      code,
      commodityId: waterCommodityId,
      effectiveDate: "2026-01-01",
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`failed to create draft schedule: ${res.statusCode} ${res.body}`);
  }
  return JSON.parse(res.body);
}

async function addComponent(scheduleId: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/rate-schedules/${scheduleId}/components`,
    headers: headers(),
    payload: {
      effectiveDate: "2026-01-01",
      sortOrder: 100,
      ...payload,
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`failed to add component: ${res.statusCode} ${res.body}`);
  }
  return JSON.parse(res.body);
}

describe("POST /api/v1/rate-schedules/:id/revise component copy", () => {
  it("copies an active flat component to the new revision with a fresh id", async () => {
    const draft = await createDraftSchedule();
    const original = await addComponent(draft.id, {
      kindCode: "consumption",
      label: "Volumetric Charge",
      predicate: { class: "single_family" },
      quantitySource: { base: "metered", transforms: [] },
      pricing: { type: "flat", rate: 5.25 },
    });

    const reviseRes = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/revise`,
      headers: headers(),
      payload: { effectiveDate: "2027-01-01" },
    });
    expect(reviseRes.statusCode).toBe(201);
    const newSchedule = JSON.parse(reviseRes.body);

    const { prisma } = prismaImports;
    const copied = await prisma.rateComponent.findMany({
      where: { rateScheduleId: newSchedule.id, utilityId: TENANT_A },
    });
    expect(copied).toHaveLength(1);
    const c = copied[0];
    expect(c.id).not.toBe(original.id);
    expect(c.kindCode).toBe("consumption");
    expect(c.label).toBe("Volumetric Charge");
    expect(c.pricing).toEqual({ type: "flat", rate: 5.25 });
    expect(c.sortOrder).toBe(100);
    expect(c.effectiveDate.toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(c.expirationDate).toBeNull();
  });

  it("rewrites pricing.percent_of.selector.component_id to the new id when copying", async () => {
    const draft = await createDraftSchedule();
    const base = await addComponent(draft.id, {
      kindCode: "consumption",
      label: "Volumetric Charge",
      predicate: { class: "single_family" },
      quantitySource: { base: "metered", transforms: [] },
      pricing: { type: "flat", rate: 5.25 },
      sortOrder: 100,
    });
    const surcharge = await addComponent(draft.id, {
      kindCode: "surcharge",
      label: "Drought Surcharge",
      predicate: { class: "single_family" },
      quantitySource: { base: "metered", transforms: [] },
      pricing: {
        type: "percent_of",
        selector: { component_id: base.id },
        percent: 25,
      },
      sortOrder: 200,
    });

    const reviseRes = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/revise`,
      headers: headers(),
      payload: { effectiveDate: "2027-01-01" },
    });
    expect(reviseRes.statusCode).toBe(201);
    const newSchedule = JSON.parse(reviseRes.body);

    const { prisma } = prismaImports;
    const copied = await prisma.rateComponent.findMany({
      where: { rateScheduleId: newSchedule.id, utilityId: TENANT_A },
      orderBy: { sortOrder: "asc" },
    });
    expect(copied).toHaveLength(2);

    const newBase = copied.find((c) => c.label === "Volumetric Charge")!;
    const newSurcharge = copied.find((c) => c.label === "Drought Surcharge")!;
    expect(newBase.id).not.toBe(base.id);
    expect(newSurcharge.id).not.toBe(surcharge.id);

    const surchargePricing = newSurcharge.pricing as {
      type: string;
      selector: { component_id: string };
      percent: number;
    };
    expect(surchargePricing.type).toBe("percent_of");
    expect(surchargePricing.percent).toBe(25);
    // The reference must point at the NEW base id, not the old one.
    expect(surchargePricing.selector.component_id).toBe(newBase.id);
    expect(surchargePricing.selector.component_id).not.toBe(base.id);
  });

  it("rewrites component_id references nested inside and/or selectors", async () => {
    const draft = await createDraftSchedule();
    const a = await addComponent(draft.id, {
      kindCode: "consumption",
      label: "Tier A",
      predicate: { class: "single_family" },
      quantitySource: { base: "metered", transforms: [] },
      pricing: { type: "flat", rate: 1 },
      sortOrder: 100,
    });
    const b = await addComponent(draft.id, {
      kindCode: "consumption",
      label: "Tier B",
      predicate: { class: "single_family" },
      quantitySource: { base: "metered", transforms: [] },
      pricing: { type: "flat", rate: 2 },
      sortOrder: 200,
    });
    await addComponent(draft.id, {
      kindCode: "surcharge",
      label: "Combined Surcharge",
      predicate: { class: "single_family" },
      quantitySource: { base: "metered", transforms: [] },
      pricing: {
        type: "percent_of",
        selector: { or: [{ component_id: a.id }, { component_id: b.id }] },
        percent: 10,
      },
      sortOrder: 300,
    });

    const reviseRes = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/revise`,
      headers: headers(),
      payload: { effectiveDate: "2027-01-01" },
    });
    expect(reviseRes.statusCode).toBe(201);
    const newSchedule = JSON.parse(reviseRes.body);

    const { prisma } = prismaImports;
    const copied = await prisma.rateComponent.findMany({
      where: { rateScheduleId: newSchedule.id, utilityId: TENANT_A },
      orderBy: { sortOrder: "asc" },
    });
    const newA = copied.find((c) => c.label === "Tier A")!;
    const newB = copied.find((c) => c.label === "Tier B")!;
    const newSurcharge = copied.find((c) => c.label === "Combined Surcharge")!;
    const pricing = newSurcharge.pricing as {
      selector: { or: Array<{ component_id: string }> };
    };
    const ids = pricing.selector.or.map((s) => s.component_id).sort();
    expect(ids).toEqual([newA.id, newB.id].sort());
    // None of the old ids should leak through.
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("does not carry forward components that already have an expirationDate on the predecessor", async () => {
    const draft = await createDraftSchedule();
    const active = await addComponent(draft.id, {
      kindCode: "consumption",
      label: "Active Charge",
      predicate: { class: "single_family" },
      quantitySource: { base: "metered", transforms: [] },
      pricing: { type: "flat", rate: 5 },
      sortOrder: 100,
    });
    const retired = await addComponent(draft.id, {
      kindCode: "surcharge",
      label: "Retired Surcharge",
      predicate: { class: "single_family" },
      quantitySource: { base: "metered", transforms: [] },
      pricing: { type: "flat", rate: 1 },
      sortOrder: 200,
      expirationDate: "2025-12-31",
    });

    const reviseRes = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/revise`,
      headers: headers(),
      payload: { effectiveDate: "2027-01-01" },
    });
    expect(reviseRes.statusCode).toBe(201);
    const newSchedule = JSON.parse(reviseRes.body);

    const { prisma } = prismaImports;
    const copied = await prisma.rateComponent.findMany({
      where: { rateScheduleId: newSchedule.id, utilityId: TENANT_A },
    });
    expect(copied).toHaveLength(1);
    expect(copied[0].label).toBe("Active Charge");
    expect(copied[0].id).not.toBe(active.id);
    // The retired one should NOT appear on the new schedule.
    expect(copied.some((c) => c.label === "Retired Surcharge")).toBe(false);
    // sanity: the retired component still exists on the predecessor.
    const onPredecessor = await prisma.rateComponent.findUnique({
      where: { id: retired.id },
    });
    expect(onPredecessor).not.toBeNull();
  });
});
