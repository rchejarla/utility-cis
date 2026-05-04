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
