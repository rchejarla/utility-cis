import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolvePlanTerms } from "../../services/payment-plan/terms.js";
import { prisma } from "../../lib/prisma.js";
import { PaymentPlanTermsSchema, DEFAULT_PLAN_TERMS } from "@utility-cis/shared";

/**
 * A plan's terms are tenant policy, stored in
 * `UtilityConfig.settings.paymentPlans` and edited under Collections
 * beside the delinquency rules.
 *
 * The read has to be defensive in the way `issuerOf` is: every tenant
 * has no `paymentPlans` key until somebody opens that screen, and a
 * tenant that set two of the eleven values must get its two and the
 * defaults for the rest. Falling back per-namespace instead of per-key
 * would silently revert the two.
 */

beforeEach(() => {
  vi.mocked(prisma.utilityConfig.findUnique).mockReset();
});

describe("resolvePlanTerms", () => {
  it("falls back to every default when the tenant has no paymentPlans namespace", async () => {
    vi.mocked(prisma.utilityConfig.findUnique).mockResolvedValue({ settings: {} } as never);
    await expect(resolvePlanTerms("util-1")).resolves.toEqual(DEFAULT_PLAN_TERMS);
  });

  it("falls back to every default when the tenant has no config row at all", async () => {
    // A freshly provisioned tenant, before anything has written settings.
    vi.mocked(prisma.utilityConfig.findUnique).mockResolvedValue(null as never);
    await expect(resolvePlanTerms("util-1")).resolves.toEqual(DEFAULT_PLAN_TERMS);
  });

  it("takes the tenant's value where it has one and the default elsewhere", async () => {
    vi.mocked(prisma.utilityConfig.findUnique).mockResolvedValue({
      settings: { paymentPlans: { downPaymentPercent: 15 } },
    } as never);
    const terms = await resolvePlanTerms("util-1");
    expect(terms.downPaymentPercent).toBe(15);
    expect(terms.minInstallments).toBe(DEFAULT_PLAN_TERMS.minInstallments);
  });

  it("ignores a stored value that is not of the right shape", async () => {
    // Settings is a Json column: nothing in the database stops a bad
    // write, and a string where a number belongs must not reach the
    // arithmetic that computes an instalment.
    vi.mocked(prisma.utilityConfig.findUnique).mockResolvedValue({
      settings: { paymentPlans: "monthly-ish" },
    } as never);
    await expect(resolvePlanTerms("util-1")).resolves.toEqual(DEFAULT_PLAN_TERMS);
  });
});

describe("PaymentPlanTermsSchema", () => {
  it("refuses a maximum below the minimum, which would offer no valid plan", () => {
    expect(() =>
      PaymentPlanTermsSchema.parse({ minInstallments: 6, maxInstallments: 3 }),
    ).toThrow();
  });

  it("accepts a minimum equal to the maximum, which offers exactly one plan", () => {
    expect(() =>
      PaymentPlanTermsSchema.parse({ minInstallments: 4, maxInstallments: 4 }),
    ).not.toThrow();
  });

  it("refuses a down payment percent outside 0-100", () => {
    expect(() => PaymentPlanTermsSchema.parse({ downPaymentPercent: 101 })).toThrow();
    expect(() => PaymentPlanTermsSchema.parse({ downPaymentPercent: -1 })).toThrow();
  });

  it("accepts a down payment of zero, which some tenants agree", () => {
    expect(() => PaymentPlanTermsSchema.parse({ downPaymentPercent: 0 })).not.toThrow();
  });

  it("refuses a default threshold of zero, which would default every new plan", () => {
    expect(() =>
      PaymentPlanTermsSchema.parse({ missedInstallmentsBeforeDefault: 0 }),
    ).toThrow();
  });

  it("refuses a key it does not know", () => {
    // `.strict()`: a misspelled key must not be stored and silently
    // ignored, leaving an operator believing they changed something.
    expect(() => PaymentPlanTermsSchema.parse({ graceDayz: 5 })).toThrow();
  });

  it("supplies every default when parsing an empty object", () => {
    expect(PaymentPlanTermsSchema.parse({})).toEqual(DEFAULT_PLAN_TERMS);
  });
});
