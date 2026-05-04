import { describe, it, expect } from "vitest";
import { rate } from "../../rate.js";
import type {
  RateComponentSnapshot,
  ResolvedAssignment,
  RatingContext,
} from "../../types.js";

const REDS_ID = "rs-nwe-reds-1";
const ESS_ID = "rs-nwe-ess-1";
const USBC_ID = "rs-nwe-usbc";
const EFF_DATE = new Date(2025, 8, 15);

function redsComponents(): RateComponentSnapshot[] {
  return [
    {
      id: "c-reds-service",
      rateScheduleId: REDS_ID,
      kindCode: "service_charge",
      label: "REDS-1 Basic Service Charge",
      sortOrder: 10,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: {},
      quantitySource: { base: "fixed" },
      pricing: { type: "flat", rate: 4.2 },
    },
    {
      id: "c-reds-distribution",
      rateScheduleId: REDS_ID,
      kindCode: "consumption",
      label: "REDS-1 Distribution Delivery",
      sortOrder: 20,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "residential" },
      quantitySource: { base: "metered" },
      pricing: { type: "flat", rate: 0.04, unit: "kWh" },
    },
    {
      id: "c-reds-delivery-tax",
      rateScheduleId: REDS_ID,
      kindCode: "surcharge",
      label: "REDS-1 Delivery Tax",
      sortOrder: 30,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: {},
      quantitySource: { base: "metered" },
      pricing: { type: "flat", rate: 0.011765, unit: "kWh" },
    },
  ];
}

function essComponents(): RateComponentSnapshot[] {
  return [
    {
      id: "c-ess-supply",
      rateScheduleId: ESS_ID,
      kindCode: "consumption",
      label: "ESS-1 Electric Supply",
      sortOrder: 10,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "residential" },
      quantitySource: { base: "metered" },
      pricing: {
        type: "indexed",
        index_name: "supply_residential",
        period_resolver: "current_quarter",
        multiplier: 1,
        unit: "kWh",
      },
    },
  ];
}

function usbcComponents(): RateComponentSnapshot[] {
  return [
    {
      id: "c-usbc-rider",
      rateScheduleId: USBC_ID,
      kindCode: "surcharge",
      label: "Universal System Benefits Charge",
      sortOrder: 10,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: {},
      quantitySource: { base: "metered" },
      pricing: { type: "flat", rate: 0.0024, unit: "kWh" },
    },
  ];
}

function mkAssignment(
  scheduleId: string,
  code: string,
  name: string,
  components: RateComponentSnapshot[],
  roleCode: string,
): ResolvedAssignment {
  return {
    id: `a-${scheduleId}`,
    rateScheduleId: scheduleId,
    roleCode,
    effectiveDate: EFF_DATE,
    expirationDate: null,
    schedule: {
      id: scheduleId,
      name,
      code,
      version: 1,
      components,
    },
  };
}

describe("NWE Residential Electric — multi-schedule golden test", () => {
  it("750 kWh, residential, May 2026 → REDS-1 + ESS-1 + USBC produce 5 lines with correct attribution", () => {
    const redsAssignment = mkAssignment(
      REDS_ID,
      "REDS-1",
      "NWE Residential Electric Delivery 2025-09",
      redsComponents(),
      "delivery",
    );
    const essAssignment = mkAssignment(
      ESS_ID,
      "ESS-1",
      "NWE Electric Supply Service 2025-09",
      essComponents(),
      "supply",
    );
    const usbcAssignment = mkAssignment(
      USBC_ID,
      "USBC",
      "Universal System Benefits Charge 2025-09",
      usbcComponents(),
      "rider",
    );

    const ctx: RatingContext = {
      base: {
        sa: {
          id: "sa-1",
          utilityId: "u-1",
          accountId: "a-1",
          premiseId: "p-1",
          commodityId: "c-electric",
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
        assignments: [redsAssignment, essAssignment, usbcAssignment],
      },
      vars: new Map<string, unknown>([
        ["meter:reads:M-1", { quantity: 750, unit: "kWh" }],
        ["index:supply_residential:2026-Q2", 0.07],
      ]),
    };

    const result = rate(ctx);

    // Expected lines:
    //   REDS-1 service_charge: $4.20
    //   REDS-1 distribution: 750 × $0.04 = $30.00
    //   REDS-1 delivery tax: 750 × $0.0117650 = $8.82375
    //   ESS-1 supply: 750 × $0.07000 = $52.50
    //   USBC: 750 × $0.0024 = $1.80
    // Subtotal = $97.32375
    expect(result.lines).toHaveLength(5);

    const serviceLine = result.lines.find((l) => l.sourceComponentId === "c-reds-service")!;
    expect(serviceLine).toBeDefined();
    expect(serviceLine.label).toBe("REDS-1 Basic Service Charge");
    expect(serviceLine.kindCode).toBe("service_charge");
    expect(serviceLine.amount.toFixed(2)).toBe("4.20");
    expect(serviceLine.sourceScheduleId).toBe(REDS_ID);

    const distributionLine = result.lines.find(
      (l) => l.sourceComponentId === "c-reds-distribution",
    )!;
    expect(distributionLine).toBeDefined();
    expect(distributionLine.label).toBe("REDS-1 Distribution Delivery");
    expect(distributionLine.kindCode).toBe("consumption");
    expect(distributionLine.amount.toFixed(2)).toBe("30.00");
    expect(distributionLine.sourceScheduleId).toBe(REDS_ID);

    const deliveryTaxLine = result.lines.find(
      (l) => l.sourceComponentId === "c-reds-delivery-tax",
    )!;
    expect(deliveryTaxLine).toBeDefined();
    expect(deliveryTaxLine.label).toBe("REDS-1 Delivery Tax");
    expect(deliveryTaxLine.kindCode).toBe("surcharge");
    expect(deliveryTaxLine.amount.toFixed(5)).toBe("8.82375");
    expect(deliveryTaxLine.sourceScheduleId).toBe(REDS_ID);

    const supplyLine = result.lines.find((l) => l.sourceComponentId === "c-ess-supply")!;
    expect(supplyLine).toBeDefined();
    expect(supplyLine.label).toBe("ESS-1 Electric Supply");
    expect(supplyLine.kindCode).toBe("consumption");
    expect(supplyLine.amount.toFixed(2)).toBe("52.50");
    expect(supplyLine.sourceScheduleId).toBe(ESS_ID);

    const usbcLine = result.lines.find((l) => l.sourceComponentId === "c-usbc-rider")!;
    expect(usbcLine).toBeDefined();
    expect(usbcLine.label).toBe("Universal System Benefits Charge");
    expect(usbcLine.kindCode).toBe("surcharge");
    expect(usbcLine.amount.toFixed(4)).toBe("1.8000");
    expect(usbcLine.sourceScheduleId).toBe(USBC_ID);

    // Line attribution: 3 lines from REDS-1, 1 from ESS-1, 1 from USBC
    const fromReds = result.lines.filter((l) => l.sourceScheduleId === REDS_ID);
    expect(fromReds).toHaveLength(3);
    const fromEss = result.lines.filter((l) => l.sourceScheduleId === ESS_ID);
    expect(fromEss).toHaveLength(1);
    const fromUsbc = result.lines.filter((l) => l.sourceScheduleId === USBC_ID);
    expect(fromUsbc).toHaveLength(1);

    expect(result.totals.subtotal.toFixed(5)).toBe("97.32375");
    expect(result.totals.taxes.toFixed(2)).toBe("0.00");
    expect(result.totals.credits.toFixed(2)).toBe("0.00");
    expect(result.totals.total.toFixed(5)).toBe("97.32375");
    expect(result.totals.minimumFloorApplied).toBe(false);
  });
});
