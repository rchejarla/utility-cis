import { z } from "zod";

export const meterEventTypeEnum = z.enum([
  "LEAK",
  "TAMPER",
  "REVERSE_FLOW",
  "HIGH_USAGE",
  "NO_SIGNAL",
  "BATTERY_LOW",
  "COVER_OPEN",
  "BURST_PIPE",
  "FREEZE",
  "OTHER",
]);

export const meterEventStatusEnum = z.enum([
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "DISMISSED",
]);

export const meterEventSourceEnum = z.enum(["AMI", "FIELD", "MANUAL", "RULE"]);

export const meterEventSortFields = [
  "eventDatetime",
  "severity",
  "status",
  "createdAt",
] as const;

export const createMeterEventSchema = z.object({
  meterId: z.string().uuid(),
  eventType: meterEventTypeEnum,
  severity: z.number().int().min(1).max(3).default(1),
  eventDatetime: z.string().datetime(),
  source: meterEventSourceEnum.default("MANUAL"),
  description: z.string().max(2000).optional(),
}).strict();

export const updateMeterEventSchema = z.object({
  status: meterEventStatusEnum.optional(),
  severity: z.number().int().min(1).max(3).optional(),
  resolutionNotes: z.string().max(2000).optional(),
});

export const meterEventQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(meterEventSortFields).default("eventDatetime"),
  order: z.enum(["asc", "desc"]).default("desc"),
  meterId: z.string().uuid().optional(),
  eventType: meterEventTypeEnum.optional(),
  status: meterEventStatusEnum.optional(),
  minSeverity: z.coerce.number().int().min(1).max(3).optional(),
}).strict();

export type MeterEventType = z.infer<typeof meterEventTypeEnum>;
export type MeterEventStatus = z.infer<typeof meterEventStatusEnum>;
export type MeterEventSource = z.infer<typeof meterEventSourceEnum>;
export type CreateMeterEventInput = z.infer<typeof createMeterEventSchema>;
export type UpdateMeterEventInput = z.infer<typeof updateMeterEventSchema>;
export type MeterEventQuery = z.infer<typeof meterEventQuerySchema>;
