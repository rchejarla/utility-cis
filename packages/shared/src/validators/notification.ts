import { z } from "zod";

export const notificationChannelSchema = z.enum(["EMAIL", "SMS"]);

const channelContentSchema = z.object({
  subject: z.string().max(500).optional(),
  body: z.string().min(1).max(10000),
}).strict();

const channelsSchema = z.object({
  email: channelContentSchema.optional(),
  sms: channelContentSchema.optional(),
}).strict();

const templateVariableSchema = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  sample: z.string().max(500).default(""),
});

export const createNotificationTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  eventType: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_.]*$/),
  description: z.string().max(2000).optional(),
  channels: channelsSchema,
  variables: z.array(templateVariableSchema).default([]),
  isActive: z.boolean().default(true),
}).strict();

export const updateNotificationTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  channels: channelsSchema.optional(),
  variables: z.array(templateVariableSchema).optional(),
  isActive: z.boolean().optional(),
}).strict();

export const notificationTemplateQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(20),
  sort: z.enum(["createdAt", "name", "eventType"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  eventType: z.string().optional(),
  isActive: z.coerce.boolean().optional(),
}).strict();

export const notificationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  sort: z.enum(["createdAt", "sentAt"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: z.enum(["PENDING", "SENDING", "SENT", "FAILED"]).optional(),
  channel: notificationChannelSchema.optional(),
  customerId: z.string().uuid().optional(),
  eventType: z.string().optional(),
}).strict();

export const manualSendSchema = z.object({
  eventType: z.string().min(1).max(100),
  channel: notificationChannelSchema,
  recipientId: z.string().uuid(),
  context: z.record(z.string()).default({}),
}).strict();

export const previewSchema = z.object({
  sampleContext: z.record(z.string()).optional(),
}).strict();

export type CreateNotificationTemplateInput = z.infer<typeof createNotificationTemplateSchema>;
export type UpdateNotificationTemplateInput = z.infer<typeof updateNotificationTemplateSchema>;
export type NotificationTemplateQuery = z.infer<typeof notificationTemplateQuerySchema>;
export type NotificationQuery = z.infer<typeof notificationQuerySchema>;
export type ManualSendInput = z.infer<typeof manualSendSchema>;
