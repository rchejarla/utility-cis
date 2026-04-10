import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Smoke-test that every top-level route is registered and reachable.
 *
 * The previous implementation asserted substrings of Fastify's radix-tree
 * `printRoutes()` output, which compresses shared prefixes in ways that
 * change whenever a sibling route is added (e.g. "customers" gets split
 * into "cu" + "stomers" once a second "cu*" route appears). That made the
 * test fragile and uninformative.
 *
 * This version injects a real HTTP request to each known path and asserts
 * the response is NOT 404 — it may be 200, 400 (validation), 403 (authz),
 * or 500 (unmocked DB), all of which prove the route is registered.
 */

const EXPECTED_ROUTES: Array<{ method: "GET" | "POST"; path: string }> = [
  { method: "GET", path: "/api/v1/commodities" },
  { method: "GET", path: "/api/v1/uom" },
  { method: "GET", path: "/api/v1/premises" },
  { method: "GET", path: "/api/v1/meters" },
  { method: "GET", path: "/api/v1/accounts" },
  { method: "GET", path: "/api/v1/customers" },
  { method: "GET", path: "/api/v1/contacts?accountId=11111111-1111-4111-8111-111111111111" },
  { method: "GET", path: "/api/v1/billing-addresses?accountId=11111111-1111-4111-8111-111111111111" },
  { method: "GET", path: "/api/v1/billing-cycles" },
  { method: "GET", path: "/api/v1/service-agreements" },
  { method: "GET", path: "/api/v1/rate-schedules" },
  { method: "GET", path: "/api/v1/theme" },
  { method: "GET", path: "/api/v1/audit-log" },
  { method: "GET", path: "/api/v1/users" },
  { method: "GET", path: "/api/v1/roles" },
  { method: "GET", path: "/api/v1/attachments?entityType=Premise&entityId=11111111-1111-4111-8111-111111111111" },
  { method: "GET", path: "/api/v1/auth/me" },
];

describe("Route registration", () => {
  const token = createTestToken();
  const headers = { authorization: `Bearer ${token}` };

  beforeEach(() => {
    vi.clearAllMocks();
    // Enable every module + grant full admin permissions so authorization
    // doesn't 403 before the route handler is reached.
    const ALL_MODULES = [
      "customers",
      "premises",
      "meters",
      "accounts",
      "agreements",
      "commodities",
      "rate_schedules",
      "billing_cycles",
      "attachments",
      "audit_log",
      "settings",
      "theme",
    ];
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      ALL_MODULES.map((moduleKey) => ({ moduleKey }))
    );
    (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "test-user-001",
      utilityId: "test-utility-001",
      roleId: "role-admin",
      isActive: true,
      role: {
        name: "Admin",
        permissions: Object.fromEntries(
          ALL_MODULES.map((m) => [m, ["VIEW", "CREATE", "EDIT", "DELETE"]])
        ),
      },
    });
  });

  it("health route returns 200", async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });

  it("returns 401 for unknown routes under /api/v1 without auth", async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/nonexistent" });
    expect(response.statusCode).toBe(401);
  });

  it("serves the OpenAPI document at /api/v1/openapi.json without auth", async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.openapi).toBe("3.1.0");
    expect(body.paths).toHaveProperty("/api/v1/accounts");
    expect(body.components.schemas).toHaveProperty("CreateAccount");
  });

  for (const { method, path } of EXPECTED_ROUTES) {
    it(`${method} ${path.split("?")[0]} is registered`, async () => {
      const app = await createTestApp();
      const response = await app.inject({ method, url: path, headers });
      // 404 = route not registered. Anything else means the route exists
      // and was reachable through the middleware stack.
      expect(response.statusCode).not.toBe(404);
    });
  }
});
