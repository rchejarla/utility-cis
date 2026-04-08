import { describe, it, expect } from "vitest";
import {
  createServiceAgreementSchema,
  isValidStatusTransition,
} from "../service-agreement";

const validAgreement = {
  agreementNumber: "SA-2024-001",
  accountId: "550e8400-e29b-41d4-a716-446655440001",
  premiseId: "550e8400-e29b-41d4-a716-446655440002",
  commodityId: "550e8400-e29b-41d4-a716-446655440003",
  rateScheduleId: "550e8400-e29b-41d4-a716-446655440004",
  billingCycleId: "550e8400-e29b-41d4-a716-446655440005",
  startDate: "2024-01-01",
  meters: [
    { meterId: "550e8400-e29b-41d4-a716-446655440006", isPrimary: true },
  ],
};

describe("createServiceAgreementSchema", () => {
  it("accepts a valid service agreement", () => {
    const result = createServiceAgreementSchema.safeParse(validAgreement);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("PENDING");
    }
  });

  it("rejects an empty meters array", () => {
    const result = createServiceAgreementSchema.safeParse({ ...validAgreement, meters: [] });
    expect(result.success).toBe(false);
  });

  it("accepts multiple meters", () => {
    const result = createServiceAgreementSchema.safeParse({
      ...validAgreement,
      meters: [
        { meterId: "550e8400-e29b-41d4-a716-446655440006", isPrimary: true },
        { meterId: "550e8400-e29b-41d4-a716-446655440007", isPrimary: false },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("isValidStatusTransition", () => {
  it("allows PENDING → ACTIVE", () => {
    expect(isValidStatusTransition("PENDING", "ACTIVE")).toBe(true);
  });

  it("rejects PENDING → FINAL", () => {
    expect(isValidStatusTransition("PENDING", "FINAL")).toBe(false);
  });

  it("rejects backward transitions (ACTIVE → PENDING)", () => {
    expect(isValidStatusTransition("ACTIVE", "PENDING")).toBe(false);
  });

  it("rejects any transition from CLOSED", () => {
    expect(isValidStatusTransition("CLOSED", "ACTIVE")).toBe(false);
    expect(isValidStatusTransition("CLOSED", "PENDING")).toBe(false);
    expect(isValidStatusTransition("CLOSED", "FINAL")).toBe(false);
    expect(isValidStatusTransition("CLOSED", "CLOSED")).toBe(false);
  });

  it("allows ACTIVE → FINAL", () => {
    expect(isValidStatusTransition("ACTIVE", "FINAL")).toBe(true);
  });

  it("allows ACTIVE → CLOSED", () => {
    expect(isValidStatusTransition("ACTIVE", "CLOSED")).toBe(true);
  });

  it("allows FINAL → CLOSED", () => {
    expect(isValidStatusTransition("FINAL", "CLOSED")).toBe(true);
  });
});
