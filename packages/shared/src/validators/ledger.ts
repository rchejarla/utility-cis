import { z } from "zod";

/**
 * Ledger money rules, shared between API and UI.
 *
 * Sign convention, from one fixed viewpoint: positive increases what the
 * customer owes the utility, negative reduces it. See
 * docs/superpowers/specs/2026-10-09-ar-ledger-design.md §3.3a.
 */

export type DebitType = "BILL_CHARGE" | "FEE" | "ADJUSTMENT_DEBIT";
export type CreditType = "PAYMENT" | "ADJUSTMENT_CREDIT" | "WRITE_OFF";

/**
 * Expected sign per entry type. REVERSAL is deliberately absent: its
 * amount is -original.amount, so its sign follows the entry it reverses
 * and there is no fixed mapping to assert.
 */
export const ENTRY_SIGN: Record<DebitType | CreditType, 1 | -1> = {
  BILL_CHARGE: 1,
  FEE: 1,
  ADJUSTMENT_DEBIT: 1,
  PAYMENT: -1,
  ADJUSTMENT_CREDIT: -1,
  WRITE_OFF: -1,
};

/**
 * Round a rate-engine amount (Decimal(14,4)) to ledger precision
 * (Decimal(14,2)), half-up, away from zero.
 *
 * Implemented on integers rather than with `toFixed`, because
 * `toFixed` uses the IEEE-754 representation and rounds 1.005 to
 * "1.00". Half-up is the utility billing convention; the test pins
 * 47.3250 -> 47.33.
 */
export function roundToCents(value: string | number): string {
  const s = (typeof value === "number" ? value.toString() : value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`roundToCents: not a decimal string: ${value}`);
  }
  const neg = s.startsWith("-");
  const [intPart, fracPart = ""] = (neg ? s.slice(1) : s).split(".");

  // Three decimals is enough to decide half-up at two: no digits beyond
  // the third can flip a decision made there, because 0.0004999… is
  // always < 0.0005. Everything is integer arithmetic via BigInt, so no
  // float representation is involved in rounding money.
  const frac = (fracPart + "000").slice(0, 3);
  let cents = BigInt(intPart) * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n;

  const whole = cents / 100n;
  const rem = cents % 100n;
  const body = `${whole}.${rem.toString().padStart(2, "0")}`;
  // Avoid "-0.00": a value that rounds to zero has no sign.
  return neg && cents !== 0n ? `-${body}` : body;
}

/**
 * Body for POST /api/v1/bills/:id/post. One optional field: an
 * effectiveDate override, defaulting to the bill's billDate.
 *
 * The regex pins the shape and the refine pins the calendar. Without the
 * refine, "2026-13-45" is well-shaped, becomes an Invalid Date, and
 * reaches Prisma inside the posting transaction, which rejects it as a
 * PrismaClientValidationError — a 400 that blames the database client
 * for a malformed request body. Rejecting it here says what is actually
 * wrong.
 *
 * The refine is a round trip, not a `Date.parse` null check, because
 * `Date.parse` is only range-checking: it accepts "2026-02-30" and rolls
 * it forward to 2026-03-02, which would post a receivable dated a day
 * the caller never asked for. Re-formatting and comparing rejects every
 * date that does not exist, and keeps leap days that do ("2024-02-29").
 * The `Date.parse` guard stays in front of it so `toISOString()` cannot
 * throw on an Invalid Date.
 */
export const postBillSchema = z.object({
  effectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .refine(
      (s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
      "effectiveDate is not a real date",
    )
    .optional(),
});

export type PostBillInput = z.infer<typeof postBillSchema>;
