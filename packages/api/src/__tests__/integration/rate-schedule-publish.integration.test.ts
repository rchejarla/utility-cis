import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A, ensurePrincipal} from "./_effective-dating-fixtures.js";

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
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  await ensurePrincipal(prismaImports.prisma, TENANT_A);
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
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.$executeRawUnsafe("DELETE FROM rate_component");
  // Clear self-referencing FK before deleting rows.
  await prisma.$executeRawUnsafe("UPDATE rate_schedule SET superseded_by_id = NULL, supersedes_id = NULL");
  await prisma.$executeRawUnsafe("DELETE FROM rate_schedule");

  const existing = await prisma.utilityModule.findFirst({
    where: { utilityId: TENANT_A, moduleKey: "rate_schedules" },
  });
  if (!existing) {
    await prisma.utilityModule.create({
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

/**
 * What the list sends, because the list now renders it.
 *
 * The web page showed no lifecycle at all and a "Components (coming
 * soon)" placeholder, and both answers were already available: the list
 * service passes no `select`, so `publishedAt` and `supersededById` come
 * back as ordinary columns, and the count needed one `_count`. A page
 * that reads a field the API does not send fails silently — an undefined
 * field is falsy, so it renders the wrong word with total confidence —
 * which is what these two cases exist to prevent.
 */
describe("GET /api/v1/rate-schedules", () => {
  it("carries the lifecycle fields and the charge count for each row", async () => {
    const draft = await createDraftSchedule("LIST-1", "List One");
    const added = await app.inject({
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
    expect(added.statusCode).toBe(201);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/rate-schedules",
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    const row = JSON.parse(res.body).data.find((r: { id: string }) => r.id === draft.id);
    expect(row.publishedAt).toBeNull();
    expect(row.supersededById).toBeNull();
    expect(row._count.components).toBe(1);
  });

  it("reports zero charges on a schedule that has none", async () => {
    // The state the setup check-list refuses to call ready, and the one
    // that cannot be repaired in place: components are refused once a
    // schedule is published, so an empty published schedule has to be
    // revised rather than filled.
    const draft = await createDraftSchedule("LIST-2", "List Two");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/rate-schedules",
      headers: headers(),
    });

    const row = JSON.parse(res.body).data.find((r: { id: string }) => r.id === draft.id);
    expect(row._count.components).toBe(0);
  });
});

/**
 * Filtering by lifecycle, which is what the list offers now.
 *
 * The old `active` filter asked the database about expiration dates
 * while the screen said Active/Inactive, and its "false" could not
 * arrive as false at all. These cases pin the three states against real
 * rows — including the one that made the boolean wrong in principle: a
 * superseded version is still published, so "published" must not return
 * it.
 */
describe("GET /api/v1/rate-schedules?status=", () => {
  async function rows(status: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/rate-schedules?status=${status}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).data as { id: string; code: string }[];
  }

  /** A draft, a published one, and a superseded v1 with its v2. */
  async function threeStates() {
    const draft = await createDraftSchedule("ST-DRAFT", "Still Drafting");

    const live = await createDraftSchedule("ST-LIVE", "Live Tariff");
    await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${live.id}/publish`,
      headers: headers(),
    });

    const old = await createDraftSchedule("ST-OLD", "Superseded Tariff");
    await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${old.id}/publish`,
      headers: headers(),
    });
    const revised = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${old.id}/revise`,
      headers: headers(),
      payload: { effectiveDate: "2027-01-01" },
    });
    expect(revised.statusCode).toBe(201);

    return { draft, live, old, v2: JSON.parse(revised.body) };
  }

  it("returns only the drafts", async () => {
    const { draft, v2 } = await threeStates();

    const ids = (await rows("draft")).map((r) => r.id);

    // The revision is a draft too: revise creates v2 unpublished.
    expect(ids).toContain(draft.id);
    expect(ids).toContain(v2.id);
    expect(ids).toHaveLength(2);
  });

  it("returns the live published ones and not a superseded version", async () => {
    const { live, old } = await threeStates();

    const ids = (await rows("published")).map((r) => r.id);

    expect(ids).toEqual([live.id]);
    expect(ids).not.toContain(old.id);
  });

  it("returns the superseded version when asked for it", async () => {
    const { old } = await threeStates();

    expect((await rows("superseded")).map((r) => r.id)).toEqual([old.id]);
  });

  it("refuses a state it cannot honour", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/rate-schedules?status=retired",
      headers: headers(),
    });

    expect(res.statusCode).toBe(400);
  });

  it("refuses the old active parameter rather than ignoring it", async () => {
    // `.strict()`: a bookmarked `?active=false` fails loudly instead of
    // quietly returning everything, which is what it did before.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/rate-schedules?active=false",
      headers: headers(),
    });

    expect(res.statusCode).toBe(400);
  });
});
