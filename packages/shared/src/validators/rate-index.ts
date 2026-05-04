import { z } from "zod";

/**
 * Slice 1 task 7 — RateIndex validators.
 *
 * Indexes back `pricing.type = "indexed"` for periodic values (FAC,
 * EPCC, supply quarterlies, drought_reserve_rate). Names are lowercased
 * with underscores so they're stable identifiers for the engine and
 * not subject to display-cosmetic drift.
 */

export const createRateIndexSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(50)
      .regex(/^[a-z0-9_]+$/, "Name must be lowercase letters, digits, and underscores"),
    period: z.string().min(1).max(20),
    value: z.number(),
    effectiveDate: z.string().date(),
    expirationDate: z.string().date().optional(),
    description: z.string().max(2000).optional(),
  })
  .strict();

export const updateRateIndexSchema = createRateIndexSchema.partial();

export const rateIndexQuerySchema = z
  .object({
    name: z.string().min(1).optional(),
    period: z.string().min(1).optional(),
  })
  .strict();

export type CreateRateIndexInput = z.infer<typeof createRateIndexSchema>;
export type UpdateRateIndexInput = z.infer<typeof updateRateIndexSchema>;
export type RateIndexQuery = z.infer<typeof rateIndexQuerySchema>;
