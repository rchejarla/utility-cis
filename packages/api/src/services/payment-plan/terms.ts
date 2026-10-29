import {
  PaymentPlanTermsSchema,
  DEFAULT_PLAN_TERMS,
  type PaymentPlanTerms,
} from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";

/**
 * What terms this tenant agrees payment plans on.
 *
 * Design: docs/superpowers/specs/2026-10-26-payment-plans-design.md §4a.
 *
 * Read defensively, the way `issuerOf` reads the bill issuer: `settings`
 * is a Json column, every tenant lacks a `paymentPlans` key until
 * somebody opens the Collections screen, and nothing in the database
 * stops a bad write. Three failures are therefore ordinary rather than
 * exceptional — no config row, no namespace, a namespace of the wrong
 * shape — and each falls back to the full defaults.
 *
 * **Merging is per key, not per namespace.** A tenant that set two of
 * the eleven values gets its two and the defaults for the other nine;
 * falling back wholesale would silently revert the two it did set.
 *
 * Only the four creation-time terms are read through here. The six that
 * judge a running plan are copied onto `payment_plan` at agreement and
 * read from the row, so a plan is never re-termed by a later edit to
 * this namespace.
 */
export async function resolvePlanTerms(utilityId: string): Promise<PaymentPlanTerms> {
  const config = await prisma.utilityConfig.findUnique({
    where: { utilityId },
    select: { settings: true },
  });

  return planTermsOf(config?.settings);
}

/**
 * The pure half, so the fallback behaviour is testable without a
 * database and reusable by the route that saves the namespace.
 */
export function planTermsOf(settings: unknown): PaymentPlanTerms {
  if (!settings || typeof settings !== "object" || !("paymentPlans" in settings)) {
    return DEFAULT_PLAN_TERMS;
  }

  const stored = (settings as { paymentPlans?: unknown }).paymentPlans;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return DEFAULT_PLAN_TERMS;
  }

  // Zod's per-key `.default()` does the merge: a key the tenant omitted
  // arrives as the default, and a key it set wins. A parse failure means
  // a value of the wrong type reached the column, and the defaults are
  // a better answer than arithmetic on a string.
  const parsed = PaymentPlanTermsSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_PLAN_TERMS;
}
