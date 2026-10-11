import { z } from "zod";

/**
 * Slice 5b.2 — generate-Bill request body.
 *
 * Account id comes from the URL params; the body carries an optional
 * `asOfDate` to override the auto-derived period (defaults server-side
 * to today). The service layer reads the account's BillCycle to compute
 * periodStart/periodEnd from that anchor.
 */
export const generateBillSchema = z
  .object({
    asOfDate: z.string().date().optional(),
  })
  .strict();

export type GenerateBillInput = z.infer<typeof generateBillSchema>;

export const billSortFields = [
  "billDate",
  "dueDate",
  "periodEnd",
  "total",
  "billNumber",
  "postedAt",
  "createdAt",
] as const;

/**
 * Where a bill stands, as a filter.
 *
 * Two axes are folded into one control on purpose, because an operator
 * does not hold them apart: `unposted` is about **issuance** — is this
 * calculation a debt yet? — and the rest are about **settlement**: has
 * the debt been paid? A bill is only ever on one side of the first
 * question, so one list stays answerable.
 *
 * Every state is **derived from the ledger**, never stored on `Bill`. A
 * status column would be a second copy of what the ledger already
 * knows, free to drift from it — the same reason a refund's pool is
 * derived from the credits it discharges rather than written down. Bill
 * still has no status enum and does not need one for this.
 *
 * `overdue` deliberately overlaps `outstanding` and `partPaid`: a bill
 * can be part paid and late at once, and collections asks for "late"
 * without caring which. Filter values are not a partition.
 */
export const billStates = z.enum([
  /** Calculated, not yet owed. No charge on the ledger at all. */
  "unposted",
  /** Anything still owed, whether or not part of it has been paid. */
  "outstanding",
  /** Something was applied to the charge, and some is still owed. */
  "partPaid",
  /** The charge is settled. */
  "paid",
  /** Still owed, and past the bill's due date. */
  "overdue",
  /** The charge was reversed, so it no longer stands. */
  "reversed",
]);

export type BillState = z.infer<typeof billStates>;

/**
 * Query for the tenant-wide bill list.
 *
 * This list exists because every other bill route is account-scoped or
 * single-id, so a bill number in a caller's hand could not be looked up
 * anywhere. `search` therefore matches the bill number — the one
 * identifier a customer reads off a piece of paper.
 *
 * `posted` is a tri-state on purpose: omitted means every bill, `false`
 * is the posting queue (calculated but not yet owed), `true` is the
 * receivables that actually moved a balance. A boolean defaulting either
 * way would quietly hide half the data. It is kept alongside `state`
 * because other callers pass it; `state: "unposted"` is the same
 * question asked by the richer filter.
 */
export const billQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(20),
    sort: z.enum(billSortFields).default("billDate"),
    order: z.enum(["asc", "desc"]).default("desc"),
    accountId: z.string().uuid().optional(),
    billingCycleId: z.string().uuid().optional(),
    posted: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    state: billStates.optional(),
    /** Inclusive bounds on billDate. */
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    /**
     * Case-insensitive contains against the bill number, the account
     * number, and the customer's name. Whitespace splits it into tokens
     * that must all match, so a full name works.
     */
    search: z.string().min(1).max(100).optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "from must not be after to",
    path: ["from"],
  });

export type BillQuery = z.infer<typeof billQuerySchema>;
