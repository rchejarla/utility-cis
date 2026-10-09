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
 * The order open debits are paid down in: fees first, then manual
 * debits, then bills — so a reconnection or late fee clears before the
 * oldest bill. Within a class, the oldest `dueDate` wins, tie-broken by
 * `postedAt`. See spec §6.3.
 *
 * One constant, deliberately. Spec 10 wants this tenant-configurable; it
 * is not built, because no second tenant wants a different order. When
 * one does it moves to `TenantSetting`, which already exists.
 */
export const DEBIT_ALLOCATION_ORDER = [
  "FEE",
  "ADJUSTMENT_DEBIT",
  "BILL_CHARGE",
] as const satisfies readonly DebitType[];

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

/** A money amount as a positive decimal string with at most 2dp. */
const positiveMoney = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "must be a positive amount with at most 2 decimal places")
  .refine((s) => Number(s) > 0, "amount must be greater than zero");

/** YYYY-MM-DD that is a date on the calendar, not merely well-shaped. */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine(
    (s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
    "not a real date",
  );

/**
 * Body for POST /api/v1/accounts/:id/payments.
 *
 * `amount` is **positive** here — what the operator typed, money
 * received. The service negates it when it writes the PAYMENT entry,
 * because the ledger's sign convention is the customer's obligation to
 * the utility (§3.3a) and money received reduces it. Rejecting a
 * negative here is what stops money received being posted as money owed;
 * there is exactly one negation on that path and it is in the service.
 */
export const recordPaymentSchema = z.object({
  amount: positiveMoney,
  tender: z.enum(["CARD", "ACH", "CASH", "CHECK", "LOCKBOX"]),
  receivedAt: calendarDate.optional(),
  externalRef: z.string().max(100).optional(),
  memo: z.string().max(2000).optional(),
});

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

/**
 * Body for POST /api/v1/ledger-entries/:id/reverse.
 *
 * `reasonId` is optional in slice 2 because `LedgerReasonDef` is seeded
 * in slice 3; §4.2's required-reason list covers FEE / ADJUSTMENT_DEBIT /
 * ADJUSTMENT_CREDIT / WRITE_OFF and excludes REVERSAL, so this is
 * consistent with the data model rather than a shortcut. It tightens
 * when the reason codes exist.
 */
export const reverseEntrySchema = z.object({
  reasonId: z.string().uuid().optional(),
  memo: z.string().max(2000).optional(),
});

export type ReverseEntryInput = z.infer<typeof reverseEntrySchema>;
