import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Whether a utility can actually operate.
 *
 * The console implied an answer it had never checked. A freshly
 * provisioned utility shows 32 modules and 6 roles, which reads like
 * readiness, while `provisionTenant` creates no commodity, no unit of
 * measure, no billing cycle and no rate schedule — so it cannot bill
 * anything. Worse, bill production *refuses outright* when issuer
 * identity is incomplete, and the only way an operator learned that was
 * a tenant complaining.
 *
 * Every check here reads a constraint the code already enforces
 * somewhere, rather than inventing a definition of "ready":
 * `REQUIRED_ISSUER_FIELDS` is what `loadBillPresentation` throws
 * ISSUER_INCOMPLETE over, and the storage integration is what
 * `bill-document.service` refuses without. The point is to surface them
 * before a bill is attempted, not to restate them.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/provisioning.service.js");
let readiness: typeof import("../../services/utility-readiness.service.js");

const UTILITY = "00000000-0000-4000-8000-0000000000f8";

const COMPLETE_ISSUER = {
  utilityName: "City of Readiness",
  remittanceAddressLine1: "1 Water Way",
  remittanceCity: "Bozeman",
  remittanceState: "MT",
  remittancePostalCode: "59715",
};

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/provisioning.service.js");
  readiness = await import("../../services/utility-readiness.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.auditLog.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.rateSchedule.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.billingCycle.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.unitOfMeasure.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.commodity.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.utilityConfig.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.userRole.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.cisUser.deleteMany({ where: { utilityId: UTILITY } });
  // Customer references utility ON DELETE RESTRICT, so the portal test's
  // row would block the utility delete on the next run rather than here.
  await prisma.customer.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.role.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.utilityModule.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.utility.deleteMany({ where: { id: UTILITY } });
  await svc.provisionTenant({ utilityId: UTILITY, name: "City of Readiness" });
});

const check = (checks: { key: string; ok: boolean }[], key: string) =>
  checks.find((c) => c.key === key)!;

describe("a freshly provisioned utility", () => {
  it("is not ready, despite its 32 modules and 6 roles", async () => {
    // The whole reason this exists: the stats imply an answer the page
    // had never checked.
    const result = await readiness.getUtilityReadiness(UTILITY);

    expect(result.ready).toBe(false);
  });

  it("says nobody can administer it, because provisioning was given no admin", async () => {
    const result = await readiness.getUtilityReadiness(UTILITY);

    expect(check(result.checks, "administrable").ok).toBe(false);
  });

  it("says it cannot bill: no commodity, no unit, no cycle, no tariff", async () => {
    const result = await readiness.getUtilityReadiness(UTILITY);

    for (const key of ["commodity", "unitOfMeasure", "billingCycle", "rateSchedule"]) {
      expect(check(result.checks, key).ok, key).toBe(false);
    }
  });

  it("says it cannot produce a bill document: no issuer identity, no storage", async () => {
    const result = await readiness.getUtilityReadiness(UTILITY);

    expect(check(result.checks, "issuerIdentity").ok).toBe(false);
    expect(check(result.checks, "billStorage").ok).toBe(false);
  });

  it("names what each unmet check prevents, not just that it is unmet", async () => {
    const result = await readiness.getUtilityReadiness(UTILITY);

    for (const c of result.checks) {
      expect(c.blocks.length, c.key).toBeGreaterThan(0);
      expect(c.label.length, c.key).toBeGreaterThan(0);
    }
  });
});

describe("administrable", () => {
  it("is met by an active user holding settings:EDIT", async () => {
    await svc.provisionTenant(
      { utilityId: UTILITY, name: "City of Readiness", firstAdmin: { email: "a@x.gov", name: "A" } },
    );

    const result = await readiness.getUtilityReadiness(UTILITY);
    expect(check(result.checks, "administrable").ok).toBe(true);
  });

  it("is not met by a user whose only role cannot change settings", async () => {
    // Utility Admin holds settings:["VIEW"] — it can read the settings
    // page and change nothing on it, so a utility whose only staff hold
    // that cannot administer itself.
    const { prisma } = prismaImports;
    const utilityAdmin = await prisma.role.findFirstOrThrow({
      where: { utilityId: UTILITY, name: "Utility Admin" },
    });
    const user = await prisma.cisUser.create({
      data: { utilityId: UTILITY, email: "va@x.gov", name: "Viewer Admin" },
    });
    await prisma.userRole.create({
      data: { utilityId: UTILITY, userId: user.id, accountId: null, roleId: utilityAdmin.id },
    });

    const result = await readiness.getUtilityReadiness(UTILITY);
    expect(check(result.checks, "administrable").ok).toBe(false);
  });

  it("is not met by a deactivated admin", async () => {
    const { prisma } = prismaImports;
    await svc.provisionTenant(
      { utilityId: UTILITY, name: "City of Readiness", firstAdmin: { email: "a@x.gov", name: "A" } },
    );
    await prisma.cisUser.updateMany({ where: { utilityId: UTILITY }, data: { isActive: false } });

    const result = await readiness.getUtilityReadiness(UTILITY);
    expect(check(result.checks, "administrable").ok).toBe(false);
  });

  it("is not met by a portal customer, however many there are", async () => {
    // Portal Customer grants portal_* only, and those users are not staff.
    const { prisma } = prismaImports;
    const portal = await prisma.role.findFirstOrThrow({
      where: { utilityId: UTILITY, name: "Portal Customer" },
    });
    const customer = await prisma.customer.create({
      data: { utilityId: UTILITY, customerType: "INDIVIDUAL", firstName: "Jo", lastName: "P" },
    });
    const user = await prisma.cisUser.create({
      data: { utilityId: UTILITY, email: "jo@x.com", name: "Jo", customerId: customer.id },
    });
    await prisma.userRole.create({
      data: { utilityId: UTILITY, userId: user.id, accountId: null, roleId: portal.id },
    });

    const result = await readiness.getUtilityReadiness(UTILITY);
    expect(check(result.checks, "administrable").ok).toBe(false);
  });
});

describe("issuer identity", () => {
  it("is met only when every required field is set", async () => {
    const { prisma } = prismaImports;
    await prisma.utilityConfig.create({
      data: { utilityId: UTILITY, settings: { issuer: COMPLETE_ISSUER } },
    });

    const result = await readiness.getUtilityReadiness(UTILITY);
    expect(check(result.checks, "issuerIdentity").ok).toBe(true);
  });

  it("names the fields still missing, which is what the 422 would have said", async () => {
    const { prisma } = prismaImports;
    const { remittanceCity: _omitted, ...partial } = COMPLETE_ISSUER;
    await prisma.utilityConfig.create({
      data: { utilityId: UTILITY, settings: { issuer: partial } },
    });

    const result = await readiness.getUtilityReadiness(UTILITY);
    const c = check(result.checks, "issuerIdentity") as unknown as { ok: boolean; detail: string };
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("remittanceCity");
  });

  it("treats a blank string as unset, since a bill cannot print one", async () => {
    const { prisma } = prismaImports;
    await prisma.utilityConfig.create({
      data: { utilityId: UTILITY, settings: { issuer: { ...COMPLETE_ISSUER, remittanceCity: "   " } } },
    });

    const result = await readiness.getUtilityReadiness(UTILITY);
    expect(check(result.checks, "issuerIdentity").ok).toBe(false);
  });
});

describe("a utility with everything", () => {
  it("is ready", async () => {
    const { prisma } = prismaImports;
    await svc.provisionTenant(
      { utilityId: UTILITY, name: "City of Readiness", firstAdmin: { email: "a@x.gov", name: "A" } },
    );
    await prisma.utilityConfig.create({
      data: {
        utilityId: UTILITY,
        settings: {
          issuer: COMPLETE_ISSUER,
          billDocuments: { storageIntegration: "cis-bills" },
        },
      },
    });
    const commodity = await prisma.commodity.create({
      data: { utilityId: UTILITY, code: "WATER", name: "Water", displayOrder: 1 },
    });
    const measure = await prisma.measureTypeDef.findFirstOrThrow({ where: { utilityId: null } });
    await prisma.unitOfMeasure.create({
      data: {
        utilityId: UTILITY,
        code: "GAL",
        name: "Gallons",
        commodityId: commodity.id,
        measureTypeId: measure.id,
        conversionFactor: 1,
        isBaseUnit: true,
        isActive: true,
      },
    });
    await prisma.billingCycle.create({
      data: {
        utilityId: UTILITY,
        name: "R1",
        cycleCode: "R01",
        readDayOfMonth: 1,
        billDayOfMonth: 15,
        frequency: "MONTHLY",
      },
    });
    await prisma.rateSchedule.create({
      data: {
        utilityId: UTILITY,
        name: "Residential Water",
        code: "RES-W",
        commodityId: commodity.id,
        effectiveDate: new Date("2026-01-01"),
        publishedAt: new Date("2026-01-01"),
      },
    });

    const result = await readiness.getUtilityReadiness(UTILITY);

    expect(result.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]);
    expect(result.ready).toBe(true);
  });

  it("does not count an unpublished tariff, which cannot rate anything", async () => {
    const { prisma } = prismaImports;
    const commodity = await prisma.commodity.create({
      data: { utilityId: UTILITY, code: "WATER", name: "Water", displayOrder: 1 },
    });
    await prisma.rateSchedule.create({
      data: {
        utilityId: UTILITY,
        name: "Draft",
        code: "DRAFT",
        commodityId: commodity.id,
        effectiveDate: new Date("2026-01-01"),
      },
    });

    const result = await readiness.getUtilityReadiness(UTILITY);
    expect(check(result.checks, "rateSchedule").ok).toBe(false);
  });
});

describe("the utility itself", () => {
  it("refuses one that does not exist", async () => {
    await expect(
      readiness.getUtilityReadiness("00000000-0000-4000-8000-0000000000ef"),
    ).rejects.toMatchObject({ code: "UTILITY_NOT_FOUND" });
  });
});

describe("through the detail route", () => {
  /*
   * Readiness rides on the detail response rather than an endpoint of its
   * own. The panel is always visible on that page — unlike History, which
   * is a tab opened on demand — so a second request would buy a second
   * loading state and nothing else.
   */
  let app: import("fastify").FastifyInstance;
  const PLATFORM_ACTOR = "00000000-0000-4000-8000-aaaa0000f001";

  function token(claims: Record<string, unknown>) {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  }
  const platformHeaders = {
    authorization: `Bearer ${token({ sub: PLATFORM_ACTOR, platform: true, email: "o@x.gov", name: "Ops" })}`,
  };

  beforeAll(async () => {
    const appImports = await import("../../app.js");
    app = await appImports.buildApp();
    await app.ready();
  }, 60_000);

  beforeEach(async () => {
    const { prisma } = prismaImports;
    await prisma.cisUser.deleteMany({ where: { utilityId: null } });
    await prisma.cisUser.create({
      data: { id: PLATFORM_ACTOR, utilityId: null, email: "o@x.gov", name: "Ops", isActive: true },
    });
  });

  it("serves readiness alongside the counts that used to imply it", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/platform/utilities/${UTILITY}`,
      headers: platformHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.moduleCount ?? body.modules?.length).toBeGreaterThan(0);
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.checks.length).toBeGreaterThan(0);
  });
});
