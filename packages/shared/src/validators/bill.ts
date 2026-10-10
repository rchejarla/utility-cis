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
 * way would quietly hide half the data.
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
    /** Inclusive bounds on billDate. */
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    /** Case-insensitive contains against billNumber. */
    search: z.string().min(1).max(100).optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "from must not be after to",
    path: ["from"],
  });

export type BillQuery = z.infer<typeof billQuerySchema>;
