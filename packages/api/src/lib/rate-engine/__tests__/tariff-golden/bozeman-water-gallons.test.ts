import { describe, it, expect } from "vitest";
import { rate } from "../../rate.js";
import {
  bozemanWaterComponents,
  bozemanWaterAssignment,
} from "./_bozeman-water-fixtures.js";
import type { RatingContext } from "../../types.js";

/**
 * The same water, read in gallons, bills the same as in HCF.
 *
 * Every other test in this directory hands the engine a quantity already
 * in the tariff's own unit, because the fixtures were written next to
 * the tariff. Production does not: Bozeman publishes water rates per
 * HCF and the meters are `GAL`, so `meter-loader` produces
 * `{ quantity: 3515, unit: "GAL" }` for a tariff whose tiers break at 6,
 * 25 and 55. Nothing reconciled the two, and 3,515 gallons priced as
 * 3,515 HCF came to $33,445.38 of usage on one house for one month.
 *
 * Stated as an equivalence rather than an expected total, because the
 * invariant is what matters: how a meter happens to be denominated must
 * not change what a customer owes. The HCF figures are the sibling
 * golden test's, unchanged, so the two cannot drift apart.
 */

/** 12 HCF in gallons: 100 ft³ is 172800/231 gallons, exactly. */
const TWELVE_HCF_IN_GALLONS = (12 * 172800) / 231;

function ctxWithRead(read: { quantity: number; unit: string }): RatingContext {
  const components = bozemanWaterComponents();
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
      period: {
        startDate: new Date("2026-05-01T00:00:00Z"),
        endDate: new Date("2026-05-31T00:00:00Z"),
      },
      assignments: [bozemanWaterAssignment(components)],
    },
    vars: new Map<string, unknown>([
      ["meter:size:M-1", '5/8"'],
      ["meter:reads:M-1", read],
      ["tenant:drought_stage", 0],
    ]),
  };
}

describe("Bozeman Water — a gallons meter on an HCF tariff", () => {
  it("bills 8,976.62 gallons exactly as it bills 12 HCF", () => {
    const inGallons = rate(
      ctxWithRead({ quantity: TWELVE_HCF_IN_GALLONS, unit: "GAL" }),
    );
    const inHcf = rate(ctxWithRead({ quantity: 12, unit: "HCF" }));

    // 6 HCF × $3.31 + 6 HCF × $4.58 = $47.34, and the $22.31 service
    // charge is per meter size, so it does not move either way.
    expect(inGallons.totals.total.toFixed(2)).toBe(inHcf.totals.total.toFixed(2));
    expect(inGallons.totals.total.toFixed(2)).toBe("69.65");
  });

  /*
   * The month that produced the $33,467.69 bill, as the loader
   * presented it. A tier-1 month: 3,515 gallons is 4.70 HCF, so all of
   * it prices at $3.31 and none of it reaches the $9.58 top tier that
   * the unconverted figure fell into.
   */
  it("prices a real month's gallons inside the first tier", () => {
    const result = rate(ctxWithRead({ quantity: 3515, unit: "GAL" }));

    // 3,515 × 231/172800 = 4.69887 HCF, × $3.31 = $15.5532.
    const usage = result.lines.find((l) => l.kindCode === "consumption")!;
    expect(usage.amount.toFixed(2)).toBe("15.55");
    expect(result.totals.total.toFixed(2)).toBe("37.86");
  });

  /*
   * A unit the table does not know must stop the bill, not sail through
   * as though it were already right. Passing an unknown quantity
   * straight to the tariff is exactly what made a 748× error look like a
   * successful run.
   */
  it("refuses a unit it cannot convert rather than guessing", () => {
    expect(() => rate(ctxWithRead({ quantity: 100, unit: "FURLONG" }))).toThrow(
      /FURLONG/,
    );
  });
});
