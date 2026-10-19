import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { createTestToken, createPlatformToken } from "../setup.js";

/**
 * Platform routes, and the two refusals that keep the kinds apart.
 *
 * A route declares `{ platform: true }` instead of a module and a
 * permission, because being the platform actor *is* the authority —
 * there is no platform permission matrix until a second class of
 * platform actor exists to need one (D6 sizes this actor by what cannot
 * live anywhere else).
 *
 * The two refusals matter as much as the admission. `request.user` is
 * undefined on a platform request and `request.platformActor` is
 * undefined on a tenant one, so a missing check is a crash or a bypass
 * rather than a 403 — which is also what lets `request.user` keep its
 * non-nullable `utilityId` at all 243 of its read sites.
 *
 * Through `app.inject` with probe routes, so the real hook chain runs:
 * authMiddleware, then tenantMiddleware, then authorizationMiddleware.
 * That ordering is load-bearing and is why one of these tests exists —
 * tenantMiddleware refuses a request with no tenant, which a platform
 * request is by definition.
 */

const PLATFORM_ID = "test-platform-001";
const TENANT = "test-utility-001";

const platformHeaders = { authorization: `Bearer ${createPlatformToken({ sub: PLATFORM_ID })}` };
const headers = { authorization: `Bearer ${createTestToken()}` };

let platformRow: { id: string; email: string; name: string } | null;

/**
 * One `cisUser.findFirst` serves both `getPlatformActor` and
 * `getUserRole`, so the mock branches on the predicate — which also
 * pins it: if `getPlatformActor` stopped asking for `utilityId: null`,
 * it would fall through to the tenant row and the "a tenant user's id in
 * a platform token" test below would admit it.
 */
function mockPrisma(permissions: Record<string, string[]>) {
  (prisma.cisUser.findFirst as Mock).mockImplementation((args: { where: Record<string, unknown> }) => {
    const where = args?.where ?? {};
    if (where.utilityId === null) {
      // Behave like the scoped query this stands in for: honour every
      // predicate, not just the one being pinned. An earlier version
      // ignored `where.id` and so returned the platform row for any
      // subject at all, which made a tenant user's id in a platform
      // token look admissible — the mock lying rather than the code
      // being wrong. A real-database case covers this in Task 6.
      if (where.isActive !== true) return Promise.resolve(null);
      if (!platformRow || where.id !== platformRow.id) return Promise.resolve(null);
      return Promise.resolve(platformRow);
    }
    return Promise.resolve({
      id: "test-user-001",
      utilityId: TENANT,
      email: "test@example.com",
      name: "Test User",
      customerId: null,
      isActive: true,
    });
  });
  (prisma.utilityModule.findMany as Mock).mockResolvedValue(
    Object.keys(permissions).map((moduleKey) => ({ moduleKey })),
  );
  (prisma.userRole.findFirst as Mock).mockResolvedValue({
    roleId: "role-admin",
    role: { id: "role-admin", name: "System Admin", permissions },
  });
}

async function appWithProbes() {
  const app = await buildApp();
  app.get("/__platform", { config: { platform: true } }, async () => ({ ok: "platform" }));
  app.get(
    "/__tenant",
    { config: { module: "settings", permission: "VIEW" } },
    async () => ({ ok: "tenant" }),
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  platformRow = { id: PLATFORM_ID, email: "platform@example.com", name: "Platform Operator" };
  mockPrisma({ settings: ["VIEW", "CREATE", "EDIT", "DELETE"] });
});

describe("a platform route", () => {
  it("admits the platform actor", async () => {
    const app = await appWithProbes();
    const res = await app.inject({ method: "GET", url: "/__platform", headers: platformHeaders });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: "platform" });
  });

  it("refuses a tenant admin, System Admin included", async () => {
    // §1.2: System Admin is a tenant role. Holding every permission a
    // tenant can grant is not the same authority as being above tenants.
    const app = await appWithProbes();
    const res = await app.inject({ method: "GET", url: "/__platform", headers });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("PLATFORM_REQUIRED");
  });

  it("refuses a platform token whose user row is gone", async () => {
    // The token outlives the row. This must not fall through to the
    // "no CisUser row ⇒ allow" branch the tenant path still carries.
    platformRow = null;
    const app = await appWithProbes();
    const res = await app.inject({ method: "GET", url: "/__platform", headers: platformHeaders });

    expect(res.statusCode).toBe(403);
  });

  it("refuses a platform token naming a user that belongs to a tenant", async () => {
    // A tenant user's id minted into a platform-claiming token. The
    // claim selects the lookup; the lookup requires utility_id IS NULL,
    // so the claim alone is not authority.
    const app = await appWithProbes();
    const res = await app.inject({
      method: "GET",
      url: "/__platform",
      headers: { authorization: `Bearer ${createPlatformToken({ sub: "test-user-001" })}` },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("a tenant route", () => {
  it("refuses the platform actor", async () => {
    // request.user is undefined here. Without this check the handler
    // would read user.utilityId off undefined and 500 instead.
    const app = await appWithProbes();
    const res = await app.inject({ method: "GET", url: "/__tenant", headers: platformHeaders });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("TENANT_CONTEXT_REQUIRED");
  });

  it("still admits a tenant user", async () => {
    const app = await appWithProbes();
    const res = await app.inject({ method: "GET", url: "/__tenant", headers });

    expect(res.statusCode).toBe(200);
  });
});

describe("the hook chain", () => {
  it("does not let tenantMiddleware refuse a platform request first", async () => {
    // tenantMiddleware sends 400 "No utility context available" when
    // request.user.utilityId is absent, and it runs before
    // authorization. A platform request has no tenant by definition, so
    // without an exemption every platform route answers 400 and the
    // authorization branch below is unreachable.
    const app = await appWithProbes();
    const res = await app.inject({ method: "GET", url: "/__platform", headers: platformHeaders });

    expect(res.statusCode).not.toBe(400);
  });
});
