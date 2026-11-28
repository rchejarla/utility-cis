import { describe, it, expect } from "vitest";
import { rate } from "../../rate.js";
import { Decimal } from "../../decimal.js";
import type { RateComponentSnapshot, RatingContext } from "../../types.js";

/**
 * NWE GSEDS-1 shape, general service with demand — golden test (spec 31).
 *
 * The tariff the dev seed carries as `NWE-GSEDS-1`: a monthly customer
 * charge, delivery energy and tax per kWh, and a demand charge per kW held
 * at 75% of the highest peak in the last eleven months. **Placeholder
 * rates**, the same as the seed's — 07c has GSEDS-1's shape, not NWE's
 * figures. What is golden here is the arithmetic and the explanation:
 *
 *   - an ordinary month bills the measured peak, and the line says nothing
 *     more;
 *   - a month after a summer peak bills the ratchet, and the line says why
 *     ("Ratchet: 75% of 130 kW peak (Jul 2026); measured 82 kW");
 *   - the energy lines price kWh only — the kW never leaks into them.
 */

const GS = "rs-nwe-gseds-1";
const EFF = new Date("2026-01-01");

const component = (c: Partial<RateComponentSnapshot> & Pick<RateComponentSnapshot, "id" | "label" | "kindCode" | "quantitySource" | "pricing">): RateComponentSnapshot => ({
  rateScheduleId: GS,
  predicate: { class: "large_commercial" },
  sortOrder: 10,
  effectiveDate: EFF,
  expirationDate: null,
  ...c,
});

const GSEDS: RateComponentSnapshot[] = [
  component({ id: "c-customer", label: "General Service Customer Charge — Large", kindCode: "service_charge", quantitySource: { base: "fixed" }, pricing: { type: "flat", rate: 85, unit: "MONTH" } }),
  component({ id: "c-energy", label: "General Service Delivery Energy", kindCode: "consumption", sortOrder: 20, quantitySource: { base: "metered" }, pricing: { type: "flat", rate: 0.0298, unit: "kWh" } }),
  component({ id: "c-tax", label: "General Service Delivery Tax", kindCode: "surcharge", sortOrder: 30, quantitySource: { base: "metered" }, pricing: { type: "flat", rate: 0.011765, unit: "kWh" } }),
  component({
    id: "c-demand",
    label: "General Service Demand Charge — Large",
    kindCode: "demand",
    sortOrder: 16,
    quantitySource: { base: "peak_demand", transforms: [{ type: "ratchet", percent: 75, lookback_months: 11 }] },
    pricing: { type: "flat", rate: 11.4, unit: "kW" },
  }),
];

/** The agreement's history: July's summer peak and an ordinary spring. */
const HISTORY = [
  { month: "2026-04", readDate: "2026-04-08", quantity: new Decimal(76), unit: "KW" },
  { month: "2026-07", readDate: "2026-07-08", quantity: new Decimal(130), unit: "KW" },
  { month: "2026-09", readDate: "2026-09-08", quantity: new Decimal(84), unit: "KW" },
];

function ctx(period: { startDate: Date; endDate: Date }, peakKw: number, kwh: number): RatingContext {
  return {
    base: {
      seasons: [],
      seasonSpanRule: "START_DATE",
      sa: { id: "sa-1", utilityId: "u-1", accountId: "a-1", premiseId: "p-1", commodityId: "c-electric", rateServiceClassCode: "large_commercial" },
      account: { id: "a-1", accountNumber: "A-1" },
      premise: { id: "p-1", premiseType: "COMMERCIAL", eruCount: null, hasStormwaterInfra: false },
      period,
      assignments: [{
        id: "a-gs", rateScheduleId: GS, roleCode: "delivery", effectiveDate: EFF, expirationDate: null,
        schedule: { id: GS, name: "NWE General Service Delivery", code: "NWE-GSEDS-1", version: 1, components: GSEDS },
      }],
    },
    vars: new Map<string, unknown>([
      ["meter:reads:EM-1", { quantity: kwh, unit: "KWH" }],
      ["demand:peak:EM-1", { quantity: new Decimal(peakKw), unit: "KW", readDate: "2026-11-08" }],
      ["demand:history:sa-1", HISTORY],
    ]),
  };
}

const line = (r: ReturnType<typeof rate>, id: string) => r.lines.find((l) => l.sourceComponentId === id)!;

describe("NWE GSEDS-1 with demand — golden", () => {
  it("October–November, after a 130 kW July: demand billed on the ratchet, and the line says so", () => {
    const r = rate(ctx({ startDate: new Date("2026-10-11"), endDate: new Date("2026-11-10") }, 82, 15_251));

    // Demand: max(82, 75% × 130 = 97.5) = 97.5 kW × $11.40 = $1,111.50
    const demand = line(r, "c-demand");
    expect(demand.kindCode).toBe("demand");
    expect(demand.quantity!.toString()).toBe("97.5");
    expect(demand.unit).toBe("kW");
    expect(demand.amount.toFixed(2)).toBe("1111.50");
    expect(demand.basis).toBe("Ratchet: 75% of 130 kW peak (Jul 2026); measured 82 kW");

    // Energy on kWh alone: 15,251 × $0.0298 = $454.4798; tax × $0.011765 = $179.428015
    expect(line(r, "c-energy").amount.toFixed(4)).toBe("454.4798");
    expect(line(r, "c-tax").amount.toFixed(6)).toBe("179.428015");
    expect(line(r, "c-customer").amount.toFixed(2)).toBe("85.00");

    // 85 + 1,111.50 + 454.4798 + 179.428015
    expect(r.totals.total.toFixed(6)).toBe("1830.407815");
  });

  it("the same customer a year on, past the July: the measured peak, with nothing to explain", () => {
    // Eleven months back from 11 Aug 2027 is 11 Sep 2026: July 2026 has
    // aged out, and the highest left is September's 84 (75% = 63).
    const r = rate(ctx({ startDate: new Date("2027-08-11"), endDate: new Date("2027-09-10") }, 79, 14_000));

    const demand = line(r, "c-demand");
    expect(demand.quantity!.toString()).toBe("79");
    expect(demand.amount.toFixed(2)).toBe("900.60");
    expect(demand.basis).toBeUndefined();
  });
});
