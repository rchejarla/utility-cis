import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";

import { runAsPlatform, runAsTenant } from "../../lib/tenant-context.js";
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

/**
 * The services this file calls directly, as a route reaches them: acting
 * for the tenant, not merely naming it.
 *
 * Each already receives the tenant — production passed it from a request
 * or a job whose scope had been entered, so the argument and the scope
 * are always the same id. A direct service test has the argument and not
 * the scope, and under `cis_app` a tenant table read with no scope raises
 * rather than returning the wrong rows.
 *
 * `runAsTenant` also overrides a surrounding `seedAsPlatform`, which is
 * what lets fixture rows be arranged across tenants while the call under
 * test stays confined to one.
 */
/**
 * `provisionTenant` as the platform console calls it: creating a tenant
 * is an above-tenant operation, so the scope is the platform's, not any
 * tenant's.
 */
const provisionTenant = (...args: Parameters<typeof svc.provisionTenant>) =>
  runAsPlatform(async () => svc.provisionTenant(...args));

const getUtilityReadiness = (...args: Parameters<typeof readiness.getUtilityReadiness>) =>
  runAsTenant(args[0], async () => readiness.getUtilityReadiness(...args));

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/provisioning.service.js");
  readiness = await import("../../services/utility-readiness.service.js");
}, 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
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
  await provisionTenant({ utilityId: UTILITY, name: "City of Readiness" });
}),
);

const check = (checks: { key: string; ok: boolean }[], key: string) =>
  checks.find((c) => c.key === key)!;

describe("a freshly provisioned utility", () => {
  it("is not ready, despite its 32 modules and 6 roles", async () => {
    // The whole reason this exists: the stats imply an answer the page
    // had never checked.
    const result = await getUtilityReadiness(UTILITY);

    expect(result.ready).toBe(false);
  });

  it("says nobody can administer it, because provisioning was given no admin", async () => {
    const result = await getUtilityReadiness(UTILITY);

    expect(check(result.checks, "administrable").ok).toBe(false);
  });

  it("says it cannot bill: no commodity, no unit, no cycle, no tariff", async () => {
    const result = await getUtilityReadiness(UTILITY);

    for (const key of ["commodity", "unitOfMeasure", "billingCycle", "rateSchedule"]) {
      expect(check(result.checks, key).ok, key).toBe(false);
    }
  });

  it("says it cannot produce a bill document: no issuer identity, no storage", async () => {
    const result = await getUtilityReadiness(UTILITY);

    expect(check(result.checks, "issuerIdentity").ok).toBe(false);
    expect(check(result.checks, "billStorage").ok).toBe(false);
  });

  it("names what each unmet check prevents, not just that it is unmet", async () => {
    const result = await getUtilityReadiness(UTILITY);

    for (const c of result.checks) {
      expect(c.blocks.length, c.key).toBeGreaterThan(0);
      expect(c.label.length, c.key).toBeGreaterThan(0);
    }
  });
});

describe("administrable", () => {
  it("is met by an active user holding settings:EDIT", async () => {
    await provisionTenant(
      { utilityId: UTILITY, name: "City of Readiness", firstAdmin: { email: "a@x.gov", name: "A" } },
    );

    const result = await getUtilityReadiness(UTILITY);
    expect(check(result.checks, "administrable").ok).toBe(true);
  });

  it("is not met by a user whose only role cannot change settings", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
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

      const result = await getUtilityReadiness(UTILITY);
      expect(check(result.checks, "administrable").ok).toBe(false);
  
    }));

  it("is not met by a deactivated admin", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await provisionTenant(
        { utilityId: UTILITY, name: "City of Readiness", firstAdmin: { email: "a@x.gov", name: "A" } },
      );
      await prisma.cisUser.updateMany({ where: { utilityId: UTILITY }, data: { isActive: false } });

      const result = await getUtilityReadiness(UTILITY);
      expect(check(result.checks, "administrable").ok).toBe(false);
  
    }));

  it("is not met by a portal customer, however many there are", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
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

      const result = await getUtilityReadiness(UTILITY);
      expect(check(result.checks, "administrable").ok).toBe(false);
  
    }));
});

describe("issuer identity", () => {
  it("is met only when every required field is set", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await prisma.utilityConfig.create({
        data: { utilityId: UTILITY, settings: { issuer: COMPLETE_ISSUER } },
      });

      const result = await getUtilityReadiness(UTILITY);
      expect(check(result.checks, "issuerIdentity").ok).toBe(true);
  
    }));

  it("names the fields still missing, which is what the 422 would have said", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      const { remittanceCity: _omitted, ...partial } = COMPLETE_ISSUER;
      await prisma.utilityConfig.create({
        data: { utilityId: UTILITY, settings: { issuer: partial } },
      });

      const result = await getUtilityReadiness(UTILITY);
      const c = check(result.checks, "issuerIdentity") as unknown as { ok: boolean; detail: string };
      expect(c.ok).toBe(false);
      expect(c.detail).toContain("remittanceCity");
  
    }));

  it("treats a blank string as unset, since a bill cannot print one", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await prisma.utilityConfig.create({
        data: { utilityId: UTILITY, settings: { issuer: { ...COMPLETE_ISSUER, remittanceCity: "   " } } },
      });

      const result = await getUtilityReadiness(UTILITY);
      expect(check(result.checks, "issuerIdentity").ok).toBe(false);
  
    }));
});

describe("a utility with everything", () => {
  it("is ready", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await provisionTenant(
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
      const schedule = await prisma.rateSchedule.create({
        data: {
          utilityId: UTILITY,
          name: "Residential Water",
          code: "RES-W",
          commodityId: commodity.id,
          effectiveDate: new Date("2026-01-01"),
          publishedAt: new Date("2026-01-01"),
        },
      });
      // With a charge on it: a published schedule carrying none prices
      // nothing, so a tenant holding only that is not ready.
      await prisma.rateComponent.create({
        data: {
          utilityId: UTILITY,
          rateScheduleId: schedule.id,
          kindCode: "service_charge",
          label: "Monthly service charge",
          predicate: {},
          quantitySource: {},
          pricing: { amount: "12.50" },
          effectiveDate: new Date("2026-01-01"),
        },
      });

      const result = await getUtilityReadiness(UTILITY);

      expect(result.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]);
      expect(result.ready).toBe(true);
  
    }));

  it("does not count a published tariff that carries no charges", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      /*
       * `publishRateSchedule` guards only against publishing twice and
       * publishing a superseded version — nothing requires a component —
       * so an empty schedule can be published, and counting
       * `publishedAt != null` called such a tenant priced while its bills
       * would still come out at zero. The check claims usage can be
       * priced; this is what makes the claim true.
       */
      const { prisma } = prismaImports;
      const commodity = await prisma.commodity.create({
        data: { utilityId: UTILITY, code: "WATER", name: "Water", displayOrder: 1 },
      });
      await prisma.rateSchedule.create({
        data: {
          utilityId: UTILITY,
          name: "Published but empty",
          code: "EMPTY",
          commodityId: commodity.id,
          effectiveDate: new Date("2026-01-01"),
          publishedAt: new Date("2026-01-01"),
        },
      });

      const result = await getUtilityReadiness(UTILITY);
      const c = check(result.checks, "rateSchedule") as unknown as { ok: boolean; detail: string };

      expect(c.ok).toBe(false);
      // And says which of the two states it is in, since "none published"
      // would send an admin to create a second empty schedule.
      expect(c.detail).toMatch(/charge/i);
  
    }));

  it("counts a published tariff once it has a charge on it", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      const commodity = await prisma.commodity.create({
        data: { utilityId: UTILITY, code: "WATER", name: "Water", displayOrder: 1 },
      });
      const schedule = await prisma.rateSchedule.create({
        data: {
          utilityId: UTILITY,
          name: "Residential Water",
          code: "RES-W",
          commodityId: commodity.id,
          effectiveDate: new Date("2026-01-01"),
          publishedAt: new Date("2026-01-01"),
        },
      });
      await prisma.rateComponent.create({
        data: {
          utilityId: UTILITY,
          rateScheduleId: schedule.id,
          kindCode: "service_charge",
          label: "Monthly service charge",
          predicate: {},
          quantitySource: {},
          pricing: { amount: "12.50" },
          effectiveDate: new Date("2026-01-01"),
        },
      });

      const result = await getUtilityReadiness(UTILITY);
      expect(check(result.checks, "rateSchedule").ok).toBe(true);
  
    }));

  it("does not count an unpublished tariff, which cannot rate anything", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
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

      const result = await getUtilityReadiness(UTILITY);
      expect(check(result.checks, "rateSchedule").ok).toBe(false);
  
    }));
});

describe("the utility itself", () => {
  it("refuses one that does not exist", async () => {
    await expect(
      getUtilityReadiness("00000000-0000-4000-8000-0000000000ef"),
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

  beforeEach(() =>
  seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await prisma.cisUser.deleteMany({ where: { utilityId: null } });
    await prisma.cisUser.create({
      data: { id: PLATFORM_ACTOR, utilityId: null, email: "o@x.gov", name: "Ops", isActive: true },
    });
  }),
);

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

describe("the tenant's own readiness route", () => {
  /*
   * The same answer, served to the people who can act on it. The
   * operator sees it to know why a tenant is quiet; the tenant's own
   * admin sees it as a list of what to go and do, which is the only
   * side that can do any of it.
   *
   * `settings:VIEW`, which is what /settings/bill-production already
   * requires to show the issuer fields two of these checks are about.
   * Deliberately not a new module key: that would need a
   * `utility_module` row for every tenant and a place in six presets to
   * answer a question the existing key already covers.
   */
  let app: import("fastify").FastifyInstance;
  const ADMIN = "00000000-0000-4000-8000-bbbb0000f001";
  const CSR = "00000000-0000-4000-8000-bbbb0000f002";

  function token(claims: Record<string, unknown>) {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  }
  const asUser = (sub: string) => ({
    authorization: `Bearer ${token({ sub, utility_id: UTILITY, email: "u@x.gov", name: "U" })}`,
  });

  beforeAll(async () => {
    const appImports = await import("../../app.js");
    app = await appImports.buildApp();
    await app.ready();
  }, 60_000);

  /** A staff member holding exactly these permissions. */
  async function staff(id: string, permissions: Record<string, string[]>) {
    /*
     * Arranging rows, so the authority the fixtures use. Calls under
     * test re-enter their own tenant scope.
     */
    return seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const role = await prisma.role.create({
        data: { utilityId: UTILITY, name: `Fixture ${id.slice(-4)}`, permissions },
      });
      await prisma.cisUser.create({
        data: { id, utilityId: UTILITY, email: `${id.slice(-4)}@x.gov`, name: "Staff", isActive: true },
      });
      await prisma.userRole.create({
        data: { utilityId: UTILITY, userId: id, accountId: null, roleId: role.id },
      });
      const rbac = await import("../../services/rbac.service.js");
      await rbac.invalidateUserRoleCache(id, UTILITY);
  
    });
  }

  it("serves its own readiness to an admin who can view settings", async () => {
    await staff(ADMIN, { settings: ["VIEW"] });

    const res = await app.inject({ method: "GET", url: "/api/v1/readiness", headers: asUser(ADMIN) });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ready).toBe(false);
    expect(body.checks.map((c: { key: string }) => c.key)).toContain("issuerIdentity");
  });

  it("refuses a CSR, who cannot see settings", async () => {
    await staff(CSR, { customers: ["VIEW"], accounts: ["VIEW"] });

    const res = await app.inject({ method: "GET", url: "/api/v1/readiness", headers: asUser(CSR) });

    expect(res.statusCode).toBe(403);
  });

  it("answers for the caller's own tenant, not one named in a query", async () => {
    // There is no utility parameter, on purpose: the only tenant this
    // can report on is the token's own.
    await staff(ADMIN, { settings: ["VIEW"] });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/readiness?utilityId=00000000-0000-4000-8000-0000000000ef",
      headers: asUser(ADMIN),
    });

    expect(res.statusCode).toBe(200);
  });

  it("refuses the platform actor, who has no tenant to report on", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      const operator = "00000000-0000-4000-8000-bbbb0000f003";
      await prisma.cisUser.deleteMany({ where: { utilityId: null } });
      await prisma.cisUser.create({
        data: { id: operator, utilityId: null, email: "o@x.gov", name: "Ops", isActive: true },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/readiness",
        headers: { authorization: `Bearer ${token({ sub: operator, platform: true, email: "o@x.gov" })}` },
      });

      expect(res.statusCode).toBe(403);
  
    }));
});
