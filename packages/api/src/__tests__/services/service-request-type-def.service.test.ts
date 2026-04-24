import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listServiceRequestTypes,
  assertServiceRequestTypeCode,
} from "../../services/service-request-type-def.service.js";
import { prisma } from "../../lib/prisma.js";

const UID = "00000000-0000-4000-8000-00000000000a";

describe("service-request-type-def service", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("listServiceRequestTypes", () => {
    it("shadow-resolves tenant rows over globals with the same code", async () => {
      (prisma.serviceRequestTypeDef.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "g1", utilityId: null, code: "LEAK_REPORT", label: "Global Leak", description: null, category: null, sortOrder: 100, isActive: true },
        { id: "t1", utilityId: UID, code: "LEAK_REPORT", label: "Tenant Leak", description: null, category: null, sortOrder: 100, isActive: true },
        { id: "g2", utilityId: null, code: "OTHER", label: "Other", description: null, category: null, sortOrder: 900, isActive: true },
      ]);

      const result = await listServiceRequestTypes(UID);
      const leak = result.find((r) => r.code === "LEAK_REPORT")!;
      expect(leak.label).toBe("Tenant Leak");
      expect(leak.isGlobal).toBe(false);
    });
  });

  describe("assertServiceRequestTypeCode", () => {
    it("throws 400 when the code is unknown", async () => {
      (prisma.serviceRequestTypeDef.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(assertServiceRequestTypeCode(UID, "BOGUS"))
        .rejects.toMatchObject({ statusCode: 400 });
    });

    it("resolves when the code exists as a global row", async () => {
      (prisma.serviceRequestTypeDef.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1" });
      await expect(assertServiceRequestTypeCode(UID, "LEAK_REPORT")).resolves.toBeUndefined();
    });
  });
});
