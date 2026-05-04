import { describe, it, expect } from "vitest";
import { rate } from "../../rate.js";
import type {
  RateComponentSnapshot,
  ResolvedAssignment,
  RatingContext,
} from "../../types.js";

const SCHEDULE_ID = "rs-bozeman-solid-waste";
const EFF_DATE = new Date(2025, 8, 15);

// IMPORTANT: catalog pricing walks ALL `items:*` vars across components. If two
// components have catalog tables keyed by overlapping fields (e.g. just "size"),
// each item's join key would match every component's table → cross-component
// double-counting. Including `item_type` first in `by` keeps each component's
// table keys distinct (e.g. "recycling_cart:65" vs "garbage_cart:65"), so non-
// matching items contribute zero.
function bozemanSolidWasteComponents(): RateComponentSnapshot[] {
  return [
    {
      id: "c-sw-garbage",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "item_price",
      label: "Garbage Cart",
      sortOrder: 10,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: {},
      quantitySource: { base: "item_count" },
      pricing: {
        type: "catalog",
        by: ["item_type", "size", "frequency"],
        table: {
          "garbage_cart:35:weekly": 18.96,
          "garbage_cart:45:weekly": 18.96,
          "garbage_cart:45:monthly": 14.11,
          "garbage_cart:65:weekly": 27.24,
          "garbage_cart:100:weekly": 34.91,
          "garbage_cart:220:weekly": 58.30,
          "garbage_cart:300:weekly": 73.09,
          "garbage_cart:450:weekly": 105.30,
        },
      },
    },
    {
      id: "c-sw-recycling",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "item_price",
      label: "Recycling Cart",
      sortOrder: 11,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: {},
      quantitySource: { base: "item_count" },
      pricing: {
        type: "catalog",
        by: ["item_type", "size"],
        table: {
          "recycling_cart:35": 9.96,
          "recycling_cart:65": 12.96,
          "recycling_cart:100": 16.96,
        },
      },
    },
    {
      id: "c-sw-organics",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "item_price",
      label: "Organics Cart",
      sortOrder: 12,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: {},
      quantitySource: { base: "item_count" },
      pricing: {
        type: "catalog",
        by: ["item_type", "size"],
        table: {
          "organics_cart:35": 12.00,
          "organics_cart:65": 15.00,
        },
      },
    },
  ];
}

function bozemanSolidWasteAssignment(
  components: RateComponentSnapshot[],
): ResolvedAssignment {
  return {
    id: "a-bzn-solid-waste",
    rateScheduleId: SCHEDULE_ID,
    roleCode: "primary",
    effectiveDate: EFF_DATE,
    expirationDate: null,
    schedule: {
      id: SCHEDULE_ID,
      name: "Bozeman Solid Waste 2025-09",
      code: "BZN-SOLIDWASTE",
      version: 1,
      components,
    },
  };
}

describe("Bozeman Solid Waste — catalog golden test", () => {
  it("3 carts (garbage 65 weekly, recycling 65, organics 35) → 3 lines, no cross-component double-count", () => {
    const components = bozemanSolidWasteComponents();
    const assignment = bozemanSolidWasteAssignment(components);

    const items = [
      { itemType: "garbage_cart", size: "65", frequency: "weekly" },
      { itemType: "recycling_cart", size: "65" },
      { itemType: "organics_cart", size: "35" },
    ];

    const ctx: RatingContext = {
      base: {
        sa: {
          id: "sa-1",
          utilityId: "u-1",
          accountId: "a-1",
          premiseId: "p-1",
          commodityId: "c-solid-waste",
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
      vars: new Map<string, unknown>([["items:sp-1:all", items]]),
    };

    const result = rate(ctx);

    // Each component walks all 3 items but only its own table has matching
    // joinKeys, so each emits exactly its own item's price:
    //   Garbage:   garbage_cart:65:weekly → $27.24
    //   Recycling: recycling_cart:65      → $12.96
    //   Organics:  organics_cart:35       → $12.00
    // Subtotal = $52.20

    expect(result.lines).toHaveLength(3);

    const garbageLine = result.lines.find((l) => l.label === "Garbage Cart")!;
    expect(garbageLine.kindCode).toBe("item_price");
    expect(garbageLine.amount.toFixed(2)).toBe("27.24");

    const recyclingLine = result.lines.find((l) => l.label === "Recycling Cart")!;
    expect(recyclingLine.amount.toFixed(2)).toBe("12.96");

    const organicsLine = result.lines.find((l) => l.label === "Organics Cart")!;
    expect(organicsLine.amount.toFixed(2)).toBe("12.00");

    expect(result.totals.subtotal.toFixed(2)).toBe("52.20");
    expect(result.totals.taxes.toFixed(2)).toBe("0.00");
    expect(result.totals.credits.toFixed(2)).toBe("0.00");
    expect(result.totals.total.toFixed(2)).toBe("52.20");
  });
});
