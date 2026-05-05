import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 5a task 7 — POST /api/v1/service-agreements/:id/bills produces a
 * persisted Bill with line items matching the Slice 4 golden test:
 * Bozeman SFR water customer, May 2026, 12 HCF read → $69.65 subtotal.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;

let utilityId: string;
let saId: string;

const ACTOR_ID = "00000000-0000-4000-8000-aaaa00000001";

function makeToken(uid: string) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: ACTOR_ID,
      utility_id: uid,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}
const headers = () => ({ authorization: `Bearer ${makeToken(utilityId)}` });

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;

  const TSX_BIN =
    process.platform === "win32"
      ? path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx.cmd")
      : path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx");
  execSync(`"${TSX_BIN}" prisma/seed.ts`, {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: booted.dbUrl },
    stdio: "pipe",
  });

  prismaImports = await import("../../lib/prisma.js");
  appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();

  // Pick the Bozeman SFR water SA seeded by the v2 seed.
  const { prisma } = prismaImports;
  const sched = await prisma.rateSchedule.findFirstOrThrow({
    where: { code: "BZN-WATER" },
  });
  const assignment = await prisma.sAScheduleAssignment.findFirstOrThrow({
    where: {
      rateScheduleId: sched.id,
      roleCode: "primary",
      serviceAgreement: { rateServiceClass: { code: "single_family" } },
    },
    include: {
      serviceAgreement: {
        include: {
          servicePoints: {
            where: { endDate: null },
            include: { meters: { include: { meter: true } } },
            take: 1,
          },
        },
      },
    },
  });
  saId = assignment.serviceAgreementId;
  utilityId = assignment.serviceAgreement.utilityId;

  // Enable the service_agreements module so the bill routes' permission
  // check (module: service_agreements, permission: EDIT/VIEW) passes.
  const existingMod = await prisma.tenantModule.findFirst({
    where: { utilityId, moduleKey: "service_agreements" },
  });
  if (!existingMod) {
    await prisma.tenantModule.create({
      data: { utilityId, moduleKey: "service_agreements" },
    });
  }
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateTenantModulesCache(utilityId);

  // Seed meter size + a single 12 HCF read for May 2026.
  const meterId = assignment.serviceAgreement.servicePoints[0]!.meters[0]!.meterId;
  await prisma.meter.update({
    where: { id: meterId },
    data: { customFields: { size: '5/8"' } as object },
  });
  const meter = await prisma.meter.findUniqueOrThrow({
    where: { id: meterId },
    select: { uomId: true },
  });
  await prisma.meterRead.create({
    data: {
      utilityId,
      meterId,
      serviceAgreementId: saId,
      uomId: meter.uomId,
      readDate: new Date(2026, 4, 31),
      readDatetime: new Date(2026, 4, 31, 12, 0, 0),
      reading: 100,
      priorReading: 88,
      consumption: 12,
      readType: "ACTUAL",
      readSource: "MANUAL",
    },
  });
}, 600_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  // Wipe any bills from a prior test in the same suite — keep meters / SAs.
  await prisma.$executeRawUnsafe("DELETE FROM bill_line");
  await prisma.$executeRawUnsafe("DELETE FROM bill");
  await prisma.$executeRawUnsafe(
    "UPDATE meter_read SET billed_at = NULL WHERE service_agreement_id = $1::uuid",
    saId,
  );
});

describe("POST /api/v1/service-agreements/:id/bills — Bozeman SFR golden", () => {
  it("creates a Bill with $69.65 subtotal and persists lines", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
      payload: { periodStart: "2026-05-01", periodEnd: "2026-05-31" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(parseFloat(body.subtotal).toFixed(2)).toBe("69.65");
    expect(body.lines.length).toBeGreaterThanOrEqual(2);

    const serviceLine = body.lines.find((l: any) => l.kindCode === "service_charge");
    expect(parseFloat(serviceLine.amount).toFixed(2)).toBe("22.31");

    const consumption = body.lines.find(
      (l: any) => l.kindCode === "consumption" && l.label.includes("Single Family"),
    );
    expect(parseFloat(consumption.amount).toFixed(2)).toBe("47.34");

    // DB row exists
    const { prisma } = prismaImports;
    const dbBill = await prisma.bill.findUniqueOrThrow({
      where: { id: body.id, utilityId },
      include: { lines: true },
    });
    expect(dbBill.lines.length).toBe(body.lines.length);
    expect(dbBill.subtotal.toFixed(2)).toBe("69.65");

    // MeterRead consumed
    const consumed = await prisma.meterRead.findFirst({
      where: { serviceAgreementId: saId, billedAt: { not: null } },
    });
    expect(consumed).not.toBeNull();
  }, 600_000);

  it("GET /service-agreements/:id/bills returns the new bill", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
      payload: { periodStart: "2026-05-01", periodEnd: "2026-05-31" },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    const arr = JSON.parse(list.body);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(1);
  }, 600_000);

  it("GET /bills/:id returns full bill with lines", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
      payload: { periodStart: "2026-05-01", periodEnd: "2026-05-31" },
    });
    const created = JSON.parse(create.body);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/bills/${created.id}`,
      headers: headers(),
    });
    expect(get.statusCode).toBe(200);
    const fetched = JSON.parse(get.body);
    expect(fetched.id).toBe(created.id);
    expect(fetched.lines.length).toBe(created.lines.length);
  }, 600_000);

  it("returns 400 INVALID_PERIOD when periodEnd < periodStart", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
      payload: { periodStart: "2026-05-31", periodEnd: "2026-05-01" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error?.code).toBe("INVALID_PERIOD");
  });

  it("returns 400 NO_ACTIVE_ASSIGNMENTS for a period before any assignment", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
      payload: { periodStart: "1999-01-01", periodEnd: "1999-01-31" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error?.code).toBe("NO_ACTIVE_ASSIGNMENTS");
  });

  it("returns 409 SCHEDULE_NOT_PUBLISHED when an assigned schedule has publishedAt = NULL", async () => {
    const { prisma } = prismaImports;
    // Find the schedule the SA is assigned to and force it back to draft.
    const a = await prisma.sAScheduleAssignment.findFirstOrThrow({
      where: { serviceAgreementId: saId },
    });
    await prisma.rateSchedule.update({
      where: { id: a.rateScheduleId },
      data: { publishedAt: null },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/service-agreements/${saId}/bills`,
        headers: headers(),
        payload: { periodStart: "2026-05-01", periodEnd: "2026-05-31" },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error?.code).toBe("SCHEDULE_NOT_PUBLISHED");
    } finally {
      // Restore for any later tests.
      await prisma.rateSchedule.update({
        where: { id: a.rateScheduleId },
        data: { publishedAt: new Date(2026, 0, 1) },
      });
    }
  }, 600_000);
});
