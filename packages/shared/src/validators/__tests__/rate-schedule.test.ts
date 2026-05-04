import { describe, it, expect } from "vitest";
import { createRateScheduleSchema } from "../rate-schedule";

// v2 RateSchedule is metadata-only. rateType + rateConfig moved
// off the schedule onto RateComponent rows; the closed-grammar
// validators for predicate/quantity_source/pricing land in slice
// 1 task 4 (rate-grammar.test.ts) and component CRUD validation
// in task 5 (rate-component.test.ts).

const baseSchedule = {
  name: "Standard Residential Rate",
  code: "RES-001",
  commodityId: "550e8400-e29b-41d4-a716-446655440001",
  effectiveDate: "2024-01-01",
};

describe("createRateScheduleSchema (v2 metadata-only)", () => {
  it("accepts a minimal valid schedule", () => {
    const result = createRateScheduleSchema.safeParse(baseSchedule);
    expect(result.success).toBe(true);
  });

  it("accepts the optional fields", () => {
    const result = createRateScheduleSchema.safeParse({
      ...baseSchedule,
      expirationDate: "2025-12-31",
      description: "Default residential rate",
      regulatoryRef: "PUC-DOC-12",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing name", () => {
    const { name: _name, ...rest } = baseSchedule;
    const result = createRateScheduleSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid commodityId", () => {
    const result = createRateScheduleSchema.safeParse({
      ...baseSchedule,
      commodityId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown legacy fields like rateType", () => {
    const result = createRateScheduleSchema.safeParse({
      ...baseSchedule,
      rateType: "FLAT",
      rateConfig: { type: "FLAT", baseCharge: 5, perUnitCharge: 0.1 },
    });
    expect(result.success).toBe(false);
  });
});
