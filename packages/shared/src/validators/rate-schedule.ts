import { z } from "zod";

// SEASONAL is excluded from Phase 1 scope
export const rateTypeEnum = z.enum(["FLAT", "TIERED", "TIME_OF_USE", "DEMAND", "BUDGET"]);

export const flatRateConfigSchema = z.object({
  type: z.literal("FLAT"),
  baseCharge: z.number().min(0),
  perUnitCharge: z.number().min(0),
});

export const tieredRateConfigSchema = z.object({
  type: z.literal("TIERED"),
  baseCharge: z.number().min(0),
  tiers: z
    .array(
      z.object({
        upToUsage: z.number().positive().optional(),
        perUnitCharge: z.number().min(0),
      })
    )
    .min(1),
});

export const touRateConfigSchema = z.object({
  type: z.literal("TIME_OF_USE"),
  baseCharge: z.number().min(0),
  periods: z.array(
    z.object({
      name: z.string().min(1),
      perUnitCharge: z.number().min(0),
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(0).max(23),
    })
  ),
});

export const demandRateConfigSchema = z.object({
  type: z.literal("DEMAND"),
  baseCharge: z.number().min(0),
  perUnitCharge: z.number().min(0),
  demandCharge: z.number().min(0),
});

export const budgetRateConfigSchema = z.object({
  type: z.literal("BUDGET"),
  baseCharge: z.number().min(0),
  budgetAmount: z.number().positive(),
  overageCharge: z.number().min(0),
});

export const rateConfigSchema = z.union([
  flatRateConfigSchema,
  tieredRateConfigSchema,
  touRateConfigSchema,
  demandRateConfigSchema,
  budgetRateConfigSchema,
]);

const RATE_TYPE_TO_CONFIG_TYPE: Record<string, string> = {
  FLAT: "FLAT",
  TIERED: "TIERED",
  TIME_OF_USE: "TIME_OF_USE",
  DEMAND: "DEMAND",
  BUDGET: "BUDGET",
};

export const createRateScheduleSchema = z
  .object({
    name: z.string().min(1).max(255),
    code: z.string().min(1).max(50),
    commodityId: z.string().uuid(),
    rateType: rateTypeEnum,
    effectiveDate: z.string().date(),
    expirationDate: z.string().date().optional(),
    description: z.string().optional(),
    regulatoryRef: z.string().max(100).optional(),
    rateConfig: rateConfigSchema,
  })
  .refine(
    (data) => data.rateConfig.type === RATE_TYPE_TO_CONFIG_TYPE[data.rateType],
    {
      message: "rateConfig.type must match rateType",
      path: ["rateConfig"],
    }
  );

export const rateScheduleQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.string().default("effectiveDate"),
  order: z.enum(["asc", "desc"]).default("desc"),
  commodityId: z.string().uuid().optional(),
  rateType: rateTypeEnum.optional(),
  active: z.coerce.boolean().optional(),
});

export type RateType = z.infer<typeof rateTypeEnum>;
export type FlatRateConfig = z.infer<typeof flatRateConfigSchema>;
export type TieredRateConfig = z.infer<typeof tieredRateConfigSchema>;
export type TouRateConfig = z.infer<typeof touRateConfigSchema>;
export type DemandRateConfig = z.infer<typeof demandRateConfigSchema>;
export type BudgetRateConfig = z.infer<typeof budgetRateConfigSchema>;
export type RateConfig = z.infer<typeof rateConfigSchema>;
export type CreateRateScheduleInput = z.infer<typeof createRateScheduleSchema>;
export type RateScheduleQuery = z.infer<typeof rateScheduleQuerySchema>;
