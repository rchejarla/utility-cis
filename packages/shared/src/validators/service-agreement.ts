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
  billingCycleId: z.string().uuid(),
  startDate: z.string().date(),
  endDate: z.string().date().optional(),
  status: agreementStatusEnum.default("PENDING"),
  readSequence: z.number().int().optional(),
  meters: z.array(meterAssignmentSchema).min(1),
  // Tenant-configurable custom fields. Validated server-side.
  customFields: z.record(z.unknown()).optional(),
}).strict();

// Generic PATCH cannot drift the SA into a different lifecycle state.
// `startDate`, `endDate`, `status` are intentionally absent — closing
// an SA goes through `POST /api/v1/service-agreements/:id/close`,
// which calls `closeServiceAgreement` and cascades the close onto
// child meter assignments atomically. Keeping these fields out of the
// PATCH schema is the first line of defense; the DB-level lifecycle
// invariant trigger (`enforce_sa_lifecycle_invariants`) is the second.
// `.strict()` so passing a removed field returns 422 instead of being
// silently stripped — the deprecation needs to be visible.
export const updateServiceAgreementSchema = z.object({
  billingCycleId: z.string().uuid().optional(),
  readSequence: z.number().int().optional(),
  customFields: z.record(z.unknown()).optional(),
}).strict();

export const closeServiceAgreementSchema = z.object({
  endDate: z.string().date(),
  status: z.enum(["FINAL", "CLOSED"]),
  reason: z.string().max(500).optional(),
}).strict();

export const removeMeterFromAgreementSchema = z.object({
  removedDate: z.string().date(),
  reason: z.string().max(500).optional(),
}).strict();

export const swapMeterSchema = z.object({
  oldMeterId: z.string().uuid(),
  newMeterId: z.string().uuid(),
  swapDate: z.string().date(),
  reason: z.string().max(500).optional(),
}).strict();

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
export type CloseServiceAgreementInput = z.infer<typeof closeServiceAgreementSchema>;
export type RemoveMeterFromAgreementInput = z.infer<typeof removeMeterFromAgreementSchema>;
export type SwapMeterInput = z.infer<typeof swapMeterSchema>;
export type AddMeterToAgreementInput = z.infer<typeof addMeterToAgreementSchema>;
export type UpdateAgreementMeterInput = z.infer<typeof updateAgreementMeterSchema>;
export type ServiceAgreementQuery = z.infer<typeof serviceAgreementQuerySchema>;
