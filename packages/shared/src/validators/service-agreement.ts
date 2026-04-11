import { z } from "zod";

export const agreementStatusEnum = z.enum(["PENDING", "ACTIVE", "FINAL", "CLOSED"]);

export type AgreementStatus = z.infer<typeof agreementStatusEnum>;

export const VALID_STATUS_TRANSITIONS: Record<AgreementStatus, AgreementStatus[]> = {
  PENDING: ["ACTIVE"],
  ACTIVE: ["FINAL"],
  FINAL: ["CLOSED"],
  CLOSED: [],
};

export function isValidStatusTransition(from: AgreementStatus, to: AgreementStatus): boolean {
  return VALID_STATUS_TRANSITIONS[from].includes(to);
}

export const meterAssignmentSchema = z.object({
  meterId: z.string().uuid(),
  isPrimary: z.boolean().default(false),
});

export const serviceAgreementSortFields = [
  "createdAt",
  "updatedAt",
  "agreementNumber",
  "startDate",
  "endDate",
  "status",
] as const;

export const createServiceAgreementSchema = z.object({
  // Optional: backend auto-generates via the tenant's configured
  // numberFormats.agreement template when absent. CSRs can still
  // supply a custom number to override.
  agreementNumber: z.string().min(1).max(50).optional(),
  accountId: z.string().uuid(),
  premiseId: z.string().uuid(),
  commodityId: z.string().uuid(),
  rateScheduleId: z.string().uuid(),
  billingCycleId: z.string().uuid(),
  startDate: z.string().date(),
  endDate: z.string().date().optional(),
  status: agreementStatusEnum.default("PENDING"),
  readSequence: z.number().int().optional(),
  meters: z.array(meterAssignmentSchema).min(1),
  // Tenant-configurable custom fields. Validated server-side.
  customFields: z.record(z.unknown()).optional(),
}).strict();

// Update schemas intentionally strip unknown keys (forgiving PATCH semantics).
export const updateServiceAgreementSchema = z.object({
  rateScheduleId: z.string().uuid().optional(),
  billingCycleId: z.string().uuid().optional(),
  endDate: z.string().date().optional(),
  status: agreementStatusEnum.optional(),
  readSequence: z.number().int().optional(),
  customFields: z.record(z.unknown()).optional(),
});

export const addMeterToAgreementSchema = z.object({
  meterId: z.string().uuid(),
  isPrimary: z.boolean().default(false),
}).strict();

export const updateAgreementMeterSchema = z.object({
  isPrimary: z.boolean().optional(),
  endDate: z.string().date().optional(),
}).strict();

export const serviceAgreementQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(serviceAgreementSortFields).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  accountId: z.string().uuid().optional(),
  premiseId: z.string().uuid().optional(),
  status: agreementStatusEnum.optional(),
  /** Substring match against agreement_number, used by the entity picker. */
  search: z.string().optional(),
}).strict();

export type MeterAssignment = z.infer<typeof meterAssignmentSchema>;
export type CreateServiceAgreementInput = z.infer<typeof createServiceAgreementSchema>;
export type UpdateServiceAgreementInput = z.infer<typeof updateServiceAgreementSchema>;
export type AddMeterToAgreementInput = z.infer<typeof addMeterToAgreementSchema>;
export type UpdateAgreementMeterInput = z.infer<typeof updateAgreementMeterSchema>;
export type ServiceAgreementQuery = z.infer<typeof serviceAgreementQuerySchema>;
