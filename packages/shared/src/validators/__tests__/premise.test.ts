import { describe, it, expect } from "vitest";
import {
  createPremiseSchema,
  premiseQuerySchema,
} from "../premise";

const validPremise = {
  addressLine1: "123 Main St",
  city: "Springfield",
  state: "IL",
  zip: "62701",
  premiseType: "RESIDENTIAL" as const,
  commodityIds: ["550e8400-e29b-41d4-a716-446655440000"],
};

describe("createPremiseSchema", () => {
  it("accepts a valid premise", () => {
    const result = createPremiseSchema.safeParse(validPremise);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("ACTIVE");
    }
  });

  it("rejects a premise missing addressLine1", () => {
    const { addressLine1: _a, ...rest } = validPremise;
    const result = createPremiseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a premise with invalid state code (not length 2)", () => {
    const result = createPremiseSchema.safeParse({ ...validPremise, state: "ILL" });
    expect(result.success).toBe(false);
  });

  it("rejects a premise with empty commodityIds array", () => {
    const result = createPremiseSchema.safeParse({ ...validPremise, commodityIds: [] });
    expect(result.success).toBe(false);
  });

  it("rejects geoLat out of bounds (-90..90)", () => {
    const result = createPremiseSchema.safeParse({ ...validPremise, geoLat: 91 });
    expect(result.success).toBe(false);
  });

  it("rejects geoLng out of bounds (-180..180)", () => {
    const result = createPremiseSchema.safeParse({ ...validPremise, geoLng: -181 });
    expect(result.success).toBe(false);
  });

  it("accepts valid geo coordinates at boundaries", () => {
    const result = createPremiseSchema.safeParse({ ...validPremise, geoLat: -90, geoLng: 180 });
    expect(result.success).toBe(true);
  });
});

describe("premiseQuerySchema", () => {
  it("applies default values when no query params provided", () => {
    const result = premiseQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
      expect(result.data.sort).toBe("createdAt");
      expect(result.data.order).toBe("desc");
    }
  });

  it("accepts optional filter fields", () => {
    const result = premiseQuerySchema.safeParse({
      status: "ACTIVE",
      premiseType: "COMMERCIAL",
      serviceTerritoryId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });
});
