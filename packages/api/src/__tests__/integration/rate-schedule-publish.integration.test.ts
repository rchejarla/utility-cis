import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * Slice 2 follow-up — POST /api/v1/rate-schedules/:id/publish.
 *
 * A RateSchedule is editable iff publishedAt IS NULL AND
 * supersededById IS NULL. The publish endpoint flips publishedAt
 * once and freezes the components. Component create/update/delete
 * surfaces 409 SCHEDULE_NOT_EDITABLE on a published or superseded
 * schedule. These tests cover:
 *
 *   1. Publish on a draft schedule sets publishedAt and returns
 *      the updated row.
 *   2. Publish on an already-published schedule returns 409.
 *   3. Publish on a superseded schedule returns 409.
 *   4. Component create on a published schedule returns 409 with
 *      code SCHEDULE_NOT_EDITABLE.
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
  // Clear self-referencing FK before deleting rows.
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

describe("POST /api/v1/rate-schedules/:id/publish", () => {
  it("sets publishedAt and returns the updated schedule on a draft", async () => {
    const draft = await createDraftSchedule();
    expect(draft.publishedAt).toBeNull();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/publish`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(draft.id);
    expect(body.publishedAt).not.toBeNull();
    expect(typeof body.publishedAt).toBe("string");
    // sanity-check it parses as a date
    expect(Number.isNaN(new Date(body.publishedAt).getTime())).toBe(false);
  });

  it("returns 409 ALREADY_PUBLISHED when publishing a schedule that has already been published", async () => {
    const draft = await createDraftSchedule();
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/publish`,
      headers: headers(),
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/publish`,
      headers: headers(),
    });
    expect(second.statusCode).toBe(409);
    const body = JSON.parse(second.body);
    expect(body.error?.code).toBe("ALREADY_PUBLISHED");
  });

  it("returns 409 SUPERSEDED when publishing a schedule that has been superseded", async () => {
    const draft = await createDraftSchedule();
    // Publish first so we can revise — revise is only allowed against a
    // published schedule in the typical flow, but the service allows it
    // regardless. We need supersededById set, which revise does.
    const pubRes = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/publish`,
      headers: headers(),
    });
    expect(pubRes.statusCode).toBe(200);

    const reviseRes = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/revise`,
      headers: headers(),
      payload: { effectiveDate: "2027-01-01" },
    });
    expect(reviseRes.statusCode).toBe(201);

    // The original schedule is now superseded. Publishing it again
    // (after we manually re-null its publishedAt to remove the
    // ALREADY_PUBLISHED short-circuit) must hit the SUPERSEDED branch.
    const { prisma } = prismaImports;
    await prisma.rateSchedule.update({
      where: { id: draft.id },
      data: { publishedAt: null },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/publish`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error?.code).toBe("SUPERSEDED");
  });

  it("returns 409 SCHEDULE_NOT_EDITABLE when creating a component on a published schedule", async () => {
    const draft = await createDraftSchedule();
    const pubRes = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/publish`,
      headers: headers(),
    });
    expect(pubRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${draft.id}/components`,
      headers: headers(),
      payload: {
        kindCode: "consumption",
        label: "Volumetric Charge",
        predicate: { class: "single_family" },
        quantitySource: { base: "metered", transforms: [] },
        pricing: { type: "flat", rate: 5.25 },
        sortOrder: 100,
        effectiveDate: "2026-01-01",
      },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error?.code).toBe("SCHEDULE_NOT_EDITABLE");
  });
});
