import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMeterReadEvent } from "../../services/meter-read.service.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Service-layer tests for multi-register read events (Phase 2.5).
 *
 * Focus: the rules that make a read event usable by billing — every
 * active register must be covered (read or skipped), sibling rows must
 * share one read_event_id, and each sibling's UoM must come from its
 * own register (not the meter default).
 *
 * The prisma mock is thin (a global in vitest.setup.ts) so each test
 * restubs just the methods the code path touches. Transactions use the
 * same tx object as the outer prisma mock so `tx.meterRead.create`
 * lands on the same spy as `prisma.meterRead.create`.
 */

const UID = "00000000-0000-4000-8000-00000000000a";
const ACTOR_ID = "00000000-0000-4000-8000-00000000000b";
const METER_ID = "00000000-0000-4000-8000-000000000100";
const REG_1 = "00000000-0000-4000-8000-000000000201";
const REG_2 = "00000000-0000-4000-8000-000000000202";
const UOM_KWH = "00000000-0000-4000-8000-000000000301";
const UOM_KW = "00000000-0000-4000-8000-000000000302";
const SA_ID = "00000000-0000-4000-8000-000000000401";

function stubTwoActiveRegisters() {
  (prisma.meterRegister.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: REG_1, registerNumber: 1, uomId: UOM_KWH },
    { id: REG_2, registerNumber: 2, uomId: UOM_KW },
  ]);
}

function stubMeterForConsumption() {
  (prisma.meter.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    multiplier: 1,
    dialCount: null,
  });
  (prisma.meterRead.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
}

function stubTransactionPassthrough() {
  // The real transaction client must expose .meterRead.create and
  // .meterEvent.create — route them back to the outer prisma mock so
  // the test can assert against the same spies.
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
    (fn: any) => {
      return fn(prisma);
    },
  );
  (prisma.meterRead.create as ReturnType<typeof vi.fn>).mockImplementation(
    (args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: `row-${args.data.registerId as string}`,
        ...args.data,
      }),
  );
  (prisma.meterEvent.create as ReturnType<typeof vi.fn>).mockImplementation(
    (args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "event-1", ...args.data }),
  );
}

describe("createMeterReadEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes one MeterRead per register sharing one readEventId", async () => {
    stubTwoActiveRegisters();
    stubMeterForConsumption();
    stubTransactionPassthrough();

    const result = await createMeterReadEvent(UID, ACTOR_ID, "Test User", {
      meterId: METER_ID,
      serviceAgreementId: SA_ID,
      readDate: "2026-04-22",
      readDatetime: "2026-04-22T14:00:00.000Z",
      readings: [
        { registerId: REG_1, reading: 45000 },
        { registerId: REG_2, reading: 120 },
      ],
      skips: [],
      readType: "ACTUAL",
      readSource: "MANUAL",
    });

    expect(result.readEventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.readings).toHaveLength(2);
    expect(prisma.meterRead.create).toHaveBeenCalledTimes(2);
    // Both sibling rows carry the same readEventId.
    const calls = (prisma.meterRead.create as ReturnType<typeof vi.fn>).mock.calls;
    const eventIds = calls.map((c) => (c[0] as any).data.readEventId);
    expect(new Set(eventIds).size).toBe(1);
    expect(eventIds[0]).toBe(result.readEventId);
  });

  it("preserves per-register uomId (kWh for register 1, kW for register 2)", async () => {
    stubTwoActiveRegisters();
    stubMeterForConsumption();
    stubTransactionPassthrough();

    await createMeterReadEvent(UID, ACTOR_ID, "Test User", {
      meterId: METER_ID,
      serviceAgreementId: SA_ID,
      readDate: "2026-04-22",
      readDatetime: "2026-04-22T14:00:00.000Z",
      readings: [
        { registerId: REG_1, reading: 45000 },
        { registerId: REG_2, reading: 120 },
      ],
      skips: [],
      readType: "ACTUAL",
      readSource: "MANUAL",
    });

    const calls = (prisma.meterRead.create as ReturnType<typeof vi.fn>).mock.calls;
    const byRegister: Record<string, string> = {};
    for (const c of calls) {
      const d = (c[0] as any).data;
      byRegister[d.registerId] = d.uomId;
    }
    expect(byRegister[REG_1]).toBe(UOM_KWH);
    expect(byRegister[REG_2]).toBe(UOM_KW);
  });

  it("rejects with REGISTERS_INCOMPLETE when a register is neither read nor skipped", async () => {
    stubTwoActiveRegisters();

    await expect(
      createMeterReadEvent(UID, ACTOR_ID, "Test User", {
        meterId: METER_ID,
        serviceAgreementId: SA_ID,
        readDate: "2026-04-22",
        readDatetime: "2026-04-22T14:00:00.000Z",
        readings: [{ registerId: REG_1, reading: 45000 }],
        skips: [],
        readType: "ACTUAL",
        readSource: "MANUAL",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "REGISTERS_INCOMPLETE",
      missingRegisterIds: [REG_2],
    });
    expect(prisma.meterRead.create).not.toHaveBeenCalled();
  });

  it("rejects with REGISTER_NOT_FOUND when a payload registerId isn't on the meter", async () => {
    stubTwoActiveRegisters();
    const BOGUS = "00000000-0000-4000-8000-0000000009ff";

    // All active registers covered + one extra bogus id. Without the
    // bogus one this would pass the missing-registers check. With it,
    // the next loop rejects the id that doesn't belong to the meter.
    await expect(
      createMeterReadEvent(UID, ACTOR_ID, "Test User", {
        meterId: METER_ID,
        serviceAgreementId: SA_ID,
        readDate: "2026-04-22",
        readDatetime: "2026-04-22T14:00:00.000Z",
        readings: [
          { registerId: REG_1, reading: 45000 },
          { registerId: REG_2, reading: 120 },
          { registerId: BOGUS, reading: 9999 },
        ],
        skips: [],
        readType: "ACTUAL",
        readSource: "MANUAL",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "REGISTER_NOT_FOUND" });
  });

  it("rejects with NO_ACTIVE_REGISTERS when the meter has no registers", async () => {
    (prisma.meterRegister.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await expect(
      createMeterReadEvent(UID, ACTOR_ID, "Test User", {
        meterId: METER_ID,
        serviceAgreementId: SA_ID,
        readDate: "2026-04-22",
        readDatetime: "2026-04-22T14:00:00.000Z",
        readings: [{ registerId: REG_1, reading: 45000 }],
        skips: [],
        readType: "ACTUAL",
        readSource: "MANUAL",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "NO_ACTIVE_REGISTERS" });
  });

  it("records a MeterEvent (not a MeterRead) for each skipped register", async () => {
    stubTwoActiveRegisters();
    stubMeterForConsumption();
    stubTransactionPassthrough();

    const result = await createMeterReadEvent(UID, ACTOR_ID, "Test User", {
      meterId: METER_ID,
      serviceAgreementId: SA_ID,
      readDate: "2026-04-22",
      readDatetime: "2026-04-22T14:00:00.000Z",
      readings: [{ registerId: REG_1, reading: 45000 }],
      skips: [{ registerId: REG_2, skipReason: "DEFECTIVE" }],
      readType: "ACTUAL",
      readSource: "MANUAL",
    });

    expect(prisma.meterRead.create).toHaveBeenCalledTimes(1);
    expect(prisma.meterEvent.create).toHaveBeenCalledTimes(1);
    expect(result.skippedRegisterIds).toEqual([REG_2]);

    const eventCall = (prisma.meterEvent.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { data: { description: string; eventType: string } };
    expect(eventCall.data.eventType).toBe("OTHER");
    expect(eventCall.data.description).toContain("Register 2 skipped");
    expect(eventCall.data.description).toContain("DEFECTIVE");
  });
});
