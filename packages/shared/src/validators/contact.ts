import { z } from "zod";

/**
 * Contacts are now strictly record-only people on file for an account
 * (no portal access, no permissions). Anyone with portal capabilities
 * is represented by a CisUser + UserRole assignment instead. So the
 * Contact payload no longer carries a role or isPrimary flag.
 */
export const createContactSchema = z.object({
  accountId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(20).optional(),
  notes: z.string().max(2000).optional(),
});

export const updateContactSchema = createContactSchema.partial().omit({ accountId: true });

export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
