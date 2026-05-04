import { z } from "zod";

// v2: rate_type / rate_config are gone from the RateSchedule. Pricing
// logic now lives on RateComponent rows (see rate-component.ts in
// task 4) and assignment metadata on SAScheduleAssignment (task 6).
// This module is reduced to schedule-level metadata + the revise flow.

export const createRateScheduleSchema = z
  .object({
    name: z.string().min(1).max(255),
    code: z.string().min(1).max(50),
    commodityId: z.string().uuid(),
    effectiveDate: z.string().date(),
    expirationDate: z.string().date().optional(),
    description: z.string().optional(),
    regulatoryRef: z.string().max(100).optional(),
  })
  .strict();

// Revising a rate schedule forks it forward. The route copies all
// non-supplied fields from the predecessor; the only required input
// is the new effective date. Optional overrides let the operator
// adjust description / regulatoryRef without leaving the dialog.
export const reviseRateScheduleSchema = z.object({
  effectiveDate: z.string().date(),
  expirationDate: z.string().date().optional(),
  description: z.string().optional(),
  regulatoryRef: z.string().max(100).optional(),
});

export type ReviseRateScheduleInput = z.infer<typeof reviseRateScheduleSchema>;

export const rateScheduleSortFields = [
  "createdAt",
  "updatedAt",
  "effectiveDate",
  "expirationDate",
  "name",
  "code",
  "version",
] as const;

export const rateScheduleQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(rateScheduleSortFields).default("effectiveDate"),
  order: z.enum(["asc", "desc"]).default("desc"),
  commodityId: z.string().uuid().optional(),
  active: z.coerce.boolean().optional(),
}).strict();

export type CreateRateScheduleInput = z.infer<typeof createRateScheduleSchema>;
export type RateScheduleQuery = z.infer<typeof rateScheduleQuerySchema>;
