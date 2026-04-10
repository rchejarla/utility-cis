import { z } from "zod";

export const suspensionTypeEnum = z.enum([
  "VACATION_HOLD",
  "SEASONAL",
  "TEMPORARY",
  "DISPUTE",
]);

export const suspensionStatusEnum = z.enum([
  "PENDING",
  "ACTIVE",
  "COMPLETED",
  "CANCELLED",
]);

export const suspensionSortFields = [
  "startDate",
  "endDate",
  "createdAt",
  "status",
] as const;

export const createSuspensionSchema = z.object({
  serviceAgreementId: z.string().uuid(),
  suspensionType: suspensionTypeEnum,
  startDate: z.string().date(),
  endDate: z.string().date().optional(),
  billingSuspended: z.boolean().default(true),
  prorateOnStart: z.boolean().default(true),
  prorateOnEnd: z.boolean().default(true),
  reason: z.string().max(2000).optional(),
}).strict();

export const updateSuspensionSchema = z.object({
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  billingSuspended: z.boolean().optional(),
  reason: z.string().max(2000).optional(),
  status: suspensionStatusEnum.optional(),
});

export const suspensionQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(suspensionSortFields).default("startDate"),
  order: z.enum(["asc", "desc"]).default("desc"),
  serviceAgreementId: z.string().uuid().optional(),
  suspensionType: suspensionTypeEnum.optional(),
  status: suspensionStatusEnum.optional(),
  activeOn: z.string().date().optional(),
}).strict();

export type SuspensionType = z.infer<typeof suspensionTypeEnum>;
export type SuspensionStatus = z.infer<typeof suspensionStatusEnum>;
export type CreateSuspensionInput = z.infer<typeof createSuspensionSchema>;
export type UpdateSuspensionInput = z.infer<typeof updateSuspensionSchema>;
export type SuspensionQuery = z.infer<typeof suspensionQuerySchema>;
