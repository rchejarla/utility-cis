import { z } from "zod";
import { RATE_COMPONENT_KIND_CODES } from "./rate-grammar/registered-codes.js";

const rateComponentKindCode = z.enum([...RATE_COMPONENT_KIND_CODES] as [string, ...string[]]);

export const createRateComponentKindSchema = z
  .object({
    code: rateComponentKindCode,
    label: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    sortOrder: z.number().int().nonnegative().default(100),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateRateComponentKindSchema = createRateComponentKindSchema.partial();

export type CreateRateComponentKindInput = z.infer<typeof createRateComponentKindSchema>;
export type UpdateRateComponentKindInput = z.infer<typeof updateRateComponentKindSchema>;
