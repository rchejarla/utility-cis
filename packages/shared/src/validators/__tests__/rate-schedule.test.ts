import { describe, it, expect } from "vitest";
import { createRateScheduleSchema } from "../rate-schedule";

const baseSchedule = {
  name: "Standard Residential Rate",
  code: "RES-001",
  commodityId: "550e8400-e29b-41d4-a716-446655440001",
  effectiveDate: "2024-01-01",
};

describe("createRateScheduleSchema — flat rate", () => {
  it("accepts a valid flat rate schedule", () => {
    const result = createRateScheduleSchema.safeParse({
      ...baseSchedule,
      rateType: "FLAT",
      rateConfig: {
        type: "FLAT",
        baseCharge: 5.00,
        perUnitCharge: 0.08,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative base charge", () => {
    const result = createRateScheduleSchema.safeParse({
      ...baseSchedule,
      rateType: "FLAT",
      rateConfig: {
        type: "FLAT",
        baseCharge: -1,
        perUnitCharge: 0.08,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("createRateScheduleSchema — tiered rate", () => {
  it("accepts a valid tiered rate schedule", () => {
    const result = createRateScheduleSchema.safeParse({
      ...baseSchedule,
      rateType: "TIERED",
      rateConfig: {
        type: "TIERED",
        baseCharge: 5.00,
        tiers: [
          { upToUsage: 500, perUnitCharge: 0.06 },
          { perUnitCharge: 0.10 },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a tiered rate with no tiers", () => {
    const result = createRateScheduleSchema.safeParse({
      ...baseSchedule,
      rateType: "TIERED",
      rateConfig: {
        type: "TIERED",
        baseCharge: 5.00,
        tiers: [],
      },
    });
    expect(result.success).toBe(false);
  });
});
