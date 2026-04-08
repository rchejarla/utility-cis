import { describe, it, expect } from "vitest";
import { isValidStatusTransition } from "@utility-cis/shared";

// VALID_STATUS_TRANSITIONS from the validator:
// PENDING: ["ACTIVE", "CLOSED"]
// ACTIVE:  ["FINAL", "CLOSED"]
// FINAL:   ["CLOSED"]
// CLOSED:  []

describe("ServiceAgreement status transitions", () => {
  const validTransitions: [string, string][] = [
    ["PENDING", "ACTIVE"],
    ["PENDING", "CLOSED"],
    ["ACTIVE", "FINAL"],
    ["ACTIVE", "CLOSED"],
    ["FINAL", "CLOSED"],
  ];

  const invalidTransitions: [string, string][] = [
    ["PENDING", "FINAL"],
    ["ACTIVE", "PENDING"],
    ["FINAL", "PENDING"],
    ["FINAL", "ACTIVE"],
    ["CLOSED", "PENDING"],
    ["CLOSED", "ACTIVE"],
    ["CLOSED", "FINAL"],
    ["CLOSED", "CLOSED"],
  ];

  validTransitions.forEach(([from, to]) => {
    it(`allows ${from} → ${to}`, () => {
      expect(isValidStatusTransition(from as any, to as any)).toBe(true);
    });
  });

  invalidTransitions.forEach(([from, to]) => {
    it(`rejects ${from} → ${to}`, () => {
      expect(isValidStatusTransition(from as any, to as any)).toBe(false);
    });
  });
});
