import { z } from "zod";

export const createCommoditySchema = z.object({
  code: z.string().min(1).max(50).transform((v) => v.toUpperCase()),
  name: z.string().min(1).max(100),
  defaultUomId: z.string().uuid().optional(),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().default(0),
});

export const updateCommoditySchema = createCommoditySchema.partial();

export type CreateCommodityInput = z.infer<typeof createCommoditySchema>;
export type UpdateCommodityInput = z.infer<typeof updateCommoditySchema>;
