import { z } from "zod";
import { baseListQuerySchema } from "../lib/base-list-query";
import { serviceRequestTypeCode } from "./service-request-type-def";
import { serviceRequestPriorityEnum } from "./sla";

export const serviceRequestStatusEnum = z.enum([
  "NEW",
  "ASSIGNED",
  "IN_PROGRESS",
  "PENDING_FIELD",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);

export const serviceRequestSourceEnum = z.enum([
  "CSR",
  "PORTAL",
  "API",
  "SYSTEM",
  "DELINQUENCY_WORKFLOW",
]);

export const slaStatusFilter = z.enum(["on_time", "at_risk", "breached"]);

export const createServiceRequestSchema = z
  .object({
    accountId: z.string().uuid().optional().nullable(),
    premiseId: z.string().uuid().optional().nullable(),
    serviceAgreementId: z.string().uuid().optional().nullable(),
    requestType: serviceRequestTypeCode,
    requestSubtype: z.string().max(100).optional().nullable(),
    priority: serviceRequestPriorityEnum,
    description: z.string().min(1).max(10_000),
  })
  .strict();

export const updateServiceRequestSchema = z
  .object({
    description: z.string().min(1).max(10_000).optional(),
    priority: serviceRequestPriorityEnum.optional(),
    requestSubtype: z.string().max(100).optional().nullable(),
  })
  .strict();

export const assignServiceRequestSchema = z
  .object({
    assignedTo: z.string().uuid().optional().nullable(),
    assignedTeam: z.string().max(100).optional().nullable(),
  })
  .strict()
  .refine(
    (v) => v.assignedTo !== undefined || v.assignedTeam !== undefined,
    { message: "Provide at least one of assignedTo or assignedTeam" },
  );

export const transitionServiceRequestSchema = z
  .object({
    toStatus: z.enum(["ASSIGNED", "IN_PROGRESS", "PENDING_FIELD", "FAILED"]),
    notes: z.string().max(10_000).optional(),
  })
  .strict();

export const completeServiceRequestSchema = z
  .object({
    resolutionNotes: z.string().min(1).max(10_000),
  })
  .strict();

export const cancelServiceRequestSchema = z
  .object({
    reason: z.string().min(1).max(10_000),
  })
  .strict();

export const serviceRequestQuerySchema = baseListQuerySchema
  .extend({
    type: serviceRequestTypeCode.optional(),
    status: z
      .union([serviceRequestStatusEnum, z.array(serviceRequestStatusEnum)])
      .optional(),
    priority: z
      .union([serviceRequestPriorityEnum, z.array(serviceRequestPriorityEnum)])
      .optional(),
    accountId: z.string().uuid().optional(),
    premiseId: z.string().uuid().optional(),
    assignedTo: z.string().uuid().optional(),
    slaStatus: slaStatusFilter.optional(),
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().optional(),
    q: z.string().max(200).optional(),
  })
  .strict();

export type ServiceRequestStatus = z.infer<typeof serviceRequestStatusEnum>;
export type ServiceRequestSource = z.infer<typeof serviceRequestSourceEnum>;
export type CreateServiceRequestInput = z.infer<typeof createServiceRequestSchema>;
export type UpdateServiceRequestInput = z.infer<typeof updateServiceRequestSchema>;
export type AssignServiceRequestInput = z.infer<typeof assignServiceRequestSchema>;
export type TransitionServiceRequestInput = z.infer<typeof transitionServiceRequestSchema>;
export type CompleteServiceRequestInput = z.infer<typeof completeServiceRequestSchema>;
export type CancelServiceRequestInput = z.infer<typeof cancelServiceRequestSchema>;
export type ServiceRequestQuery = z.infer<typeof serviceRequestQuerySchema>;
