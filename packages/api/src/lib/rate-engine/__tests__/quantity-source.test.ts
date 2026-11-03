import { describe, it, expect } from "vitest";
import { resolveQuantity } from "../evaluators/quantity-source.js";
import { Decimal } from "../decimal.js";
import { UnsupportedInSlice3Error } from "../types.js";
import type { RatingContext } from "../types.js";

function makeCtx(
  overrides: Partial<RatingContext["base"]> = {},
  vars: Map<string, unknown> = new Map(),
): RatingContext {
  return {
    base: {
      /*
       * The seasons every tenant was seeded with by the `season_sets`
       * migration — summer 1 May – 31 October, winter the rest — which
       * is exactly what the hard-coded `seasonOf()` these tests were
       * written against returned. Stated here so a `season` predicate
       * case still means what it meant.
       */
      seasons: [
        { seasonCode: "summer", startMonth: 5, startDay: 1, endMonth: 10, endDay: 31 },
        { seasonCode: "winter", startMonth: 11, startDay: 1, endMonth: 4, endDay: 30 },
      ],
      seasonSpanRule: "START_DATE" as const,
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
        startDate: new Date("2026-05-01"),
        endDate: new Date("2026-05-31"),
      },
      assignments: overrides.assignments ?? [],
    },
    vars,
  };
}

describe("resolveQuantity — bases", () => {
  it("metered reads from vars and returns Decimal", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-1", { quantity: "42.5" }],
    ]);
    const result = resolveQuantity({ base: "metered" }, makeCtx({}, vars));
    expect(result.toString()).toBe("42.5");
  });

  it("metered throws when meter:reads var is missing", () => {
    expect(() => resolveQuantity({ base: "metered" }, makeCtx())).toThrow(
      /requires meter:reads/,
    );
  });

  it("wqa reads from vars and returns Decimal", () => {
    const vars = new Map<string, unknown>([["wqa:current:sa-1", "12.34"]]);
    const result = resolveQuantity({ base: "wqa" }, makeCtx({}, vars));
    expect(result.toString()).toBe("12.34");
  });

  it("wqa throws when var is missing", () => {
    expect(() => resolveQuantity({ base: "wqa" }, makeCtx())).toThrow(
      /requires wqa:current/,
    );
  });

  it("premise_attribute reads eruCount via snake-to-camel mapping", () => {
    const ctx = makeCtx({
      premise: {
        id: "p-1",
        premiseType: "single_family",
        eruCount: new Decimal("3.5"),
        hasStormwaterInfra: false,
      },
    });
    const result = resolveQuantity(
      { base: "premise_attribute", source_attr: "premise.eru_count" },
      ctx,
    );
    expect(result.toString()).toBe("3.5");
  });

  it("premise_attribute returns 0 when value is null/undefined", () => {
    const result = resolveQuantity(
      { base: "premise_attribute", source_attr: "eru_count" },
      makeCtx(),
    );
    expect(result.toString()).toBe("0");
  });

  it("linked_commodity reads single linked:*:current_period var", () => {
    const vars = new Map<string, unknown>([
      ["linked:water:current_period", "100"],
    ]);
    const result = resolveQuantity({ base: "linked_commodity" }, makeCtx({}, vars));
    expect(result.toString()).toBe("100");
  });

  it("linked_commodity throws when no linked vars present", () => {
    expect(() =>
      resolveQuantity({ base: "linked_commodity" }, makeCtx()),
    ).toThrow(/requires a linked:\*:current_period/);
  });

  it("linked_commodity throws when multiple candidates ambiguous", () => {
    const vars = new Map<string, unknown>([
      ["linked:water:current_period", "100"],
      ["linked:sewer:current_period", "80"],
    ]);
    expect(() =>
      resolveQuantity({ base: "linked_commodity" }, makeCtx({}, vars)),
    ).toThrow(/ambiguous/);
  });

  it("item_count sums array lengths across multiple items:* keys", () => {
    const vars = new Map<string, unknown>([
      ["items:sp-1:cart", [1, 2, 3]],
      ["items:sp-2:cart", ["a", "b"]],
      ["items:sp-3:cart", []],
    ]);
    const result = resolveQuantity({ base: "item_count" }, makeCtx({}, vars));
    expect(result.toString()).toBe("5");
  });

  it("fixed returns 1", () => {
    const result = resolveQuantity({ base: "fixed" }, makeCtx());
    expect(result.toString()).toBe("1");
  });

  it("peak_demand throws UnsupportedInSlice3Error", () => {
    expect(() => resolveQuantity({ base: "peak_demand" }, makeCtx())).toThrow(
      UnsupportedInSlice3Error,
    );
  });

  it("unknown base throws clear error", () => {
    expect(() =>
      resolveQuantity({ base: "no_such_base" }, makeCtx()),
    ).toThrow(/Unknown quantity source base: no_such_base/);
  });
});

describe("resolveQuantity — transforms", () => {
  it("clamp with min only raises low values", () => {
    const vars = new Map<string, unknown>([["wqa:current:sa-1", "2"]]);
    const result = resolveQuantity(
      { base: "wqa", transforms: [{ type: "clamp", min: 5 }] },
      makeCtx({}, vars),
    );
    expect(result.toString()).toBe("5");
  });

  it("clamp with max only caps high values", () => {
    const vars = new Map<string, unknown>([["wqa:current:sa-1", "100"]]);
    const result = resolveQuantity(
      { base: "wqa", transforms: [{ type: "clamp", max: 50 }] },
      makeCtx({}, vars),
    );
    expect(result.toString()).toBe("50");
  });

  it("clamp with both min and max", () => {
    const vars = new Map<string, unknown>([["wqa:current:sa-1", "75"]]);
    const result = resolveQuantity(
      { base: "wqa", transforms: [{ type: "clamp", min: 10, max: 50 }] },
      makeCtx({}, vars),
    );
    expect(result.toString()).toBe("50");
  });

  it("prorate is identity for full standard month", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-1", { quantity: "30" }],
    ]);
    const ctx = makeCtx(
      {
        period: {
          startDate: new Date("2026-05-01"),
          endDate: new Date("2026-05-30"),
        },
      },
      vars,
    );
    const result = resolveQuantity(
      { base: "metered", transforms: [{ type: "prorate", standard_days: 30 }] },
      ctx,
    );
    expect(result.toString()).toBe("30");
  });

  it("prorate halves quantity for half month", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-1", { quantity: "30" }],
    ]);
    const ctx = makeCtx(
      {
        period: {
          startDate: new Date("2026-05-01"),
          endDate: new Date("2026-05-15"),
        },
      },
      vars,
    );
    const result = resolveQuantity(
      { base: "metered", transforms: [{ type: "prorate", standard_days: 30 }] },
      ctx,
    );
    expect(result.toString()).toBe("15");
  });

  it("net subtracts var when present", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-1", { quantity: "100" }],
      ["irrigation:deduct", 30],
    ]);
    const result = resolveQuantity(
      {
        base: "metered",
        transforms: [{ type: "net", subtract: "irrigation:deduct" }],
      },
      makeCtx({}, vars),
    );
    expect(result.toString()).toBe("70");
  });

  it("net clamps negative result to 0", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-1", { quantity: "10" }],
      ["irrigation:deduct", 50],
    ]);
    const result = resolveQuantity(
      {
        base: "metered",
        transforms: [{ type: "net", subtract: "irrigation:deduct" }],
      },
      makeCtx({}, vars),
    );
    expect(result.toString()).toBe("0");
  });

  it("subtract_linked_commodity subtracts linked qty", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-1", { quantity: "100" }],
      ["linked:water:current_period", 40],
    ]);
    const result = resolveQuantity(
      {
        base: "metered",
        transforms: [{ type: "subtract_linked_commodity", commodity_id: "water" }],
      },
      makeCtx({}, vars),
    );
    expect(result.toString()).toBe("60");
  });

  it("floor raises quantity to min", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-1", { quantity: "3" }],
    ]);
    const result = resolveQuantity(
      { base: "metered", transforms: [{ type: "floor", min: 10 }] },
      makeCtx({}, vars),
    );
    expect(result.toString()).toBe("10");
  });

  it("ratchet transform throws UnsupportedInSlice3Error", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-1", { quantity: "5" }],
    ]);
    expect(() =>
      resolveQuantity(
        { base: "metered", transforms: [{ type: "ratchet" }] },
        makeCtx({}, vars),
      ),
    ).toThrow(UnsupportedInSlice3Error);
  });

  it("unknown transform type throws clear error", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-1", { quantity: "5" }],
    ]);
    expect(() =>
      resolveQuantity(
        { base: "metered", transforms: [{ type: "bogus_transform" }] },
        makeCtx({}, vars),
      ),
    ).toThrow(/Unknown quantity transform type: bogus_transform/);
  });

  it("Decimal precision: 0.1 + 0.2 doesn't drift", () => {
    // Net of two decimals should be exact, not the float 0.30000000000000004.
    const vars = new Map<string, unknown>([
      ["meter:reads:m-1", { quantity: "0.3" }],
      ["adj", "0.1"],
    ]);
    const result = resolveQuantity(
      {
        base: "metered",
        transforms: [{ type: "net", subtract: "adj" }],
      },
      makeCtx({}, vars),
    );
    expect(result.toString()).toBe("0.2");
  });
});

describe("tou_period base (spec 26, TOU-ENG-1)", () => {
  /**
   * Each TOU period is its own charge with its own price and its own
   * bill line, which is how tariffs are written and how bills read. So
   * the component names the period whose quantity it prices, and the
   * quantity *is* that period's usage — read from where it lives, not
   * derived from the total.
   *
   * That is why this is a base and not the `tou_window_filter`
   * transform the grammar first sketched: on-peak kWh cannot be
   * computed from total kWh, so such a transform would have to ignore
   * its own input.
   */

  const bucket = (quantity: string | number, unit?: string) => ({ quantity, unit });

  it("prices the named period's usage", () => {
    const vars = new Map<string, unknown>([
      ["meter:tou:m-1:peak", bucket(120, "kWh")],
      ["meter:tou:m-1:off_peak", bucket(680, "kWh")],
    ]);
    const result = resolveQuantity({ base: "tou_period", peak_code: "peak" }, makeCtx({}, vars));
    expect(result.toString()).toBe("120");
  });

  it("bills a period with no usage as zero rather than raising", () => {
    // A customer who used nothing on-peak owes nothing on-peak. The
    // bucket exists and reads zero, which is a different thing from the
    // bucket being absent.
    const vars = new Map<string, unknown>([["meter:tou:m-1:peak", bucket(0, "kWh")]]);
    const result = resolveQuantity({ base: "tou_period", peak_code: "peak" }, makeCtx({}, vars));
    expect(result.toString()).toBe("0");
  });

  it("raises when the period's bucket is absent", () => {
    /*
     * **The contract that closes the silent-zero failure.** The loader
     * emits a bucket for every period in the calendar, zero included,
     * so an absent one means the TOU data did not load. Returning zero
     * here would bill a TOU customer nothing for their on-peak usage
     * and look like a quiet month.
     */
    const vars = new Map<string, unknown>([["meter:tou:m-1:off_peak", bucket(680, "kWh")]]);
    expect(() =>
      resolveQuantity({ base: "tou_period", peak_code: "peak" }, makeCtx({}, vars)),
    ).toThrow(/meter:tou:.*peak/);
  });

  it("requires the component to name a period", () => {
    expect(() => resolveQuantity({ base: "tou_period" }, makeCtx({}, new Map()))).toThrow(
      /peak_code/,
    );
  });

  it("does not confuse one period's code with another's", () => {
    /*
     * `peak`, `mid_peak`, `off_peak` and `super_off_peak` all end in
     * "peak". Matching the key by suffix would have the on-peak charge
     * price the off-peak usage — at roughly twice the rate, on every
     * TOU bill, with nothing raised.
     */
    const vars = new Map<string, unknown>([
      ["meter:tou:m-1:peak", bucket(10, "kWh")],
      ["meter:tou:m-1:mid_peak", bucket(200, "kWh")],
      ["meter:tou:m-1:off_peak", bucket(300, "kWh")],
      ["meter:tou:m-1:super_off_peak", bucket(400, "kWh")],
    ]);
    const ctx = makeCtx({}, vars);
    expect(resolveQuantity({ base: "tou_period", peak_code: "peak" }, ctx).toString()).toBe("10");
    expect(resolveQuantity({ base: "tou_period", peak_code: "mid_peak" }, ctx).toString()).toBe("200");
    expect(resolveQuantity({ base: "tou_period", peak_code: "off_peak" }, ctx).toString()).toBe("300");
    expect(
      resolveQuantity({ base: "tou_period", peak_code: "super_off_peak" }, ctx).toString(),
    ).toBe("400");
  });

  it("sums the period across an agreement's meters", () => {
    // An agreement with two meters owes the sum of their on-peak usage.
    const vars = new Map<string, unknown>([
      ["meter:tou:m-1:peak", bucket(120, "kWh")],
      ["meter:tou:m-2:peak", bucket(80, "kWh")],
    ]);
    const result = resolveQuantity({ base: "tou_period", peak_code: "peak" }, makeCtx({}, vars));
    expect(result.toString()).toBe("200");
  });

  it("converts each meter into the pricing unit before summing", () => {
    // Two meters in different units cannot simply be added. 1 MWh is
    // 1000 kWh, so this is 1120 and not 121.
    const vars = new Map<string, unknown>([
      ["meter:tou:m-1:peak", bucket(120, "kWh")],
      ["meter:tou:m-2:peak", bucket(1, "MWh")],
    ]);
    const result = resolveQuantity(
      { base: "tou_period", peak_code: "peak" },
      makeCtx({}, vars),
      "kWh",
    );
    expect(result.toString()).toBe("1120");
  });

  it("keeps decimal precision when summing meters", () => {
    const vars = new Map<string, unknown>([
      ["meter:tou:m-1:peak", bucket("0.1", "kWh")],
      ["meter:tou:m-2:peak", bucket("0.2", "kWh")],
    ]);
    const result = resolveQuantity({ base: "tou_period", peak_code: "peak" }, makeCtx({}, vars));
    expect(result.toString()).toBe("0.3");
  });

  it("still applies transforms, so a TOU quantity can be prorated", () => {
    const vars = new Map<string, unknown>([["meter:tou:m-1:peak", bucket(100, "kWh")]]);
    const result = resolveQuantity(
      {
        base: "tou_period",
        peak_code: "peak",
        transforms: [{ type: "clamp", max: 60 }],
      },
      makeCtx({}, vars),
    );
    expect(result.toString()).toBe("60");
  });
});
