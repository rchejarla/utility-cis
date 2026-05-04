import { describe, it, expect } from "vitest";
import { rate } from "../../rate.js";
import {
  bozemanWaterComponents,
  bozemanWaterAssignment,
} from "./_bozeman-water-fixtures.js";
import type { RatingContext } from "../../types.js";

describe("Bozeman Water — SFR golden test", () => {
  it('12 HCF, 5/8" meter, no drought → service charge + tier-walked usage', () => {
    const components = bozemanWaterComponents();
    const assignment = bozemanWaterAssignment(components);

    const ctx: RatingContext = {
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
        assignments: [assignment],
      },
      vars: new Map<string, unknown>([
        ["meter:size:M-1", '5/8"'],
        ["meter:reads:M-1", { quantity: 12, unit: "HCF" }],
        ["tenant:drought_stage", 0],
      ]),
    };

    const result = rate(ctx);

    // Service Charge $22.31 + tier-walked usage:
    //   6 HCF × $3.31 = $19.86 (tier 0-6)
    //   6 HCF × $4.58 = $27.48 (tier 6-25)
    //   total usage = $47.34
    // Subtotal = $22.31 + $47.34 = $69.65, no minimum_bill (subtotal > $6.62)

    expect(result.lines).toHaveLength(2);

    const serviceLine = result.lines.find((l) => l.kindCode === "service_charge")!;
    expect(serviceLine.amount.toFixed(2)).toBe("22.31");

    const consumptionLine = result.lines.find((l) => l.kindCode === "consumption")!;
    expect(consumptionLine.label).toBe("Water Usage — Single Family");
    expect(consumptionLine.amount.toFixed(2)).toBe("47.34");

    expect(result.totals.subtotal.toFixed(2)).toBe("69.65");
    expect(result.totals.taxes.toFixed(2)).toBe("0.00");
    expect(result.totals.credits.toFixed(2)).toBe("0.00");
    expect(result.totals.total.toFixed(2)).toBe("69.65");
    expect(result.totals.minimumFloorApplied).toBe(false);

    // Other consumption components (MF, Gov, MSU, Commercial) should be silent
    const trace = result.trace;
    const mfTrace = trace.find((t) => t.componentId === "c-consumption-mf");
    expect(mfTrace?.skipReason).toBe("predicate_false");
  });
});
