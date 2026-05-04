import { describe, it, expect } from "vitest";
import { evaluatePredicate } from "../evaluators/predicate.js";
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
        startDate: new Date(2026, 4, 1),
        endDate: new Date(2026, 4, 31),
      },
      assignments: overrides.assignments ?? [],
    },
    vars,
  };
}

describe("evaluatePredicate", () => {
  it("returns true for empty predicate {}", () => {
    expect(evaluatePredicate({}, makeCtx())).toBe(true);
  });

  it("and returns true when all subpredicates are true", () => {
    const pred = { and: [{ class: "single_family" }, {}] };
    expect(evaluatePredicate(pred, makeCtx())).toBe(true);
  });

  it("and returns false (short-circuits) when any subpredicate is false", () => {
    const pred = { and: [{ class: "single_family" }, { class: "commercial" }] };
    expect(evaluatePredicate(pred, makeCtx())).toBe(false);
  });

  it("or returns true (short-circuits) when any subpredicate is true", () => {
    const pred = { or: [{ class: "commercial" }, { class: "single_family" }] };
    expect(evaluatePredicate(pred, makeCtx())).toBe(true);
  });

  it("or returns false when all subpredicates are false", () => {
    const pred = { or: [{ class: "commercial" }, { class: "industrial" }] };
    expect(evaluatePredicate(pred, makeCtx())).toBe(false);
  });

  it("not inverts inner predicate", () => {
    expect(evaluatePredicate({ not: { class: "commercial" } }, makeCtx())).toBe(true);
    expect(evaluatePredicate({ not: { class: "single_family" } }, makeCtx())).toBe(false);
  });

  it("class matches when SA rateServiceClassCode equals value", () => {
    expect(evaluatePredicate({ class: "single_family" }, makeCtx())).toBe(true);
  });

  it("class returns false when SA rateServiceClassCode mismatches", () => {
    expect(evaluatePredicate({ class: "commercial" }, makeCtx())).toBe(false);
  });

  it("class_in matches when SA class is in list", () => {
    expect(
      evaluatePredicate({ class_in: ["single_family", "multi_family"] }, makeCtx()),
    ).toBe(true);
  });

  it("class_in returns false when SA class not in list", () => {
    expect(
      evaluatePredicate({ class_in: ["commercial", "industrial"] }, makeCtx()),
    ).toBe(false);
  });

  it("eq with two literals", () => {
    expect(
      evaluatePredicate({ eq: { left: "a", right: "a" } }, makeCtx()),
    ).toBe(true);
    expect(
      evaluatePredicate({ eq: { left: "a", right: "b" } }, makeCtx()),
    ).toBe(false);
  });

  it("eq with a {var} reference resolves from ctx.vars", () => {
    const vars = new Map<string, unknown>([["account:flag:autopay", true]]);
    const pred = { eq: { left: { var: "account:flag:autopay" }, right: true } };
    expect(evaluatePredicate(pred, makeCtx({}, vars))).toBe(true);
  });

  it("ne returns true when values differ", () => {
    expect(
      evaluatePredicate({ ne: { left: "a", right: "b" } }, makeCtx()),
    ).toBe(true);
  });

  it("in returns true when value is in set", () => {
    const vars = new Map<string, unknown>([["x", 5]]);
    const pred = { in: { value: { var: "x" }, set: [1, 5, 10] } };
    expect(evaluatePredicate(pred, makeCtx({}, vars))).toBe(true);
  });

  it("meter_size looks up var by inferred meter id", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-7", 1234],
      ["meter:size:m-7", "0.75"],
    ]);
    expect(evaluatePredicate({ meter_size: "0.75" }, makeCtx({}, vars))).toBe(true);
    expect(evaluatePredicate({ meter_size: "1.0" }, makeCtx({}, vars))).toBe(false);
  });

  it("meter_size_in matches list lookup", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-9", 100],
      ["meter:size:m-9", "1.0"],
    ]);
    expect(
      evaluatePredicate({ meter_size_in: ["0.75", "1.0"] }, makeCtx({}, vars)),
    ).toBe(true);
  });

  it("season returns 'summer' for May start", () => {
    const ctx = makeCtx({
      period: { startDate: new Date(2026, 4, 1), endDate: new Date(2026, 4, 31) },
    });
    expect(evaluatePredicate({ season: "summer" }, ctx)).toBe(true);
    expect(evaluatePredicate({ season: "winter" }, ctx)).toBe(false);
  });

  it("season returns 'winter' for January start", () => {
    const ctx = makeCtx({
      period: { startDate: new Date(2026, 0, 1), endDate: new Date(2026, 0, 31) },
    });
    expect(evaluatePredicate({ season: "winter" }, ctx)).toBe(true);
    expect(evaluatePredicate({ season: "summer" }, ctx)).toBe(false);
  });

  it("drought_stage_active: true matches when var is truthy", () => {
    const vars = new Map<string, unknown>([["tenant:drought_stage", 2]]);
    expect(
      evaluatePredicate({ drought_stage_active: true }, makeCtx({}, vars)),
    ).toBe(true);
  });

  it("drought_stage_active: false matches when var is 0 or unset", () => {
    const zeroVars = new Map<string, unknown>([["tenant:drought_stage", 0]]);
    expect(
      evaluatePredicate({ drought_stage_active: false }, makeCtx({}, zeroVars)),
    ).toBe(true);
    expect(
      evaluatePredicate({ drought_stage_active: false }, makeCtx({}, new Map())),
    ).toBe(true);
  });

  it("premise_attr with eq match", () => {
    const ctx = makeCtx({
      premise: {
        id: "p-1",
        premiseType: "single_family",
        eruCount: null,
        hasStormwaterInfra: true,
      },
    });
    expect(
      evaluatePredicate(
        { premise_attr: { attr: "hasStormwaterInfra", eq: true } },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        { premise_attr: { attr: "hasStormwaterInfra", eq: false } },
        ctx,
      ),
    ).toBe(false);
  });

  it("meter_role with eq compares role var", () => {
    const vars = new Map<string, unknown>([
      ["meter:reads:m-1", 100],
      ["meter:role:m-1", "domestic"],
    ]);
    expect(
      evaluatePredicate({ meter_role: { eq: "domestic" } }, makeCtx({}, vars)),
    ).toBe(true);
    expect(
      evaluatePredicate({ meter_role: { eq: "irrigation" } }, makeCtx({}, vars)),
    ).toBe(false);
  });

  it("qty_gte reads var and compares", () => {
    const vars = new Map<string, unknown>([["usage:water:total", 1500]]);
    expect(
      evaluatePredicate(
        { qty_gte: { var: "usage:water:total", value: 1000 } },
        makeCtx({}, vars),
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        { qty_gte: { var: "usage:water:total", value: 2000 } },
        makeCtx({}, vars),
      ),
    ).toBe(false);
  });

  it("qty_lte reads var and compares", () => {
    const vars = new Map<string, unknown>([["usage:water:total", 500]]);
    expect(
      evaluatePredicate(
        { qty_lte: { var: "usage:water:total", value: 1000 } },
        makeCtx({}, vars),
      ),
    ).toBe(true);
  });

  it("customer_attr reads account:flag:* and compares", () => {
    const vars = new Map<string, unknown>([["account:flag:senior", true]]);
    expect(
      evaluatePredicate(
        { customer_attr: { attr: "senior", eq: true } },
        makeCtx({}, vars),
      ),
    ).toBe(true);
    // boolean fallback when no eq
    expect(
      evaluatePredicate({ customer_attr: { attr: "senior" } }, makeCtx({}, vars)),
    ).toBe(true);
  });

  it("period returns true within range, false outside", () => {
    const ctx = makeCtx({
      period: { startDate: new Date(2026, 4, 1), endDate: new Date(2026, 4, 31) },
    });
    expect(
      evaluatePredicate({ period: { from: "2026-01-01", to: "2026-12-31" } }, ctx),
    ).toBe(true);
    expect(
      evaluatePredicate({ period: { from: "2026-06-01" } }, ctx),
    ).toBe(false);
    expect(
      evaluatePredicate({ period: { to: "2026-04-30" } }, ctx),
    ).toBe(false);
  });

  it("tou_window throws UnsupportedInSlice3Error", () => {
    expect(() => evaluatePredicate({ tou_window: "peak" }, makeCtx())).toThrow(
      UnsupportedInSlice3Error,
    );
  });

  it("unknown operator throws clear error", () => {
    expect(() =>
      evaluatePredicate({ no_such_op: true } as unknown as Record<string, unknown>, makeCtx()),
    ).toThrow(/Unknown predicate operator: no_such_op/);
  });

  it("multi-key predicate throws", () => {
    expect(() =>
      evaluatePredicate(
        { class: "single_family", season: "summer" } as unknown as Record<string, unknown>,
        makeCtx(),
      ),
    ).toThrow(/exactly one operator key/);
  });
});
