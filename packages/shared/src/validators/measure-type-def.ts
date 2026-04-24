import { z } from "zod";

// Matches the existing pattern on suspension-type-def / service-request-
// type-def so tenant admins can't insert lowercase or spaced codes.
const measureCode = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[A-Z0-9_]+$/, "Code must be uppercase letters, digits, and underscores");

export const createMeasureTypeDefSchema = z
  .object({
    code: measureCode,
    label: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    sortOrder: z.number().int().nonnegative().default(100),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateMeasureTypeDefSchema = createMeasureTypeDefSchema.partial();

export type CreateMeasureTypeDefInput = z.infer<typeof createMeasureTypeDefSchema>;
export type UpdateMeasureTypeDefInput = z.infer<typeof updateMeasureTypeDefSchema>;

export interface MeasureTypeDefDTO {
  id: string;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  isGlobal: boolean; // derived from utilityId === null
}
