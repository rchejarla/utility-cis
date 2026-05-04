import { z } from "zod";
import { RATE_ASSIGNMENT_ROLE_CODES } from "./rate-grammar/registered-codes.js";

const roleCodeSchema = z.enum([...RATE_ASSIGNMENT_ROLE_CODES] as [string, ...string[]]);

export const createSAScheduleAssignmentSchema = z
  .object({
    serviceAgreementId: z.string().uuid(),
    rateScheduleId: z.string().uuid(),
    roleCode: roleCodeSchema,
    effectiveDate: z.string().date(),
    expirationDate: z.string().date().optional(),
  })
  .strict();

export const updateSAScheduleAssignmentSchema = z
  .object({
    effectiveDate: z.string().date().optional(),
    expirationDate: z.string().date().nullable().optional(),
    roleCode: roleCodeSchema.optional(),
  })
  .strict();

export const saScheduleAssignmentQuerySchema = z
  .object({
    serviceAgreementId: z.string().uuid().optional(),
    rateScheduleId: z.string().uuid().optional(),
  })
  .strict();

export type CreateSAScheduleAssignmentInput = z.infer<typeof createSAScheduleAssignmentSchema>;
export type UpdateSAScheduleAssignmentInput = z.infer<typeof updateSAScheduleAssignmentSchema>;
export type SAScheduleAssignmentQuery = z.infer<typeof saScheduleAssignmentQuerySchema>;
