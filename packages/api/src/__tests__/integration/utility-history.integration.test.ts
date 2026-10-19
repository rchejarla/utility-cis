import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * What the operator may read of a utility's audit log: its own actions.
 *
 * Not the tenant's log. Those rows carry the tenant's business data —
 * `auditUpdate` stores before/after states of customers, accounts and
 * bills — so reading them is reading the tenant's data rather than
 * metadata about the tenant, and D6 sizes this actor by the opposite
 * rule: it "holds only what cannot live anywhere else", because "every
 * capability added to it is a capability that can reach every customer's
 * data". A full audit read is the broadest such capability there is, and
 * it is impersonation's reconnaissance half without the time-box that
 * D6 insists impersonation would need.
 *
 * So the filter is the feature, and it is the thing these tests are
 * mostly about: `platform:` and `script:` rows only, which are exactly
 * the rows the operator or a CLI run wrote, and whose before/after
 * states hold utility status, module keys and role names — nothing of
 * any customer's.
 *
 * The asymmetry runs the other way for the tenant: its own log contains
 * these rows too, so it can see what was done to it from outside. The
 * outside actor is the accountable one, not the one with extra sight.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/provisioning.service.js");

const UTILITY = "00000000-0000-4000-8000-0000000000e9";
const OTHER = "00000000-0000-4000-8000-0000000000ea";
const OPERATOR = "00000000-0000-4000-8000-aaaa0000e001";
const operator = { id: OPERATOR, name: "Pat Operator", source: `platform:${OPERATOR}` };

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/provisioning.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  for (const id of [UTILITY, OTHER]) {
    await prisma.auditLog.deleteMany({ where: { utilityId: id } });
    await prisma.userRole.deleteMany({ where: { utilityId: id } });
    await prisma.cisUser.deleteMany({ where: { utilityId: id } });
    await prisma.role.deleteMany({ where: { utilityId: id } });
    await prisma.utilityModule.deleteMany({ where: { utilityId: id } });
    await prisma.utility.deleteMany({ where: { id } });
  }
  await svc.provisionTenant({ utilityId: UTILITY, name: "City of History" }, operator);
  await svc.provisionTenant({ utilityId: OTHER, name: "Other Utility" }, operator);
});

/** A row of the kind the tenant's own staff produce. */
async function seedTenantRow(utilityId: string, source: string | null) {
  const { prisma } = prismaImports;
  await prisma.auditLog.create({
    data: {
      utilityId,
      entityType: "Customer",
      entityId: "00000000-0000-4000-8000-ccccc0000001",
      action: "UPDATE",
      actorId: null,
      actorName: "Tenant Staff",
      source,
      beforeState: { lastName: "Public" },
      afterState: { lastName: "Private" },
    },
  });
}

describe("listUtilityHistory", () => {
  it("returns what the operator did to this utility", async () => {
    await svc.suspendUtility(UTILITY, operator);

    const rows = await svc.listUtilityHistory(UTILITY);

    expect(rows.length).toBeGreaterThanOrEqual(2); // provisioned + suspended
    expect(rows.every((r) => r.source?.startsWith("platform:"))).toBe(true);
  });

  it("never returns a row the tenant's own staff wrote", async () => {
    // The boundary. A staff action writes NULL source and its states hold
    // customer data; it must not appear here however the list is read.
    await seedTenantRow(UTILITY, null);

    const rows = await svc.listUtilityHistory(UTILITY);

    expect(rows.some((r) => r.entityType === "Customer")).toBe(false);
    expect(rows.every((r) => r.source !== null)).toBe(true);
  });

  it("never returns a scheduler row either", async () => {
    // Those are system actions on tenant records — an SLA breach names a
    // service request — so they are the tenant's, not the operator's.
    await seedTenantRow(UTILITY, "scheduler:sla-breach-sweep");

    const rows = await svc.listUtilityHistory(UTILITY);

    expect(rows.every((r) => !r.source?.startsWith("scheduler:"))).toBe(true);
  });

  it("includes a run from the CLI, which is the operator's other hand", async () => {
    const { prisma } = prismaImports;
    await prisma.auditLog.deleteMany({ where: { utilityId: UTILITY } });
    await svc.suspendUtility(UTILITY); // no operator: attributed to the script

    const rows = await svc.listUtilityHistory(UTILITY);

    expect(rows.some((r) => r.source?.startsWith("script:"))).toBe(true);
  });

  it("returns nothing belonging to another utility", async () => {
    await svc.suspendUtility(OTHER, operator);

    const rows = await svc.listUtilityHistory(UTILITY);

    expect(rows.every((r) => r.utilityId === UTILITY)).toBe(true);
  });

  it("puts the newest first, since that is what an operator opens it for", async () => {
    await svc.suspendUtility(UTILITY, operator);
    await svc.reactivateUtility(UTILITY, operator);

    const rows = await svc.listUtilityHistory(UTILITY);

    expect(rows[0].afterState).toMatchObject({ status: "ACTIVE" });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(rows[i].createdAt.getTime());
    }
  });

  it("caps how much it returns", async () => {
    for (let i = 0; i < 6; i++) {
      await svc.setUtilityModule(UTILITY, "containers", i % 2 === 0, operator);
    }

    expect((await svc.listUtilityHistory(UTILITY, 3))).toHaveLength(3);
  });

  it("refuses a utility that does not exist", async () => {
    await expect(
      svc.listUtilityHistory("00000000-0000-4000-8000-0000000000ef"),
    ).rejects.toMatchObject({ code: "UTILITY_NOT_FOUND" });
  });
});

describe("through the route", () => {
  let app: import("fastify").FastifyInstance;
  const PLATFORM_ACTOR = "00000000-0000-4000-8000-aaaa0000e002";

  function token(claims: Record<string, unknown>) {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  }
  const platformHeaders = {
    authorization: `Bearer ${token({ sub: PLATFORM_ACTOR, platform: true, email: "o@x.gov", name: "Ops" })}`,
  };
  const tenantHeaders = {
    authorization: `Bearer ${token({ sub: "00000000-0000-4000-8000-aaaa00000001", utility_id: UTILITY, email: "t@x.gov", name: "T" })}`,
  };

  beforeAll(async () => {
    const appImports = await import("../../app.js");
    app = await appImports.buildApp();
    await app.ready();
  }, 60_000);

  beforeEach(async () => {
    await prismaImports.prisma.cisUser.deleteMany({ where: { utilityId: null } });
    await prismaImports.prisma.cisUser.create({
      data: { id: PLATFORM_ACTOR, utilityId: null, email: "o@x.gov", name: "Ops", isActive: true },
    });
  });

  it("serves the history to the operator", async () => {
    await svc.suspendUtility(UTILITY, operator);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/platform/utilities/${UTILITY}/history`,
      headers: platformHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.length).toBeGreaterThan(0);
  });

  it("refuses a tenant admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/platform/utilities/${UTILITY}/history`,
      headers: tenantHeaders,
    });

    expect(res.statusCode).toBe(403);
  });

  it("answers 404 for a utility that does not exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/utilities/00000000-0000-4000-8000-0000000000ef/history",
      headers: platformHeaders,
    });

    expect(res.statusCode).toBe(404);
  });

  it("refuses a limit beyond the cap rather than silently clamping", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/platform/utilities/${UTILITY}/history?limit=5000`,
      headers: platformHeaders,
    });

    expect(res.statusCode).toBe(400);
  });
});
