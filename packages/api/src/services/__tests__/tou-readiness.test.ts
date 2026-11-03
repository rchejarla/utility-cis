import { describe, it, expect } from "vitest";
import {
  describeTouProblem,
  reconcileRegisters,
  toleranceFrom,
  type TouReadinessProblem,
} from "../tou-readiness.service.js";
import { toDecimal } from "../../lib/rate-engine/decimal.js";

/**
 * Register reconciliation (spec 26, TOU-REG-1).
 *
 * A TOU meter's period registers should sum to its total register. When
 * they do not, some usage is either billed twice or never billed — and
 * nothing about the resulting bill looks wrong, which is why this is a
 * pre-run check rather than something rating discovers.
 */

const d = toDecimal;
const DEFAULTS = toleranceFrom(undefined);

describe("reconcileRegisters", () => {
  it("accepts registers that sum exactly", () => {
    expect(reconcileRegisters(d(600), d(600), DEFAULTS)).toBeNull();
  });

  it("has nothing to check without a total register", () => {
    /*
     * A meter with only TOU registers has no second opinion to compare
     * against. That is not a fault — TOU-REG-1 says "if a total
     * register exists" — and treating it as one would flag every
     * two-register meter in the territory.
     */
    expect(reconcileRegisters(null, d(600), DEFAULTS)).toBeNull();
  });

  it("accepts a difference inside the absolute tolerance", () => {
    // Dial rounding, on a small month.
    expect(reconcileRegisters(d(10), d("9.4"), DEFAULTS)).toBeNull();
  });

  it("reports a difference outside both tolerances", () => {
    const off = reconcileRegisters(d(600), d(500), DEFAULTS);
    expect(off).not.toBeNull();
    expect(off?.difference.toString()).toBe("100");
    // 0.5% of 600 is 3, which beats the absolute 1.
    expect(off?.allowed.toString()).toBe("3");
  });

  it("uses the relative tolerance where it is the larger", () => {
    /*
     * The reason there are two. At 40,000 units, 0.5% is 200 — so a
     * 150-unit discrepancy is rounding, and an absolute tolerance of 1
     * would flag every large account every month and bury the real
     * faults.
     */
    expect(reconcileRegisters(d(40_000), d(39_850), DEFAULTS)).toBeNull();
    expect(reconcileRegisters(d(40_000), d(39_000), DEFAULTS)).not.toBeNull();
  });

  it("uses the absolute tolerance where it is the larger", () => {
    /*
     * The other reason. At 2 units, 0.5% is 0.01 — tighter than any
     * dial reads — so a relative-only rule would flag a customer who
     * used almost nothing.
     */
    expect(reconcileRegisters(d(2), d("1.2"), DEFAULTS)).toBeNull();
    expect(reconcileRegisters(d(2), d("0.5"), DEFAULTS)).not.toBeNull();
  });

  it("is symmetric: buckets over the total is equally wrong", () => {
    // Over-counting bills usage twice, which is the direction a
    // customer complains about.
    const off = reconcileRegisters(d(500), d(600), DEFAULTS);
    expect(off?.difference.toString()).toBe("100");
  });

  it("compares at the boundary without drifting", () => {
    // Exactly the allowed difference passes; a hair more does not.
    // Decimal arithmetic, so 0.5% of 600 is 3 and not 2.9999999.
    expect(reconcileRegisters(d(600), d(597), DEFAULTS)).toBeNull();
    expect(reconcileRegisters(d(600), d("596.99"), DEFAULTS)).not.toBeNull();
  });

  it("honours a tenant's own tolerances", () => {
    const tight = toleranceFrom({ registerToleranceAbsolute: 0, registerTolerancePercent: 0 });
    expect(reconcileRegisters(d(600), d("599.99"), tight)).not.toBeNull();

    const loose = toleranceFrom({ registerTolerancePercent: 25 });
    expect(reconcileRegisters(d(600), d(500), loose)).toBeNull();
  });

  it("falls back to the declared defaults one setting at a time", () => {
    // A tenant who sets only the percentage keeps the default absolute.
    const partial = toleranceFrom({ registerTolerancePercent: 10 });
    expect(partial.absolute.toString()).toBe("1");
    expect(partial.percent.toString()).toBe("10");
  });
});

describe("describeTouProblem", () => {
  /*
   * One place for the wording, so the API and the UI cannot describe the
   * same problem two ways. Each sentence has to say what *happens* —
   * whoever reads it is deciding whether to run the bill anyway.
   */
  const cases: Array<[TouReadinessProblem, RegExp]> = [
    [
      {
        kind: "CALENDAR_MISMATCH",
        meterId: "m",
        meterNumber: "M-1",
        meterCalendar: "Old hours",
        scheduleCalendar: "TOD 5-8pm",
      },
      /wrong hours/i,
    ],
    [{ kind: "CALENDAR_UNKNOWN", meterId: "m", meterNumber: "M-1" }, /cannot be checked/i],
    [
      {
        kind: "REGISTERS_UNRECONCILED",
        meterId: "m",
        meterNumber: "M-1",
        total: "600",
        bucketSum: "500",
        difference: "100",
        allowed: "3",
      },
      /billed twice or not at all/i,
    ],
    [
      { kind: "PERIOD_NOT_REPORTED", meterId: "m", meterNumber: "M-1", peakCode: "mid_peak" },
      /rating will stop/i,
    ],
    [{ kind: "NO_TOU_READS", meterId: "m", meterNumber: "M-1" }, /no TOU usage at all/i],
  ];

  it.each(cases)("names the meter and the consequence", (problem, consequence) => {
    const text = describeTouProblem(problem);
    expect(text).toMatch(/M-1/);
    expect(text).toMatch(consequence);
  });

  it("covers every kind", () => {
    // So a new problem kind cannot be added without wording for it.
    const kinds = new Set(cases.map(([p]) => p.kind));
    expect(kinds.size).toBe(5);
  });
});
