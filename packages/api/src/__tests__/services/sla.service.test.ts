import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/audit-wrap.js", () => ({
  auditCreate: vi.fn(async (_ctx, _evt, fn) => fn()),
  auditUpdate: vi.fn(async (_ctx, _evt, _before, fn) => fn()),
}));

import { createSla, resolveSlaForRequest } from "../../services/sla.service.js";
import { prisma } from "../../lib/prisma.js";

const UID = "00000000-0000-4000-8000-00000000000a";
const ACTOR = "00000000-0000-4000-8000-00000000000b";

describe("sla service", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("createSla", () => {
    it("creates with response + resolution hours", async () => {
      (prisma.sla.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "s1", utilityId: UID, requestType: "LEAK_REPORT", priority: "HIGH",
        responseHours: "2", resolutionHours: "12", escalationHours: null,
        escalationUserId: null, isActive: true,
      });
      const result = await createSla(UID, ACTOR, "Jane", {
        requestType: "LEAK_REPORT",
        priority: "HIGH",
        responseHours: 2,
        resolutionHours: 12,
      });
      expect(result.requestType).toBe("LEAK_REPORT");
      expect(result.responseHours).toBe(2);
    });
  });

  describe("resolveSlaForRequest", () => {
    it("returns the matching active SLA", async () => {
      (prisma.sla.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "s1", responseHours: "2", resolutionHours: "12",
      });
      const sla = await resolveSlaForRequest(UID, "LEAK_REPORT", "HIGH");
      expect(sla?.id).toBe("s1");
    });

    it("returns null when no SLA matches", async () => {
      (prisma.sla.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const sla = await resolveSlaForRequest(UID, "BILLING_DISPUTE", "LOW");
      expect(sla).toBeNull();
    });
  });
});
