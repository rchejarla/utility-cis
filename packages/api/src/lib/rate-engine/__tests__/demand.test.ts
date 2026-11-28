import { describe, it, expect } from "vitest";
import { resolveQuantity } from "../evaluators/quantity-source.js";
import { rate } from "../rate.js";
import { Decimal } from "../decimal.js";
import type { RatingContext, RateComponentSnapshot } from "../types.js";
import { manifest, pricesDemand } from "../manifest.js";

/**
 * Peak demand and the ratchet (spec 31, slice 2), in the engine alone.
 *
 * The loader hands over each meter's period peak (already the maximum of
 * its reads) and the agreement's past peaks by month; these tests are
 * about what the engine does with them: add meters, refuse an absent
 * peak, and hold billed demand at a percentage of the highest recent one.
 */

const SA = "sa-1";
const PERIOD = { startDate: new Date("2026-10-11"), endDate: new Date("2026-11-10") };

const peak = (q: string, unit = "KW") => ({ quantity: new Decimal(q), unit, readDate: "2026-11-08" });
const month = (m: string, q: string) => ({ month: m, readDate: `${m}-08`, quantity: new Decimal(q), unit: "KW" });

function ctx(vars: Array<[string, unknown]>, components: RateComponentSnapshot[] = []): RatingContext {
  return {
    base: {
      seasons: [],
      seasonSpanRule: "START_DATE",
      sa: { id: SA, utilityId: "u-1", accountId: "a-1", premiseId: "p-1", commodityId: "c-1", rateServiceClassCode: "large_commercial" },
      account: { id: "a-1", accountNumber: "A-1" },
      premise: { id: "p-1", premiseType: "COMMERCIAL", eruCount: null, hasStormwaterInfra: false },
      period: PERIOD,
      assignments: components.length
        ? [{
            id: "as-1", rateScheduleId: "rs-1", roleCode: "delivery",
            effectiveDate: new Date("2026-01-01"), expirationDate: null,
            schedule: { id: "rs-1", name: "GS", code: "GS-1", version: 1, components },
          }]
        : [],
    },
    vars: new Map(vars),
  };
}

const RATCHET_75 = { type: "ratchet", percent: 75, lookback_months: 11 };

describe("peak_demand", () => {
  it("prices one meter's peak", () => {
    const q = resolveQuantity({ base: "peak_demand" }, ctx([["demand:peak:m-1", peak("42.5")]]), "kW");
    expect(q.toString()).toBe("42.5");
  });

  it("adds several meters' peaks — each meter's own maximum, then summed (D3)", () => {
    const q = resolveQuantity(
      { base: "peak_demand" },
      ctx([["demand:peak:m-1", peak("40")], ["demand:peak:m-2", peak("15.5")]]),
      "kW",
    );
    expect(q.toString()).toBe("55.5");
  });

  it("converts a peak recorded in another demand unit", () => {
    const q = resolveQuantity({ base: "peak_demand" }, ctx([["demand:peak:m-1", peak("0.2", "MW")]]), "kW");
    expect(q.toString()).toBe("200");
  });

  it("refuses kWh posing as demand rather than pricing it", () => {
    expect(() =>
      resolveQuantity({ base: "peak_demand" }, ctx([["demand:peak:m-1", peak("900", "KWH")]]), "kW"),
    ).toThrow(/measure different things/);
  });

  it("refuses when no meter measures demand, instead of billing 0 kW (DEM-ENG-3)", () => {
    expect(() => resolveQuantity({ base: "peak_demand" }, ctx([]), "kW")).toThrow(
      expect.objectContaining({ code: "DEMAND_NOT_MEASURED" }),
    );
  });

  it("refuses when a demand register has no read this period — the missing read may be the peak", () => {
    expect(() =>
      resolveQuantity(
        { base: "peak_demand" },
        ctx([["demand:peak:m-1", peak("40")], ["demand:peak:m-2", { quantity: null, unit: "KW", readDate: null }]]),
        "kW",
      ),
    ).toThrow(expect.objectContaining({ code: "DEMAND_READ_MISSING" }));
  });
});

describe("the ratchet", () => {
  const history = [month("2026-01", "60"), month("2026-07", "120"), month("2026-09", "70")];

  it("bills the percentage of the highest recent peak when it is above this month's", () => {
    const notes: string[] = [];
    const q = resolveQuantity(
      { base: "peak_demand", transforms: [RATCHET_75] },
      ctx([["demand:peak:m-1", peak("70")], [`demand:history:${SA}`, history]]),
      "kW",
      notes,
    );
    expect(q.toString()).toBe("90"); // 75% of July's 120
    expect(notes).toEqual(["Ratchet: 75% of 120 kW peak (Jul 2026); measured 70 kW"]);
  });

  it("bills the measurement, and says nothing, when it is above the ratchet", () => {
    const notes: string[] = [];
    const q = resolveQuantity(
      { base: "peak_demand", transforms: [RATCHET_75] },
      ctx([["demand:peak:m-1", peak("95")], [`demand:history:${SA}`, history]]),
      "kW",
      notes,
    );
    expect(q.toString()).toBe("95");
    expect(notes).toEqual([]);
  });

  it("looks back only lookback_months before the period", () => {
    // Three months back from 11 Oct is 11 Jul: July's 8th read is outside.
    const q = resolveQuantity(
      { base: "peak_demand", transforms: [{ ...RATCHET_75, lookback_months: 3 }] },
      ctx([["demand:peak:m-1", peak("40")], [`demand:history:${SA}`, history]]),
      "kW",
    );
    expect(q.toString()).toBe("52.5"); // 75% of September's 70
  });

  it("a summer ratchet looks only at summer months (D2)", () => {
    const q = resolveQuantity(
      { base: "peak_demand", transforms: [{ ...RATCHET_75, months: [1, 2, 12] }] },
      ctx([["demand:peak:m-1", peak("30")], [`demand:history:${SA}`, history]]),
      "kW",
    );
    expect(q.toString()).toBe("45"); // 75% of January's 60, July ignored
  });

  it("an agreement with no history is billed what it measured", () => {
    const q = resolveQuantity(
      { base: "peak_demand", transforms: [RATCHET_75] },
      ctx([["demand:peak:m-1", peak("30")], [`demand:history:${SA}`, []]]),
      "kW",
    );
    expect(q.toString()).toBe("30");
  });
});

describe("a demand charge on the bill", () => {
  const demandCharge: RateComponentSnapshot = {
    id: "c-demand",
    rateScheduleId: "rs-1",
    kindCode: "demand",
    label: "Demand Charge",
    predicate: {},
    quantitySource: { base: "peak_demand", transforms: [RATCHET_75] },
    pricing: { type: "flat", rate: 10, unit: "kW" },
    sortOrder: 10,
    effectiveDate: new Date("2026-01-01"),
    expirationDate: null,
  };

  it("carries the ratchet's explanation as the line's basis", () => {
    const result = rate(
      ctx(
        [["demand:peak:m-1", peak("70")], [`demand:history:${SA}`, [month("2026-07", "120")]]],
        [demandCharge],
      ),
    );
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.quantity!.toString()).toBe("90");
    expect(result.lines[0]!.amount.toString()).toBe("900");
    expect(result.lines[0]!.basis).toBe("Ratchet: 75% of 120 kW peak (Jul 2026); measured 70 kW");
  });

  it("asks for history only when a component ratchets, and knows the schedule prices demand", () => {
    const c = ctx([], [demandCharge]);
    expect(manifest(c.base)).toContain(`demand:history:${SA}`);
    expect(pricesDemand(c.base)).toBe(true);

    const flat = ctx([], [{ ...demandCharge, quantitySource: { base: "metered" } }]);
    expect(manifest(flat.base)).not.toContain(`demand:history:${SA}`);
    expect(pricesDemand(flat.base)).toBe(false);
  });
});
