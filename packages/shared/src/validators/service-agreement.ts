import { z } from "zod";

export const agreementStatusEnum = z.enum(["PENDING", "ACTIVE", "FINAL", "CLOSED"]);

export type AgreementStatus = z.infer<typeof agreementStatusEnum>;

export const VALID_STATUS_TRANSITIONS: Record<AgreementStatus, AgreementStatus[]> = {
  PENDING: ["ACTIVE", "CLOSED"],
  ACTIVE: ["FINAL", "CLOSED"],
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

export const createServiceAgreementSchema = z.object({
  agreementNumber: z.string().min(1).max(50),
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
});

export const updateServiceAgreementSchema = z.object({
  rateScheduleId: z.string().uuid().optional(),
  billingCycleId: z.string().uuid().optional(),
  endDate: z.string().date().optional(),
  status: agreementStatusEnum.optional(),
  readSequence: z.number().int().optional(),
});

export type MeterAssignment = z.infer<typeof meterAssignmentSchema>;
export type CreateServiceAgreementInput = z.infer<typeof createServiceAgreementSchema>;
export type UpdateServiceAgreementInput = z.infer<typeof updateServiceAgreementSchema>;
