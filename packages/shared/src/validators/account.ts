import { z } from "zod";

export const accountTypeEnum = z.enum(["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "MUNICIPAL"]);
export const accountStatusEnum = z.enum(["ACTIVE", "INACTIVE", "FINAL", "CLOSED", "SUSPENDED"]);
export const creditRatingEnum = z.enum(["EXCELLENT", "GOOD", "FAIR", "POOR", "UNRATED"]);

export const accountSortFields = [
  "createdAt",
  "updatedAt",
  "accountNumber",
  "status",
  "accountType",
  "creditRating",
] as const;

export const createAccountSchema = z.object({
  // Optional: backend auto-generates via the tenant's configured
  // numberFormats.account template when absent.
  accountNumber: z.string().min(1).max(50).optional(),
  customerId: z.string().uuid().optional(),
  accountType: accountTypeEnum,
  status: accountStatusEnum.default("ACTIVE"),
  creditRating: creditRatingEnum.default("UNRATED"),
  billingCycleId: z.string().uuid(),
  depositAmount: z.number().min(0).default(0),
  /**
   * How the opening deposit arrived — cash at the counter, a cheque, a
   * card. Optional, because a deposit may be recorded without anyone
   * knowing, but a tie-out groups receipts by tender, so a deposit with
   * none cannot be matched against the bank slip it was part of.
   */
  depositTender: z.enum(["CARD", "ACH", "CASH", "CHECK", "LOCKBOX"]).optional(),
  depositWaived: z.boolean().default(false),
  depositWaivedReason: z.string().max(255).optional(),
  languagePref: z.string().length(5).default("en-US"),
  paperlessBilling: z.boolean().default(false),
  budgetBilling: z.boolean().default(false),
  saaslogicAccountId: z.string().uuid().optional(),
  // Tenant-configurable custom fields. Validated server-side at the
  // service layer against the tenant's custom_field_schema row, not
  // against this static Zod schema. See spec 20.
  customFields: z.record(z.unknown()).optional(),
}).strict();

/**
 * Update schemas intentionally strip unknown keys (forgiving PATCH
 * semantics).
 *
 * `depositAmount` is omitted because it is a cache of the DEPOSIT ledger
 * entries, exactly as `balance` caches the receivable — and nobody edits
 * `balance` by hand either. A deposit changes by taking one or returning
 * one, which are acts with a tender, a date and an audit row behind
 * them. Typing a new number would leave the column disagreeing with the
 * ledger until the next recompute silently overwrote it, and
 * reconciliation would report the drift in between.
 *
 * `depositWaived` and `depositWaivedReason` stay editable: they record
 * whether a deposit was REQUIRED, which is a decision, not money.
 *
 * `depositTender` goes with the amount for the same reason: it describes
 * how one particular deposit arrived, so it is part of the act of taking
 * it, not a property of the account that can later be revised.
 */
export const updateAccountSchema = createAccountSchema
  .omit({ accountNumber: true, depositAmount: true, depositTender: true })
  .partial();

export const accountQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(accountSortFields).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: accountStatusEnum.optional(),
  accountType: accountTypeEnum.optional(),
  creditRating: creditRatingEnum.optional(),
  customerId: z.string().uuid().optional(),
  /** Free-text match against premise.addressLine1 / city — joins
   *  through serviceAgreements. Case-insensitive contains. */
  premiseSearch: z.string().min(1).max(200).optional(),
  search: z.string().optional(),
}).strict();

export type AccountType = z.infer<typeof accountTypeEnum>;
export type AccountStatus = z.infer<typeof accountStatusEnum>;
export type CreditRating = z.infer<typeof creditRatingEnum>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type AccountQuery = z.infer<typeof accountQuerySchema>;
