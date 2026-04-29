import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Attachments route contract tests.
 *
 * These exist specifically to catch regressions like the one on 2026-04-09,
 * where the API validator was tightened to a lowercase entityType enum while
 * the web app sends PascalCase ("Premise", "Customer", ...). The earlier
 * suite had no attachments coverage, so the regression shipped silently.
 *
 * Every casing the web actually sends MUST be accepted by the API.
 */

const PASCAL_CASE_ENTITY_TYPES = [
  "Customer",
  "Account",
  "Premise",
  "Meter",
  "ServiceAgreement",
  "RateSchedule",
  "BillingCycle",
] as const;

describe("GET /api/v1/attachments", () => {
  const token = createTestToken();
  const headers = { authorization: `Bearer ${token}` };

  beforeEach(() => {
    vi.clearAllMocks();
    // Module must be enabled or the authorization middleware returns 403
    // before Zod validation runs.
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: "attachments" },
    ]);
    // Give the test user a role with attachments:VIEW so authz passes.
    (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "test-user-001",
      utilityId: "test-utility-001",
      isActive: true,
      customerId: null,
    });
    (prisma.userRole.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      roleId: "role-test",
      role: {
        name: "Admin",
        permissions: { attachments: ["VIEW", "CREATE", "EDIT", "DELETE"] },
      },
    });
    (prisma.attachment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  for (const entityType of PASCAL_CASE_ENTITY_TYPES) {
    it(`accepts entityType="${entityType}" (the casing the web app sends)`, async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/attachments?entityType=${entityType}&entityId=11111111-1111-4111-8111-111111111111`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
    });
  }

  it("rejects an unknown entityType with 400 VALIDATION_ERROR", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/attachments?entityType=Unknown&entityId=11111111-1111-4111-8111-111111111111",
      headers,
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-UUID entityId with 400 VALIDATION_ERROR", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/attachments?entityType=Premise&entityId=not-a-uuid",
      headers,
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects missing entityType/entityId with 400", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/attachments",
      headers,
    });
    expect(response.statusCode).toBe(400);
  });
});
