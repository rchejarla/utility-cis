import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { createTestToken, createPlatformToken } from "../setup.js";
import { MODULES } from "@utility-cis/shared";

/**
 * The platform operator's own routes.
 *
 * These replace `/api/v1/dev/tenants`, which existed behind
 * `!IS_PROD && ENABLE_DEV_AUTH_ENDPOINTS` because the authority it
 * needed did not exist yet — provisioning had nowhere to live but a
 * tenant's own Administration section, gated on a tenant permission,
 * which is the borrowing §1.6 flags with Bull Board.
 *
 * The authority exists now, so the fence comes off and the inverse of
 * the old fence test applies: these routes must be present in a
 * production build. What refuses a tenant admin is no longer the
 * absence of the route but `{ platform: true }`.
 *
 * Note what is NOT claimed here. Nothing in this app authenticates
 * anyone yet — there is no password column and the web login form
 * returns a fixed user — so "present in production" means the authority
 * model is right, not that the deployment is safe. That is Q2's
 * destination (apptorID) and a separate piece of work.
 */

const PLATFORM_ID = "test-platform-001";
const TENANT = "00000000-0000-4000-8000-000000000001";
const ABSENT = "00000000-0000-4000-8000-0000000000ff";

const platformHeaders = {
  authorization: `Bearer ${createPlatformToken({ sub: PLATFORM_ID })}`,
  "content-type": "application/json",
};
const tenantHeaders = {
  authorization: `Bearer ${createTestToken()}`,
  "content-type": "application/json",
};

function summaryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TENANT,
    name: "City of Bozeman",
    status: "ACTIVE",
    createdAt: new Date("2026-10-18T00:00:00Z"),
    _count: { utilityModules: MODULES.length, roles: 6, cisUsers: 7 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // One findFirst serves getPlatformActor and getUserRole, so the mock
  // honours the predicates rather than just the first one it sees.
  (prisma.cisUser.findFirst as Mock).mockImplementation(
    (args: { where: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      if (where.utilityId === null) {
        // Honour whichever identifier the caller supplied — id for
        // getPlatformActor, email for dev-login — rather than only the
        // predicate being pinned. A mock that answers every lookup the
        // same way is a mock that cannot show a wrong one.
        if (where.isActive !== true) return Promise.resolve(null);
        const matchesId = where.id === undefined || where.id === PLATFORM_ID;
        const matchesEmail =
          where.email === undefined || where.email === "platform@utility.com";
        if (!matchesId || !matchesEmail) return Promise.resolve(null);
        return Promise.resolve({
          id: PLATFORM_ID,
          email: "platform@utility.com",
          name: "Platform Operator",
          customerId: null,
          isActive: true,
        });
      }
      return Promise.resolve({
        id: "test-user-001",
        utilityId: "test-utility-001",
        email: "test@example.com",
        name: "Test User",
        customerId: null,
        isActive: true,
      });
    },
  );
  // A tenant admin holding everything a tenant can grant.
  (prisma.utilityModule.findMany as Mock).mockResolvedValue(
    MODULES.map((moduleKey) => ({ moduleKey })),
  );
  (prisma.userRole.findFirst as Mock).mockResolvedValue({
    roleId: "role-admin",
    role: { id: "role-admin", name: "System Admin", permissions: { settings: ["VIEW", "EDIT"] } },
  });
  (prisma.utility.findMany as Mock).mockResolvedValue([summaryRow()]);
  (prisma.utility.findUnique as Mock).mockResolvedValue({ id: TENANT, status: "ACTIVE" });
  (prisma.utility.update as Mock).mockResolvedValue(summaryRow({ status: "SUSPENDED" }));
});

describe("GET /api/v1/platform/utilities", () => {
  it("lists tenants for the platform actor", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/utilities",
      headers: platformHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0]).toMatchObject({ name: "City of Bozeman" });
  });

  it("refuses a tenant admin, System Admin included", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/utilities",
      headers: tenantHeaders,
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("PLATFORM_REQUIRED");
  });

  it("exists in a production build", async () => {
    // The inverse of the step-3 fence test. `hasRoute` asks the question
    // without sending a request, so it does not depend on a token being
    // accepted — unsigned tokens are rejected in production.
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const { buildApp: buildProd } = await import("../../app.js");
    const app = await buildProd();

    expect(app.hasRoute({ method: "GET", url: "/api/v1/platform/utilities" })).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("POST /api/v1/platform/utilities", () => {
  it("creates, and answers 201", async () => {
    (prisma.utility.findUnique as Mock).mockResolvedValue(null);
    (prisma.utility.findFirst as Mock).mockResolvedValue(null);
    (prisma.utility.create as Mock).mockResolvedValue({ id: ABSENT, name: "City of Example" });
    (prisma.utilityModule.createMany as Mock).mockResolvedValue({ count: MODULES.length });
    (prisma.role.findMany as Mock).mockResolvedValue([]);
    (prisma.role.create as Mock).mockResolvedValue({ id: "r1", name: "System Admin" });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/utilities",
      headers: platformHeaders,
      payload: { name: "City of Example" },
    });

    expect(res.statusCode).toBe(201);
  });

  it("answers 200 for a dry run, since nothing was created", async () => {
    (prisma.utility.findUnique as Mock).mockResolvedValue(null);
    (prisma.utility.findFirst as Mock).mockResolvedValue(null);
    (prisma.utility.create as Mock).mockResolvedValue({ id: ABSENT, name: "City of Example" });
    (prisma.utilityModule.createMany as Mock).mockResolvedValue({ count: MODULES.length });
    (prisma.role.findMany as Mock).mockResolvedValue([]);
    (prisma.role.create as Mock).mockResolvedValue({ id: "r1", name: "System Admin" });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/utilities",
      headers: platformHeaders,
      payload: { name: "City of Example", dryRun: true },
    });

    expect(res.statusCode).toBe(200);
  });

  it("refuses a tenant admin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/utilities",
      headers: tenantHeaders,
      payload: { name: "City of Example" },
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.utility.create).not.toHaveBeenCalled();
  });

  // The body contract is unchanged by the move, so these carry over.
  it("refuses a name that is only whitespace", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/utilities",
      headers: platformHeaders,
      payload: { name: "   " },
    });

    expect(res.statusCode).toBe(400);
  });

  it("refuses an admin email without a name", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/utilities",
      headers: platformHeaders,
      payload: { name: "City of Example", firstAdmin: { email: "a@b.gov" } },
    });

    expect(res.statusCode).toBe(400);
  });

  it("refuses a field the schema does not name", async () => {
    // `.strict()`: Q4 is unanswered, so a profile cannot be smuggled in
    // through a field the route does not declare.
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/utilities",
      headers: platformHeaders,
      payload: { name: "City of Example", profile: "bozeman" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/platform/utilities/:id", () => {
  function mockDetail() {
    // The detail read selects the whole summary projection, not the
    // `{ id }` the suspend path's existence check does.
    (prisma.utility.findUnique as Mock).mockResolvedValue(summaryRow());
    (prisma.utilityModule.findMany as Mock).mockResolvedValue(
      MODULES.map((moduleKey) => ({ moduleKey, isEnabled: true })),
    );
    (prisma.role.findMany as Mock).mockResolvedValue([
      {
        id: "r1",
        name: "System Admin",
        description: "Everything",
        isSystem: true,
        permissions: { settings: ["VIEW"] },
        _count: { userRoles: 0 },
      },
    ]);
    (prisma.cisUser.findMany as Mock).mockResolvedValue([
      {
        id: "u1",
        email: "ops@example.gov",
        name: "Pat Admin",
        isActive: true,
        userRoles: [{ role: { name: "System Admin" } }],
      },
    ]);
    (prisma.cisUser.count as Mock).mockResolvedValue(3);
  }

  it("reports what the tenant holds", async () => {
    mockDetail();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/platform/utilities/${TENANT}`,
      headers: platformHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ name: "City of Bozeman", portalUserCount: 3 });
    expect(body.staff[0]).toMatchObject({ email: "ops@example.gov", roleName: "System Admin" });
  });

  it("refuses a tenant admin", async () => {
    mockDetail();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/platform/utilities/${TENANT}`,
      headers: tenantHeaders,
    });

    expect(res.statusCode).toBe(403);
  });

  it("answers 404 for a tenant that does not exist", async () => {
    (prisma.utility.findUnique as Mock).mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/platform/utilities/${ABSENT}`,
      headers: platformHeaders,
    });

    expect(res.statusCode).toBe(404);
  });

  it("refuses an id that is not a uuid", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/utilities/not-a-uuid",
      headers: platformHeaders,
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/v1/platform/utilities/:id/modules/:moduleKey", () => {
  function mockToggle() {
    (prisma.utility.findUnique as Mock).mockResolvedValue({ id: TENANT, status: "ACTIVE" });
    (prisma.utilityModule.upsert as Mock).mockResolvedValue({
      moduleKey: "containers",
      isEnabled: false,
    });
  }

  it("disables a module", async () => {
    mockToggle();
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/utilities/${TENANT}/modules/containers`,
      headers: platformHeaders,
      payload: { isEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ moduleKey: "containers", isEnabled: false });
  });

  it("refuses a tenant admin", async () => {
    mockToggle();
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/utilities/${TENANT}/modules/containers`,
      headers: tenantHeaders,
      payload: { isEnabled: false },
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.utilityModule.upsert).not.toHaveBeenCalled();
  });

  it("refuses a module the code does not have", async () => {
    mockToggle();
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/utilities/${TENANT}/modules/not_a_module`,
      headers: platformHeaders,
      payload: { isEnabled: true },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("UNKNOWN_MODULE");
  });

  it("refuses a body without isEnabled", async () => {
    // Otherwise "toggle" is implied, and a retried request flips it back.
    mockToggle();
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/utilities/${TENANT}/modules/containers`,
      headers: platformHeaders,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("suspend and reactivate", () => {
  it("suspends", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/platform/utilities/${TENANT}/suspend`,
      headers: platformHeaders,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("SUSPENDED");
  });

  it("reactivates", async () => {
    (prisma.utility.update as Mock).mockResolvedValue(summaryRow({ status: "ACTIVE" }));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/platform/utilities/${TENANT}/reactivate`,
      headers: platformHeaders,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ACTIVE");
  });

  it("answers 404 for a tenant that does not exist", async () => {
    // Refused rather than treated as a no-op: an operator who mistypes
    // an id has suspended nothing.
    (prisma.utility.findUnique as Mock).mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/platform/utilities/${ABSENT}/suspend`,
      headers: platformHeaders,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("UTILITY_NOT_FOUND");
  });

  it("refuses a tenant admin suspending anybody", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/platform/utilities/${TENANT}/suspend`,
      headers: tenantHeaders,
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.utility.update).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a uuid", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/utilities/not-a-uuid/suspend",
      headers: platformHeaders,
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("dev-login for the platform actor", () => {
  it("mints a token that claims the platform and names no tenant", async () => {
    // The only way to obtain a platform token in development, so the
    // console depends on it entirely.
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-login",
      payload: { email: "platform@utility.com", platform: true },
    });

    expect(res.statusCode).toBe(200);
    const { token, redirectTo } = JSON.parse(res.body);
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
    expect(claims).toMatchObject({ sub: PLATFORM_ID, platform: true });
    expect(claims.utility_id).toBeUndefined();
    // A page in the web app, not this API's route name — the two differ
    // (`/api/v1/platform/tenants` is the endpoint) and the console's page
    // is `/platform/utilities`. Sending the operator to a path the web
    // app does not serve is a 404 straight after a successful login,
    // which is what this assertion exists to stop.
    expect(redirectTo).toBe("/platform/utilities");
  });

  it("refuses a tenant user asked for as a platform login", async () => {
    // The lookup requires utility_id IS NULL, so naming a tenant user's
    // address here finds nothing rather than minting them a platform
    // token.
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-login",
      payload: { email: "test@example.com", platform: true },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("attribution", () => {
  /**
   * The services default a missing actor to the script identity, so a
   * route that forgets to pass one records the action against "script"
   * instead of the operator — an audit that is wrong rather than
   * absent, which is harder to notice. These pin it at the boundary.
   */
  it("records a suspension against the signed-in operator", async () => {
    (prisma.utility.findUnique as Mock).mockResolvedValue({ id: TENANT, status: "ACTIVE" });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: `/api/v1/platform/utilities/${TENANT}/suspend`,
      headers: platformHeaders,
      payload: {},
    });

    const audited = (prisma.auditLog.create as Mock).mock.calls.at(-1)?.[0]?.data;
    expect(audited).toMatchObject({
      entityType: "Utility",
      actorId: PLATFORM_ID,
      source: `platform:${PLATFORM_ID}`,
    });
  });

  it("records a module change against the signed-in operator", async () => {
    (prisma.utility.findUnique as Mock).mockResolvedValue({ id: TENANT, status: "ACTIVE" });
    (prisma.utilityModule.upsert as Mock).mockResolvedValue({
      id: "um-1",
      moduleKey: "containers",
      isEnabled: false,
    });
    const app = await buildApp();
    await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/utilities/${TENANT}/modules/containers`,
      headers: platformHeaders,
      payload: { isEnabled: false },
    });

    const audited = (prisma.auditLog.create as Mock).mock.calls.at(-1)?.[0]?.data;
    expect(audited).toMatchObject({
      entityType: "UtilityModule",
      actorId: PLATFORM_ID,
      source: `platform:${PLATFORM_ID}`,
    });
  });
});

describe("GET /api/v1/platform/me", () => {
  it("names the platform actor", async () => {
    // The console needs to know who it is, and /auth/me cannot serve it:
    // that route reads request.user, which a platform request leaves
    // unset, and it answers with permissions and enabled modules that
    // mean nothing for an identity with no tenant.
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/me",
      headers: platformHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).actor).toMatchObject({
      id: PLATFORM_ID,
      email: "platform@utility.com",
    });
  });

  it("refuses a tenant admin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/me",
      headers: tenantHeaders,
    });

    expect(res.statusCode).toBe(403);
  });
});
