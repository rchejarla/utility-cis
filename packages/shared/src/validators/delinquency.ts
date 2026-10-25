import { z } from "zod";

export const delinquencyActionTypes = [
  "NOTICE_EMAIL",
  "NOTICE_SMS",
  "DOOR_HANGER",
  "SHUT_OFF_ELIGIBLE",
  "DISCONNECT",
] as const;

export const resolutionTypes = [
  "PAYMENT_RECEIVED",
  "PAYMENT_PLAN",
  "WRITE_OFF",
  "WAIVED",
] as const;

export const delinquencyFeeTypes = ["FLAT_FEE", "PERCENT_OF_BALANCE"] as const;

/**
 * What a tier charges, as strings rather than numbers.
 *
 * `minBalance` above is a `z.number()` and this deliberately is not. A
 * fee amount is handed straight to `assessFee`, whose own schema takes a
 * decimal string, and a rate of 0.0150 has no exact float. The two
 * conventions sit side by side in this file because the destination
 * differs, not because one of them is a leftover.
 *
 * Four decimal places, because `feeAmount` is a money amount under
 * FLAT_FEE and a rate under PERCENT_OF_BALANCE. `maxFee` is only ever
 * money, so two.
 */
const feeAmountString = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, "must be a positive decimal with at most 4 decimal places")
  .refine((s) => Number(s) > 0, "must be greater than zero");

const feeCapString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "must be a positive amount with at most 2 decimal places")
  .refine((s) => Number(s) > 0, "must be greater than zero");

const feeFields = {
  feeType: z.enum(delinquencyFeeTypes).nullable().optional(),
  feeAmount: feeAmountString.nullable().optional(),
  maxFee: feeCapString.nullable().optional(),
  feeReasonId: z.string().uuid().nullable().optional(),
};

const FEE_TRIO = ["feeType", "feeAmount", "feeReasonId"] as const;

/**
 * The fee configuration is set, or cleared, as a unit.
 *
 * Checked here as well as by the database's CHECK so the operator gets a
 * 400 naming the fields instead of a Prisma constraint error. On a PATCH
 * the key-presence rule is what makes it checkable without reading the
 * row back: sending one of the three alone would otherwise leave the row
 * half-configured and fail in the database.
 */
function refineFeeGroup(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const present = FEE_TRIO.filter((k) => k in value);
  if (present.length > 0 && present.length < FEE_TRIO.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [FEE_TRIO.find((k) => !(k in value))!],
      message: "feeType, feeAmount and feeReasonId are set and cleared together",
    });
  }

  const filled = FEE_TRIO.filter((k) => value[k] !== undefined && value[k] !== null);
  if (filled.length > 0 && filled.length < FEE_TRIO.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [FEE_TRIO.find((k) => value[k] === undefined || value[k] === null)!],
      message: "a tier charges an amount for a reason, or charges nothing",
    });
  }

  if (value.maxFee !== undefined && value.maxFee !== null
      && value.feeType !== "PERCENT_OF_BALANCE") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxFee"],
      message: "maxFee caps a PERCENT_OF_BALANCE fee; a flat amount is its own cap",
    });
  }
}

export const createDelinquencyRuleSchema = z.object({
  name: z.string().min(1).max(255),
  accountType: z.enum(["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "MUNICIPAL"]).optional(),
  commodityId: z.string().uuid().optional(),
  tier: z.number().int().min(1).max(20),
  daysPastDue: z.number().int().min(1).max(365),
  minBalance: z.number().min(0),
  actionType: z.enum(delinquencyActionTypes),
  notificationEventType: z.string().max(100).optional(),
  autoApply: z.boolean().default(true),
  isActive: z.boolean().default(true),
  effectiveDate: z.string().optional(),
  ...feeFields,
}).strict().superRefine(refineFeeGroup);

export const updateDelinquencyRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  daysPastDue: z.number().int().min(1).max(365).optional(),
  minBalance: z.number().min(0).optional(),
  actionType: z.enum(delinquencyActionTypes).optional(),
  notificationEventType: z.string().max(100).optional().nullable(),
  autoApply: z.boolean().optional(),
  isActive: z.boolean().optional(),
  ...feeFields,
}).strict().superRefine(refineFeeGroup);

export const delinquencyRuleQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  sort: z.enum(["tier", "createdAt", "daysPastDue"]).default("tier"),
  order: z.enum(["asc", "desc"]).default("asc"),
  accountType: z.enum(["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "MUNICIPAL"]).optional(),
  isActive: z.coerce.boolean().optional(),
}).strict();

export const delinquencyActionQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  sort: z.enum(["createdAt", "tier"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  accountId: z.string().uuid().optional(),
  status: z.enum(["PENDING", "COMPLETED", "RESOLVED", "CANCELLED"]).optional(),
  tier: z.coerce.number().int().optional(),
}).strict();

export const resolveDelinquencySchema = z.object({
  resolutionType: z.enum(resolutionTypes),
  notes: z.string().max(2000).optional(),
}).strict();

export const escalateDelinquencySchema = z.object({
  notes: z.string().max(2000).optional(),
}).strict();

export type CreateDelinquencyRuleInput = z.infer<typeof createDelinquencyRuleSchema>;
export type UpdateDelinquencyRuleInput = z.infer<typeof updateDelinquencyRuleSchema>;
