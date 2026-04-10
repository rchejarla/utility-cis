import { z } from "zod";

export const serviceEventTypeEnum = z.enum([
  "MISSED_COLLECTION",
  "CONTAMINATION",
  "EXTRA_PICKUP",
  "BULKY_ITEM",
  "CART_DAMAGED",
  "CART_STOLEN",
  "CART_SWAP",
]);

export const serviceEventSourceEnum = z.enum([
  "RAMS",
  "MANUAL",
  "DRIVER_APP",
  "CUSTOMER_REPORT",
]);

export const serviceEventStatusEnum = z.enum([
  "RECEIVED",
  "REVIEWED",
  "ADJUSTMENT_PENDING",
  "RESOLVED",
]);

export const serviceEventBillingActionEnum = z.enum([
  "CREDIT_ISSUED",
  "CHARGE_ISSUED",
  "NO_ACTION",
]);

export const serviceEventSortFields = [
  "eventDatetime",
  "eventDate",
  "createdAt",
  "status",
] as const;

export const createServiceEventSchema = z.object({
  premiseId: z.string().uuid(),
  serviceAgreementId: z.string().uuid().optional(),
  containerId: z.string().uuid().optional(),
  eventType: serviceEventTypeEnum,
  eventDate: z.string().date(),
  eventDatetime: z.string().datetime(),
  source: serviceEventSourceEnum.default("RAMS"),
  ramsEventId: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

export const resolveServiceEventSchema = z.object({
  billingAction: serviceEventBillingActionEnum,
  billingAmount: z.number().optional(),
  notes: z.string().max(2000).optional(),
}).strict();

export const serviceEventQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(serviceEventSortFields).default("eventDatetime"),
  order: z.enum(["asc", "desc"]).default("desc"),
  premiseId: z.string().uuid().optional(),
  serviceAgreementId: z.string().uuid().optional(),
  containerId: z.string().uuid().optional(),
  eventType: serviceEventTypeEnum.optional(),
  status: serviceEventStatusEnum.optional(),
  source: serviceEventSourceEnum.optional(),
  fromDate: z.string().date().optional(),
  toDate: z.string().date().optional(),
}).strict();

export type ServiceEventType = z.infer<typeof serviceEventTypeEnum>;
export type ServiceEventSource = z.infer<typeof serviceEventSourceEnum>;
export type ServiceEventStatus = z.infer<typeof serviceEventStatusEnum>;
export type ServiceEventBillingAction = z.infer<typeof serviceEventBillingActionEnum>;
export type CreateServiceEventInput = z.infer<typeof createServiceEventSchema>;
export type ResolveServiceEventInput = z.infer<typeof resolveServiceEventSchema>;
export type ServiceEventQuery = z.infer<typeof serviceEventQuerySchema>;
