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
});
