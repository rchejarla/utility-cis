import { describe, it, expect } from "vitest";
import { manifest } from "../manifest.js";
import type {
  BaseContext,
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
    pricing: overrides.pricing ?? { type: "flat", rate: 1 },
    sortOrder: overrides.sortOrder ?? 10,
    effectiveDate: overrides.effectiveDate ?? new Date(2025, 8, 15),
    expirationDate: overrides.expirationDate ?? null,
  };
}

function mkAssignment(
  scheduleId: string,
  components: RateComponentSnapshot[],
): ResolvedAssignment {
  return {
    id: `a-${scheduleId}`,
    rateScheduleId: scheduleId,
    roleCode: "primary",
    effectiveDate: new Date(2025, 8, 15),
    expirationDate: null,
    schedule: {
      id: scheduleId,
      name: scheduleId,
      code: scheduleId,
      version: 1,
      components,
    },
  };
}

function mkBase(
  assignments: ResolvedAssignment[],
  periodStart: Date = new Date(2026, 4, 1), // May 2026 = Q2
): BaseContext {
  return {
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
    period: {
      startDate: periodStart,
      endDate: new Date(periodStart.getFullYear(), periodStart.getMonth(), 28),
    },
    assignments,
  };
}

describe("manifest()", () => {
  it("returns empty array when no assignments", () => {
    expect(manifest(mkBase([]))).toEqual([]);
  });

  it("collects tenant:drought_stage from drought_stage_active predicate", () => {
    const c = mkComponent({ predicate: { drought_stage_active: 2 } });
    const keys = manifest(mkBase([mkAssignment("rs-1", [c])]));
    expect(keys).toEqual(["tenant:drought_stage"]);
  });

  it("collects wqa:current:<sa_id> from wqa quantity source", () => {
    const c = mkComponent({ quantitySource: { base: "wqa" } });
    const keys = manifest(mkBase([mkAssignment("rs-1", [c])]));
    expect(keys).toEqual(["wqa:current:sa-1"]);
  });

  it("resolves indexed pricing with current_quarter to YYYY-Qn", () => {
    const c = mkComponent({
      pricing: {
        type: "indexed",
        index_name: "ppi_water",
        period_resolver: "current_quarter",
      },
    });
    // May 2026 = month index 4 → Q2
    const keys = manifest(mkBase([mkAssignment("rs-1", [c])]));
    expect(keys).toEqual(["index:ppi_water:2026-Q2"]);
  });

  it("resolves indexed pricing with current_month to YYYY-MM", () => {
    const c = mkComponent({
      pricing: {
        type: "indexed",
        index_name: "cpi",
        period_resolver: "current_month",
      },
    });
    const keys = manifest(mkBase([mkAssignment("rs-1", [c])], new Date(2026, 0, 15)));
    expect(keys).toEqual(["index:cpi:2026-01"]);
  });

  it("resolves indexed pricing with fixed period", () => {
    const c = mkComponent({
      pricing: {
        type: "indexed",
        index_name: "ppi_water",
        period_resolver: "fixed",
        fixed_period: "2025-Q4",
      },
    });
    const keys = manifest(mkBase([mkAssignment("rs-1", [c])]));
    expect(keys).toEqual(["index:ppi_water:2025-Q4"]);
  });

  it("collects net.subtract var from quantity-source transforms", () => {
    const c = mkComponent({
      quantitySource: {
        base: "metered",
        transforms: [{ type: "net", subtract: "irrigation:credit:sa-1" }],
      },
    });
    const keys = manifest(mkBase([mkAssignment("rs-1", [c])]));
    expect(keys).toEqual(["irrigation:credit:sa-1"]);
  });

  it("collects linked:<commodity_id>:current_period from subtract_linked_commodity", () => {
    const c = mkComponent({
      quantitySource: {
        base: "metered",
        transforms: [
          { type: "subtract_linked_commodity", commodity_id: "comm-water" },
        ],
      },
    });
    const keys = manifest(mkBase([mkAssignment("rs-1", [c])]));
    expect(keys).toEqual(["linked:comm-water:current_period"]);
  });

  it("dedupes identical keys produced by multiple components", () => {
    const c1 = mkComponent({
      id: "c-1",
      predicate: { drought_stage_active: 1 },
    });
    const c2 = mkComponent({
      id: "c-2",
      predicate: { drought_stage_active: 2 },
      quantitySource: { base: "wqa" },
    });
    const c3 = mkComponent({
      id: "c-3",
      quantitySource: { base: "wqa" },
    });
    const keys = manifest(mkBase([mkAssignment("rs-1", [c1, c2, c3])]));
    expect(keys).toEqual(["tenant:drought_stage", "wqa:current:sa-1"]);
  });

  it("returns deterministic, alphabetically sorted output", () => {
    const c = mkComponent({
      predicate: {
        and: [
          { drought_stage_active: 2 },
          { customer_attr: { attr: "senior" } },
          { qty_gte: { var: "meter:reads:m-1", value: 0 } },
        ],
      },
      quantitySource: { base: "wqa" },
      pricing: {
        type: "indexed",
        index_name: "cpi",
        period_resolver: "current_year",
      },
    });
    const base = mkBase([mkAssignment("rs-1", [c])]);
    const first = manifest(base);
    const second = manifest(base);
    expect(first).toEqual(second);
    // Verify sorted alphabetically:
    expect(first).toEqual([
      "account:flag:senior",
      "index:cpi:2026",
      "meter:reads:m-1",
      "tenant:drought_stage",
      "wqa:current:sa-1",
    ]);
  });

  it("recurses into and/or/not composite predicates", () => {
    const c = mkComponent({
      predicate: {
        or: [
          { not: { drought_stage_active: 3 } },
          {
            and: [
              { customer_attr: { attr: "low_income" } },
              { qty_lte: { var: "meter:reads:m-2", value: 100 } },
            ],
          },
        ],
      },
    });
    const keys = manifest(mkBase([mkAssignment("rs-1", [c])]));
    expect(keys).toEqual([
      "account:flag:low_income",
      "meter:reads:m-2",
      "tenant:drought_stage",
    ]);
  });
});
