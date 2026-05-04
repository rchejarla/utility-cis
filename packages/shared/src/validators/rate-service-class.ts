import { z } from "zod";

/**
 * Per-tenant, per-commodity customer service class (Single Family,
 * Multi-Family, MSU, Commercial, etc.). Distinct from
 * Premise.premiseType (a physical-property classification) — this is
 * the billing classification used by the rate engine to select rate
 * components.
 *
 * Unlike RateComponentKind / RateAssignmentRole, ServiceClass codes
 * are tenant-defined: Bozeman has "msu"; another muni doesn't. There
 * are NO globals — every row carries a populated utility_id.
 */
const rateServiceClassCode = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9_]+$/, "Code must be lowercase letters, digits, and underscores");

export const createRateServiceClassSchema = z
  .object({
    commodityId: z.string().uuid(),
    code: rateServiceClassCode,
    label: z.string().min(1).max(100),
    sortOrder: z.number().int().nonnegative().default(100),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateRateServiceClassSchema = createRateServiceClassSchema
  .omit({ commodityId: true, code: true })
  .partial();

export const rateServiceClassQuerySchema = z
  .object({
    commodityId: z.string().uuid().optional(),
    isActive: z.coerce.boolean().optional(),
  })
  .strict();

export type CreateRateServiceClassInput = z.infer<typeof createRateServiceClassSchema>;
export type UpdateRateServiceClassInput = z.infer<typeof updateRateServiceClassSchema>;
export type RateServiceClassQuery = z.infer<typeof rateServiceClassQuerySchema>;
