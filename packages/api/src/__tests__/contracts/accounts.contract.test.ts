import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";
import { accountCreate } from "./web-payloads.js";

/**
 * Catches the specific class of bug fixed on 2026-04-09 in accounts/new/page.tsx
 * where the UI was sending accountType values ("GOVERNMENT", "OTHER") and credit
 * ratings ("AAA", "AA", ...) that the API's shared validator has never accepted.
 */
describe("Contract: accounts ← web", () => {
  const token = createTestToken();
  const headers = { authorization: `Bearer ${token}` };

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: "accounts" },
    ]);
    (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "test-user-001",
      utilityId: "test-utility-001",
      isActive: true,
      customerId: null,
    });
    // Tenant-wide user_role assignment now lives in user_role, not on
    // the cis_user row itself. Mock the lookup the new getUserRole
    // does to keep these contract tests realistic.
    (prisma.userRole.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      roleId: "role-admin",
      role: {
        name: "Admin",
        permissions: { accounts: ["VIEW", "CREATE", "EDIT", "DELETE"] },
      },
    });
    (prisma.account.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "acct-1",
    });
  });

  it("accepts the payload from accounts/new page (post enum-alignment fix)", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers,
      payload: accountCreate(),
    });
    if (response.statusCode === 400) {
      // eslint-disable-next-line no-console
      console.error("[contract] account create rejected:", response.body);
    }
    expect(response.statusCode).not.toBe(400);
  });
});
