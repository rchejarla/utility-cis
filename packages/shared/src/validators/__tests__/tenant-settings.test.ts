import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import {
  issuerSettingsSchema,
  billDocumentSettingsSchema,
  REQUIRED_ISSUER_FIELDS,
  missingIssuerFields,
  type IssuerSettings,
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

/**
 * The predicate travels with the list.
 *
 * `REQUIRED_ISSUER_FIELDS` exists so the presentation loader's 422 and
 * the settings page's required markers cannot drift apart — but the list
 * alone does not say what counts as set, and a blank string is exactly
 * where the answers would diverge: the test above pins that the schema
 * accepts `""`, because that is how the settings page clears a field.
 * Anything checking for the key's presence would therefore call such a
 * tenant complete while its bills refuse to render.
 */
describe("missingIssuerFields", () => {
  const COMPLETE: IssuerSettings = {
    utilityName: "City of Testville",
    remittanceAddressLine1: "1 Water Way",
    remittanceCity: "Testville",
    remittanceState: "MT",
    remittancePostalCode: "59771",
  };

  it("finds nothing missing in a complete issuer", () => {
    expect(missingIssuerFields(COMPLETE)).toEqual([]);
  });

  it("names every required field when the block is absent", () => {
    expect(missingIssuerFields(undefined)).toEqual([...REQUIRED_ISSUER_FIELDS]);
    expect(missingIssuerFields(null)).toEqual([...REQUIRED_ISSUER_FIELDS]);
    expect(missingIssuerFields({})).toEqual([...REQUIRED_ISSUER_FIELDS]);
  });

  it("counts a blank string as missing, since a bill cannot print one", () => {
    expect(missingIssuerFields({ ...COMPLETE, remittanceCity: "" })).toEqual(["remittanceCity"]);
    expect(missingIssuerFields({ ...COMPLETE, remittanceState: "   " })).toEqual([
      "remittanceState",
    ]);
  });

  it("ignores the optional fields, however empty", () => {
    // Only five of the eleven stop a bill. A tenant with no website and
    // no billing phone still bills.
    expect(
      missingIssuerFields({
        ...COMPLETE,
        websiteUrl: "",
        billingPhone: "",
        utilityLegalName: "",
        remittanceAddressLine2: "",
      }),
    ).toEqual([]);
  });

  it("reports in the order the list declares, not the order the object happens to have", () => {
    // The 422 prints this list, and an operator fixing fields reads it
    // against the settings form, which is in declaration order.
    expect(missingIssuerFields({ remittanceState: "MT" })).toEqual(
      REQUIRED_ISSUER_FIELDS.filter((f) => f !== "remittanceState"),
    );
  });
});
