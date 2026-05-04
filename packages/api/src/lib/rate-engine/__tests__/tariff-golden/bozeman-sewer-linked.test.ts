import { describe, it, expect } from "vitest";
import { rate } from "../../rate.js";
import {
  bozemanSewerComponents,
  bozemanSewerAssignment,
  LINKED_COMMODITY_ID,
} from "./_bozeman-sewer-fixtures.js";
import type { RatingContext } from "../../types.js";

describe("Bozeman Sewer — Commercial linked-commodity golden test", () => {
  it("commercial class with 50 HCF linked water usage → mid-class service + linked derived consumption", () => {
    const components = bozemanSewerComponents();
    const assignment = bozemanSewerAssignment(components);

    const ctx: RatingContext = {
      base: {
        sa: {
          id: "sa-2",
          utilityId: "u-1",
          accountId: "a-2",
          premiseId: "p-2",
          commodityId: "c-sewer",
          rateServiceClassCode: "commercial",
        },
        account: { id: "a-2", accountNumber: "A-2" },
        premise: {
          id: "p-2",
          premiseType: "commercial",
          eruCount: null,
          hasStormwaterInfra: false,
        },
        period: { startDate: new Date(2026, 4, 1), endDate: new Date(2026, 4, 31) },
        assignments: [assignment],
      },
      vars: new Map<string, unknown>([
        // Linked-commodity quantity comes from the upstream water SA
        [`linked:${LINKED_COMMODITY_ID}:current_period`, 50],
      ]),
    };

    const result = rate(ctx);

    // Service Charge $25.26 (mid-class group via class_in)
    // Derived Consumption: 50 HCF × $5.13 = $256.50
    // Subtotal = $25.26 + $256.50 = $281.76

    expect(result.lines).toHaveLength(2);

    const serviceLine = result.lines.find((l) => l.kindCode === "service_charge")!;
    expect(serviceLine.label).toBe("Sewer Service Charge — Mid-Class Group");
    expect(serviceLine.amount.toFixed(2)).toBe("25.26");

    const derivedLine = result.lines.find((l) => l.kindCode === "derived_consumption")!;
    expect(derivedLine.label).toBe("Sewer Usage — Commercial (Linked)");
    expect(derivedLine.amount.toFixed(2)).toBe("256.50");
    expect(derivedLine.quantity?.toString()).toBe("50");

    expect(result.totals.subtotal.toFixed(2)).toBe("281.76");
    expect(result.totals.taxes.toFixed(2)).toBe("0.00");
    expect(result.totals.credits.toFixed(2)).toBe("0.00");
    expect(result.totals.total.toFixed(2)).toBe("281.76");

    // Residential and Industrial service charges should be silent
    const residentialSvcTrace = result.trace.find(
      (t) => t.componentId === "c-sewer-svc-residential",
    );
    expect(residentialSvcTrace?.skipReason).toBe("predicate_false");
    const industrialSvcTrace = result.trace.find(
      (t) => t.componentId === "c-sewer-svc-industrial",
    );
    expect(industrialSvcTrace?.skipReason).toBe("predicate_false");

    // The Residential WQA derived row should be silent (no wqa var seeded, but
    // predicate_false short-circuits before the quantity source is evaluated).
    const residentialDerivedTrace = result.trace.find(
      (t) => t.componentId === "c-sewer-derived-residential",
    );
    expect(residentialDerivedTrace?.skipReason).toBe("predicate_false");
  });
});
