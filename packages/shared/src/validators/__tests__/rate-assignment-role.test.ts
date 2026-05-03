import { describe, it, expect } from "vitest";
import { createRateAssignmentRoleSchema } from "../rate-assignment-role";

describe("createRateAssignmentRoleSchema", () => {
  it("accepts a registered code with valid label", () => {
    const result = createRateAssignmentRoleSchema.safeParse({
      code: "primary",
      label: "Primary",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unregistered code", () => {
    const result = createRateAssignmentRoleSchema.safeParse({
      code: "auxiliary",
      label: "Auxiliary",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing label", () => {
    const result = createRateAssignmentRoleSchema.safeParse({
      code: "delivery",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (strict mode)", () => {
    const result = createRateAssignmentRoleSchema.safeParse({
      code: "rider",
      label: "Rider",
      bogus: "value",
    });
    expect(result.success).toBe(false);
  });
});
