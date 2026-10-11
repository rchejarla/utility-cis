import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Bill message CRUD. Gated on the `settings` module like the other
 * reference-data catalogues a tenant edits, not on `accounts` — a
 * message is tenant configuration, and nobody should need the authority
 * to see every account in order to edit the text printed on bills.
 */

describe("/api/v1/bill-messages", () => {
  const token = createTestToken();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const utilityId = "test-utility-001";

  // Permissions are read from userRole.findFirst, not from a role
  // embedded on cisUser — see mockAuthUser in authorization.test.ts,
  // which is the canonical shape.
  function grant(permissions: Record<string, string[]>) {
    (prisma.tenantModule.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(
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

  beforeEach(() => {
    vi.clearAllMocks();
    grant({ settings: ["VIEW", "CREATE", "EDIT", "DELETE"] });
  });

  it("lists the tenant's messages in print order", async () => {
    (prisma.billMessage.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "m-1", label: "Notice", body: "Text", priority: 10 },
    ]);

    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/bill-messages", headers });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toHaveLength(1);
  });

  it("creates a message", async () => {
    (prisma.billMessage.create as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "m-1",
      label: "Notice",
    });

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bill-messages",
      headers,
      payload: {
        label: "Notice",
        body: "Water restrictions begin June 1.",
        activeFrom: "2026-06-01",
        priority: 10,
      },
    });

    expect(res.statusCode).toBe(201);
    const createArgs = (prisma.billMessage.create as never as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(createArgs.data.utilityId).toBe(utilityId);
    expect(createArgs.data.label).toBe("Notice");
  });

  it("rejects a message with no active-from date", async () => {
    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bill-messages",
      headers,
      payload: { label: "Notice", body: "Text" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an active window that ends before it starts", async () => {
    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bill-messages",
      headers,
      payload: {
        label: "Notice",
        body: "Text",
        activeFrom: "2026-06-01",
        activeTo: "2026-05-01",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("refuses a caller without settings:EDIT", async () => {
    grant({ settings: ["VIEW"] });

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bill-messages",
      headers,
      payload: { label: "Notice", body: "Text", activeFrom: "2026-06-01" },
    });

    expect(res.statusCode).toBe(403);
  });
});
