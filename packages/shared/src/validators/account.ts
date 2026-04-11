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
  depositAmount: z.number().min(0).default(0),
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

// Update schemas intentionally strip unknown keys (forgiving PATCH semantics).
export const updateAccountSchema = createAccountSchema
  .omit({ accountNumber: true })
  .partial();

export const accountQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(accountSortFields).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: accountStatusEnum.optional(),
  accountType: accountTypeEnum.optional(),
  creditRating: creditRatingEnum.optional(),
  search: z.string().optional(),
}).strict();

export type AccountType = z.infer<typeof accountTypeEnum>;
export type AccountStatus = z.infer<typeof accountStatusEnum>;
export type CreditRating = z.infer<typeof creditRatingEnum>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type AccountQuery = z.infer<typeof accountQuerySchema>;
