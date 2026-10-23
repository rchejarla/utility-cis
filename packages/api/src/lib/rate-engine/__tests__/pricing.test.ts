import { describe, it, expect } from "vitest";
import { applyPricing } from "../evaluators/pricing.js";
import { Decimal } from "../decimal.js";
import type { LineItem, RatingContext } from "../types.js";

function makeCtx(
  overrides: Partial<RatingContext["base"]> = {},
  vars: Map<string, unknown> = new Map(),
): RatingContext {
  return {
    base: {
      sa: {
        id: "sa-1",
        utilityId: "u-1",
        accountId: "a-1",
        premiseId: "p-1",
        commodityId: "c-1",
        rateServiceClassCode: "single_family",
        ...overrides.sa,
      },
      account: { id: "a-1", accountNumber: "A-1", ...overrides.account },
      premise: {
        id: "p-1",
        premiseType: "single_family",
        eruCount: null,
        hasStormwaterInfra: false,
        ...overrides.premise,
      },
      period: overrides.period ?? {
        startDate: new Date(2026, 4, 1), // May 2026 → Q2
        endDate: new Date(2026, 4, 31),
      },
      assignments: overrides.assignments ?? [],
    },
    vars,
  };
}

function line(overrides: Partial<LineItem> = {}): LineItem {
  return {
    label: "L",
    amount: new Decimal(0),
    kindCode: "volumetric",
    sourceScheduleId: "sched-1",
    sourceComponentId: "comp-1",
    ...overrides,
  };
}

describe("applyPricing — flat", () => {
  it("multiplies rate × qty", () => {
    const result = applyPricing(
      { type: "flat", rate: 2.5 },
      new Decimal(10),
      [],
      makeCtx(),
    );
    expect(result.toString()).toBe("25");
  });
});

describe("applyPricing — tiered", () => {
  it("walks 4-tier inclining bracket: 12 HCF over [6, 25, 55, ∞]", () => {
    // Tier 1: 0-6 @ 3.31, Tier 2: 6-25 @ 4.58, Tier 3: 25-55 @ 6.39, Tier 4: 55+ @ 9.58
    // qty=12: 6 × 3.31 + 6 × 4.58 = 19.86 + 27.48 = 47.34
    const tiers = [
      { to: 6, rate: 3.31 },
      { to: 25, rate: 4.58 },
      { to: 55, rate: 6.39 },
      { to: null, rate: 9.58 },
    ];
    const result = applyPricing(
      { type: "tiered", tiers },
      new Decimal(12),
      [],
      makeCtx(),
    );
    expect(result.toString()).toBe("47.34");
  });

  /**
   * Bozeman Req 138. A tiered threshold is an allowance for a period, so
   * an interval of a different length needs a proportionate one.
   *
   * These use the real SFR brackets, because the size of the error is
   * the argument: without proration a 44-day interval is priced against
   * one month's allowance and crosses tiers the customer never earned.
   */
  describe("threshold proration", () => {
    const tiers = [
      { to: 6, rate: 3.31 },
      { to: 25, rate: 4.58 },
      { to: 55, rate: 6.39 },
      { to: null, rate: 9.58 },
    ];
    const period = (startDay: number, endDay: number) => ({
      period: {
        startDate: new Date(Date.UTC(2026, 0, startDay)),
        endDate: new Date(Date.UTC(2026, 1, endDay)),
      },
    });

    it("leaves thresholds alone when the tariff declares no standard period", () => {
      // 31 days billed, no standard_days: absolute thresholds, as before.
      const result = applyPricing(
        { type: "tiered", tiers },
        new Decimal(12),
        [],
        makeCtx(period(1, 0)),
      );
      expect(result.toString()).toBe("47.34");
    });

    it("prices a standard-length interval identically with or without it", () => {
      // 2026-01-01 through 2026-01-31 inclusive is 31 days.
      const ctx = makeCtx({
        period: {
          startDate: new Date(Date.UTC(2026, 0, 1)),
          endDate: new Date(Date.UTC(2026, 0, 31)),
        },
      });
      const prorated = applyPricing(
        { type: "tiered", tiers, standard_days: 31 },
        new Decimal(12),
        [],
        ctx,
      );
      const absolute = applyPricing({ type: "tiered", tiers }, new Decimal(12), [], ctx);
      expect(prorated.toString()).toBe(absolute.toString());
    });

    it("widens the allowance for a long interval, so usage keeps its tier", () => {
      // A missed read: 2025-12-31 through 2026-02-01 is 33 days against a
      // 30-day tariff, so tier 1 runs to 6 × 33/30 = 6.6 units.
      const ctx = makeCtx({
        period: {
          startDate: new Date(Date.UTC(2025, 11, 31)),
          endDate: new Date(Date.UTC(2026, 1, 1)),
        },
      });
      const prorated = applyPricing(
        { type: "tiered", tiers, standard_days: 30 },
        new Decimal(12),
        [],
        ctx,
      );
      const absolute = applyPricing({ type: "tiered", tiers }, new Decimal(12), [], ctx);

      // 6.6 × 3.31 + 5.4 × 4.58 = 21.846 + 24.732 = 46.578
      expect(prorated.toString()).toBe("46.578");
      // Cheaper than pricing the same usage against a month's allowance,
      // which is the whole point: the extra days earned extra tier 1.
      expect(prorated.lt(absolute)).toBe(true);
    });

    it("narrows it for a short interval, so a part month is not a bargain", () => {
      // A move-in mid-cycle: 2026-01-16 through 2026-01-31 is 16 days,
      // so tier 1 runs to 6 × 16/30 = 3.2 units.
      const ctx = makeCtx({
        period: {
          startDate: new Date(Date.UTC(2026, 0, 16)),
          endDate: new Date(Date.UTC(2026, 0, 31)),
        },
      });
      const result = applyPricing(
        { type: "tiered", tiers, standard_days: 30 },
        new Decimal(6),
        [],
        ctx,
      );
      // 3.2 × 3.31 + 2.8 × 4.58 = 10.592 + 12.824 = 23.416
      expect(result.toString()).toBe("23.416");
    });

    it("does not round a scaled threshold", () => {
      // 31/30 of 6 is 6.2 exactly; a threshold rounded to 6 would price
      // 0.2 units a tier too high and the error would compound per tier.
      const ctx = makeCtx({
        period: {
          startDate: new Date(Date.UTC(2026, 0, 1)),
          endDate: new Date(Date.UTC(2026, 0, 31)),
        },
      });
      const result = applyPricing(
        { type: "tiered", tiers, standard_days: 30 },
        new Decimal(6.2),
        [],
        ctx,
      );
      // All of it inside a widened tier 1: 6.2 × 3.31 = 20.522
      expect(result.toString()).toBe("20.522");
    });

    it("leaves the open-ended tier open", () => {
      const ctx = makeCtx({
        period: {
          startDate: new Date(Date.UTC(2026, 0, 1)),
          endDate: new Date(Date.UTC(2026, 0, 31)),
        },
      });
      const result = applyPricing(
        { type: "tiered", tiers, standard_days: 30 },
        new Decimal(100),
        [],
        ctx,
      );
      // Thresholds scale by 31/30: 6.2, 25.833…, 56.833…, then the rest
      // at 9.58 with no ceiling.
      expect(result.gt(new Decimal(0))).toBe(true);
      const absolute = applyPricing({ type: "tiered", tiers }, new Decimal(100), [], ctx);
      expect(result.lt(absolute)).toBe(true);
    });
  });

  it("qty within first tier only", () => {
    const tiers = [
      { to: 6, rate: 3.31 },
      { to: 25, rate: 4.58 },
      { to: null, rate: 9.58 },
    ];
    const result = applyPricing(
      { type: "tiered", tiers },
      new Decimal(4),
      [],
      makeCtx(),
    );
    // 4 × 3.31 = 13.24
    expect(result.toString()).toBe("13.24");
  });

  it("qty exceeds final unbounded tier", () => {
    const tiers = [
      { to: 6, rate: 1 },
      { to: null, rate: 2 },
    ];
    const result = applyPricing(
      { type: "tiered", tiers },
      new Decimal(20),
      [],
      makeCtx(),
    );
    // 6 × 1 + 14 × 2 = 6 + 28 = 34
    expect(result.toString()).toBe("34");
  });
});

describe("applyPricing — lookup", () => {
  it("meter_size lookup returns rate × qty", () => {
    const vars = new Map<string, unknown>([
      ["meter:size:m-7", "0.75"],
      ["meter:reads:m-7", { quantity: 100 }],
    ]);
    const result = applyPricing(
      {
        type: "lookup",
        by: "meter_size",
        table: { "0.75": 12.5, "1.0": 25.0 },
      },
      new Decimal(1),
      [],
      makeCtx({}, vars),
    );
    expect(result.toString()).toBe("12.5");
  });

  it("missing meter:size:* var throws", () => {
    expect(() =>
      applyPricing(
        { type: "lookup", by: "meter_size", table: { "0.75": 1 } },
        new Decimal(1),
        [],
        makeCtx(),
      ),
    ).toThrow(/lookup by meter_size requires a meter:size:\* variable/);
  });

  it("by other than meter_size throws", () => {
    expect(() =>
      applyPricing(
        { type: "lookup", by: "customer_class", table: {} },
        new Decimal(1),
        [],
        makeCtx(),
      ),
    ).toThrow(/lookup pricing 'by' field not supported/);
  });
});

describe("applyPricing — catalog", () => {
  it("multi-attribute join — single item", () => {
    const vars = new Map<string, unknown>([
      [
        "items:sp-1:cart",
        [{ size: "96", type: "trash" }],
      ],
    ]);
    const result = applyPricing(
      {
        type: "catalog",
        by: ["size", "type"],
        table: { "96:trash": 18.5, "64:trash": 14.0 },
      },
      new Decimal(1),
      [],
      makeCtx({}, vars),
    );
    expect(result.toString()).toBe("18.5");
  });

  it("multi-cart aggregation across multiple items:* vars", () => {
    const vars = new Map<string, unknown>([
      [
        "items:sp-1:cart",
        [
          { size: "96", type: "trash" },
          { size: "64", type: "recycle" },
        ],
      ],
      [
        "items:sp-2:cart",
        [{ size: "96", type: "trash" }],
      ],
    ]);
    const result = applyPricing(
      {
        type: "catalog",
        by: ["size", "type"],
        table: { "96:trash": 10, "64:recycle": 5 },
      },
      new Decimal(1),
      [],
      makeCtx({}, vars),
    );
    // 10 + 5 + 10 = 25
    expect(result.toString()).toBe("25");
  });

  it("empty items returns 0", () => {
    const result = applyPricing(
      {
        type: "catalog",
        by: ["size"],
        table: { "96": 10 },
      },
      new Decimal(1),
      [],
      makeCtx(),
    );
    expect(result.toString()).toBe("0");
  });
});

describe("applyPricing — per_unit", () => {
  it("multiplies rate × qty (same as flat)", () => {
    const result = applyPricing(
      { type: "per_unit", rate: 0.5, unit: "HCF" },
      new Decimal(20),
      [],
      makeCtx(),
    );
    expect(result.toString()).toBe("10");
  });
});

describe("applyPricing — percent_of", () => {
  it("selects by kind, sums, applies percent", () => {
    const lines: LineItem[] = [
      line({ kindCode: "volumetric", amount: new Decimal(40) }),
      line({ kindCode: "service_charge", amount: new Decimal(20) }),
      line({ kindCode: "volumetric", amount: new Decimal(60) }),
    ];
    const result = applyPricing(
      {
        type: "percent_of",
        selector: { kind: "volumetric" },
        percent: 8.5,
      },
      new Decimal(0),
      lines,
      makeCtx(),
    );
    // (40 + 60) × 8.5 / 100 = 8.5
    expect(result.toString()).toBe("8.5");
  });

  it("empty selector match returns 0", () => {
    const lines: LineItem[] = [line({ kindCode: "volumetric", amount: new Decimal(40) })];
    const result = applyPricing(
      {
        type: "percent_of",
        selector: { kind: "tax" },
        percent: 10,
      },
      new Decimal(0),
      lines,
      makeCtx(),
    );
    expect(result.toString()).toBe("0");
  });

  it("negative percent yields negative result (e.g. discount)", () => {
    const lines: LineItem[] = [line({ kindCode: "volumetric", amount: new Decimal(100) })];
    const result = applyPricing(
      {
        type: "percent_of",
        selector: { kind: "volumetric" },
        percent: -10,
      },
      new Decimal(0),
      lines,
      makeCtx(),
    );
    expect(result.toString()).toBe("-10");
  });
});

describe("applyPricing — indexed", () => {
  it("current_quarter resolver looks up correct key (May 2026 → 2026-Q2)", () => {
    const vars = new Map<string, unknown>([["index:cpi:2026-Q2", 1.04]]);
    const result = applyPricing(
      {
        type: "indexed",
        index_name: "cpi",
        period_resolver: "current_quarter",
      },
      new Decimal(100),
      [],
      makeCtx({}, vars),
    );
    // 1.04 × 100 × 1 = 104
    expect(result.toString()).toBe("104");
  });

  it("multiplier scales the result", () => {
    const vars = new Map<string, unknown>([["index:cpi:2026", 2]]);
    const result = applyPricing(
      {
        type: "indexed",
        index_name: "cpi",
        period_resolver: "current_year",
        multiplier: 0.5,
      },
      new Decimal(10),
      [],
      makeCtx({}, vars),
    );
    // 2 × 10 × 0.5 = 10
    expect(result.toString()).toBe("10");
  });

  it("missing index var throws", () => {
    expect(() =>
      applyPricing(
        {
          type: "indexed",
          index_name: "cpi",
          period_resolver: "current_quarter",
        },
        new Decimal(1),
        [],
        makeCtx(),
      ),
    ).toThrow(/indexed pricing requires var index:cpi:2026-Q2/);
  });

  it("fixed period_resolver requires fixed_period", () => {
    expect(() =>
      applyPricing(
        {
          type: "indexed",
          index_name: "cpi",
          period_resolver: "fixed",
        },
        new Decimal(1),
        [],
        makeCtx(),
      ),
    ).toThrow(/fixed period_resolver requires fixed_period/);
  });
});

describe("applyPricing — floor", () => {
  it("throws (handled at orchestrator level)", () => {
    expect(() =>
      applyPricing({ type: "floor", min: 10 }, new Decimal(0), [], makeCtx()),
    ).toThrow(/floor pricing is applied at the orchestrator level/);
  });
});

/**
 * The period a date falls in is the UTC one.
 *
 * A service period's start comes from a `@db.Date` column — an
 * agreement's start date, or the day after the last billed read — and
 * Prisma hands those back as UTC midnight. Read with local getters,
 * UTC midnight on 1 January is 31 December anywhere west of Greenwich,
 * so an agreement starting 2025-01-01 asks the index for 2024-Q4: a
 * quarter in the wrong year, and one no utility would have published.
 *
 * The cases below construct the dates the way the database produces
 * them. The older cases in this file build theirs with `new Date(y, m,
 * d)`, which is local midnight and therefore cannot show the fault.
 * These assert the same values in any zone; they only *fail* west of
 * Greenwich, which is where the bug was found.
 */
describe("applyPricing — period resolvers read dates in UTC", () => {
  const utcMidnight = (iso: string) => ({
    period: { startDate: new Date(`${iso}T00:00:00Z`), endDate: new Date(`${iso}T00:00:00Z`) },
  });

  it("resolves the quarter of a UTC-midnight start, not the previous evening's", () => {
    const vars = new Map<string, unknown>([["index:supply:2025-Q1", 0.1]]);
    const result = applyPricing(
      { type: "indexed", index_name: "supply", period_resolver: "current_quarter" },
      new Decimal(10),
      [],
      makeCtx(utcMidnight("2025-01-01"), vars),
    );
    expect(result.toString()).toBe("1");
  });

  it("resolves the month of a UTC-midnight start", () => {
    const vars = new Map<string, unknown>([["index:supply:2025-01", 0.1]]);
    const result = applyPricing(
      { type: "indexed", index_name: "supply", period_resolver: "current_month" },
      new Decimal(10),
      [],
      makeCtx(utcMidnight("2025-01-01"), vars),
    );
    expect(result.toString()).toBe("1");
  });

  it("resolves the year of a UTC-midnight start", () => {
    const vars = new Map<string, unknown>([["index:supply:2025", 0.1]]);
    const result = applyPricing(
      { type: "indexed", index_name: "supply", period_resolver: "current_year" },
      new Decimal(10),
      [],
      makeCtx(utcMidnight("2025-01-01"), vars),
    );
    expect(result.toString()).toBe("1");
  });
});

describe("applyPricing — unknown type", () => {
  it("throws clear error", () => {
    expect(() =>
      applyPricing(
        { type: "no_such_type" } as unknown as { type: string },
        new Decimal(0),
        [],
        makeCtx(),
      ),
    ).toThrow(/Unknown pricing type: no_such_type/);
  });
});
