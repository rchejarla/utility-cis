import { describe, it, expect } from "vitest";
import { PaymentPlanTermsSchema, DEFAULT_PLAN_TERMS } from "../payment-plan-terms.js";

/**
 * The terms a tenant that configures nothing gets.
 *
 * The schema's stated position is "the most permissive reading consistent
 * with the state rules the design surveys", so a default that is
 * *stricter* than the rule it cites is a defect in the default, not a
 * conservative choice — it refuses a customer something no regulator
 * asked anyone to refuse.
 */

/** Business days strictly after `from`, within `days` calendar days. */
function businessDaysWithin(from: Date, days: number): number {
  let n = 0;
  for (let i = 1; i <= days; i++) {
    const d = new Date(from.getTime() + i * 86_400_000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

describe("payment plan terms defaults", () => {
  it("leaves room for the three business days the start-date rule cites", () => {
    /*
     * `maxStartDateDays` counts calendar days, and the rule it is drawn
     * from — Arkansas' down payment by the close of the third business
     * day — counts business days. At 3 calendar days a plan agreed on a
     * Friday gave the customer one business day to pay, which is
     * stricter than the rule and stricter than anyone intended.
     *
     * Four rather than three, so a single public holiday inside the
     * window still leaves the three the rule asks for. A holiday
     * calendar is the only way to count this exactly, and this system
     * has none — nor does anything else in it reason in business days.
     * The headroom is what stands in for one.
     */
    for (let dow = 0; dow < 7; dow++) {
      // 2026-11-01 is a Sunday, so this walks every weekday of agreement.
      const agreedOn = new Date(Date.UTC(2026, 10, 1 + dow));
      expect(businessDaysWithin(agreedOn, DEFAULT_PLAN_TERMS.maxStartDateDays)).toBeGreaterThanOrEqual(4);
    }
  });

  it("still lets a tenant set a stricter bound than the default", () => {
    // The default being loose is not the same as the bound being
    // unenforceable: a tenant under a tighter tariff lowers it.
    const terms = PaymentPlanTermsSchema.parse({ maxStartDateDays: 1 });
    expect(terms.maxStartDateDays).toBe(1);
  });
});
