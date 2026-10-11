import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import {
  issuerSettingsSchema,
  billDocumentSettingsSchema,
  REQUIRED_ISSUER_FIELDS,
} from "../tenant-settings.js";

describe("issuerSettingsSchema", () => {
  it("accepts a complete issuer block", () => {
    const parsed = issuerSettingsSchema.parse({
      utilityName: "City of Testville Utilities",
      utilityLegalName: "City of Testville, Montana",
      remittanceAddressLine1: "PO Box 1230",
      remittanceCity: "Testville",
      remittanceState: "MT",
      remittancePostalCode: "59771",
      billingPhone: "406-555-0100",
      billingEmail: "ub@testville.gov",
      websiteUrl: "https://testville.gov",
    });
    expect(parsed.utilityName).toBe("City of Testville Utilities");
  });

  it("accepts a partial block, because a PATCH may send one field", () => {
    expect(() => issuerSettingsSchema.parse({ billingPhone: "406-555-0100" })).not.toThrow();
  });

  // This is what a plain JSON blob would not give us. Asserting ZodError
  // rather than any throw: before the schema exists, reading .parse off
  // undefined throws a TypeError, and a bare .toThrow() would pass on
  // that and never prove .strict() does anything.
  it("rejects a misspelled key instead of silently dropping it", () => {
    expect(() => issuerSettingsSchema.parse({ remitanceCity: "Testville" })).toThrow(ZodError);
  });

  it("rejects a malformed email and a malformed url", () => {
    expect(() => issuerSettingsSchema.parse({ billingEmail: "not-an-email" })).toThrow(ZodError);
    expect(() => issuerSettingsSchema.parse({ websiteUrl: "not-a-url" })).toThrow(ZodError);
  });

  it("accepts an empty string, which is how a settings page clears a value", () => {
    expect(() => issuerSettingsSchema.parse({ remittanceAddressLine2: "" })).not.toThrow();
  });

  it("names the five fields a bill cannot render without", () => {
    expect([...REQUIRED_ISSUER_FIELDS]).toEqual([
      "utilityName",
      "remittanceAddressLine1",
      "remittanceCity",
      "remittanceState",
      "remittancePostalCode",
    ]);
  });
});

describe("billDocumentSettingsSchema", () => {
  it("accepts the storage integration name and optional connection", () => {
    const parsed = billDocumentSettingsSchema.parse({
      storageIntegration: "cis-bills",
      storageConnection: "primary",
    });
    expect(parsed.storageIntegration).toBe("cis-bills");
  });

  it("rejects an unknown key", () => {
    expect(() => billDocumentSettingsSchema.parse({ bucket: "my-bucket" })).toThrow(ZodError);
  });
});
