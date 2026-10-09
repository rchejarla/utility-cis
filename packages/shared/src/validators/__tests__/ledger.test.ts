import { describe, it, expect } from "vitest";
import {
  ENTRY_SIGN,
  roundToCents,
  postBillSchema,
  DEBIT_ALLOCATION_ORDER,
  recordPaymentSchema,
  reverseEntrySchema,
} from "../ledger";

describe("ENTRY_SIGN", () => {
  it("signs debits positive and credits negative", () => {
    expect(ENTRY_SIGN.BILL_CHARGE).toBe(1);
    expect(ENTRY_SIGN.FEE).toBe(1);
    expect(ENTRY_SIGN.ADJUSTMENT_DEBIT).toBe(1);
    expect(ENTRY_SIGN.PAYMENT).toBe(-1);
    expect(ENTRY_SIGN.ADJUSTMENT_CREDIT).toBe(-1);
    expect(ENTRY_SIGN.WRITE_OFF).toBe(-1);
  });

  it("has no entry for REVERSAL, whose sign follows its target", () => {
    expect("REVERSAL" in ENTRY_SIGN).toBe(false);
  });
});

describe("roundToCents", () => {
  it("rounds half-up at the half cent", () => {
    expect(roundToCents("47.3250")).toBe("47.33");
    expect(roundToCents("47.3249")).toBe("47.32");
    expect(roundToCents("0.005")).toBe("0.01");
  });

  it("rounds half-up away from zero for negatives", () => {
    expect(roundToCents("-47.3250")).toBe("-47.33");
  });

  it("pads to two decimal places", () => {
    expect(roundToCents("5")).toBe("5.00");
    expect(roundToCents("5.1")).toBe("5.10");
  });
});

describe("postBillSchema", () => {
  it("accepts an empty body", () => {
    expect(postBillSchema.parse({})).toEqual({});
  });

  it("accepts an effectiveDate override", () => {
    expect(postBillSchema.parse({ effectiveDate: "2026-05-15" })).toEqual({
      effectiveDate: "2026-05-15",
    });
  });

  it("rejects a malformed effectiveDate", () => {
    expect(() => postBillSchema.parse({ effectiveDate: "15/05/2026" })).toThrow();
  });

  // Well-shaped but out of calendar range. Without the refine these pass
  // and become an Invalid Date inside the posting transaction.
  it("rejects a well-shaped date whose month or day is out of range", () => {
    expect(() => postBillSchema.parse({ effectiveDate: "2026-13-45" })).toThrow();
    expect(() => postBillSchema.parse({ effectiveDate: "2026-00-10" })).toThrow();
  });

  // A day that overflows a real month would roll forward under
  // Date.parse alone — "2026-02-30" becomes 2026-03-02 — and post a
  // receivable dated a day the caller never asked for. The round trip
  // rejects it.
  it("rejects a day that does not exist in its month", () => {
    expect(() => postBillSchema.parse({ effectiveDate: "2026-02-30" })).toThrow();
    expect(() => postBillSchema.parse({ effectiveDate: "2026-04-31" })).toThrow();
    expect(() => postBillSchema.parse({ effectiveDate: "2026-02-29" })).toThrow();
  });

  it("keeps a leap day that does exist", () => {
    expect(postBillSchema.parse({ effectiveDate: "2024-02-29" })).toEqual({
      effectiveDate: "2024-02-29",
    });
  });
});

describe("DEBIT_ALLOCATION_ORDER", () => {
  // Spec §6.3: reconnection fees, then late fees, then oldest bills FIFO.
  it("ranks fees before adjustments before bill charges", () => {
    expect([...DEBIT_ALLOCATION_ORDER]).toEqual(["FEE", "ADJUSTMENT_DEBIT", "BILL_CHARGE"]);
  });

  it("covers every debit type, so no debit is unrankable", () => {
    const debitTypes = ["BILL_CHARGE", "FEE", "ADJUSTMENT_DEBIT"];
    expect([...DEBIT_ALLOCATION_ORDER].sort()).toEqual(debitTypes.sort());
  });
});

describe("recordPaymentSchema", () => {
  it("accepts a positive amount with a tender", () => {
    expect(recordPaymentSchema.parse({ amount: "50.00", tender: "CHECK" })).toEqual({
      amount: "50.00",
      tender: "CHECK",
    });
  });

  // Review Focus: a negative amount would post money received as money owed.
  it("rejects a negative or zero amount", () => {
    expect(() => recordPaymentSchema.parse({ amount: "-50.00", tender: "CHECK" })).toThrow();
    expect(() => recordPaymentSchema.parse({ amount: "0.00", tender: "CHECK" })).toThrow();
    expect(() => recordPaymentSchema.parse({ amount: "0", tender: "CHECK" })).toThrow();
  });

  it("rejects a non-decimal amount and more than two decimal places", () => {
    expect(() => recordPaymentSchema.parse({ amount: "fifty", tender: "CHECK" })).toThrow();
    expect(() => recordPaymentSchema.parse({ amount: "50.001", tender: "CHECK" })).toThrow();
  });

  it("requires a tender and rejects an unknown one", () => {
    expect(() => recordPaymentSchema.parse({ amount: "50.00" })).toThrow();
    expect(() => recordPaymentSchema.parse({ amount: "50.00", tender: "BITCOIN" })).toThrow();
  });

  it("rejects a receivedAt that is not a real date", () => {
    expect(() =>
      recordPaymentSchema.parse({ amount: "50.00", tender: "CHECK", receivedAt: "2026-02-30" }),
    ).toThrow();
  });

  it("accepts a real receivedAt, an externalRef and a memo", () => {
    expect(
      recordPaymentSchema.parse({
        amount: "50.00",
        tender: "LOCKBOX",
        receivedAt: "2026-06-01",
        externalRef: "BATCH-77",
        memo: "lockbox batch 77",
      }),
    ).toEqual({
      amount: "50.00",
      tender: "LOCKBOX",
      receivedAt: "2026-06-01",
      externalRef: "BATCH-77",
      memo: "lockbox batch 77",
    });
  });
});

describe("reverseEntrySchema", () => {
  it("accepts an empty body — reasonId is slice 3", () => {
    expect(reverseEntrySchema.parse({})).toEqual({});
  });

  it("rejects a reasonId that is not a uuid", () => {
    expect(() => reverseEntrySchema.parse({ reasonId: "nope" })).toThrow();
  });

  it("accepts a uuid reasonId and a memo", () => {
    const reasonId = "00000000-0000-4000-8000-00000000r001".replace("r", "a");
    expect(reverseEntrySchema.parse({ reasonId, memo: "NSF" })).toEqual({ reasonId, memo: "NSF" });
  });
});
