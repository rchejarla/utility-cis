import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestToken } from "../setup.js";

/**
 * The API behind `/dev/tenants`.
 *
 * D1 says provisioning is "callable from a script, **no UI**", and the
 * build order puts a console at step 6. This exists against that, by
 * decision — and the objection it answers was never the screen but the
 * authority: before the platform actor exists, a provisioning page would
 * have to live in a tenant's own Administration section gated on a
 * tenant permission, which is the borrowing §1.6 flags with Bull Board.
 *
 * The fence is the answer, so the fence is what these tests are mostly
 * about. The routes are registered only when `!IS_PROD &&
 * ENABLE_DEV_AUTH_ENDPOINTS`, the same condition guarding
 * `/api/v1/auth/dev-login`. A tool that cannot exist in a production
 * build cannot become a tenant's route to provisioning other tenants.
 *
 * `config` reads the environment once at import, so opening the fence
 * means stubbing the variable and re-importing the module graph. That is
 * also why the closed case is the default here: it is what the suite's
 * own environment produces.
 */

const token = createTestToken();
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const utilityId = "test-utility-001";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function grant(prisma: any, permissions: Record<string, string[]>) {
  (prisma.utilityModule.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(
    Object.keys(permissions).map((moduleKey) => ({ moduleKey })),
  );
  (prisma.cisUser.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "test-user-001",
    utilityId,
    email: "test@example.com",
    name: "Test User",
    customerId: null,
    isActive: true,
  });
  (prisma.userRole.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue({
    roleId: "role-admin",
    role: { id: "role-admin", name: "Admin", permissions },
  });
}

/**
 * Builds the app with the fence in the given state, and returns the
 * prisma mock that build is actually wired to.
 *
 * `vi.resetModules()` is what lets `config` re-read the environment, and
 * it also hands the re-imported app a fresh `lib/prisma.js` mock — so a
 * mock configured on the module this file imported at the top would be a
 * different object from the one the routes call. Both come back from
 * here for that reason.
 */
async function appWithFence(open: boolean, permissions?: Record<string, string[]>) {
  vi.resetModules();
  vi.stubEnv("ENABLE_DEV_AUTH_ENDPOINTS", open ? "true" : "");
  const { prisma } = await import("../../lib/prisma.js");
  const { buildApp } = await import("../../app.js");
  grant(prisma, permissions ?? { settings: ["VIEW", "CREATE", "EDIT", "DELETE"] });
  return { app: await buildApp(), prisma };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/v1/dev/tenants with the fence closed", () => {
  it("answers 404, not 403 — a route that cannot exist should not advertise itself", async () => {
    const { app, prisma } = await appWithFence(false);
    const list = await app.inject({ method: "GET", url: "/api/v1/dev/tenants", headers });
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/dev/tenants",
      headers,
      payload: { name: "City of Example" },
    });

    expect(list.statusCode).toBe(404);
    expect(create.statusCode).toBe(404);
    expect(prisma.utility.create).not.toHaveBeenCalled();
  });
});

describe("/api/v1/dev/tenants with the fence open", () => {
  it("lists utilities", async () => {
    const { app, prisma } = await appWithFence(true);
    (prisma.utility.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = await app.inject({ method: "GET", url: "/api/v1/dev/tenants", headers });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual([]);
  });

  it("refuses a name that is only whitespace", async () => {
    const { app, prisma } = await appWithFence(true);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dev/tenants",
      headers,
      payload: { name: "   " },
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.utility.create).not.toHaveBeenCalled();
  });

  it("refuses an admin email without a name", async () => {
    const { app, prisma } = await appWithFence(true);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dev/tenants",
      headers,
      payload: { name: "City of Example", firstAdmin: { email: "a@b.gov" } },
    });

    expect(res.statusCode).toBe(400);
  });

  /**
   * Both routes require `settings:EDIT`, not VIEW. The Utility Admin
   * preset holds `settings: ["VIEW"]` — the one permission separating it
   * from System Admin — so a read gated on VIEW would let any tenant's
   * own admin enumerate every other tenant's name, id and counts. That is
   * the borrowing §1.6 flags, arriving through the route the fence was
   * written to keep it out of.
   */
  it("refuses a tenant admin holding settings VIEW only", async () => {
    const { app } = await appWithFence(true, { settings: ["VIEW"] });
    const res = await app.inject({ method: "GET", url: "/api/v1/dev/tenants", headers });

    expect(res.statusCode).toBe(403);
  });

  /**
   * The refusal carries the only explanation there is — both names, so
   * the operator can see which one was the typo. Without a `statusCode`
   * on the error, the handler's final branch answers 500 and replaces the
   * message with "An internal server error occurred".
   */
  it("surfaces a refusal as 409 carrying its code and message", async () => {
    const { app, prisma } = await appWithFence(true);
    const utilityId = "00000000-0000-4000-8000-0000000000aa";
    (prisma.utility.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: utilityId,
      name: "City of Example",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dev/tenants",
      headers,
      payload: { utilityId, name: "Typo City" },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("UTILITY_NAME_MISMATCH");
    expect(body.error.message).toContain("City of Example");
  });

  it("refuses a field the schema does not name", async () => {
    const { app, prisma } = await appWithFence(true);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dev/tenants",
      headers,
      payload: { name: "City of Example", profile: "bozeman" },
    });

    // `.strict()`: Q4 is unanswered, so a profile cannot be smuggled in
    // through a field the route does not declare.
    expect(res.statusCode).toBe(400);
  });
});
