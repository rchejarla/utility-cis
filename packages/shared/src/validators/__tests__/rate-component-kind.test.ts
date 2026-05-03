import { describe, it, expect } from "vitest";
import { createRateComponentKindSchema } from "../rate-component-kind";

describe("createRateComponentKindSchema", () => {
  it("accepts a registered code with valid label", () => {
    const result = createRateComponentKindSchema.safeParse({
      code: "consumption",
      label: "Consumption",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unregistered code", () => {
    const result = createRateComponentKindSchema.safeParse({
      code: "weather_surcharge",
      label: "Weather Surcharge",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing label", () => {
    const result = createRateComponentKindSchema.safeParse({
      code: "tax",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (strict mode)", () => {
    const result = createRateComponentKindSchema.safeParse({
      code: "tax",
      label: "Tax",
      bogus: "value",
    });
    expect(result.success).toBe(false);
  });
});
