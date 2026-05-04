import { z } from "zod";
import { predicateSchema } from "./rate-grammar/predicate.js";
import { quantitySourceSchema } from "./rate-grammar/quantity-source.js";
import { pricingSchema } from "./rate-grammar/pricing.js";
import { RATE_COMPONENT_KIND_CODES } from "./rate-grammar/registered-codes.js";

const kindCodeSchema = z.enum([...RATE_COMPONENT_KIND_CODES] as [string, ...string[]]);

export const createRateComponentSchema = z
  .object({
    kindCode: kindCodeSchema,
    label: z.string().min(1).max(255),
    predicate: predicateSchema,
    quantitySource: quantitySourceSchema,
    pricing: pricingSchema,
    sortOrder: z.number().int().nonnegative().default(100),
    effectiveDate: z.string().date(),
    expirationDate: z.string().date().optional(),
  })
  .strict();

export const updateRateComponentSchema = createRateComponentSchema.partial();

export type CreateRateComponentInput = z.infer<typeof createRateComponentSchema>;
export type UpdateRateComponentInput = z.infer<typeof updateRateComponentSchema>;
