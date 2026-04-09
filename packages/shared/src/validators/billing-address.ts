import { z } from "zod";

export const createBillingAddressSchema = z.object({
  accountId: z.string().uuid(),
  addressLine1: z.string().min(1).max(255),
  addressLine2: z.string().max(255).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(1).max(50),
  zip: z.string().min(1).max(20),
  country: z.string().length(2).default("US"),
  isPrimary: z.boolean().default(true),
});

export const updateBillingAddressSchema = createBillingAddressSchema.partial().omit({ accountId: true });

export type CreateBillingAddressInput = z.infer<typeof createBillingAddressSchema>;
export type UpdateBillingAddressInput = z.infer<typeof updateBillingAddressSchema>;
