import { z } from "zod";

// Matches the tightened code pattern on ServiceSuspension.suspensionType.
// Kept here too so tenant admins can't insert lower-case or spaced codes.
const typeCode = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[A-Z0-9_]+$/, "Code must be uppercase letters, digits, and underscores");

export const createSuspensionTypeDefSchema = z.object({
  code: typeCode,
  label: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  category: z.string().max(50).optional(),
  sortOrder: z.number().int().nonnegative().default(100),
  isActive: z.boolean().default(true),
  defaultBillingSuspended: z.boolean().default(true),
}).strict();

export const updateSuspensionTypeDefSchema = createSuspensionTypeDefSchema.partial();

export type CreateSuspensionTypeDefInput = z.infer<typeof createSuspensionTypeDefSchema>;
export type UpdateSuspensionTypeDefInput = z.infer<typeof updateSuspensionTypeDefSchema>;

export interface SuspensionTypeDefDTO {
  id: string;
  code: string;
  label: string;
  description: string | null;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
  defaultBillingSuspended: boolean;
  isGlobal: boolean; // derived from utilityId === null
}
