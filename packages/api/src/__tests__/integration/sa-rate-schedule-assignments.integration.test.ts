import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 task 6 — SAScheduleAssignment CRUD endpoints.
 *
 * The join lets one SA hold N rate schedules at once, each tagged
 * with a role and its own effective dating window. The test creates
 * the SA + schedule fixtures via direct prisma writes (the SA flow
 * involves enough collaborators that going through the API would
 * dwarf the assignment-specific assertions) and exercises the four
 * CRUD endpoints directly with `app.inject`.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;

let waterCommodityId: string;
let billingCycleId: string;
let accountId: string;
let scheduleId: string;
let scheduleId2: string;
let serviceAgreementId: string;
let serviceAgreementId2: string;

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

  const billingCycle = await prisma.billingCycle.upsert({
    where: { utilityId_cycleCode: { utilityId: TENANT_A, cycleCode: "BC-A" } },
    create: {
      utilityId: TENANT_A,
      name: "Cycle A",
      cycleCode: "BC-A",
      readDayOfMonth: 5,
      billDayOfMonth: 10,
      frequency: "MONTHLY",
    },
    update: {},
  });
  billingCycleId = billingCycle.id;

  const account = await prisma.account.create({
    data: {
      utilityId: TENANT_A,
      accountNumber: `ACCT-SA-RSA-${Date.now()}`,
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      depositAmount: 0,
    },
  });
  accountId = account.id;
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  // Wipe assignments first (FK to schedule + SA), then dependents.
  await prisma.$executeRawUnsafe("DELETE FROM sa_rate_schedule_assignment");
  await prisma.$executeRawUnsafe("DELETE FROM service_agreement");
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

  const sched1 = await prisma.rateSchedule.create({
    data: {
      utilityId: TENANT_A,
      name: "Residential Delivery",
      code: "RES-DELIV",
      commodityId: waterCommodityId,
      effectiveDate: new Date("2026-01-01"),
      version: 1,
    },
  });
  scheduleId = sched1.id;

  const sched2 = await prisma.rateSchedule.create({
    data: {
      utilityId: TENANT_A,
      name: "Residential Supply",
      code: "RES-SUPPLY",
      commodityId: waterCommodityId,
      effectiveDate: new Date("2026-01-01"),
      version: 1,
    },
  });
  scheduleId2 = sched2.id;

  const sa1 = await prisma.serviceAgreement.create({
    data: {
      utilityId: TENANT_A,
      agreementNumber: "SA-001",
      accountId,
      commodityId: waterCommodityId,
      billingCycleId,
      startDate: new Date("2026-01-01"),
      status: "ACTIVE",
    },
  });
  serviceAgreementId = sa1.id;

  const sa2 = await prisma.serviceAgreement.create({
    data: {
      utilityId: TENANT_A,
      agreementNumber: "SA-002",
      accountId,
      commodityId: waterCommodityId,
      billingCycleId,
      startDate: new Date("2026-01-01"),
      status: "ACTIVE",
    },
  });
  serviceAgreementId2 = sa2.id;
});

describe("/api/v1/sa-rate-schedule-assignments", () => {
  it("POST creates an assignment (status 201)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sa-rate-schedule-assignments",
      headers: headers(),
      payload: {
        serviceAgreementId,
        rateScheduleId: scheduleId,
        roleCode: "delivery",
        effectiveDate: "2026-01-01",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.serviceAgreementId).toBe(serviceAgreementId);
    expect(body.rateScheduleId).toBe(scheduleId);
    expect(body.roleCode).toBe("delivery");
    expect(body.utilityId).toBe(TENANT_A);
    expect(body.rateSchedule).toEqual(
      expect.objectContaining({ id: scheduleId, code: "RES-DELIV", version: 1 }),
    );
  });

  it("POST rejects unknown roleCode (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sa-rate-schedule-assignments",
      headers: headers(),
      payload: {
        serviceAgreementId,
        rateScheduleId: scheduleId,
        roleCode: "weather_god",
        effectiveDate: "2026-01-01",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET list filtered by serviceAgreementId returns only matching rows", async () => {
    // Two assignments under SA-001 (delivery + supply), one under SA-002.
    for (const [saId, schedId, role] of [
      [serviceAgreementId, scheduleId, "delivery"],
      [serviceAgreementId, scheduleId2, "supply"],
      [serviceAgreementId2, scheduleId, "primary"],
    ] as const) {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/sa-rate-schedule-assignments",
        headers: headers(),
        payload: {
          serviceAgreementId: saId,
          rateScheduleId: schedId,
          roleCode: role,
          effectiveDate: "2026-01-01",
        },
      });
      expect(create.statusCode).toBe(201);
    }

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/sa-rate-schedule-assignments?serviceAgreementId=${serviceAgreementId}`,
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    const body = JSON.parse(list.body);
    expect(body).toHaveLength(2);
    for (const row of body) {
      expect(row.serviceAgreementId).toBe(serviceAgreementId);
    }
    expect(body.map((r: { roleCode: string }) => r.roleCode).sort()).toEqual(
      ["delivery", "supply"],
    );
  });

  it("PATCH expirationDate end-dates an assignment", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/sa-rate-schedule-assignments",
      headers: headers(),
      payload: {
        serviceAgreementId,
        rateScheduleId: scheduleId,
        roleCode: "delivery",
        effectiveDate: "2026-01-01",
      },
    });
    expect(create.statusCode).toBe(201);
    const created = JSON.parse(create.body);
    expect(created.expirationDate).toBeNull();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/sa-rate-schedule-assignments/${created.id}`,
      headers: headers(),
      payload: { expirationDate: "2026-12-31" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.expirationDate).toMatch(/^2026-12-31/);
    // Untouched fields stay put.
    expect(body.roleCode).toBe("delivery");
    expect(body.serviceAgreementId).toBe(serviceAgreementId);
  });

  it("DELETE removes a never-active assignment (status 204, follow-up GET returns 404)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/sa-rate-schedule-assignments",
      headers: headers(),
      payload: {
        serviceAgreementId,
        rateScheduleId: scheduleId,
        roleCode: "delivery",
        effectiveDate: "2027-01-01", // future-dated, never active yet
      },
    });
    const created = JSON.parse(create.body);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/sa-rate-schedule-assignments/${created.id}`,
      headers: headers(),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/sa-rate-schedule-assignments/${created.id}`,
      headers: headers(),
    });
    expect(get.statusCode).toBe(404);
  });
});
