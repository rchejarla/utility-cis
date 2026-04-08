import { z } from "zod";

export const billingFrequencyEnum = z.enum(["MONTHLY", "BIMONTHLY", "QUARTERLY"]);

export const createBillingCycleSchema = z.object({
  name: z.string().min(1).max(255),
  cycleCode: z.string().min(1).max(20),
  readDayOfMonth: z.number().int().min(1).max(28),
  billDayOfMonth: z.number().int().min(1).max(28),
  frequency: billingFrequencyEnum.default("MONTHLY"),
  active: z.boolean().default(true),
});

export const updateBillingCycleSchema = createBillingCycleSchema
  .omit({ cycleCode: true })
  .partial();

export type BillingFrequency = z.infer<typeof billingFrequencyEnum>;
export type CreateBillingCycleInput = z.infer<typeof createBillingCycleSchema>;
export type UpdateBillingCycleInput = z.infer<typeof updateBillingCycleSchema>;
