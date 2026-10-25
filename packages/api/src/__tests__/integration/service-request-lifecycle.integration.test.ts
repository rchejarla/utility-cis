import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";

/**
 * The service-request lifecycle over HTTP: create, list, assign,
 * transition, complete — plus the two refusals that bound it.
 *
 * This replaces `service-requests.test.ts`, which covered the same
 * ground and never ran once. It was gated behind
 * `RUN_REAL_DB_INTEGRATION_TESTS=true` *and* named so it matched neither
 * glob in `vitest.integration.config.ts` — so it landed in the unit
 * suite, where `describe.skipIf` skipped it. Two independent conditions,
 * each enough on its own to keep it dark, and between them a module
 * spent six months answering 400 to every read with a test file sitting
 * beside it that looked like proof it worked.
 *
 * The difference that matters is the database. That suite pointed at
 * whatever `DATABASE_URL` named and leaned on the dev seed for its
 * roles, which is why it needed an operator to opt in. This one boots
 * its own Postgres and builds every row it depends on, so it runs
 * wherever the rest of the integration suite runs and needs no flag.
 *
 * Permissions are built here rather than taken from the seeded presets,
 * for the same reason: a test whose 403 depends on how "Portal
 * Customer" happens to be configured today is testing the seed.
 */

const utilityId = "00000000-0000-4000-8000-0000000000aa";
const CSR = "00000000-0000-4000-8000-aaaa00000011";
const PORTAL = "00000000-0000-4000-8000-aaaa00000012";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;

function makeToken(sub: string, role: string) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub, utility_id: utilityId, email: `${role}@test`, name: role, role }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}
const csrHeaders = { authorization: `Bearer ${makeToken(CSR, "CSR")}` };
const portalHeaders = { authorization: `Bearer ${makeToken(PORTAL, "Portal Customer")}` };

/** A role with exactly these permissions, and a user wearing it. */
async function principal(
  prisma: typeof prismaImports.prisma,
  userId: string,
  roleName: string,
  permissions: Record<string, string[]>,
) {
  /*
   * Arranging rows, so the authority the fixtures use. Calls under
   * test re-enter their own tenant scope.
   */
  return seedAsPlatform(async () => {
    const role = await prisma.role.create({
      data: { utilityId, name: roleName, description: `${roleName} fixture`, permissions },
      select: { id: true },
    });
    await prisma.cisUser.create({
      data: {
        id: userId,
        utilityId,
        email: `${roleName.replace(/\s+/g, "-").toLowerCase()}@integration.test`,
        name: roleName,
        isActive: true,
      },
    });
    await prisma.userRole.create({
      data: { utilityId, userId, accountId: null, roleId: role.id },
    });

  });
}

beforeAll(() =>
  seedAsPlatform(async () => {
  const booted = await bootPostgres({ utilities: [utilityId] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  const appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();

  const { prisma } = prismaImports;

  await prisma.utilityModule.create({ data: { utilityId, moduleKey: "service_requests" } });

  // Global type-defs — `utilityId` null means "belongs to no tenant".
  await prisma.serviceRequestTypeDef.createMany({
    data: [
      { code: "LEAK_REPORT", label: "Leak Report" },
      { code: "OTHER", label: "Other" },
    ],
    skipDuplicates: true,
  });

  // An SLA for the HIGH leak case, so creation resolves one and
  // `slaDueAt` is populated rather than quietly null.
  await prisma.sla.create({
    data: {
      utilityId,
      requestType: "LEAK_REPORT",
      priority: "HIGH",
      responseHours: 2,
      resolutionHours: 24,
    },
  });

  await principal(prisma, CSR, "CSR Fixture", {
    service_requests: ["VIEW", "CREATE", "EDIT"],
  });
  // Holds a role, and that role holds nothing on this module — which is
  // the FORBIDDEN branch, not the no-role pass-through.
  await principal(prisma, PORTAL, "Portal Fixture", {
    portal_billing: ["VIEW"],
  });

  /*
   * Postgres is a fresh container every run; Redis is not. The
   * integration config points every suite at database 9 of the dev
   * Redis, and `rbac.service` caches roles, enabled modules and tenant
   * status under keys built from ids this file hardcodes — so a run
   * inherits the *previous* run's authorization state.
   *
   * That is not theoretical. It silently defeated a mutation check
   * here: granting the portal subject `service_requests:VIEW` left the
   * 403 in place, because the role being read was the one cached before
   * the grant. The suite passed, and would have passed with the
   * permission gate removed entirely.
   *
   * Other route suites have not been bitten because they authenticate
   * as an all-permissions fixture, where a stale entry says the same
   * thing as a fresh one. Any suite that cares *which* permissions a
   * subject holds has to clear these first.
   */
  const { cacheDel } = await import("../../lib/cache-redis.js");
  await Promise.all([
    cacheDel(`tenant-modules:${utilityId}`),
    cacheDel(`utility-status:${utilityId}`),
    cacheDel(`user-role:${utilityId}:${CSR}:tenant`),
    cacheDel(`user-role:${utilityId}:${PORTAL}:tenant`),
  ]);
}), 240_000);

afterAll(async () => {
  if (app) await app.close();
  await prismaImports?.prisma.$disconnect();
  // `$disconnect` does not dispose a pool the application owns — that is
  // the driver-adapter contract — so the tenant and platform pools are
  // ended here. Without it the container stops while connections are
  // live and Postgres reports 57P01 after an otherwise green run.
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop();
});

beforeEach(() =>
  seedAsPlatform(async () => {
  await prismaImports.prisma.serviceRequest.deleteMany({ where: { utilityId } });
}),
);

describe("service request lifecycle over HTTP", () => {
  it("creates, lists, assigns, progresses and completes a request", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/service-requests",
      headers: csrHeaders,
      payload: {
        requestType: "LEAK_REPORT",
        priority: "HIGH",
        description: "pipe leak near meter",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.requestNumber).toMatch(/^SR-\d{4}-\d{6}$/);
    expect(created.status).toBe("NEW");
    // The SLA above resolved, so the clock is actually running.
    expect(created.slaDueAt).not.toBeNull();

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/service-requests",
      headers: csrHeaders,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().data.some((r: { id: string }) => r.id === created.id)).toBe(true);

    const assignRes = await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${created.id}/assign`,
      headers: csrHeaders,
      payload: { assignedTeam: "Field Ops" },
    });
    expect(assignRes.statusCode).toBe(200);
    // Assigning moves it on by itself; that auto-transition is the point.
    expect(assignRes.json().status).toBe("ASSIGNED");

    const inProgressRes = await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${created.id}/transition`,
      headers: csrHeaders,
      payload: { toStatus: "IN_PROGRESS" },
    });
    expect(inProgressRes.statusCode).toBe(200);
    expect(inProgressRes.json().status).toBe("IN_PROGRESS");

    const completeRes = await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${created.id}/complete`,
      headers: csrHeaders,
      payload: { resolutionNotes: "Fixed the leak, no further action." },
    });
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.json().status).toBe("COMPLETED");
    expect(completeRes.json().completedAt).not.toBeNull();
  });

  it("refuses a transition the state machine does not allow", async () => {
    const { id } = (
      await app.inject({
        method: "POST",
        url: "/api/v1/service-requests",
        headers: csrHeaders,
        payload: { requestType: "OTHER", priority: "LOW", description: "x" },
      })
    ).json();

    // NEW → IN_PROGRESS skips ASSIGNED.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${id}/transition`,
      headers: csrHeaders,
      payload: { toStatus: "IN_PROGRESS" },
    });
    expect(res.statusCode).toBe(409);

    // And the refusal left it where it was, rather than half-moving it.
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/service-requests/${id}`,
      headers: csrHeaders,
    });
    expect(after.json().status).toBe("NEW");
  });

  it("denies a subject whose role holds nothing on this module", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/service-requests",
      headers: portalHeaders,
    });
    expect(res.statusCode).toBe(403);
    /*
     * The code, not just the status. `authorization.ts` has six 403
     * branches and four of them would fire here for reasons that have
     * nothing to do with permissions — a suspended tenant, a disabled
     * module, an unprovisioned subject, a deactivated one. Asserting
     * the status alone passes on all of them, so it would go green on a
     * fixture that never granted the module in the first place.
     */
    expect(res.json().error).toMatchObject({
      code: "FORBIDDEN",
      message: "Insufficient permissions: requires service_requests:VIEW",
    });
  });

  /*
   * The read shape, over HTTP rather than through the service.
   * `service-request-reads.integration.test.ts` pins the agreement's
   * premise at the service layer; this proves the route returns it too,
   * since a `include` fault surfaces as a 400 here and nowhere else a
   * CSR would see.
   */
    /*
   * The whole body under the fixture authority, because the rows it
   * arranges are declared here and used below — wrapping only the
   * writes would scope their names away.
   *
   * It costs nothing: `app.inject` enters its own tenant scope in the
   * request's middleware, so every route call below still runs as
   * `cis_app` acting for its own tenant, and the assertions are on the
   * HTTP responses rather than on direct reads.
   */
  it("returns a request whose agreement carries the premise it is served at", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const customer = await prisma.customer.create({
        data: { utilityId, customerType: "INDIVIDUAL", firstName: "Ada", lastName: "Lovelace" },
      });
      const cycle = await prisma.billingCycle.create({
        data: {
          utilityId,
          name: "R1",
          cycleCode: "R01",
          readDayOfMonth: 1,
          billDayOfMonth: 15,
          frequency: "MONTHLY",
        },
      });
      const account = await prisma.account.create({
        data: {
          utilityId,
          accountNumber: "SRL-001",
          accountType: "RESIDENTIAL",
          status: "ACTIVE",
          billingCycleId: cycle.id,
          customerId: customer.id,
        },
      });
      const premise = await prisma.premise.create({
        data: {
          utilityId,
          addressLine1: "412 N 7th Ave",
          city: "Bozeman",
          state: "MT",
          zip: "59715",
          premiseType: "RESIDENTIAL",
        },
      });
      const commodity = await prisma.commodity.create({
        data: { utilityId, code: "WATER-L", name: "Potable Water" },
      });
      const agreement = await prisma.serviceAgreement.create({
        data: {
          utilityId,
          accountId: account.id,
          commodityId: commodity.id,
          agreementNumber: "SA-L-0421",
          status: "ACTIVE",
          startDate: new Date("2026-01-01"),
        },
      });
      await prisma.servicePoint.create({
        data: {
          utilityId,
          serviceAgreementId: agreement.id,
          premiseId: premise.id,
          startDate: new Date("2026-01-01"),
        },
      });

      const created = (
        await app.inject({
          method: "POST",
          url: "/api/v1/service-requests",
          headers: csrHeaders,
          payload: {
            requestType: "LEAK_REPORT",
            priority: "HIGH",
            description: "kerbside pooling",
            accountId: account.id,
            premiseId: premise.id,
            serviceAgreementId: agreement.id,
          },
        })
      ).json();

      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/service-requests/${created.id}`,
        headers: csrHeaders,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().serviceAgreement).toMatchObject({
        agreementNumber: "SA-L-0421",
        commodity: { name: "Potable Water" },
        premise: { addressLine1: "412 N 7th Ave" },
      });

      // The account tab reads the same request through its own route.
      const tab = await app.inject({
        method: "GET",
        url: `/api/v1/accounts/${account.id}/service-requests`,
        headers: csrHeaders,
      });
      expect(tab.statusCode).toBe(200);
      expect(tab.json()[0].serviceAgreement.premise).toEqual({ addressLine1: "412 N 7th Ave" });
  
    }),
  );
});
