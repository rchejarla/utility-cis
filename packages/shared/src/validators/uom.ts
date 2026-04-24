import { z } from "zod";

export const createUomSchema = z.object({
  code: z.string().min(1).max(20).transform((v) => v.toUpperCase()),
  name: z.string().min(1).max(100),
  commodityId: z.string().uuid(),
  measureTypeId: z.string().uuid(),
  conversionFactor: z.number().positive(),
  isBaseUnit: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const updateUomSchema = createUomSchema.partial();

export type CreateUomInput = z.infer<typeof createUomSchema>;
export type UpdateUomInput = z.infer<typeof updateUomSchema>;
