import { describe, it, expect } from "vitest";
import { createRateIndexSchema } from "../rate-index";

const baseFields = {
  name: "henry_hub_ng",
  period: "2026Q1",
  value: 0.07,
  effectiveDate: "2026-01-01",
};

describe("createRateIndexSchema", () => {
  it("accepts a valid input (lowercase name, ISO period token, numeric value, ISO date)", () => {
    const result = createRateIndexSchema.safeParse(baseFields);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid name format (uppercase or hyphen)", () => {
    const upper = createRateIndexSchema.safeParse({ ...baseFields, name: "FAC" });
    expect(upper.success).toBe(false);

    const hyphen = createRateIndexSchema.safeParse({ ...baseFields, name: "fuel-adjust" });
    expect(hyphen.success).toBe(false);
  });

  it("rejects missing period", () => {
    const { period: _omit, ...rest } = baseFields;
    const result = createRateIndexSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = createRateIndexSchema.safeParse({
      ...baseFields,
      // Strict mode should reject unknown keys.
      bogusField: "nope",
    });
    expect(result.success).toBe(false);
  });
});
