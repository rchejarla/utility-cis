import { describe, it, expect } from "vitest";
import { rate } from "../rate.js";
import type {
  RatingContext,
  RateComponentSnapshot,
  ResolvedAssignment,
} from "../types.js";

function mkComponent(overrides: Partial<RateComponentSnapshot>): RateComponentSnapshot {
  return {
    id: overrides.id ?? "c-1",
    rateScheduleId: overrides.rateScheduleId ?? "rs-1",
    kindCode: overrides.kindCode ?? "service_charge",
    label: overrides.label ?? "Service Charge",
    predicate: overrides.predicate ?? {},
    quantitySource: overrides.quantitySource ?? { base: "fixed" },
    pricing: overrides.pricing ?? { type: "flat", rate: 22.31 },
    sortOrder: overrides.sortOrder ?? 10,
    effectiveDate: overrides.effectiveDate ?? new Date(2025, 8, 15),
    expirationDate: overrides.expirationDate ?? null,
  };
}

function mkAssignment(
  scheduleId: string,
  components: RateComponentSnapshot[],
  roleCode = "primary",
  effectiveDate: Date = new Date(2025, 8, 15),
  expirationDate: Date | null = null,
): ResolvedAssignment {
  return {
    id: `a-${scheduleId}`,
    rateScheduleId: scheduleId,
    roleCode,
    effectiveDate,
    expirationDate,
    schedule: {
      id: scheduleId,
      name: scheduleId,
      code: scheduleId,
      version: 1,
      components,
    },
  };
}

function mkCtx(
  assignments: ResolvedAssignment[],
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
      },
      account: { id: "a-1", accountNumber: "A-1" },
      premise: {
        id: "p-1",
        premiseType: "single_family",
        eruCount: null,
        hasStormwaterInfra: false,
      },
      period: { startDate: new Date(2026, 4, 1), endDate: new Date(2026, 4, 31) },
      assignments,
    },
    vars,
  };
}

describe("rate orchestrator", () => {
  it("returns empty result when no assignments", () => {
    const result = rate(mkCtx([]));
    expect(result.lines).toEqual([]);
    expect(result.totals.subtotal.toNumber()).toBe(0);
    expect(result.totals.taxes.toNumber()).toBe(0);
    expect(result.totals.credits.toNumber()).toBe(0);
    expect(result.totals.total.toNumber()).toBe(0);
    expect(result.totals.minimumFloorApplied).toBe(false);
    expect(result.trace).toEqual([]);
  });

  it("evaluates a single service_charge component", () => {
    const c = mkComponent({
      id: "sc-1",
      pricing: { type: "flat", rate: 22.31 },
    });
    const result = rate(mkCtx([mkAssignment("rs-1", [c])]));
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.amount.toNumber()).toBe(22.31);
    expect(result.lines[0]!.sourceScheduleId).toBe("rs-1");
    expect(result.lines[0]!.sourceComponentId).toBe("sc-1");
    expect(result.totals.subtotal.toNumber()).toBe(22.31);
    expect(result.totals.total.toNumber()).toBe(22.31);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]!.fired).toBe(true);
  });

  it("traces a component skipped by predicate_false", () => {
    const c1 = mkComponent({
      id: "sc-1",
      pricing: { type: "flat", rate: 10 },
    });
    const c2 = mkComponent({
      id: "sc-2",
      sortOrder: 20,
      pricing: { type: "flat", rate: 5 },
      predicate: { class: "commercial" }, // not single_family
    });
    const result = rate(mkCtx([mkAssignment("rs-1", [c1, c2])]));
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.sourceComponentId).toBe("sc-1");
    const skipped = result.trace.find((t) => t.componentId === "sc-2");
    expect(skipped?.skipReason).toBe("predicate_false");
    expect(skipped?.fired).toBe(false);
  });

  it("applies minimum_bill when subtotal under floor", () => {
    const sc = mkComponent({
      id: "sc-1",
      pricing: { type: "flat", rate: 5 },
    });
    const min = mkComponent({
      id: "min-1",
      kindCode: "minimum_bill",
      label: "Minimum Bill",
      sortOrder: 1000,
      pricing: { type: "floor", amount: 10 },
    });
    const result = rate(mkCtx([mkAssignment("rs-1", [sc, min])]));
    expect(result.lines).toHaveLength(2);
    const adjustment = result.lines.find((l) => l.kindCode === "minimum_bill");
    expect(adjustment).toBeDefined();
    expect(adjustment!.amount.toNumber()).toBe(5); // 10 - 5
    expect(result.totals.minimumFloorApplied).toBe(true);
    expect(result.totals.subtotal.toNumber()).toBe(10); // 5 + 5
  });

  it("does not emit minimum_bill line when subtotal exceeds floor", () => {
    const sc = mkComponent({
      id: "sc-1",
      pricing: { type: "flat", rate: 25 },
    });
    const min = mkComponent({
      id: "min-1",
      kindCode: "minimum_bill",
      label: "Minimum Bill",
      sortOrder: 1000,
      pricing: { type: "floor", amount: 10 },
    });
    const result = rate(mkCtx([mkAssignment("rs-1", [sc, min])]));
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.kindCode).toBe("service_charge");
    expect(result.totals.minimumFloorApplied).toBe(false);
  });

  it("evaluates percent_of after its target consumption line", () => {
    const consumption = mkComponent({
      id: "cons-1",
      kindCode: "consumption",
      label: "Consumption",
      sortOrder: 100,
      quantitySource: { base: "metered" },
      pricing: { type: "flat", rate: 4 }, // 10 units * $4 = $40
    });
    const surcharge = mkComponent({
      id: "sur-1",
      kindCode: "fee",
      label: "Surcharge",
      sortOrder: 50, // before in sortOrder, but topo sort should defer it
      pricing: {
        type: "percent_of",
        percent: 10,
        selector: { kind: "consumption" },
      },
    });
    const vars = new Map<string, unknown>();
    vars.set("meter:reads:m-1", { quantity: 10 });
    const result = rate(mkCtx([mkAssignment("rs-1", [surcharge, consumption])], vars));
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]!.sourceComponentId).toBe("cons-1");
    expect(result.lines[0]!.amount.toNumber()).toBe(40);
    expect(result.lines[1]!.sourceComponentId).toBe("sur-1");
    expect(result.lines[1]!.amount.toNumber()).toBe(4); // 10% of 40
  });

  it("filters out components outside the bill period", () => {
    const inScope = mkComponent({
      id: "in-1",
      pricing: { type: "flat", rate: 10 },
      effectiveDate: new Date(2025, 0, 1),
      expirationDate: null,
    });
    const expired = mkComponent({
      id: "exp-1",
      pricing: { type: "flat", rate: 99 },
      effectiveDate: new Date(2024, 0, 1),
      expirationDate: new Date(2024, 11, 31),
    });
    const future = mkComponent({
      id: "fut-1",
      pricing: { type: "flat", rate: 99 },
      effectiveDate: new Date(2030, 0, 1),
      expirationDate: null,
    });
    const result = rate(mkCtx([mkAssignment("rs-1", [inScope, expired, future])]));
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.sourceComponentId).toBe("in-1");
    // Components outside period don't appear in trace at all
    expect(result.trace.find((t) => t.componentId === "exp-1")).toBeUndefined();
    expect(result.trace.find((t) => t.componentId === "fut-1")).toBeUndefined();
  });

  it("filters out assignments outside the bill period", () => {
    const c = mkComponent({ id: "c-1", pricing: { type: "flat", rate: 10 } });
    const activeAssignment = mkAssignment("rs-active", [c]);
    const expiredAssignment = mkAssignment(
      "rs-expired",
      [mkComponent({ id: "c-2", pricing: { type: "flat", rate: 99 } })],
      "primary",
      new Date(2024, 0, 1),
      new Date(2024, 11, 31),
    );
    const result = rate(mkCtx([activeAssignment, expiredAssignment]));
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.sourceScheduleId).toBe("rs-active");
  });

  it("places tax line into taxes total, not subtotal", () => {
    const consumption = mkComponent({
      id: "cons-1",
      kindCode: "consumption",
      label: "Consumption",
      sortOrder: 100,
      pricing: { type: "flat", rate: 100 },
    });
    const tax = mkComponent({
      id: "tax-1",
      kindCode: "tax",
      label: "Sales Tax",
      sortOrder: 200,
      pricing: {
        type: "percent_of",
        percent: 5,
        selector: { kind: "consumption" },
      },
    });
    const result = rate(mkCtx([mkAssignment("rs-1", [consumption, tax])]));
    expect(result.totals.subtotal.toNumber()).toBe(100);
    expect(result.totals.taxes.toNumber()).toBe(5);
    expect(result.totals.total.toNumber()).toBe(105);
  });

  it("places credit line into credits total, not subtotal", () => {
    const consumption = mkComponent({
      id: "cons-1",
      kindCode: "consumption",
      label: "Consumption",
      sortOrder: 100,
      pricing: { type: "flat", rate: 100 },
    });
    const credit = mkComponent({
      id: "cred-1",
      kindCode: "credit",
      label: "Senior Discount",
      sortOrder: 200,
      pricing: { type: "flat", rate: -5 },
    });
    const result = rate(mkCtx([mkAssignment("rs-1", [consumption, credit])]));
    expect(result.totals.subtotal.toNumber()).toBe(100);
    expect(result.totals.credits.toNumber()).toBe(-5);
    expect(result.totals.total.toNumber()).toBe(95);
  });

  it("limits minimum_bill scope when selector is provided", () => {
    // service_charge contributes $5, consumption contributes $2.
    // floor of $10 is scoped only to consumption: subtotal=$2, adjustment=$8.
    const sc = mkComponent({
      id: "sc-1",
      kindCode: "service_charge",
      label: "Service Charge",
      sortOrder: 50,
      pricing: { type: "flat", rate: 5 },
    });
    const cons = mkComponent({
      id: "cons-1",
      kindCode: "consumption",
      label: "Consumption",
      sortOrder: 100,
      pricing: { type: "flat", rate: 2 },
    });
    const min = mkComponent({
      id: "min-1",
      kindCode: "minimum_bill",
      label: "Min Consumption",
      sortOrder: 1000,
      pricing: {
        type: "floor",
        amount: 10,
        selector: { kind: "consumption" },
      },
    });
    const result = rate(mkCtx([mkAssignment("rs-1", [sc, cons, min])]));
    const adjustment = result.lines.find((l) => l.kindCode === "minimum_bill");
    expect(adjustment).toBeDefined();
    expect(adjustment!.amount.toNumber()).toBe(8); // 10 - 2 (only consumption in scope)
    expect(result.totals.minimumFloorApplied).toBe(true);
  });
});
