import { z } from "zod";
import { baseListQuerySchema } from "../lib/base-list-query";
import { serviceRequestTypeCode } from "./service-request-type-def";

export const serviceRequestPriorityEnum = z.enum([
  "EMERGENCY",
  "HIGH",
  "NORMAL",
  "LOW",
]);

const hours = z.coerce.number().positive().max(9999.99);

export const createSlaSchema = z
  .object({
    requestType: serviceRequestTypeCode,
    priority: serviceRequestPriorityEnum,
    responseHours: hours,
    resolutionHours: hours,
    escalationHours: hours.optional(),
    escalationUserId: z.string().uuid().optional(),
  })
  .strict();

export const updateSlaSchema = z
  .object({
    responseHours: hours.optional(),
    resolutionHours: hours.optional(),
    escalationHours: hours.optional().nullable(),
    escalationUserId: z.string().uuid().optional().nullable(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const slaQuerySchema = baseListQuerySchema
  .extend({
    requestType: serviceRequestTypeCode.optional(),
    includeInactive: z.coerce.boolean().optional(),
  })
  .strict();

export interface SlaDTO {
  id: string;
  requestType: string;
  priority: z.infer<typeof serviceRequestPriorityEnum>;
  responseHours: number;
  resolutionHours: number;
  escalationHours: number | null;
  escalationUserId: string | null;
  escalationUser?: { id: string; name: string } | null;
  isActive: boolean;
}

export type CreateSlaInput = z.infer<typeof createSlaSchema>;
export type UpdateSlaInput = z.infer<typeof updateSlaSchema>;
export type SlaQuery = z.infer<typeof slaQuerySchema>;
export type ServiceRequestPriority = z.infer<typeof serviceRequestPriorityEnum>;
