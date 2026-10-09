import { describe, it, expect } from "vitest";
import { ENTRY_SIGN, roundToCents, postBillSchema } from "../ledger";

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

  // Known limit of Date.parse, pinned so nobody reads the refine as
  // stronger than it is: a day that overflows a real month is accepted
  // and rolls forward — "2026-02-30" posts as 2026-03-02. That is JS
  // Date semantics, not a crash, and it is what the rest of this
  // codebase already relies on for date arithmetic.
  it("accepts a day that overflows its month, which rolls forward", () => {
    expect(postBillSchema.parse({ effectiveDate: "2026-02-30" })).toEqual({
      effectiveDate: "2026-02-30",
    });
    expect(new Date("2026-02-30").toISOString().slice(0, 10)).toBe("2026-03-02");
  });
});
