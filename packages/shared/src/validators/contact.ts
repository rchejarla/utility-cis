import { z } from "zod";

export const contactRoleEnum = z.enum(["PRIMARY", "BILLING", "AUTHORIZED", "EMERGENCY"]);

export const createContactSchema = z.object({
  accountId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  role: contactRoleEnum,
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(20).optional(),
  isPrimary: z.boolean().default(false),
});

export const updateContactSchema = createContactSchema.partial().omit({ accountId: true });

export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
