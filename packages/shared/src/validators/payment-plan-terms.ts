import { z } from "zod";

/**
 * A tenant's terms for deferred payment agreements.
 *
 * Stored in `UtilityConfig.settings.paymentPlans` and edited under
 * Collections beside the delinquency rules — a plan's terms are
 * collections policy, not a system setting, and where a value is stored
 * must not pick the screen it is edited on.
 *
 * Design: docs/superpowers/specs/2026-10-26-payment-plans-design.md §4a.
 *
 * **The defaults are the most permissive position consistent with the
 * state rules the design surveys, not a recommendation.** A tenant that
 * changes nothing is then not accidentally stricter than its regulator
 * allows; the opposite mistake, being more lenient than allowed, is one
 * a utility notices.
 *
 * Four of these shape a plan at agreement (`downPaymentPercent`, the
 * instalment bounds, `frequency`); the other six are copied onto the
 * plan row and judge it for the rest of its life, so changing them
 * never re-terms an agreement already running.
 */

/** What a plan must not be configured into being: no valid plan at all. */
const installmentsOrdered = (t: { minInstallments: number; maxInstallments: number }) =>
  t.minInstallments <= t.maxInstallments;

export const PaymentPlanFrequencySchema = z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY"]);

export const PaymentPlanTermsSchema = z
  .object({
    /**
     * Illinois' figure, and the highest any rule the design found
     * permits — so a tenant under a stricter cap lowers it and none is
     * silently over the line. Zero is legitimate: some utilities agree
     * a plan with nothing down.
     */
    downPaymentPercent: z.number().min(0).max(100).default(25),

    /** Arkansas' floor. */
    minInstallments: z.number().int().min(1).max(60).default(3),

    /**
     * A year. Beyond it the arrears outlive the service period that
     * produced them.
     */
    maxInstallments: z.number().int().min(1).max(60).default(12),

    /**
     * The billing cycle's own rhythm. A plan that bills off-cycle asks
     * for a payment with no bill beside it.
     */
    frequency: PaymentPlanFrequencySchema.default("MONTHLY"),

    /**
     * How far ahead the first payment may be set.
     *
     * Arkansas requires the down payment by the close of the third
     * business day, which is a bound on `start_date` rather than a
     * second clock — the down payment is the first instalment and is
     * judged by `graceDays` like any other.
     *
     * **Counted in calendar days, which is why the default is not 3.**
     * The rule counts business days; three calendar days from a Friday
     * agreement is one business day, so a default of 3 would be
     * *stricter* than the rule it was drawn from — and the refusal falls
     * on a customer, from this screen, with no regulator asking for it.
     * Seven is the smallest figure that leaves the three business days
     * the rule asks for from any day of the week with one public holiday
     * inside the window; counting exactly would need a per-tenant
     * holiday calendar, which nothing in this system has and no other
     * due date here wants. A tenant under a tighter tariff lowers it.
     */
    maxStartDateDays: z.number().int().min(0).max(365).default(7),

    /**
     * Days after an instalment's date before it counts as missed.
     * Illinois' test allows until the second day after the due date,
     * the shortest the design found; 5 is the customer-safe side of it,
     * and a tenant under a stricter tariff lowers it.
     */
    graceDays: z.number().int().min(0).max(60).default(5),

    /**
     * What the agreements surveyed actually say — "default on any
     * instalment". Grace, not a second chance, is what softens it.
     * Zero would default every plan on the sweep after it was agreed.
     */
    missedInstallmentsBeforeDefault: z.number().int().min(1).max(12).default(1),

    /**
     * Paying $30 of a $65 instalment is not paying the instalment. True
     * for a tenant that credits part payment pro rata.
     */
    partialInstallmentCounts: z.boolean().default(false),

    /**
     * Illinois' test: keeping to the instalments is not enough if the
     * current bill goes unpaid. False for a tenant whose rules look
     * only at the instalment.
     */
    currentBillCountsTowardDefault: z.boolean().default(true),

    /**
     * Charging a late fee on a debt the utility agreed to wait for is
     * the thing a plan exists to stop.
     */
    suppressFeesWhileKept: z.boolean().default(true),

    /**
     * The "deferred, then assessed on termination" pattern some
     * utilities use. False by default because it reopens "a tier
     * charges each bill once" — see the design's §7.
     */
    assessSuppressedFeesOnDefault: z.boolean().default(false),

    /**
     * Montana leaves it to the utility; Iowa *requires* offering one
     * after two consecutive payments under the first. Neither permits a
     * flat refusal in code.
     */
    allowSecondPlanAfterDefault: z.boolean().default(true),
  })
  /**
   * `.strict()` so a misspelled key is refused rather than stored and
   * ignored, which would leave an operator believing they had changed
   * something.
   */
  .strict()
  .refine(installmentsOrdered, {
    message: "maxInstallments must be at least minInstallments",
    path: ["maxInstallments"],
  });

export type PaymentPlanTerms = z.infer<typeof PaymentPlanTermsSchema>;

/**
 * Every default, as a value.
 *
 * Derived from the schema rather than written twice: a second literal
 * would be a copy that drifts, and the drift would be silent because
 * both would parse.
 */
export const DEFAULT_PLAN_TERMS: PaymentPlanTerms = PaymentPlanTermsSchema.parse({});
