import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 task 11 — end-to-end shape tests.
 *
 * Three tests that exercise the v2 rate-model API surface end-to-end
 * (RateSchedule -> RateComponent + SARateScheduleAssignment + SA detail
 * embed). They drive everything through the Fastify app the same way
 * a real client would, asserting shape contracts hold across endpoints
 * without invoking any rate-engine logic (that lands in slice 3).
 *
 * SA dependencies (Customer/Account/Premise/BillingCycle) are inserted
 * via prisma directly because going through the full create flows would
 * dwarf the per-assertion work — this matches the convention in
 * sa-rate-schedule-assignments.integration.test.ts.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;

let waterCommodityId: string;
let electricCommodityId: string;
let billingCycleId: string;

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

  const electric = await prisma.commodity.upsert({
    where: { utilityId_code: { utilityId: TENANT_A, code: "electric" } },
    create: { utilityId: TENANT_A, code: "electric", name: "Electric" },
    update: {},
  });
  electricCommodityId = electric.id;

  const bc = await prisma.billingCycle.upsert({
    where: { utilityId_cycleCode: { utilityId: TENANT_A, cycleCode: "BC-SHAPE" } },
    create: {
      utilityId: TENANT_A,
      name: "Shape Cycle",
      cycleCode: "BC-SHAPE",
      readDayOfMonth: 5,
      billDayOfMonth: 10,
      frequency: "MONTHLY",
    },
    update: {},
  });
  billingCycleId = bc.id;
}, 300_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  // Wipe in FK-safe order: assignments + components first (FK to schedule/SA),
  // then SAs and schedules. Account/premise persist for the run.
  await prisma.$executeRawUnsafe("DELETE FROM sa_rate_schedule_assignment");
  await prisma.$executeRawUnsafe("DELETE FROM rate_component");
  await prisma.$executeRawUnsafe("DELETE FROM service_agreement");
  await prisma.$executeRawUnsafe("DELETE FROM rate_schedule");

  // Enable the modules the test exercises (rate-schedules + SA detail).
  for (const moduleKey of ["rate_schedules", "agreements"]) {
    const existing = await prisma.tenantModule.findFirst({
      where: { utilityId: TENANT_A, moduleKey },
    });
    if (!existing) {
      await prisma.tenantModule.create({
        data: { utilityId: TENANT_A, moduleKey },
      });
    }
  }
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateTenantModulesCache(TENANT_A);
});

describe("rate-model v2 end-to-end shape", () => {
  it("creates a Bozeman-style water schedule with components via the API", async () => {
    const sched = await app.inject({
      method: "POST",
      url: "/api/v1/rate-schedules",
      headers: headers(),
      payload: {
        name: "Test Bozeman Water",
        code: "TEST-BZN-WATER-1",
        commodityId: waterCommodityId,
        effectiveDate: "2025-09-15",
      },
    });
    expect(sched.statusCode).toBe(201);
    const schedBody = JSON.parse(sched.body);

    const components = [
      {
        kindCode: "service_charge",
        label: "Service Charge",
        sortOrder: 10,
        predicate: {},
        quantitySource: { base: "fixed" },
        pricing: {
          type: "lookup",
          by: "meter_size",
          table: { '5/8"': 22.31 },
        },
        effectiveDate: "2025-09-15",
      },
      {
        kindCode: "consumption",
        label: "SFR Volumetric",
        sortOrder: 20,
        predicate: { class: "single_family" },
        quantitySource: { base: "metered" },
        pricing: { type: "tiered", tiers: [{ to: null, rate: 3.31 }] },
        effectiveDate: "2025-09-15",
      },
    ];

    for (const c of components) {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/rate-schedules/${schedBody.id}/components`,
        headers: headers(),
        payload: c,
      });
      expect(r.statusCode).toBe(201);
    }

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/rate-schedules/${schedBody.id}/components`,
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    const listBody = JSON.parse(list.body);
    expect(listBody).toHaveLength(2);
    expect(listBody.map((c: { kindCode: string }) => c.kindCode).sort()).toEqual([
      "consumption",
      "service_charge",
    ]);
  });

  it("attaches a schedule to an SA and reads it back via SA detail", async () => {
    const { prisma } = prismaImports;

    const account = await prisma.account.create({
      data: {
        utilityId: TENANT_A,
        accountNumber: `ACCT-SHAPE-1-${Date.now()}`,
        accountType: "RESIDENTIAL",
        status: "ACTIVE",
        depositAmount: 0,
      },
    });

    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: TENANT_A,
        agreementNumber: `SA-SHAPE-1-${Date.now()}`,
        accountId: account.id,
        commodityId: waterCommodityId,
        billingCycleId,
        startDate: new Date("2026-01-01"),
        status: "ACTIVE",
      },
    });

    const schedRes = await app.inject({
      method: "POST",
      url: "/api/v1/rate-schedules",
      headers: headers(),
      payload: {
        name: "Attach Test",
        code: "TEST-ATTACH-1",
        commodityId: waterCommodityId,
        effectiveDate: "2025-09-15",
      },
    });
    expect(schedRes.statusCode).toBe(201);
    const sched = JSON.parse(schedRes.body);

    const assignRes = await app.inject({
      method: "POST",
      url: "/api/v1/sa-rate-schedule-assignments",
      headers: headers(),
      payload: {
        serviceAgreementId: sa.id,
        rateScheduleId: sched.id,
        roleCode: "primary",
        effectiveDate: "2025-09-15",
      },
    });
    expect(assignRes.statusCode).toBe(201);

    const saRes = await app.inject({
      method: "GET",
      url: `/api/v1/service-agreements/${sa.id}`,
      headers: headers(),
    });
    expect(saRes.statusCode).toBe(200);
    const saBody = JSON.parse(saRes.body);
    expect(saBody.rateScheduleAssignments).toBeDefined();
    expect(saBody.rateScheduleAssignments).toHaveLength(1);
    expect(saBody.rateScheduleAssignments[0].rateSchedule.id).toBe(sched.id);
    expect(saBody.rateScheduleAssignments[0].roleCode).toBe("primary");
  });

  it("attaches three NWE-style schedules (delivery/supply/rider) to one electric SA", async () => {
    const { prisma } = prismaImports;

    const account = await prisma.account.create({
      data: {
        utilityId: TENANT_A,
        accountNumber: `ACCT-SHAPE-ELEC-${Date.now()}`,
        accountType: "RESIDENTIAL",
        status: "ACTIVE",
        depositAmount: 0,
      },
    });

    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: TENANT_A,
        agreementNumber: `SA-SHAPE-ELEC-${Date.now()}`,
        accountId: account.id,
        commodityId: electricCommodityId,
        billingCycleId,
        startDate: new Date("2026-01-01"),
        status: "ACTIVE",
      },
    });

    const stamp = Date.now();
    for (const [name, role] of [
      ["Delivery", "delivery"],
      ["Supply", "supply"],
      ["USBC", "rider"],
    ] as const) {
      const schedRes = await app.inject({
        method: "POST",
        url: "/api/v1/rate-schedules",
        headers: headers(),
        payload: {
          name: `NWE ${name}`,
          code: `NWE-${name.toUpperCase()}-${stamp}`,
          commodityId: electricCommodityId,
          effectiveDate: "2025-09-15",
        },
      });
      expect(schedRes.statusCode).toBe(201);
      const sched = JSON.parse(schedRes.body);

      const assignRes = await app.inject({
        method: "POST",
        url: "/api/v1/sa-rate-schedule-assignments",
        headers: headers(),
        payload: {
          serviceAgreementId: sa.id,
          rateScheduleId: sched.id,
          roleCode: role,
          effectiveDate: "2025-09-15",
        },
      });
      expect(assignRes.statusCode).toBe(201);
    }

    const saRes = await app.inject({
      method: "GET",
      url: `/api/v1/service-agreements/${sa.id}`,
      headers: headers(),
    });
    expect(saRes.statusCode).toBe(200);
    const saBody = JSON.parse(saRes.body);
    expect(saBody.rateScheduleAssignments).toHaveLength(3);
    expect(
      saBody.rateScheduleAssignments
        .map((a: { roleCode: string }) => a.roleCode)
        .sort(),
    ).toEqual(["delivery", "rider", "supply"]);
  });
});
