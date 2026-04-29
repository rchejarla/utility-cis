import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestApp, createTestToken } from "../setup.js";

// Mock Redis so RBAC service doesn't need a real Redis connection
vi.mock("../../lib/cache-redis.js", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
  },
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

// Mock prisma with RBAC-specific methods added on top of the global vitest.setup.ts mock.
// NOTE: rbac.service.ts uses findFirst (not findUnique) to always scope queries by
// utilityId, so the mock must expose findFirst.
vi.mock("../../lib/prisma.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/prisma.js")>();
  return {
    ...original,
    prisma: {
      ...(original as any).prisma,
      cisUser: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
      },
      userRole: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        upsert: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
      },
      cisRole: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
      },
      tenantModule: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    },
    setTenantContext: vi.fn().mockResolvedValue(undefined),
    withTenant: vi.fn((_utilityId: string, fn: any) => fn({})),
  };
});

// Import prisma after mocking so we get the mock
import { prisma } from "../../lib/prisma.js";

/**
 * Helper to set up the auth-related prisma mocks for a single test
 * scenario. After Slice 1, role assignments live on the user_role
 * table (not cis_user.role_id), so we mock both: cis_user holds the
 * user identity row, user_role holds the (user, role) assignment.
 */
function mockAuthUser(opts: {
  isActive?: boolean;
  cisUser?: Record<string, unknown> | null;
  role?: { id: string; name: string; permissions: Record<string, string[]> } | null;
}) {
  const isActive = opts.isActive ?? true;
  const cisUser =
    opts.cisUser === null
      ? null
      : {
          id: "test-user-001",
          utilityId: "test-utility-001",
          email: "test@example.com",
          name: "Test User",
          customerId: null,
          isActive,
          ...opts.cisUser,
        };
  (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(cisUser);
  (prisma.userRole.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
    opts.role ? { roleId: opts.role.id, role: opts.role } : null,
  );
}

describe("Authorization middleware", () => {
  const validToken = createTestToken();
  const authHeader = { authorization: `Bearer ${validToken}` };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no tenant modules enabled, no CIS user found
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  // Test 1: Route without module declaration is allowed
  it("allows GET /health without auth token (no module declared, no auth)", async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });

  // Test 2: Route with valid token and module enabled — authorization middleware passes through
  it("allows authenticated request when module is enabled and user has permission", async () => {
    const app = await createTestApp();

    // Enable the commodities module for tenant
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: "commodities" },
    ]);

    // Admin user with full commodities permission
    mockAuthUser({
      role: {
        id: "role-admin",
        name: "Admin",
        permissions: { commodities: ["VIEW", "CREATE", "EDIT", "DELETE"] },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/commodities",
      headers: authHeader,
    });

    // Should NOT be 401 (auth) or 403 (authorization) — authorization middleware passes
    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).not.toBe(403);
  });

  // Test 3: User has no CIS User record → allowed (backwards compatibility)
  it("allows request when user has no CIS User record in DB (backwards compatibility)", async () => {
    const app = await createTestApp();

    // Module is enabled for the tenant
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: "customers" },
    ]);

    // No CIS user found — findUnique returns null
    (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Hit a route that would have module enforcement (customers:VIEW)
    // Even with module enabled but no user record, middleware allows (BR-RB-007 compatibility)
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/customers",
      headers: authHeader,
    });

    // Not blocked by authorization (403) — may get 200 or 500 from DB mock
    expect(response.statusCode).not.toBe(403);
  });

  // Test 4: GET /api/v1/auth/me returns user, permissions, and enabledModules
  it("GET /api/v1/auth/me returns user info, permissions, and enabledModules", async () => {
    const app = await createTestApp();

    mockAuthUser({
      role: {
        id: "role-001",
        name: "Admin",
        permissions: {
          customers: ["VIEW", "CREATE", "EDIT", "DELETE"],
          premises: ["VIEW", "CREATE"],
        },
      },
    });
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: "customers" },
      { moduleKey: "premises" },
      { moduleKey: "meters" },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body).toHaveProperty("user");
    expect(body).toHaveProperty("permissions");
    expect(body).toHaveProperty("enabledModules");

    expect(body.user.email).toBe("test@example.com");
    expect(body.user.roleName).toBe("Admin");

    expect(body.permissions).toMatchObject({
      customers: expect.arrayContaining(["VIEW", "CREATE", "EDIT", "DELETE"]),
      premises: expect.arrayContaining(["VIEW", "CREATE"]),
    });

    expect(body.enabledModules).toContain("customers");
    expect(body.enabledModules).toContain("premises");
    expect(body.enabledModules).toContain("meters");
  });

  // Test 5: Inactive user is rejected with 403 USER_INACTIVE
  it("rejects inactive user (is_active=false) with 403 USER_INACTIVE (BR-RB-009)", async () => {
    const app = await createTestApp();

    mockAuthUser({
      isActive: false,
      role: {
        id: "role-001",
        name: "CSR",
        permissions: { customers: ["VIEW"] },
      },
    });
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: "customers" },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/customers",
      headers: authHeader,
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("USER_INACTIVE");
  });

  // Test 6: User lacks required permission → 403 FORBIDDEN
  it("rejects user without required module permission with 403 FORBIDDEN", async () => {
    const app = await createTestApp();

    mockAuthUser({
      role: {
        id: "role-readonly",
        name: "Read-Only",
        permissions: { customers: ["VIEW"] }, // no CREATE
      },
    });
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: "customers" },
    ]);

    // POST /customers requires customers:CREATE
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: authHeader,
      payload: {
        customerType: "INDIVIDUAL",
        firstName: "Jane",
        lastName: "Doe",
        status: "ACTIVE",
      },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  // Test 7: Module is disabled for tenant → 403 MODULE_DISABLED
  it("rejects request when module is disabled for tenant with 403 MODULE_DISABLED", async () => {
    const app = await createTestApp();

    mockAuthUser({
      role: {
        id: "role-admin",
        name: "Admin",
        permissions: { customers: ["VIEW", "CREATE", "EDIT", "DELETE"] },
      },
    });
    // Customers module NOT in enabled modules list
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: "premises" }, // only premises enabled, not customers
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/customers",
      headers: authHeader,
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("MODULE_DISABLED");
  });

  // Test 8: GET /api/v1/auth/me with no CIS user returns empty permissions
  it("GET /api/v1/auth/me with no CIS user record returns empty permissions and modules", async () => {
    const app = await createTestApp();

    // No CIS user and no modules
    (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.permissions).toEqual({});
    expect(body.enabledModules).toEqual([]);
    expect(body.user.roleId).toBeNull();
  });
});
