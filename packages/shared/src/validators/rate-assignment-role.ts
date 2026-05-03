import { z } from "zod";
import { RATE_ASSIGNMENT_ROLE_CODES } from "./rate-grammar/registered-codes.js";

const rateAssignmentRoleCode = z.enum([...RATE_ASSIGNMENT_ROLE_CODES] as [string, ...string[]]);

export const createRateAssignmentRoleSchema = z
  .object({
    code: rateAssignmentRoleCode,
    label: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    sortOrder: z.number().int().nonnegative().default(100),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateRateAssignmentRoleSchema = createRateAssignmentRoleSchema.partial();

export type CreateRateAssignmentRoleInput = z.infer<typeof createRateAssignmentRoleSchema>;
export type UpdateRateAssignmentRoleInput = z.infer<typeof updateRateAssignmentRoleSchema>;
