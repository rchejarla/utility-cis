import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Coverage for the new namespaced PATCH bodies on /api/v1/tenant-config.
 *
 * The route accepts optional `branding`, `notifications`, `retention`,
 * and `billing` blocks and merges each into settings.<namespace>
 * without touching other namespaces or existing keys (e.g.
 * numberFormats). These tests verify that behavior end-to-end via a
 * real injected request, with prisma mocked to return a canned
 * current config and capture the write args.
 */

describe("PATCH /api/v1/tenant-config — settings namespaces", () => {
  const token = createTestToken();
  const headers = { authorization: `Bearer ${token}` };
  const utilityId = "test-utility-001";

  beforeEach(() => {
    vi.clearAllMocks();

    // Grant settings:EDIT for the whole suite
    (prisma.tenantModule.findMany as any).mockResolvedValue([
      { moduleKey: "settings" },
    ]);
    (prisma.cisUser.findFirst as any).mockResolvedValue({
      id: "test-user-001",
      utilityId,
      roleId: "role-admin",
      isActive: true,
      role: {
        name: "Admin",
        permissions: { settings: ["VIEW", "CREATE", "EDIT", "DELETE"] },
      },
    });
  });

  async function inject(body: object, currentSettings: Record<string, unknown> = {}) {
    (prisma.tenantConfig.findUnique as any).mockResolvedValue({
      id: "tc1",
      utilityId,
      requireHoldApproval: false,
      settings: currentSettings,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (prisma.tenantConfig.upsert as any).mockImplementation(async (args: any) => ({
      id: "tc1",
      utilityId,
      requireHoldApproval: args.update.requireHoldApproval ?? false,
      settings: args.update.settings ?? currentSettings,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const app = await createTestApp();
    return app.inject({
      method: "PATCH",
      url: "/api/v1/tenant-config",
      headers: { ...headers, "content-type": "application/json" },
      payload: body,
    });
  }

  it("merges a branding patch into settings.branding without touching other keys", async () => {
    const res = await inject(
      { branding: { logoUrl: "https://cdn.example.com/logo.png" } },
      { numberFormats: { account: { template: "ACC-{seq:5}", startAt: 1 } } },
    );
    expect(res.statusCode).toBe(200);
    const upsertCall = (prisma.tenantConfig.upsert as any).mock.calls[0][0];
    expect(upsertCall.update.settings.branding).toEqual({
      logoUrl: "https://cdn.example.com/logo.png",
    });
    expect(upsertCall.update.settings.numberFormats).toBeDefined();
  });

  it("merges multiple namespaces in a single patch", async () => {
    const res = await inject({
      branding: { logoUrl: "https://cdn.example.com/logo.png" },
      notifications: { senderEmail: "bills@example.com", dailyDigestEnabled: true },
      retention: { auditRetentionDays: 2555 },
      billing: { sandbox: false, pollMinutes: 10 },
    });
    expect(res.statusCode).toBe(200);
    const s = (prisma.tenantConfig.upsert as any).mock.calls[0][0].update.settings;
    expect(s.branding.logoUrl).toBe("https://cdn.example.com/logo.png");
    expect(s.notifications.senderEmail).toBe("bills@example.com");
    expect(s.notifications.dailyDigestEnabled).toBe(true);
    expect(s.retention.auditRetentionDays).toBe(2555);
    expect(s.billing.sandbox).toBe(false);
    expect(s.billing.pollMinutes).toBe(10);
  });

  it("deep-merges within a namespace so a partial patch preserves other fields", async () => {
    const res = await inject(
      { billing: { pollMinutes: 30 } },
      {
        billing: {
          saaslogicBaseUrl: "https://api.saaslogic.io/v1",
          sandbox: false,
          pollMinutes: 5,
        },
      },
    );
    expect(res.statusCode).toBe(200);
    const s = (prisma.tenantConfig.upsert as any).mock.calls[0][0].update.settings;
    expect(s.billing).toEqual({
      saaslogicBaseUrl: "https://api.saaslogic.io/v1",
      sandbox: false,
      pollMinutes: 30,
    });
  });

  it("rejects an invalid retention value", async () => {
    const res = await inject({ retention: { auditRetentionDays: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid email in notifications", async () => {
    const res = await inject({ notifications: { senderEmail: "not-an-email" } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed URL in branding", async () => {
    const res = await inject({ branding: { logoUrl: "not-a-url" } });
    expect(res.statusCode).toBe(400);
  });
});
