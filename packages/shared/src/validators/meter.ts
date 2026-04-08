import { z } from "zod";

export const meterTypeEnum = z.enum(["AMR", "AMI", "MANUAL", "SMART"]);
export const meterStatusEnum = z.enum(["ACTIVE", "REMOVED", "DEFECTIVE", "PENDING_INSTALL"]);

export const createMeterSchema = z.object({
  premiseId: z.string().uuid(),
  meterNumber: z.string().min(1).max(100),
  commodityId: z.string().uuid(),
  meterType: meterTypeEnum,
  uomId: z.string().uuid(),
  dialCount: z.number().int().positive().optional(),
  multiplier: z.number().positive().default(1.0),
  installDate: z.string().date(),
  status: meterStatusEnum.default("ACTIVE"),
  notes: z.string().optional(),
});

export const updateMeterSchema = createMeterSchema
  .omit({ premiseId: true, meterNumber: true })
  .partial();

export const meterQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.string().default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: meterStatusEnum.optional(),
  meterType: meterTypeEnum.optional(),
  premiseId: z.string().uuid().optional(),
  commodityId: z.string().uuid().optional(),
});

export type MeterType = z.infer<typeof meterTypeEnum>;
export type MeterStatus = z.infer<typeof meterStatusEnum>;
export type CreateMeterInput = z.infer<typeof createMeterSchema>;
export type UpdateMeterInput = z.infer<typeof updateMeterSchema>;
export type MeterQuery = z.infer<typeof meterQuerySchema>;
