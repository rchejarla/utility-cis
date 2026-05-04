import { describe, it, expect } from "vitest";
import { predicateSchema } from "../rate-grammar/predicate";
import { quantitySourceSchema } from "../rate-grammar/quantity-source";
import { pricingSchema } from "../rate-grammar/pricing";
import { selectorSchema } from "../rate-grammar/selectors";

describe("predicateSchema", () => {
  it("accepts the empty predicate (always true)", () => {
    const result = predicateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts an and-composition with class and meter_size_in", () => {
    const result = predicateSchema.safeParse({
      and: [
        { class: "single_family" },
        { meter_size_in: ["3/4", "1"] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a deeply nested or/and/not composition", () => {
    const result = predicateSchema.safeParse({
      or: [
        { not: { class: "msu" } },
        { and: [{ season: "summer" }, { drought_stage_active: true }] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown operator", () => {
    const result = predicateSchema.safeParse({ unknown_op: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects empty arrays in and/or", () => {
    expect(predicateSchema.safeParse({ and: [] }).success).toBe(false);
    expect(predicateSchema.safeParse({ or: [] }).success).toBe(false);
  });

  it("rejects an unknown season value", () => {
    const result = predicateSchema.safeParse({ season: "monsoon" });
    expect(result.success).toBe(false);
  });
});

describe("quantitySourceSchema", () => {
  it("accepts a metered base with no transforms", () => {
    const result = quantitySourceSchema.safeParse({
      base: "metered",
      transforms: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a peak_demand base with a ratchet transform", () => {
    const result = quantitySourceSchema.safeParse({
      base: "peak_demand",
      aggregation: "max",
      interval_minutes: 15,
      transforms: [
        { type: "ratchet", percent: 80, lookback_months: 11 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown base", () => {
    const result = quantitySourceSchema.safeParse({
      base: "telepathic",
      transforms: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown transform type", () => {
    const result = quantitySourceSchema.safeParse({
      base: "metered",
      transforms: [{ type: "shimmy", amount: 1 }],
    });
    expect(result.success).toBe(false);
  });
});

describe("pricingSchema", () => {
  it("accepts a flat pricing", () => {
    const result = pricingSchema.safeParse({ type: "flat", rate: 12.5 });
    expect(result.success).toBe(true);
  });

  it("accepts a tiered pricing with mixed null/numeric tier ceilings", () => {
    const result = pricingSchema.safeParse({
      type: "tiered",
      tiers: [
        { to: 5, rate: 1.0 },
        { to: 15, rate: 2.0 },
        { to: 30, rate: 3.0 },
        { to: null, rate: 4.0 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a lookup pricing keyed by meter size", () => {
    const result = pricingSchema.safeParse({
      type: "lookup",
      by: "meter_size",
      table: { "3/4": 25, "1": 40, "2": 80 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a percent_of pricing referencing a selector", () => {
    const result = pricingSchema.safeParse({
      type: "percent_of",
      selector: { kind_in: ["consumption", "service_charge"] },
      percent: 5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown pricing type", () => {
    const result = pricingSchema.safeParse({ type: "barter", rate: 1 });
    expect(result.success).toBe(false);
  });
});

describe("selectorSchema", () => {
  it("accepts a component_id selector", () => {
    const result = selectorSchema.safeParse({
      component_id: "00000000-0000-4000-8000-000000000123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a kind_in selector with valid kind codes", () => {
    const result = selectorSchema.safeParse({
      kind_in: ["consumption", "surcharge"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a kind selector with an unknown code", () => {
    const result = selectorSchema.safeParse({ kind: "weather_surcharge" });
    expect(result.success).toBe(false);
  });
});
