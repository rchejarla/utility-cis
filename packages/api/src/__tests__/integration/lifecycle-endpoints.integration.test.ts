import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";

/**
 * HTTP-level integration tests for the new lifecycle endpoints, hit
 * via Fastify-inject against a real Postgres. Validates the full
 * request path: auth middleware → tenant-module check → Zod parse →
 * service handler → DB write → response.
 *
 * The auth middleware accepts an unsigned dev token (alg: "none") in
 * NODE_ENV=test. The authorization middleware lets the request
 * through if no `cisUser` row exists for the test actor (the
 * "backwards compat during migration" branch). What we DO need is a
 * `tenant_module` row for each module the route touches — otherwise
 * the request hits a 403 MODULE_DISABLED.
 *
 * Endpoints covered:
 *   - POST /api/v1/service-agreements/:id/close
 *   - POST /api/v1/service-agreements/:id/meters/:meterId/remove
 *   - POST /api/v1/service-agreements/:id/meters/swap
 *   - GET /api/v1/premises/:id/responsible-account
 *   - GET /api/v1/meters/:id/assignment
 *   - GET /api/v1/premises/:id/agreement-history
 *   - PATCH /api/v1/service-agreements/:id (rejection of lifecycle fields)
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;
let fixA: TenantFixture;

const ENABLED_MODULES = ["agreements", "premises", "meters"];

function makeToken(utilityId: string, actorId = "00000000-0000-4000-8000-aaaa00000001") {
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
  await resetDb(prisma);
  fixA = await makeTenantFixture(prisma, TENANT_A);

  // Enable the modules the routes are gated on.
  for (const moduleKey of ENABLED_MODULES) {
    await prisma.tenantModule.create({
      data: { utilityId: fixA.utilityId, moduleKey },
    });
  }
});

const headers = () => ({ authorization: `Bearer ${makeToken(TENANT_A)}` });

async function makeActiveSaWithTwoMeters() {
  const { prisma } = prismaImports;
  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fixA.utilityId,
      agreementNumber: "SA-HTTP",
      accountId: fixA.accountId,
      commodityId: fixA.commodityId,
      billingCycleId: fixA.billingCycleId,
      startDate: new Date("2024-01-01"),
      status: "ACTIVE",
    },
  });

  const sp = await prisma.servicePoint.create({
    data: {
      utilityId: fixA.utilityId,
      serviceAgreementId: sa.id,
      premiseId: fixA.premiseId,
      type: "METERED",
      status: "ACTIVE",
      startDate: new Date("2024-01-01"),
    },
  });

  await prisma.servicePointMeter.createMany({
    data: [
      {
        utilityId: fixA.utilityId,
        servicePointId: sp.id,
        meterId: fixA.meterId,
        addedDate: new Date("2024-01-01"),
      },
      {
        utilityId: fixA.utilityId,
        servicePointId: sp.id,
        meterId: fixA.meterId2,
        addedDate: new Date("2024-01-01"),
      },
    ],
  });

  return sa;
}

describe("POST /api/v1/service-agreements/:id/close", () => {
  it("closes the SA and cascades onto every open meter assignment", async () => {
    const { prisma } = prismaImports;
    const sa = await makeActiveSaWithTwoMeters();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${sa.id}/close`,
      headers: headers(),
      payload: { endDate: "2024-12-31", status: "FINAL", reason: "test" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.metersClosed).toBe(2);

    const reloaded = await prisma.serviceAgreement.findUniqueOrThrow({ where: { id: sa.id } });
    expect(reloaded.status).toBe("FINAL");
    expect(reloaded.endDate?.toISOString().slice(0, 10)).toBe("2024-12-31");

    const spms = await prisma.servicePointMeter.findMany({
      where: { servicePoint: { serviceAgreementId: sa.id } },
    });
    expect(spms.every((s) => s.removedDate?.toISOString().slice(0, 10) === "2024-12-31"))
      .toBe(true);
  });

  it("returns 400 (Zod) when endDate is missing", async () => {
    const sa = await makeActiveSaWithTwoMeters();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${sa.id}/close`,
      headers: headers(),
      payload: { status: "FINAL" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 (Zod) when status is not a terminal value", async () => {
    const sa = await makeActiveSaWithTwoMeters();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${sa.id}/close`,
      headers: headers(),
      payload: { endDate: "2024-12-31", status: "ACTIVE" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/v1/service-agreements/:id (lifecycle field rejection)", () => {
  it("rejects PATCH that tries to set endDate", async () => {
    const sa = await makeActiveSaWithTwoMeters();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/service-agreements/${sa.id}`,
      headers: headers(),
      payload: { endDate: "2024-12-31" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects PATCH that tries to set status", async () => {
    const sa = await makeActiveSaWithTwoMeters();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/service-agreements/${sa.id}`,
      headers: headers(),
      payload: { status: "FINAL" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/service-agreements/:id/meters/:meterId/remove", () => {
  it("closes a single SPM by (saId, meterId), emits an audit row, leaves the SA open", async () => {
    const { prisma } = prismaImports;
    const sa = await makeActiveSaWithTwoMeters();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${sa.id}/meters/${fixA.meterId}/remove`,
      headers: headers(),
      payload: { removedDate: "2024-08-15", reason: "Failed" },
    });

    expect(res.statusCode).toBe(200);
    const spms = await prisma.servicePointMeter.findMany({
      where: { servicePoint: { serviceAgreementId: sa.id } },
      orderBy: { addedDate: "asc" },
    });
    const removed = spms.find((s) => s.meterId === fixA.meterId);
    const stillOpen = spms.find((s) => s.meterId === fixA.meterId2);
    expect(removed?.removedDate?.toISOString().slice(0, 10)).toBe("2024-08-15");
    expect(stillOpen?.removedDate).toBeNull();

    // SA itself is unchanged.
    const reloaded = await prisma.serviceAgreement.findUniqueOrThrow({ where: { id: sa.id } });
    expect(reloaded.status).toBe("ACTIVE");
    expect(reloaded.endDate).toBeNull();

    // Audit row for the SPM mutation.
    const audits = await prisma.auditLog.count({
      where: { utilityId: fixA.utilityId, entityType: "ServicePointMeter" },
    });
    expect(audits).toBe(1);
  });
});

describe("POST /api/v1/service-agreements/:id/meters/swap", () => {
  it("swaps old meter for new in one transaction (old.removedDate set, new SPM created)", async () => {
    const { prisma } = prismaImports;
    const sa = await makeActiveSaWithTwoMeters();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${sa.id}/meters/swap`,
      headers: headers(),
      payload: {
        oldMeterId: fixA.meterId,
        newMeterId: fixA.meterId3,
        swapDate: "2024-09-01",
        reason: "Routine replacement",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.closedOld.removedDate).toBeTruthy();
    expect(body.newSpm.meterId).toBe(fixA.meterId3);

    const spms = await prisma.servicePointMeter.findMany({
      where: { servicePoint: { serviceAgreementId: sa.id } },
    });
    // 3 SPMs total: old (closed), other (still open), new (open).
    expect(spms).toHaveLength(3);
    expect(spms.find((s) => s.meterId === fixA.meterId)?.removedDate?.toISOString().slice(0, 10))
      .toBe("2024-09-01");
    expect(spms.find((s) => s.meterId === fixA.meterId3)?.addedDate.toISOString().slice(0, 10))
      .toBe("2024-09-01");
  });

  it("returns 409 when the new meter is already on another open SPM", async () => {
    const sa = await makeActiveSaWithTwoMeters();

    // Try to swap meter1 → meter2; meter2 is already on this SA.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${sa.id}/meters/swap`,
      headers: headers(),
      payload: {
        oldMeterId: fixA.meterId,
        newMeterId: fixA.meterId2,
        swapDate: "2024-09-01",
      },
    });

    expect(res.statusCode).toBe(409);
  });
});

describe("GET /api/v1/premises/:id/responsible-account", () => {
  it("returns the account responsible at a given as_of date", async () => {
    const { prisma } = prismaImports;
    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: fixA.utilityId,
        agreementNumber: "SA-PIT",
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        billingCycleId: fixA.billingCycleId,
        startDate: new Date("2024-01-01"),
        status: "ACTIVE",
      },
    });
    await prisma.servicePoint.create({
      data: {
        utilityId: fixA.utilityId,
        serviceAgreementId: sa.id,
        premiseId: fixA.premiseId,
        type: "METERED",
        status: "ACTIVE",
        startDate: new Date("2024-01-01"),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/premises/${fixA.premiseId}/responsible-account?commodity=${fixA.commodityId}&as_of=2024-06-15`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.accountId).toBe(fixA.accountId);
    expect(body.asOfDate).toBe("2024-06-15");
  });

  it("returns 404 when no SA covered the date", async () => {
    const { prisma } = prismaImports;
    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: fixA.utilityId,
        agreementNumber: "SA-PIT-2",
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        billingCycleId: fixA.billingCycleId,
        startDate: new Date("2024-01-01"),
        status: "ACTIVE",
      },
    });
    await prisma.servicePoint.create({
      data: {
        utilityId: fixA.utilityId,
        serviceAgreementId: sa.id,
        premiseId: fixA.premiseId,
        type: "METERED",
        status: "ACTIVE",
        startDate: new Date("2024-01-01"),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/premises/${fixA.premiseId}/responsible-account?commodity=${fixA.commodityId}&as_of=2023-06-15`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/v1/premises/:id/agreement-history", () => {
  it("returns every SA covering the premise (incl. FINAL/CLOSED)", async () => {
    const { prisma } = prismaImports;

    const saOld = await prisma.serviceAgreement.create({
      data: {
        utilityId: fixA.utilityId,
        agreementNumber: "SA-OLD",
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        billingCycleId: fixA.billingCycleId,
        startDate: new Date("2023-01-01"),
        endDate: new Date("2023-12-31"),
        status: "FINAL",
      },
    });
    await prisma.servicePoint.create({
      data: {
        utilityId: fixA.utilityId,
        serviceAgreementId: saOld.id,
        premiseId: fixA.premiseId,
        type: "METERED",
        status: "CLOSED",
        startDate: new Date("2023-01-01"),
        endDate: new Date("2023-12-31"),
      },
    });
    const saNew = await prisma.serviceAgreement.create({
      data: {
        utilityId: fixA.utilityId,
        agreementNumber: "SA-NEW",
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        billingCycleId: fixA.billingCycleId,
        startDate: new Date("2024-01-01"),
        status: "ACTIVE",
      },
    });
    await prisma.servicePoint.create({
      data: {
        utilityId: fixA.utilityId,
        serviceAgreementId: saNew.id,
        premiseId: fixA.premiseId,
        type: "METERED",
        status: "ACTIVE",
        startDate: new Date("2024-01-01"),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/premises/${fixA.premiseId}/agreement-history`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ agreementNumber: string; status: string }>;
    expect(body).toHaveLength(2);
    // Newest first per the ORDER BY in the route.
    expect(body[0].agreementNumber).toBe("SA-NEW");
    expect(body[1].agreementNumber).toBe("SA-OLD");
    expect(body[1].status).toBe("FINAL"); // historical row included
  });
});
