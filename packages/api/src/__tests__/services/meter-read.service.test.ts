import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMeterReadEvent, listMeterReads } from "../../services/meter-read.service.js";
import { meterReadQuerySchema } from "@utility-cis/shared";
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

/**
 * The two boolean filters on the Meter Reads list.
 *
 * Reported 2026-11-07: the Exceptions pill showed rows only with no
 * filter applied. The cause was in the Zod schema — `z.coerce.boolean()`
 * is `Boolean(input)`, so the string "false" a select box sends parsed
 * as `true` and both options asked for reads *with* an exception. This
 * pins the other half of that chain: that `false` reaches the query as a
 * query for `exception_code IS NULL`, and not as the opposite or as
 * nothing at all.
 */
describe("listMeterReads — the exception and billed filters", () => {
  beforeEach(() => {
    // Cleared here as well: the `clearAllMocks` above belongs to the
    // read-event describe, so without this each case would read the
    // previous one's query and agree with it.
    vi.clearAllMocks();
    (prisma.meterRead.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.meterRead.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  });

  const whereOf = () => {
    const calls = (prisma.meterRead.findMany as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    return (calls[0]![0] as { where: Record<string, unknown> }).where;
  };

  const query = (over: Record<string, unknown>) =>
    meterReadQuerySchema.parse({ ...over });

  it("asks for reads with no exception code when the pill says No exception", async () => {
    await listMeterReads(UID, query({ hasException: "false" }));
    expect(whereOf().exceptionCode).toBeNull();
  });

  it("asks for reads that have one when the pill says With exception", async () => {
    await listMeterReads(UID, query({ hasException: "true" }));
    expect(whereOf().exceptionCode).toEqual({ not: null });
  });

  it("asks about neither when no pill is chosen", async () => {
    await listMeterReads(UID, query({}));
    expect(whereOf()).not.toHaveProperty("exceptionCode");
    expect(whereOf()).not.toHaveProperty("billedAt");
  });

  it("asks for reads with no billed_at when the pill says Not billed", async () => {
    await listMeterReads(UID, query({ billed: "false" }));
    expect(whereOf().billedAt).toBeNull();
  });

  it("asks for the billed ones by the column that says so", async () => {
    // Not `is_frozen`, which nothing ever wrote: that pill could only
    // ever return nothing for "Billed".
    await listMeterReads(UID, query({ billed: "true" }));
    expect(whereOf().billedAt).toEqual({ not: null });
  });
});

/**
 * The three filters that make the list usable at ten thousand meters.
 *
 * Before them the screen could only slice by *kind* — type, source,
 * flagged, billed — which narrows nothing when a cycle's ten thousand
 * reads all arrive in the same three days. These pin the where-clause
 * each one builds, because a filter that reaches the database as the
 * wrong question is the failure mode this screen has already had twice.
 */
describe("listMeterReads — searching and narrowing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.meterRead.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.meterRead.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  });

  const whereFor = async (over: Record<string, unknown>) => {
    await listMeterReads(UID, meterReadQuerySchema.parse(over));
    const calls = (prisma.meterRead.findMany as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    return (calls[0]![0] as { where: Record<string, unknown> }).where;
  };

  it("looks for the text in both the meter number and the agreement number", async () => {
    const where = await whereFor({ search: "WM-100" });
    expect(where.OR).toEqual([
      { meter: { meterNumber: { contains: "WM-100", mode: "insensitive" } } },
      { serviceAgreement: { agreementNumber: { contains: "WM-100", mode: "insensitive" } } },
    ]);
  });

  it("reaches the cycle through the account, since a read carries none", async () => {
    const cycle = "00000000-0000-4000-8000-0000000000c1";
    const where = await whereFor({ billingCycleId: cycle });
    expect(where.serviceAgreement).toEqual({ account: { billingCycleId: cycle } });
  });

  it("turns a month into a half-open range on the read date", async () => {
    const where = await whereFor({ readMonth: "2026-10" });
    expect(where.readDate).toEqual({
      gte: new Date("2026-10-01T00:00:00.000Z"),
      lt: new Date("2026-11-01T00:00:00.000Z"),
    });
  });

  it("rolls December into the next January rather than month 13", async () => {
    const where = await whereFor({ readMonth: "2026-12" });
    expect(where.readDate).toEqual({
      gte: new Date("2026-12-01T00:00:00.000Z"),
      lt: new Date("2027-01-01T00:00:00.000Z"),
    });
  });

  it("combines a search with a cycle by AND, not by widening it", async () => {
    const cycle = "00000000-0000-4000-8000-0000000000c1";
    const where = await whereFor({ search: "WM-100", billingCycleId: cycle });
    // The cycle stays a flat constraint and the search stays in `OR`:
    // folding the search into `serviceAgreement` would have let a
    // matching agreement number escape the cycle filter.
    expect(where.serviceAgreement).toEqual({ account: { billingCycleId: cycle } });
    expect(Array.isArray(where.OR)).toBe(true);
  });
});
