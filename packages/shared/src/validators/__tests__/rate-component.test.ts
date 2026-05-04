import { describe, it, expect } from "vitest";
import { createRateComponentSchema } from "../rate-component";

const baseFields = {
  effectiveDate: "2026-01-01",
};

describe("createRateComponentSchema", () => {
  it("accepts a flat consumption component", () => {
    const result = createRateComponentSchema.safeParse({
      ...baseFields,
      kindCode: "consumption",
      label: "Volumetric Charge",
      predicate: { class: "single_family" },
      quantitySource: { base: "metered", transforms: [] },
      pricing: { type: "flat", rate: 5.25 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a four-tier inclining consumption component", () => {
    const result = createRateComponentSchema.safeParse({
      ...baseFields,
      kindCode: "consumption",
      label: "Tier Block",
      predicate: { class: "single_family" },
      quantitySource: { base: "metered", transforms: [] },
      pricing: {
        type: "tiered",
        tiers: [
          { to: 5, rate: 1.0 },
          { to: 15, rate: 2.0 },
          { to: 30, rate: 3.0 },
          { to: null, rate: 4.0 },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a service_charge component with lookup pricing", () => {
    const result = createRateComponentSchema.safeParse({
      ...baseFields,
      kindCode: "service_charge",
      label: "Monthly Service Charge",
      predicate: {},
      quantitySource: { base: "fixed", transforms: [] },
      pricing: {
        type: "lookup",
        by: "meter_size",
        table: { "3/4": 22.5, "1": 36.0, "2": 90.0 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a surcharge component priced as percent_of", () => {
    const result = createRateComponentSchema.safeParse({
      ...baseFields,
      kindCode: "surcharge",
      label: "Franchise Fee",
      predicate: {},
      quantitySource: { base: "fixed", transforms: [] },
      pricing: {
        type: "percent_of",
        selector: { kind_in: ["consumption", "service_charge"] },
        percent: 5,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an indexed pricing component", () => {
    const result = createRateComponentSchema.safeParse({
      ...baseFields,
      kindCode: "consumption",
      label: "Fuel Pass-Through",
      predicate: { class: "commercial" },
      quantitySource: { base: "metered", transforms: [] },
      pricing: {
        type: "indexed",
        index_name: "henry_hub_ng_quarterly",
        period_resolver: "current_quarter",
        multiplier: 1.04,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a minimum_bill component with floor pricing", () => {
    const result = createRateComponentSchema.safeParse({
      ...baseFields,
      kindCode: "minimum_bill",
      label: "Minimum Bill",
      predicate: {},
      quantitySource: { base: "fixed", transforms: [] },
      pricing: {
        type: "floor",
        amount: 25,
        applies_to_subtotal: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kindCode", () => {
    const result = createRateComponentSchema.safeParse({
      ...baseFields,
      kindCode: "weather_surcharge",
      label: "Weather Surcharge",
      predicate: {},
      quantitySource: { base: "fixed", transforms: [] },
      pricing: { type: "flat", rate: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects pricing with a mismatched type field", () => {
    const result = createRateComponentSchema.safeParse({
      ...baseFields,
      kindCode: "consumption",
      label: "Bad Pricing",
      predicate: {},
      quantitySource: { base: "metered", transforms: [] },
      // tiered shape but type says flat
      pricing: {
        type: "flat",
        tiers: [{ to: null, rate: 1 }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a predicate with an unknown operator", () => {
    const result = createRateComponentSchema.safeParse({
      ...baseFields,
      kindCode: "consumption",
      label: "Bad Predicate",
      predicate: { unknown_op: true },
      quantitySource: { base: "metered", transforms: [] },
      pricing: { type: "flat", rate: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing label", () => {
    const result = createRateComponentSchema.safeParse({
      ...baseFields,
      kindCode: "consumption",
      predicate: {},
      quantitySource: { base: "metered", transforms: [] },
      pricing: { type: "flat", rate: 1 },
    });
    expect(result.success).toBe(false);
  });
});
