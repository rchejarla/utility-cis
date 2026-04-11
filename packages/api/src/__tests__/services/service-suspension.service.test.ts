import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock audit-wrap to pass-through so we don't need the domain event
// emitter to be configured for these unit tests. The actual audit
// behaviour is covered by audit-wrap.test.ts.
vi.mock("../../lib/audit-wrap.js", () => ({
  auditCreate: vi.fn(async (_ctx: unknown, _evt: unknown, fn: () => unknown) => fn()),
  auditUpdate: vi.fn(async (_ctx: unknown, _evt: unknown, _before: unknown, fn: () => unknown) => fn()),
}));

// Mock the tenant-config service so we can toggle requireHoldApproval
// per-test without touching a real DB.
const getTenantConfigMock = vi.fn();
vi.mock("../../services/tenant-config.service.js", () => ({
  getTenantConfig: (utilityId: string) => getTenantConfigMock(utilityId),
}));

// Mock the reference-table assertion so createSuspension can be tested
// independently of the suspension-type-def service.
const assertSuspensionTypeCodeMock = vi.fn();
vi.mock("../../services/suspension-type-def.service.js", () => ({
  assertSuspensionTypeCode: (utilityId: string, code: string) =>
    assertSuspensionTypeCodeMock(utilityId, code),
}));

import {
  approveSuspension,
  activateSuspension,
  cancelSuspension,
  completeSuspension,
  transitionSuspensions,
} from "../../services/service-suspension.service.js";
import { prisma } from "../../lib/prisma.js";

const UID = "00000000-0000-4000-8000-00000000000a";
const ACTOR = "00000000-0000-4000-8000-00000000000b";

function hold(partial: Partial<{
  id: string;
  status: "PENDING" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  approvedBy: string | null;
  startDate: Date;
  endDate: Date | null;
  suspensionType: string;
}> = {}) {
  return {
    id: partial.id ?? "hold-1",
    utilityId: UID,
    serviceAgreementId: "sa-1",
    suspensionType: partial.suspensionType ?? "VACATION_HOLD",
    status: partial.status ?? "PENDING",
    startDate: partial.startDate ?? new Date("2026-01-01"),
    endDate: partial.endDate === undefined ? null : partial.endDate,
    billingSuspended: true,
    prorateOnStart: true,
    prorateOnEnd: true,
    reason: null,
    requestedBy: ACTOR,
    approvedBy: partial.approvedBy ?? null,
    ramsNotified: false,
    ramsNotifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("service-suspension lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTenantConfigMock.mockResolvedValue({
      utilityId: UID,
      requireHoldApproval: false,
      settings: {},
    });
  });

  describe("approveSuspension", () => {
    it("stamps approvedBy when the hold is PENDING and not yet approved", async () => {
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "PENDING", approvedBy: null }),
      );
      (prisma.serviceSuspension.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...hold({ status: "PENDING" }),
        approvedBy: ACTOR,
      });

      await approveSuspension(UID, ACTOR, "Tester", "hold-1");

      const updateCall = (prisma.serviceSuspension.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(updateCall.data).toEqual({ approvedBy: ACTOR });
    });

    it("refuses to approve a hold that is not PENDING", async () => {
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "ACTIVE" }),
      );

      await expect(
        approveSuspension(UID, ACTOR, "Tester", "hold-1"),
      ).rejects.toMatchObject({ statusCode: 400, code: "HOLD_NOT_PENDING" });
    });

    it("refuses to double-approve an already-approved hold", async () => {
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "PENDING", approvedBy: "someone-else" }),
      );

      await expect(
        approveSuspension(UID, ACTOR, "Tester", "hold-1"),
      ).rejects.toMatchObject({ statusCode: 400, code: "HOLD_ALREADY_APPROVED" });
    });
  });

  describe("activateSuspension", () => {
    it("transitions a PENDING hold to ACTIVE when no approval is required", async () => {
      getTenantConfigMock.mockResolvedValue({
        utilityId: UID,
        requireHoldApproval: false,
        settings: {},
      });
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "PENDING" }),
      );
      (prisma.serviceSuspension.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...hold({ status: "ACTIVE" }),
      });

      await activateSuspension(UID, ACTOR, "Tester", "hold-1");

      const updateCall = (prisma.serviceSuspension.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(updateCall.data).toEqual({ status: "ACTIVE" });
    });

    it("refuses when tenant requires approval and the hold is not approved", async () => {
      getTenantConfigMock.mockResolvedValue({
        utilityId: UID,
        requireHoldApproval: true,
        settings: {},
      });
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "PENDING", approvedBy: null }),
      );

      await expect(
        activateSuspension(UID, ACTOR, "Tester", "hold-1"),
      ).rejects.toMatchObject({ statusCode: 400, code: "HOLD_NOT_ACTIVATABLE" });
    });

    it("allows activation when approval is required and the hold is approved", async () => {
      getTenantConfigMock.mockResolvedValue({
        utilityId: UID,
        requireHoldApproval: true,
        settings: {},
      });
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "PENDING", approvedBy: ACTOR }),
      );
      (prisma.serviceSuspension.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...hold({ status: "ACTIVE" }),
      });

      await expect(
        activateSuspension(UID, ACTOR, "Tester", "hold-1"),
      ).resolves.toBeDefined();
    });

    it("refuses to activate a non-PENDING hold", async () => {
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "COMPLETED" }),
      );

      await expect(
        activateSuspension(UID, ACTOR, "Tester", "hold-1"),
      ).rejects.toMatchObject({ statusCode: 400, code: "HOLD_NOT_ACTIVATABLE" });
    });
  });

  describe("cancelSuspension", () => {
    it("cancels a PENDING hold", async () => {
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "PENDING" }),
      );
      (prisma.serviceSuspension.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...hold({ status: "CANCELLED" }),
      });

      await cancelSuspension(UID, ACTOR, "Tester", "hold-1");

      const updateCall = (prisma.serviceSuspension.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(updateCall.data).toEqual({ status: "CANCELLED" });
    });

    it("cancels an ACTIVE hold", async () => {
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "ACTIVE" }),
      );
      (prisma.serviceSuspension.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...hold({ status: "CANCELLED" }),
      });

      await expect(
        cancelSuspension(UID, ACTOR, "Tester", "hold-1"),
      ).resolves.toBeDefined();
    });

    it("refuses to cancel a COMPLETED hold", async () => {
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "COMPLETED" }),
      );

      await expect(
        cancelSuspension(UID, ACTOR, "Tester", "hold-1"),
      ).rejects.toMatchObject({ statusCode: 400, code: "HOLD_COMPLETED" });
    });

    it("refuses to cancel an already-CANCELLED hold", async () => {
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "CANCELLED" }),
      );

      await expect(
        cancelSuspension(UID, ACTOR, "Tester", "hold-1"),
      ).rejects.toMatchObject({ statusCode: 400, code: "HOLD_ALREADY_CANCELLED" });
    });
  });

  describe("completeSuspension", () => {
    it("refuses to complete a COMPLETED hold", async () => {
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "COMPLETED" }),
      );

      await expect(
        completeSuspension(UID, ACTOR, "Tester", "hold-1"),
      ).rejects.toMatchObject({ statusCode: 400, code: "HOLD_ALREADY_COMPLETED" });
    });

    it("refuses to complete a CANCELLED hold", async () => {
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "CANCELLED" }),
      );

      await expect(
        completeSuspension(UID, ACTOR, "Tester", "hold-1"),
      ).rejects.toMatchObject({ statusCode: 400, code: "HOLD_CANCELLED" });
    });

    it("backfills endDate to today when the hold is open-ended", async () => {
      (prisma.serviceSuspension.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
        hold({ status: "ACTIVE", endDate: null }),
      );
      (prisma.serviceSuspension.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...hold({ status: "COMPLETED", endDate: new Date() }),
      });

      await completeSuspension(UID, ACTOR, "Tester", "hold-1");

      const updateCall = (prisma.serviceSuspension.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(updateCall.data.status).toBe("COMPLETED");
      expect(updateCall.data.endDate).toBeInstanceOf(Date);
    });
  });

  describe("transitionSuspensions", () => {
    const now = new Date("2026-06-15T12:00:00Z");

    it("auto-activates PENDING holds whose start date has passed (no approval gate)", async () => {
      getTenantConfigMock.mockResolvedValue({
        utilityId: UID,
        requireHoldApproval: false,
        settings: {},
      });
      (prisma.serviceSuspension.updateMany as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ count: 3 }) // PENDING → ACTIVE
        .mockResolvedValueOnce({ count: 1 }); // ACTIVE → COMPLETED

      const result = await transitionSuspensions(UID, now);

      expect(result).toEqual({ activated: 3, completed: 1 });
      // First call should be the PENDING→ACTIVE updateMany.
      const firstCall = (prisma.serviceSuspension.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(firstCall.where.status).toBe("PENDING");
      expect(firstCall.where.startDate.lte).toEqual(now);
      // No approval gate means the query doesn't filter by approvedBy.
      expect(firstCall.where.approvedBy).toBeUndefined();
      expect(firstCall.data).toEqual({ status: "ACTIVE" });
    });

    it("respects the approval gate when the tenant requires approval", async () => {
      getTenantConfigMock.mockResolvedValue({
        utilityId: UID,
        requireHoldApproval: true,
        settings: {},
      });
      (prisma.serviceSuspension.updateMany as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ count: 2 })
        .mockResolvedValueOnce({ count: 0 });

      await transitionSuspensions(UID, now);

      const firstCall = (prisma.serviceSuspension.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Approval gate adds a filter: only approved holds roll forward.
      expect(firstCall.where.approvedBy).toEqual({ not: null });
    });

    it("skips open-ended ACTIVE holds on completion", async () => {
      (prisma.serviceSuspension.updateMany as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 2 });

      await transitionSuspensions(UID, now);

      const completeCall = (prisma.serviceSuspension.updateMany as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(completeCall.where.status).toBe("ACTIVE");
      // endDate must be non-null and ≤ now — that's how open-ended
      // holds (endDate IS NULL) are preserved from auto-completion.
      expect(completeCall.where.endDate).toEqual({ not: null, lte: now });
      expect(completeCall.data).toEqual({ status: "COMPLETED" });
    });

    it("is scoped to a single utility", async () => {
      (prisma.serviceSuspension.updateMany as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 });

      await transitionSuspensions(UID, now);

      const activateCall = (prisma.serviceSuspension.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const completeCall = (prisma.serviceSuspension.updateMany as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(activateCall.where.utilityId).toBe(UID);
      expect(completeCall.where.utilityId).toBe(UID);
    });
  });
});
