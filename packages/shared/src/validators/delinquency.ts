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
}).strict();

export const updateDelinquencyRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  daysPastDue: z.number().int().min(1).max(365).optional(),
  minBalance: z.number().min(0).optional(),
  actionType: z.enum(delinquencyActionTypes).optional(),
  notificationEventType: z.string().max(100).optional().nullable(),
  autoApply: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict();

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
