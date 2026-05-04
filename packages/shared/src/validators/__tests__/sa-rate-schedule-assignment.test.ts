import { describe, it, expect } from "vitest";
import { createSAScheduleAssignmentSchema } from "../sa-rate-schedule-assignment";

const validInput = {
  serviceAgreementId: "00000000-0000-4000-8000-000000000001",
  rateScheduleId: "00000000-0000-4000-8000-000000000002",
  roleCode: "primary",
  effectiveDate: "2026-01-01",
};

describe("createSAScheduleAssignmentSchema", () => {
  it("accepts valid input with all required fields and a known roleCode", () => {
    const result = createSAScheduleAssignmentSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("rejects an unknown roleCode", () => {
    const result = createSAScheduleAssignmentSchema.safeParse({
      ...validInput,
      roleCode: "madeup_role",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing serviceAgreementId", () => {
    const { serviceAgreementId: _omit, ...rest } = validInput;
    const result = createSAScheduleAssignmentSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = createSAScheduleAssignmentSchema.safeParse({
      ...validInput,
      bogusExtra: "nope",
    });
    expect(result.success).toBe(false);
  });
});
