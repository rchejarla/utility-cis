import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";
import {
  customerCreateIndividual,
  customerCreateOrganization,
} from "./web-payloads.js";

describe("Contract: customers ← web", () => {
  const token = createTestToken();
  const headers = { authorization: `Bearer ${token}` };

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: "customers" },
    ]);
    (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "test-user-001",
      utilityId: "test-utility-001",
      roleId: "role-admin",
      isActive: true,
      role: {
        name: "Admin",
        permissions: { customers: ["VIEW", "CREATE", "EDIT", "DELETE"] },
      },
    });
    (prisma.customer.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "cust-1",
    });
  });

  it("accepts the INDIVIDUAL payload from customers/new page", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers,
      payload: customerCreateIndividual(),
    });
    // 201 = passed Zod + service; 400 = Zod rejected (CONTRACT BROKEN)
    if (response.statusCode === 400) {
      // eslint-disable-next-line no-console
      console.error("[contract] INDIVIDUAL rejected:", response.body);
    }
    expect(response.statusCode).not.toBe(400);
  });

  it("accepts the ORGANIZATION payload from customers/new page", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers,
      payload: customerCreateOrganization(),
    });
    if (response.statusCode === 400) {
      // eslint-disable-next-line no-console
      console.error("[contract] ORGANIZATION rejected:", response.body);
    }
    expect(response.statusCode).not.toBe(400);
  });
});
