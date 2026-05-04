import { describe, it, expect } from "vitest";
import { createRateServiceClassSchema } from "../rate-service-class";

const COMMODITY_ID = "00000000-0000-4000-8000-000000000001";

describe("createRateServiceClassSchema", () => {
  it("accepts a valid lowercase code", () => {
    const result = createRateServiceClassSchema.safeParse({
      commodityId: COMMODITY_ID,
      code: "single_family",
      label: "Single Family",
    });
    expect(result.success).toBe(true);
  });

  it("rejects uppercase letters in the code", () => {
    const result = createRateServiceClassSchema.safeParse({
      commodityId: COMMODITY_ID,
      code: "SingleFamily",
      label: "Single Family",
    });
    expect(result.success).toBe(false);
  });

  it("rejects spaces in the code", () => {
    const result = createRateServiceClassSchema.safeParse({
      commodityId: COMMODITY_ID,
      code: "single family",
      label: "Single Family",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing commodityId", () => {
    const result = createRateServiceClassSchema.safeParse({
      code: "single_family",
      label: "Single Family",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (strict mode)", () => {
    const result = createRateServiceClassSchema.safeParse({
      commodityId: COMMODITY_ID,
      code: "single_family",
      label: "Single Family",
      bogus: "value",
    });
    expect(result.success).toBe(false);
  });
});
