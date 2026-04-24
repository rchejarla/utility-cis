import { describe, it, expect } from "vitest";
import { formatAgreementLabel } from "../lib/agreement-label";

describe("formatAgreementLabel", () => {
  it("formats with agreement number, commodity name, and premise address line 1", () => {
    expect(
      formatAgreementLabel({
        agreementNumber: "SA-0421",
        commodity: { name: "Potable Water" },
        premise: { addressLine1: "412 N 7th Ave" },
      }),
    ).toBe("SA-0421 · Potable Water · 412 N 7th Ave");
  });

  it("falls back gracefully when commodity or premise is missing", () => {
    expect(
      formatAgreementLabel({
        agreementNumber: "SA-0001",
        commodity: null,
        premise: null,
      }),
    ).toBe("SA-0001");
  });

  it("omits only the missing segment when one side is present", () => {
    expect(
      formatAgreementLabel({
        agreementNumber: "SA-0002",
        commodity: { name: "Electricity" },
        premise: null,
      }),
    ).toBe("SA-0002 · Electricity");
  });
});
