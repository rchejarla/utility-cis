import { describe, it, expect } from "vitest";
import {
  ENTRY_SIGN,
  roundToCents,
  postBillSchema,
  DEBIT_ALLOCATION_ORDER,
  recordPaymentSchema,
  reverseEntrySchema,
  DEFAULT_REASON_CODES,
  assessFeeSchema,
  adjustSchema,
  waiveSchema,
  writeOffSchema,
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

describe("DEFAULT_REASON_CODES", () => {
  it("covers all four types that require a reason", () => {
    const types = new Set(DEFAULT_REASON_CODES.map((r) => r.appliesToType));
    expect([...types].sort()).toEqual(
      ["ADJUSTMENT_CREDIT", "ADJUSTMENT_DEBIT", "FEE", "WRITE_OFF"].sort(),
    );
  });

  it("has unique codes, since (utilityId, code) is unique in the table", () => {
    const codes = DEFAULT_REASON_CODES.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  // seed.js's opening balances cite this one; without it the reason CHECK
  // cannot be satisfied by a seeded database.
  it("includes OPENING_BALANCE as an ADJUSTMENT_DEBIT reason", () => {
    const r = DEFAULT_REASON_CODES.find((x) => x.code === "OPENING_BALANCE");
    expect(r?.appliesToType).toBe("ADJUSTMENT_DEBIT");
  });

  it("keeps every code and label within the column widths", () => {
    for (const r of DEFAULT_REASON_CODES) {
      expect(r.code.length, r.code).toBeLessThanOrEqual(50);
      expect(r.label.length, r.code).toBeLessThanOrEqual(255);
    }
  });

  // §3.5: a concession and a bad debt are different facts, so the credit
  // reasons must not all pile onto one type.
  it("gives WRITE_OFF its own reasons, distinct from the waiver reasons", () => {
    const writeOffs = DEFAULT_REASON_CODES.filter((r) => r.appliesToType === "WRITE_OFF");
    const credits = DEFAULT_REASON_CODES.filter((r) => r.appliesToType === "ADJUSTMENT_CREDIT");
    expect(writeOffs.length).toBeGreaterThan(0);
    expect(credits.length).toBeGreaterThan(0);
    expect(writeOffs.map((r) => r.code)).not.toEqual(credits.map((r) => r.code));
  });
});

describe("assessFeeSchema", () => {
  const reasonId = "00000000-0000-4000-8000-00000000aa01";

  it("accepts a positive amount with a reason", () => {
    expect(assessFeeSchema.parse({ amount: "25.00", reasonId })).toEqual({
      amount: "25.00",
      reasonId,
    });
  });

  it("requires a reasonId — a fee with no reason is what this slice prevents", () => {
    expect(() => assessFeeSchema.parse({ amount: "25.00" })).toThrow();
  });

  it("rejects a negative or zero amount", () => {
    expect(() => assessFeeSchema.parse({ amount: "-25.00", reasonId })).toThrow();
    expect(() => assessFeeSchema.parse({ amount: "0.00", reasonId })).toThrow();
  });

  // Review Focus: most fees are assessed on nothing.
  it("leaves assessedOnId optional", () => {
    expect(assessFeeSchema.parse({ amount: "25.00", reasonId }).assessedOnId).toBeUndefined();
  });

  it("rejects a dueDate that is not a real date", () => {
    expect(() =>
      assessFeeSchema.parse({ amount: "25.00", reasonId, dueDate: "2026-02-30" }),
    ).toThrow();
  });

  it("rejects a reasonId or assessedOnId that is not a uuid", () => {
    expect(() => assessFeeSchema.parse({ amount: "25.00", reasonId: "nope" })).toThrow();
    expect(() =>
      assessFeeSchema.parse({ amount: "25.00", reasonId, assessedOnId: "nope" }),
    ).toThrow();
  });
});

describe("adjustSchema", () => {
  const reasonId = "00000000-0000-4000-8000-00000000aa01";

  it("accepts a positive amount with a reason", () => {
    expect(adjustSchema.parse({ amount: "40.00", reasonId })).toEqual({
      amount: "40.00",
      reasonId,
    });
  });

  it("requires a reasonId", () => {
    expect(() => adjustSchema.parse({ amount: "40.00" })).toThrow();
  });
});

describe("waiveSchema and writeOffSchema", () => {
  const reasonId = "00000000-0000-4000-8000-00000000aa01";
  const debitId = "00000000-0000-4000-8000-00000000bb01";

  it("require the debit they are applied to", () => {
    for (const schema of [waiveSchema, writeOffSchema]) {
      expect(() => schema.parse({ amount: "10.00", reasonId })).toThrow();
      expect(schema.parse({ amount: "10.00", reasonId, debitId }).debitId).toBe(debitId);
    }
  });

  it("reject a debitId that is not a uuid", () => {
    expect(() => waiveSchema.parse({ amount: "10.00", reasonId, debitId: "nope" })).toThrow();
  });

  // §6.5: any amount, so a partial waiver is free and over-waiving is a
  // refund due rather than a validation error.
  it("accept an amount larger than any plausible debit", () => {
    expect(waiveSchema.parse({ amount: "99999.99", reasonId, debitId }).amount).toBe("99999.99");
  });
});
