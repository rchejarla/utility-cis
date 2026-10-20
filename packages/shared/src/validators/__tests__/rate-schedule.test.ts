import { describe, it, expect } from "vitest";
import { createRateScheduleSchema, rateScheduleQuerySchema } from "../rate-schedule";

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

/**
 * The list filter, and why it is the lifecycle rather than a boolean.
 *
 * It used to be `active`, which the service translated to "has no
 * expiration date" — not what the label claimed — and which could not
 * work in either direction: `z.coerce.boolean()` is `Boolean(input)`, so
 * the string "false" a select box sends parses as **true** and the
 * Inactive option returned the active set. Draft and Published are the
 * states that decide whether a schedule can price a bill, so they are
 * what the filter asks about.
 */
describe("rateScheduleQuerySchema", () => {
  it("accepts each lifecycle state", () => {
    for (const status of ["draft", "published", "superseded"] as const) {
      expect(rateScheduleQuerySchema.parse({ status }).status).toBe(status);
    }
  });

  it("rejects a state it cannot honour instead of ignoring it", () => {
    expect(() => rateScheduleQuerySchema.parse({ status: "retired" })).toThrow();
  });

  it("no longer accepts `active`, which it could not answer either way", () => {
    // `.strict()`, so the old parameter fails loudly rather than being
    // dropped and silently returning everything.
    expect(() => rateScheduleQuerySchema.parse({ active: "false" })).toThrow();
  });

  it("leaves the filter off when nothing is asked", () => {
    expect(rateScheduleQuerySchema.parse({}).status).toBeUndefined();
  });
});
