import { describe, it, expect } from "vitest";
import { rate } from "../../rate.js";
import {
  bozemanSewerComponents,
  bozemanSewerAssignment,
} from "./_bozeman-sewer-fixtures.js";
import type { RatingContext } from "../../types.js";

describe("Bozeman Sewer — Residential WQA golden test", () => {
  it("WQA=8, residential class → service charge + WQA-based derived consumption", () => {
    const components = bozemanSewerComponents();
    const assignment = bozemanSewerAssignment(components);

    const ctx: RatingContext = {
      base: {
        sa: {
          id: "sa-1",
          utilityId: "u-1",
          accountId: "a-1",
          premiseId: "p-1",
          commodityId: "c-sewer",
          rateServiceClassCode: "residential",
        },
        account: { id: "a-1", accountNumber: "A-1" },
        premise: {
          id: "p-1",
          premiseType: "single_family",
          eruCount: null,
          hasStormwaterInfra: false,
        },
        period: { startDate: new Date(2026, 4, 1), endDate: new Date(2026, 4, 31) },
        assignments: [assignment],
      },
      vars: new Map<string, unknown>([
        // Resident-class WQA stored under SA id
        ["wqa:current:sa-1", 8],
      ]),
    };

    const result = rate(ctx);

    // Service Charge $24.65 (residential)
    // Derived Consumption: WQA=8 × $4.12 = $32.96
    // Subtotal = $24.65 + $32.96 = $57.61

    expect(result.lines).toHaveLength(2);

    const serviceLine = result.lines.find((l) => l.kindCode === "service_charge")!;
    expect(serviceLine.label).toBe("Sewer Service Charge — Residential");
    expect(serviceLine.amount.toFixed(2)).toBe("24.65");

    const derivedLine = result.lines.find((l) => l.kindCode === "derived_consumption")!;
    expect(derivedLine.label).toBe("Sewer Usage — Residential (WQA)");
    expect(derivedLine.amount.toFixed(2)).toBe("32.96");
    expect(derivedLine.quantity?.toString()).toBe("8");

    expect(result.totals.subtotal.toFixed(2)).toBe("57.61");
    expect(result.totals.taxes.toFixed(2)).toBe("0.00");
    expect(result.totals.credits.toFixed(2)).toBe("0.00");
    expect(result.totals.total.toFixed(2)).toBe("57.61");
    expect(result.totals.minimumFloorApplied).toBe(false);

    // Mid-class and industrial service charges should be silent (predicate_false)
    const midSvcTrace = result.trace.find((t) => t.componentId === "c-sewer-svc-mid");
    expect(midSvcTrace?.skipReason).toBe("predicate_false");
    const industrialSvcTrace = result.trace.find(
      (t) => t.componentId === "c-sewer-svc-industrial",
    );
    expect(industrialSvcTrace?.skipReason).toBe("predicate_false");

    // Other-class derived consumption rows should also be silent
    const mfDerivedTrace = result.trace.find(
      (t) => t.componentId === "c-sewer-derived-multi-family",
    );
    expect(mfDerivedTrace?.skipReason).toBe("predicate_false");
    const commercialDerivedTrace = result.trace.find(
      (t) => t.componentId === "c-sewer-derived-commercial",
    );
    expect(commercialDerivedTrace?.skipReason).toBe("predicate_false");
  });
});
