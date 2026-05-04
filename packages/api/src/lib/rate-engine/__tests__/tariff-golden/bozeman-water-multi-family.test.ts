import { describe, it, expect } from "vitest";
import { rate } from "../../rate.js";
import {
  bozemanWaterComponents,
  bozemanWaterAssignment,
} from "./_bozeman-water-fixtures.js";
import type { RatingContext } from "../../types.js";

describe("Bozeman Water — Multi-Family with drought golden test", () => {
  it('1" meter, 50 HCF, drought_stage=2 → service + flat consumption + drought reserve + drought stage %', () => {
    const components = bozemanWaterComponents();
    const assignment = bozemanWaterAssignment(components);

    const ctx: RatingContext = {
      base: {
        sa: {
          id: "sa-2",
          utilityId: "u-1",
          accountId: "a-2",
          premiseId: "p-2",
          commodityId: "c-water",
          rateServiceClassCode: "multi_family",
        },
        account: { id: "a-2", accountNumber: "A-2" },
        premise: {
          id: "p-2",
          premiseType: "multi_family",
          eruCount: null,
          hasStormwaterInfra: false,
        },
        period: { startDate: new Date(2026, 4, 1), endDate: new Date(2026, 4, 31) },
        assignments: [assignment],
      },
      vars: new Map<string, unknown>([
        ["meter:size:M-2", '1"'],
        ["meter:reads:M-2", { quantity: 50, unit: "HCF" }],
        ["tenant:drought_stage", 2],
      ]),
    };

    const result = rate(ctx);

    // Service Charge $29.56
    // Multi-Family consumption: 50 × $3.01 = $150.50
    // Drought Reserve: 50 × $0.11 = $5.50
    // Drought Stage Surcharge: 25% × $150.50 = $37.625
    // Subtotal = 29.56 + 150.50 + 5.50 + 37.625 = $223.185

    expect(result.lines).toHaveLength(4);

    const lookup = (kind: string, label: string) =>
      result.lines.find((l) => l.kindCode === kind && l.label === label);

    expect(lookup("service_charge", "Water Service Charge")?.amount.toFixed(2)).toBe(
      "29.56",
    );
    expect(lookup("consumption", "Water Usage — Multi-Family")?.amount.toFixed(2)).toBe(
      "150.50",
    );
    expect(lookup("surcharge", "Drought Reserve")?.amount.toFixed(2)).toBe("5.50");

    // The drought stage surcharge: percent_of(kind=consumption) × 25%
    // Should match consumption line $150.50 × 0.25 = $37.625
    const droughtStageLine = result.lines.find(
      (l) => l.label === "Drought Stage Surcharge",
    )!;
    expect(droughtStageLine.amount.toFixed(3)).toBe("37.625");

    expect(result.totals.subtotal.toFixed(3)).toBe("223.185");
    expect(result.totals.minimumFloorApplied).toBe(false); // Multi-Family doesn't have min bill
  });
});
