import { describe, it, expect } from "vitest";
import { rate } from "../rate.js";
import { manifest } from "../manifest.js";
import { ZERO } from "../decimal.js";
import type {
  RateComponentSnapshot,
  ResolvedAssignment,
  RatingContext,
  BaseContext,
} from "../types.js";

const SCHEDULE_ID = "rs-prop";
const EFF_DATE = new Date(2025, 8, 15);

function mkComponent(overrides: Partial<RateComponentSnapshot>): RateComponentSnapshot {
  return {
    id: overrides.id ?? "c-1",
    rateScheduleId: overrides.rateScheduleId ?? SCHEDULE_ID,
    kindCode: overrides.kindCode ?? "service_charge",
    label: overrides.label ?? "Charge",
    predicate: overrides.predicate ?? {},
    quantitySource: overrides.quantitySource ?? { base: "fixed" },
    pricing: overrides.pricing ?? { type: "flat", rate: 1 },
    sortOrder: overrides.sortOrder ?? 10,
    effectiveDate: overrides.effectiveDate ?? EFF_DATE,
    expirationDate: overrides.expirationDate ?? null,
  };
}

function mkAssignment(components: RateComponentSnapshot[]): ResolvedAssignment {
  return {
    id: `a-${SCHEDULE_ID}`,
    rateScheduleId: SCHEDULE_ID,
    roleCode: "primary",
    effectiveDate: EFF_DATE,
    expirationDate: null,
    schedule: {
      id: SCHEDULE_ID,
      name: "Property Test Schedule",
      code: "PROP",
      version: 1,
      components,
    },
  };
}

function mkBase(
  components: RateComponentSnapshot[],
  vars?: Map<string, unknown>,
): RatingContext {
  return {
    base: {
      sa: {
        id: "sa-1",
        utilityId: "u-1",
        accountId: "a-1",
        premiseId: "p-1",
        commodityId: "c-water",
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
      assignments: [mkAssignment(components)],
    },
    vars: vars ?? new Map<string, unknown>(),
  };
}

function mkBaseContext(
  components: RateComponentSnapshot[],
): BaseContext {
  return {
    sa: {
      id: "sa-1",
      utilityId: "u-1",
      accountId: "a-1",
      premiseId: "p-1",
      commodityId: "c-water",
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
    assignments: [mkAssignment(components)],
  };
}

describe("Rate engine — property tests", () => {
  it("rate(ctx) is deterministic — same input twice yields equal lines + totals", () => {
    const components = [
      mkComponent({
        id: "c-service",
        kindCode: "service_charge",
        label: "Service",
        pricing: { type: "flat", rate: 5 },
      }),
      mkComponent({
        id: "c-usage",
        kindCode: "consumption",
        label: "Usage",
        sortOrder: 20,
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 2.5, unit: "HCF" },
      }),
    ];
    const vars = new Map<string, unknown>([
      ["meter:reads:M-1", { quantity: 10, unit: "HCF" }],
    ]);

    const first = rate(mkBase(components, vars));
    const second = rate(mkBase(components, vars));

    expect(first.lines.length).toBe(second.lines.length);
    expect(first.totals.subtotal.toString()).toBe(second.totals.subtotal.toString());
    expect(first.totals.taxes.toString()).toBe(second.totals.taxes.toString());
    expect(first.totals.credits.toString()).toBe(second.totals.credits.toString());
    expect(first.totals.total.toString()).toBe(second.totals.total.toString());
    for (let i = 0; i < first.lines.length; i++) {
      const a = first.lines[i]!;
      const b = second.lines[i]!;
      expect(a.label).toBe(b.label);
      expect(a.kindCode).toBe(b.kindCode);
      expect(a.sourceComponentId).toBe(b.sourceComponentId);
      expect(a.amount.toString()).toBe(b.amount.toString());
    }
  });

  it("total is non-negative when all components are positive flat charges", () => {
    const components = [
      mkComponent({
        id: "c-svc",
        kindCode: "service_charge",
        label: "Service",
        pricing: { type: "flat", rate: 12.5 },
      }),
      mkComponent({
        id: "c-surcharge",
        kindCode: "surcharge",
        label: "Surcharge",
        sortOrder: 30,
        pricing: { type: "flat", rate: 3.4 },
      }),
      mkComponent({
        id: "c-usage",
        kindCode: "consumption",
        label: "Usage",
        sortOrder: 20,
        quantitySource: { base: "metered" },
        pricing: { type: "flat", rate: 1.25, unit: "HCF" },
      }),
    ];
    const vars = new Map<string, unknown>([
      ["meter:reads:M-1", { quantity: 8, unit: "HCF" }],
    ]);

    const result = rate(mkBase(components, vars));

    expect(result.totals.total.gte(ZERO)).toBe(true);
    expect(result.totals.subtotal.gte(ZERO)).toBe(true);
  });

  it("kindCode=credit lines have negative amount when percent_of percent is negative", () => {
    const components = [
      mkComponent({
        id: "c-base",
        kindCode: "non_meter",
        label: "Base Charge",
        sortOrder: 10,
        pricing: { type: "flat", rate: 10 },
      }),
      mkComponent({
        id: "c-credit",
        kindCode: "credit",
        label: "Discount",
        sortOrder: 20,
        pricing: {
          type: "percent_of",
          selector: { kind: "non_meter" },
          percent: -45,
        },
      }),
    ];

    const result = rate(mkBase(components));

    const creditLines = result.lines.filter((l) => l.kindCode === "credit");
    expect(creditLines).toHaveLength(1);
    for (const l of creditLines) {
      expect(l.amount.lt(ZERO)).toBe(true);
    }
    // credit should be exactly -$4.50
    expect(creditLines[0]!.amount.toFixed(2)).toBe("-4.50");
  });

  it("minimum_bill adjustment equals (floor - existingSubtotal) exactly", () => {
    const components = [
      mkComponent({
        id: "c-tiny",
        kindCode: "service_charge",
        label: "Tiny Service",
        sortOrder: 10,
        pricing: { type: "flat", rate: 2.5 },
      }),
      mkComponent({
        id: "c-min",
        kindCode: "minimum_bill",
        label: "Minimum Bill Floor",
        sortOrder: 90,
        pricing: { type: "floor", amount: 10, applies_to_subtotal: true },
      }),
    ];

    const result = rate(mkBase(components));

    // existing subtotal before minimum_bill = 2.5; floor = 10; adjustment = 7.5
    expect(result.totals.minimumFloorApplied).toBe(true);
    const adjustmentLine = result.lines.find((l) => l.kindCode === "minimum_bill")!;
    expect(adjustmentLine).toBeDefined();
    expect(adjustmentLine.amount.toFixed(2)).toBe("7.50");
    // total subtotal must equal floor exactly
    expect(result.totals.subtotal.toFixed(2)).toBe("10.00");
  });

  it("manifest(base) is deterministic — repeated calls return identical sorted arrays", () => {
    const components = [
      mkComponent({
        id: "c-1",
        predicate: { drought_stage_active: 1 },
        quantitySource: { base: "wqa" },
      }),
      mkComponent({
        id: "c-2",
        sortOrder: 20,
        pricing: {
          type: "indexed",
          index_name: "ppi",
          period_resolver: "current_quarter",
        },
      }),
    ];
    const base = mkBaseContext(components);

    const first = manifest(base);
    const second = manifest(base);

    expect(first).toEqual(second);
    // sorted alphabetically
    const sorted = [...first].sort();
    expect(first).toEqual(sorted);
  });

  it("manifest(base) returns distinct keys when multiple components reference the same var", () => {
    const components = [
      mkComponent({
        id: "c-a",
        predicate: { drought_stage_active: 1 },
      }),
      mkComponent({
        id: "c-b",
        sortOrder: 20,
        predicate: { drought_stage_active: 2 },
      }),
      mkComponent({
        id: "c-c",
        sortOrder: 30,
        predicate: { drought_stage_active: 3 },
      }),
    ];
    const base = mkBaseContext(components);

    const keys = manifest(base);

    expect(keys).toContain("tenant:drought_stage");
    expect(new Set(keys).size).toBe(keys.length);
  });
});
