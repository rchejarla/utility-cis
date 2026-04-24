import { z } from "zod";
import { baseListQuerySchema } from "../lib/base-list-query";

export const serviceRequestTypeCode = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9_]+$/, "Type code must be uppercase letters, digits, and underscores");

export const serviceRequestTypeQuerySchema = baseListQuerySchema
  .extend({
    includeInactive: z.coerce.boolean().optional(),
  })
  .strict();

export interface ServiceRequestTypeDefDTO {
  id: string;
  code: string;
  label: string;
  description: string | null;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
  isGlobal: boolean;
}

export type ServiceRequestTypeQuery = z.infer<typeof serviceRequestTypeQuerySchema>;
