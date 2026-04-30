import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass-through audit-wrap so the service code's writeAuditRow calls
// land on the (mocked) prisma directly. Real audit-row emission is
// covered by audit-wrap.integration.test.ts.
vi.mock("../../lib/audit-wrap.js", () => ({
  writeAuditRow: vi.fn(async () => undefined),
}));

import {
  closeServiceAgreement,
  removeMeterFromAgreement,
  swapMeter,
} from "../../services/effective-dating.service.js";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";

const UID = "00000000-0000-4000-8000-00000000000a";
const ACTOR = "00000000-0000-4000-8000-00000000000b";
const SA_ID = "00000000-0000-4000-8000-00000000aa01";
const SP_ID = "00000000-0000-4000-8000-00000000bb01";

function sa(partial: Partial<{
  id: string;
  status: "PENDING" | "ACTIVE" | "FINAL" | "CLOSED";
  startDate: Date;
  endDate: Date | null;
}> = {}) {
  return {
    id: partial.id ?? SA_ID,
    utilityId: UID,
    accountId: "acct-1",
    premiseId: "prem-1",
    commodityId: "comm-1",
    status: partial.status ?? "ACTIVE",
    startDate: partial.startDate ?? new Date("2024-01-01"),
    endDate: partial.endDate === undefined ? null : partial.endDate,
    agreementNumber: "SA-0001",
  };
}

function spm(partial: Partial<{ id: string; meterId: string; removedDate: Date | null; servicePointId: string }> = {}) {
  return {
    id: partial.id ?? "spm-1",
    utilityId: UID,
    servicePointId: partial.servicePointId ?? SP_ID,
    meterId: partial.meterId ?? "meter-1",
    addedDate: new Date("2024-01-01"),
    removedDate: partial.removedDate === undefined ? null : partial.removedDate,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction invokes the inner fn with the mocked prisma so the
  // service's tx.<model>.<method>(...) calls land on the same crud
  // mocks individual tests configure below.
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
    async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
  );
});

describe("closeServiceAgreement", () => {
  it("closes an ACTIVE SA and cascades removed_date onto every open SPM", async () => {
    const endDate = new Date("2026-04-30");
    const before = sa({ status: "ACTIVE" });
    (prisma.serviceAgreement.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(before);
    (prisma.serviceAgreement.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...before,
      status: "FINAL",
      endDate,
    });
    (prisma.servicePoint.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.servicePointMeter.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      spm({ id: "spm-1" }),
      spm({ id: "spm-2", meterId: "meter-2" }),
      spm({ id: "spm-3", meterId: "meter-3" }),
    ]);
    (prisma.servicePointMeter.update as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where, data }: { where: { id: string }; data: { removedDate: Date } }) =>
        spm({ id: where.id, removedDate: data.removedDate }),
    );

    const result = await closeServiceAgreement(UID, ACTOR, "Tester", {
      saId: SA_ID,
      endDate,
      status: "FINAL",
      reason: "Move-out",
    });

    expect(result.metersClosed).toBe(3);
    // SA update called once with the terminal status + endDate.
    const saUpdateCall = (prisma.serviceAgreement.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saUpdateCall.data).toEqual({ status: "FINAL", endDate });
    // SPM update called once per open child.
    expect((prisma.servicePointMeter.update as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    for (const call of (prisma.servicePointMeter.update as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0].data).toEqual({ removedDate: endDate });
    }
    // One audit row for the SA + one per cascaded SPM.
    expect(writeAuditRow).toHaveBeenCalledTimes(4);
    const auditCalls = (writeAuditRow as ReturnType<typeof vi.fn>).mock.calls;
    expect(auditCalls[0][3]).toBe(SA_ID); // entityId on first audit = SA
    expect(auditCalls[0][2]).toBe("service_agreement.updated");
    for (let i = 1; i < 4; i++) {
      expect(auditCalls[i][2]).toBe("service_point_meter.updated");
    }
  });

  it("is idempotent: re-closing with the same terminal status + endDate is a no-op", async () => {
    const endDate = new Date("2026-04-30");
    const already = sa({ status: "FINAL", endDate });
    (prisma.serviceAgreement.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(already);

    const result = await closeServiceAgreement(UID, ACTOR, "Tester", {
      saId: SA_ID,
      endDate,
      status: "FINAL",
    });

    expect(result.metersClosed).toBe(0);
    expect(prisma.serviceAgreement.update).not.toHaveBeenCalled();
    expect(prisma.servicePointMeter.update).not.toHaveBeenCalled();
    expect(writeAuditRow).not.toHaveBeenCalled();
  });

  it("allows FINAL → CLOSED (final-bill-issued step) as a status-only update with no cascade", async () => {
    const endDate = new Date("2026-04-30");
    const alreadyFinal = sa({ status: "FINAL", endDate });
    (prisma.serviceAgreement.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(alreadyFinal);
    (prisma.serviceAgreement.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...alreadyFinal,
      status: "CLOSED",
    });

    const result = await closeServiceAgreement(UID, ACTOR, "Tester", {
      saId: SA_ID,
      endDate,
      status: "CLOSED",
    });

    expect(result.metersClosed).toBe(0);
    // SA update was called with status-only data, no endDate (already set).
    expect((prisma.serviceAgreement.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data)
      .toEqual({ status: "CLOSED" });
    // No SPM cascade — meter assignments were already closed at FINAL.
    expect(prisma.servicePointMeter.findMany).not.toHaveBeenCalled();
  });

  it("rejects FINAL → CLOSED if the supplied endDate doesn't match the SA's existing endDate", async () => {
    const oldEnd = new Date("2026-04-30");
    const newEnd = new Date("2026-05-15");
    (prisma.serviceAgreement.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      sa({ status: "FINAL", endDate: oldEnd }),
    );

    await expect(
      closeServiceAgreement(UID, ACTOR, "Tester", {
        saId: SA_ID,
        endDate: newEnd,
        status: "CLOSED",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SA_ALREADY_TERMINAL" });
  });

  it("rejects re-closing an already-CLOSED SA (terminal-terminal)", async () => {
    const endDate = new Date("2026-04-30");
    (prisma.serviceAgreement.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      sa({ status: "CLOSED", endDate }),
    );

    await expect(
      closeServiceAgreement(UID, ACTOR, "Tester", {
        saId: SA_ID,
        endDate,
        status: "CLOSED",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SA_ALREADY_TERMINAL" });
  });

  it("propagates a SPM-update failure (transactional rollback is Postgres' job)", async () => {
    const endDate = new Date("2026-04-30");
    (prisma.serviceAgreement.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      sa({ status: "ACTIVE" }),
    );
    (prisma.serviceAgreement.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...sa({ status: "ACTIVE" }),
      status: "FINAL",
      endDate,
    });
    (prisma.servicePoint.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.servicePointMeter.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      spm({ id: "spm-1" }),
      spm({ id: "spm-2" }),
    ]);
    const boom = new Error("simulated SPM update failure");
    (prisma.servicePointMeter.update as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(spm({ id: "spm-1", removedDate: endDate }))
      .mockRejectedValueOnce(boom);

    await expect(
      closeServiceAgreement(UID, ACTOR, "Tester", {
        saId: SA_ID,
        endDate,
        status: "FINAL",
      }),
    ).rejects.toBe(boom);
  });

  it("works with no open meter assignments (empty cascade)", async () => {
    const endDate = new Date("2026-04-30");
    (prisma.serviceAgreement.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      sa({ status: "ACTIVE" }),
    );
    (prisma.serviceAgreement.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...sa({ status: "ACTIVE" }),
      status: "FINAL",
      endDate,
    });
    (prisma.servicePoint.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    (prisma.servicePointMeter.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await closeServiceAgreement(UID, ACTOR, "Tester", {
      saId: SA_ID,
      endDate,
      status: "FINAL",
    });

    expect(result.metersClosed).toBe(0);
    expect(prisma.servicePointMeter.update).not.toHaveBeenCalled();
    // Still writes the SA audit row.
    expect(writeAuditRow).toHaveBeenCalledTimes(1);
  });

  it("joins an existing transaction when existingTx is passed (no new $transaction call)", async () => {
    const endDate = new Date("2026-04-30");
    (prisma.serviceAgreement.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      sa({ status: "ACTIVE" }),
    );
    (prisma.serviceAgreement.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...sa({ status: "ACTIVE" }),
      status: "CLOSED",
      endDate,
    });
    (prisma.servicePoint.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    (prisma.servicePointMeter.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await closeServiceAgreement(
      UID,
      ACTOR,
      "Tester",
      { saId: SA_ID, endDate, status: "CLOSED" },
      prisma,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("removeMeterFromAgreement", () => {
  it("closes a single SPM and emits one audit row", async () => {
    const removedDate = new Date("2026-05-01");
    (prisma.servicePointMeter.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      spm({ id: "spm-1", removedDate: null }),
    );
    (prisma.servicePointMeter.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      spm({ id: "spm-1", removedDate }),
    );

    const result = await removeMeterFromAgreement(UID, ACTOR, "Tester", {
      saId: SA_ID,
      meterId: "meter-1",
      removedDate,
      reason: "Failed meter",
    });

    expect(result.removedDate).toEqual(removedDate);
    expect((prisma.servicePointMeter.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data)
      .toEqual({ removedDate });
    expect(writeAuditRow).toHaveBeenCalledTimes(1);
    expect((writeAuditRow as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(
      "service_point_meter.updated",
    );
  });

  it("throws not-found when no open SPM exists for (saId, meterId)", async () => {
    (prisma.servicePointMeter.findFirstOrThrow as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Not found"),
    );

    await expect(
      removeMeterFromAgreement(UID, ACTOR, "Tester", {
        saId: SA_ID,
        meterId: "meter-1",
        removedDate: new Date("2026-05-01"),
      }),
    ).rejects.toThrow("Not found");
  });
});

describe("swapMeter", () => {
  it("closes the old SPM, creates the new one, emits two audit rows", async () => {
    const swapDate = new Date("2026-05-01");
    const oldSpm = spm({ id: "spm-old", meterId: "meter-old", removedDate: null });
    (prisma.servicePointMeter.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(oldSpm) // old assignment lookup
      .mockResolvedValueOnce(null); // new meter conflict lookup -- none
    (prisma.servicePointMeter.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...oldSpm,
      removedDate: swapDate,
    });
    const newSpm = spm({ id: "spm-new", meterId: "meter-new", removedDate: null });
    (prisma.servicePointMeter.create as ReturnType<typeof vi.fn>).mockResolvedValue(newSpm);

    const result = await swapMeter(UID, ACTOR, "Tester", {
      saId: SA_ID,
      oldMeterId: "meter-old",
      newMeterId: "meter-new",
      swapDate,
      reason: "Routine replacement",
    });

    expect(result.closedOld.removedDate).toEqual(swapDate);
    expect(result.newSpm.id).toBe("spm-new");
    expect((prisma.servicePointMeter.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data)
      .toMatchObject({
        utilityId: UID,
        servicePointId: SP_ID,
        meterId: "meter-new",
        addedDate: swapDate,
      });
    expect(writeAuditRow).toHaveBeenCalledTimes(2);
    const calls = (writeAuditRow as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][2]).toBe("service_point_meter.updated"); // old close
    expect(calls[1][2]).toBe("service_point_meter.created"); // new open
  });

  it("rejects when oldMeterId is not currently assigned", async () => {
    (prisma.servicePointMeter.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null);

    await expect(
      swapMeter(UID, ACTOR, "Tester", {
        saId: SA_ID,
        oldMeterId: "meter-old",
        newMeterId: "meter-new",
        swapDate: new Date("2026-05-01"),
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "OLD_METER_NOT_ASSIGNED" });

    expect(prisma.servicePointMeter.update).not.toHaveBeenCalled();
    expect(prisma.servicePointMeter.create).not.toHaveBeenCalled();
  });

  it("rejects when newMeterId is already on another open assignment (friendly pre-check)", async () => {
    const oldSpm = spm({ id: "spm-old", meterId: "meter-old", removedDate: null });
    const conflicting = spm({ id: "spm-other", meterId: "meter-new", removedDate: null });
    (prisma.servicePointMeter.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(oldSpm)
      .mockResolvedValueOnce(conflicting);

    await expect(
      swapMeter(UID, ACTOR, "Tester", {
        saId: SA_ID,
        oldMeterId: "meter-old",
        newMeterId: "meter-new",
        swapDate: new Date("2026-05-01"),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "NEW_METER_ALREADY_ASSIGNED" });

    expect(prisma.servicePointMeter.update).not.toHaveBeenCalled();
    expect(prisma.servicePointMeter.create).not.toHaveBeenCalled();
  });
});
