import { z } from "zod";

// Hold type is now a free string that must match a code in the
// suspension_type_def reference table (global or tenant-scoped). The
// service layer enforces the FK check. This used to be a hard enum with
// four values; see suspension-type-def.ts and the Plan A migration.
const suspensionTypeCode = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[A-Z0-9_]+$/, "Type code must be uppercase letters, digits, and underscores");

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
  suspensionType: suspensionTypeCode,
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
  suspensionType: suspensionTypeCode.optional(),
  status: suspensionStatusEnum.optional(),
  activeOn: z.string().date().optional(),
}).strict();

export type SuspensionStatus = z.infer<typeof suspensionStatusEnum>;
export type CreateSuspensionInput = z.infer<typeof createSuspensionSchema>;
export type UpdateSuspensionInput = z.infer<typeof updateSuspensionSchema>;
export type SuspensionQuery = z.infer<typeof suspensionQuerySchema>;
