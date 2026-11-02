import { describe, it, expect } from "vitest";
import { rate } from "../../rate.js";
import type {
  RateComponentSnapshot,
  RatingContext,
  ResolvedAssignment,
} from "../../types.js";
import { SMUD_ENERGY_RATES, SMUD_SEASONS } from "./_smud-time-of-day-fixtures.js";

/**
 * SMUD residential Time-of-Day, priced end to end (spec 26, TOU-ENG-1,
 * TOU-ENG-9).
 *
 * The companion to `smud-time-of-day-calendar.test.ts`, which proves
 * the calendar classifies the hours. This proves the classified usage
 * turns into the right money: one bill line per TOU period, at the
 * published price, with the season deciding both which lines appear and
 * what they cost.
 *
 * **One component per period**, which is how the tariff is written and
 * how the bill reads — "Summer On-Peak Energy $45.18" is a line a
 * customer can check against the rate sheet. A single component
 * carrying all three prices would collapse into one line nobody could
 * verify.
 */

const SCHEDULE_ID = "rs-smud-tod-1";
const EFF_DATE = new Date(Date.UTC(2026, 0, 1));

/** Prices come from the fixture, so a tariff change is one edit. */
const price = (season: string, peak: string): number => {
  const value = SMUD_ENERGY_RATES[season]?.[peak];
  if (value === undefined) throw new Error(`fixture has no ${season} ${peak} price`);
  return value;
};

function touComponent(
  season: string,
  peakCode: string,
  label: string,
  sortOrder: number,
): RateComponentSnapshot {
  return {
    id: `c-smud-${season}-${peakCode}`,
    rateScheduleId: SCHEDULE_ID,
    kindCode: "consumption",
    label,
    sortOrder,
    effectiveDate: EFF_DATE,
    expirationDate: null,
    // The season gates the component; the base names the period. No new
    // predicate machinery — `season` already worked.
    predicate: { season },
    quantitySource: { base: "tou_period", peak_code: peakCode },
    pricing: { type: "flat", rate: price(season, peakCode), unit: "kWh" },
  };
}

/**
 * The whole tariff: three summer periods and two non-summer ones. Both
 * sets are always assigned — the season predicate decides which fire,
 * which is what a single published schedule has to do all year.
 */
function smudComponents(): RateComponentSnapshot[] {
  return [
    touComponent("summer", "peak", "Summer On-Peak Energy", 10),
    touComponent("summer", "mid_peak", "Summer Mid-Peak Energy", 20),
    touComponent("summer", "off_peak", "Summer Off-Peak Energy", 30),
    touComponent("non_summer", "peak", "Non-Summer Peak Energy", 40),
    touComponent("non_summer", "off_peak", "Non-Summer Off-Peak Energy", 50),
  ];
}

const assignment: ResolvedAssignment = {
  id: "a-smud-tod",
  rateScheduleId: SCHEDULE_ID,
  roleCode: "delivery",
  effectiveDate: EFF_DATE,
  expirationDate: null,
  schedule: {
    id: SCHEDULE_ID,
    name: "SMUD Residential Time-of-Day (5-8pm)",
    code: "TOD-5-8",
    version: 1,
    components: smudComponents(),
  },
};

function ctxFor(
  period: { startDate: Date; endDate: Date },
  buckets: Record<string, number>,
): RatingContext {
  return {
    base: {
      seasons: SMUD_SEASONS,
      seasonSpanRule: "START_DATE" as const,
      sa: {
        id: "sa-1",
        utilityId: "u-1",
        accountId: "a-1",
        premiseId: "p-1",
        commodityId: "c-electric",
        rateServiceClassCode: "residential",
      },
      account: { id: "a-1", accountNumber: "A-1" },
      premise: { id: "p-1", premiseType: "single_family", eruCount: null, hasStormwaterInfra: false },
      period,
      assignments: [assignment],
    },
    vars: new Map<string, unknown>(
      Object.entries(buckets).map(([peakCode, quantity]) => [
        `meter:tou:M-1:${peakCode}`,
        { quantity, unit: "kWh" },
      ]),
    ),
  };
}

const JUNE = { startDate: new Date(Date.UTC(2026, 5, 1)), endDate: new Date(Date.UTC(2026, 5, 30)) };
const JANUARY = {
  startDate: new Date(Date.UTC(2026, 0, 1)),
  endDate: new Date(Date.UTC(2026, 0, 31)),
};

const amountOf = (result: ReturnType<typeof rate>, componentId: string): string => {
  const line = result.lines.find((l) => l.sourceComponentId === componentId);
  if (!line) throw new Error(`no line from ${componentId}`);
  return line.amount.toFixed(2);
};

describe("a summer month", () => {
  // 1,000 kWh split across the three summer periods.
  const usage = { peak: 120, mid_peak: 300, off_peak: 580 };

  it("produces one line per period, at the published prices", () => {
    const result = rate(ctxFor(JUNE, usage));

    expect(result.lines).toHaveLength(3);
    expect(amountOf(result, "c-smud-summer-peak")).toBe("45.18"); // 120 × 0.3765
    expect(amountOf(result, "c-smud-summer-mid_peak")).toBe("64.17"); // 300 × 0.2139
    expect(amountOf(result, "c-smud-summer-off_peak")).toBe("89.90"); // 580 × 0.1550
  });

  it("labels each line so a customer can check it against the rate sheet", () => {
    const result = rate(ctxFor(JUNE, usage));
    expect(result.lines.map((l) => l.label)).toEqual([
      "Summer On-Peak Energy",
      "Summer Mid-Peak Energy",
      "Summer Off-Peak Energy",
    ]);
  });

  it("totals the three lines", () => {
    const result = rate(ctxFor(JUNE, usage));
    const total = result.lines.reduce((sum, l) => sum.plus(l.amount), result.lines[0].amount.mul(0));
    expect(total.toFixed(2)).toBe("199.25");
  });

  it("charges 2.4 times as much for the same kWh on-peak as off-peak", () => {
    /*
     * The point of the whole tariff, and the thing a bug here would
     * quietly undo. 100 kWh moved from off-peak to on-peak costs
     * $22.15 more; a classification that put peak usage in the off-peak
     * bucket would produce a plausible, cheaper, wrong bill.
     */
    const flat = rate(ctxFor(JUNE, { peak: 0, mid_peak: 0, off_peak: 100 }));
    const peaky = rate(ctxFor(JUNE, { peak: 100, mid_peak: 0, off_peak: 0 }));
    expect(amountOf(flat, "c-smud-summer-off_peak")).toBe("15.50");
    expect(amountOf(peaky, "c-smud-summer-peak")).toBe("37.65");
  });
});

describe("a non-summer month", () => {
  const usage = { peak: 100, off_peak: 900 };

  it("produces two lines, because non-summer has no mid-peak", () => {
    const result = rate(ctxFor(JANUARY, usage));
    expect(result.lines).toHaveLength(2);
    expect(amountOf(result, "c-smud-non_summer-peak")).toBe("17.76"); // 100 × 0.1776
    expect(amountOf(result, "c-smud-non_summer-off_peak")).toBe("115.65"); // 900 × 0.1285
  });

  it("does not ask for a bucket the season excludes", () => {
    /*
     * The interaction that makes one published schedule work all year:
     * the predicate gates the component *before* its quantity is
     * resolved, so a January bill never demands a summer mid-peak
     * bucket. The context above supplies only the two non-summer
     * buckets — if the order were the other way round, this would throw
     * rather than bill.
     */
    expect(() => rate(ctxFor(JANUARY, usage))).not.toThrow();
  });

  it("charges less for the same usage than summer would", () => {
    // 1,000 kWh in January against the same split in June.
    const january = rate(ctxFor(JANUARY, { peak: 120, off_peak: 880 }));
    const june = rate(ctxFor(JUNE, { peak: 120, mid_peak: 0, off_peak: 880 }));
    const sum = (r: ReturnType<typeof rate>) =>
      r.lines.reduce((acc, l) => acc.plus(l.amount), r.lines[0].amount.mul(0));
    expect(sum(january).toFixed(2)).toBe("134.39"); // 21.312 + 113.08
    expect(sum(june).toFixed(2)).toBe("181.58"); // 45.18 + 136.40
  });
});

describe("a period that spans the season boundary", () => {
  it("rates the whole period on the season its start date falls in", () => {
    /*
     * `seasonSpanRule: START_DATE` — today's only implemented rule
     * (TOU-SEA-5). A bill read on 28 May and covering most of June
     * therefore rates entirely at non-summer prices, which is worth
     * pinning because it surprises people: the customer's summer peak
     * usage is billed at the winter peak rate.
     *
     * It is not wrong — it is what the tariff's own meter-reading cycle
     * implies, and MAJORITY and PRORATE exist in the spec for utilities
     * that say otherwise. The column is already there, so adopting one
     * is not a migration.
     */
    const spanning = {
      startDate: new Date(Date.UTC(2026, 4, 28)),
      endDate: new Date(Date.UTC(2026, 5, 27)),
    };
    const result = rate(ctxFor(spanning, { peak: 100, off_peak: 900 }));

    expect(result.lines).toHaveLength(2);
    expect(amountOf(result, "c-smud-non_summer-peak")).toBe("17.76");
    expect(result.lines.some((l) => l.label.startsWith("Summer"))).toBe(false);
  });
});

describe("what a missing bucket does", () => {
  it("refuses to bill rather than charging nothing for the peak", () => {
    /*
     * The failure this closes. If the TOU data did not load, the
     * on-peak bucket is absent — and billing that as zero would charge
     * a TOU customer nothing for their most expensive usage, on a bill
     * that looks like an ordinary quiet month. So it raises, which
     * stops the bill and names the period.
     */
    expect(() => rate(ctxFor(JUNE, { mid_peak: 300, off_peak: 580 }))).toThrow(/peak/);
  });

  it("emits no line for a period with no usage, and says so in the trace", () => {
    /*
     * A customer who genuinely used nothing on-peak owes nothing, and
     * the engine suppresses zero-amount lines — deliberately, since
     * every tariff would otherwise carry a $0.00 line for each
     * inapplicable charge. The information is not lost: the trace
     * records the component with `zero_amount`.
     *
     * **Consequence for the bill.** TOU-BIL-2 shows usage and charges
     * *by TOU period*, and a customer who avoided the peak entirely
     * wants to see that. So the bill's period table cannot be built
     * from the rated lines — it is built from the calendar's periods,
     * with the trace or the buckets supplying the zeros. Pinned here
     * because the obvious implementation of TOU-BIL-2 is to loop over
     * `result.lines`, and it would silently drop a period.
     */
    const result = rate(ctxFor(JUNE, { peak: 0, mid_peak: 300, off_peak: 580 }));

    expect(result.lines).toHaveLength(2);
    expect(result.lines.some((l) => l.label === "Summer On-Peak Energy")).toBe(false);

    const peakTrace = result.trace.find((t) => t.componentId === "c-smud-summer-peak");
    expect(peakTrace).toMatchObject({ fired: false, skipReason: "zero_amount" });
    expect(peakTrace?.evaluatedQuantity?.toString()).toBe("0");
  });
});
