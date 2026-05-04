import { describe, it, expect } from "vitest";
import { rate } from "../../rate.js";
import { Decimal } from "../../decimal.js";
import type {
  RateComponentSnapshot,
  ResolvedAssignment,
  RatingContext,
} from "../../types.js";

const SCHEDULE_ID = "rs-bozeman-stormwater";
const EFF_DATE = new Date(2025, 8, 15);

function bozemanStormwaterComponents(): RateComponentSnapshot[] {
  return [
    {
      id: "c-stormwater-service",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "service_charge",
      label: "Stormwater Service Charge",
      sortOrder: 10,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: {},
      quantitySource: { base: "fixed" },
      pricing: { type: "flat", rate: 4.81 },
    },
    {
      id: "c-stormwater-non-meter",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "non_meter",
      label: "Stormwater Per-ERU Charge",
      sortOrder: 20,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: {},
      quantitySource: { base: "premise_attribute", source_attr: "premise.eru_count" },
      pricing: { type: "per_unit", rate: 3.99, unit: "ERU" },
    },
    {
      id: "c-stormwater-infra-credit",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "credit",
      label: "Stormwater Infrastructure Credit",
      sortOrder: 30,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { premise_attr: { attr: "hasStormwaterInfra", eq: true } },
      quantitySource: { base: "fixed" },
      pricing: {
        type: "percent_of",
        selector: { kind: "non_meter" },
        percent: -45,
      },
    },
  ];
}

function bozemanStormwaterAssignment(
  components: RateComponentSnapshot[],
): ResolvedAssignment {
  return {
    id: "a-bzn-stormwater",
    rateScheduleId: SCHEDULE_ID,
    roleCode: "primary",
    effectiveDate: EFF_DATE,
    expirationDate: null,
    schedule: {
      id: SCHEDULE_ID,
      name: "Bozeman Stormwater 2025-09",
      code: "BZN-STORMWATER",
      version: 1,
      components,
    },
  };
}

describe("Bozeman Stormwater — golden tests", () => {
  it("SFR with 1 ERU and hasStormwaterInfra=true → service + non-meter − 45% infra credit", () => {
    const components = bozemanStormwaterComponents();
    const assignment = bozemanStormwaterAssignment(components);

    const ctx: RatingContext = {
      base: {
        sa: {
          id: "sa-1",
          utilityId: "u-1",
          accountId: "a-1",
          premiseId: "p-1",
          commodityId: "c-stormwater",
          rateServiceClassCode: "single_family",
        },
        account: { id: "a-1", accountNumber: "A-1" },
        premise: {
          id: "p-1",
          premiseType: "single_family",
          eruCount: new Decimal(1),
          hasStormwaterInfra: true,
        },
        period: { startDate: new Date(2026, 4, 1), endDate: new Date(2026, 4, 31) },
        assignments: [assignment],
      },
      vars: new Map<string, unknown>(),
    };

    const result = rate(ctx);

    // Service Charge $4.81
    // Non-meter: 1 ERU × $3.99 = $3.99
    // Infra Credit: -45% of non_meter $3.99 = -$1.7955
    // subtotal (excl credits) = $4.81 + $3.99 = $8.80
    // credits = -$1.7955
    // total = $8.80 + (-$1.7955) = $7.0045

    expect(result.lines).toHaveLength(3);

    const serviceLine = result.lines.find((l) => l.kindCode === "service_charge")!;
    expect(serviceLine.amount.toFixed(2)).toBe("4.81");

    const nonMeterLine = result.lines.find((l) => l.kindCode === "non_meter")!;
    expect(nonMeterLine.amount.toFixed(2)).toBe("3.99");
    expect(nonMeterLine.quantity?.toString()).toBe("1");

    const creditLine = result.lines.find((l) => l.kindCode === "credit")!;
    expect(creditLine.amount.toFixed(4)).toBe("-1.7955");

    expect(result.totals.subtotal.toFixed(2)).toBe("8.80");
    expect(result.totals.credits.toFixed(4)).toBe("-1.7955");
    expect(result.totals.taxes.toFixed(2)).toBe("0.00");
    expect(result.totals.total.toFixed(4)).toBe("7.0045");
  });

  it("Commercial with 6 ERU and no infra → service + non-meter, no credit", () => {
    const components = bozemanStormwaterComponents();
    const assignment = bozemanStormwaterAssignment(components);

    const ctx: RatingContext = {
      base: {
        sa: {
          id: "sa-2",
          utilityId: "u-1",
          accountId: "a-2",
          premiseId: "p-2",
          commodityId: "c-stormwater",
          rateServiceClassCode: "commercial",
        },
        account: { id: "a-2", accountNumber: "A-2" },
        premise: {
          id: "p-2",
          premiseType: "commercial",
          eruCount: new Decimal(6),
          hasStormwaterInfra: false,
        },
        period: { startDate: new Date(2026, 4, 1), endDate: new Date(2026, 4, 31) },
        assignments: [assignment],
      },
      vars: new Map<string, unknown>(),
    };

    const result = rate(ctx);

    // Service Charge $4.81
    // Non-meter: 6 ERU × $3.99 = $23.94
    // Credit: skipped (predicate_false)
    // subtotal = $4.81 + $23.94 = $28.75

    expect(result.lines).toHaveLength(2);

    const serviceLine = result.lines.find((l) => l.kindCode === "service_charge")!;
    expect(serviceLine.amount.toFixed(2)).toBe("4.81");

    const nonMeterLine = result.lines.find((l) => l.kindCode === "non_meter")!;
    expect(nonMeterLine.amount.toFixed(2)).toBe("23.94");
    expect(nonMeterLine.quantity?.toString()).toBe("6");

    expect(result.totals.subtotal.toFixed(2)).toBe("28.75");
    expect(result.totals.credits.toFixed(2)).toBe("0.00");
    expect(result.totals.total.toFixed(2)).toBe("28.75");

    const creditTrace = result.trace.find(
      (t) => t.componentId === "c-stormwater-infra-credit",
    );
    expect(creditTrace?.skipReason).toBe("predicate_false");
  });
});
