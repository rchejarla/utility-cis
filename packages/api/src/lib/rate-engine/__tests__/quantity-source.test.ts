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
