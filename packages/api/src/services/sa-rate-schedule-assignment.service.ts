import { prisma } from "../lib/prisma.js";
import type {
  CreateSAScheduleAssignmentInput,
  UpdateSAScheduleAssignmentInput,
  SAScheduleAssignmentQuery,
} from "@utility-cis/shared";

/**
 * Slice 1 task 6 — SAScheduleAssignment CRUD service.
 *
 * The N-schedules-per-SA join. One SA can hold a primary delivery
 * schedule, a supply schedule, and any number of rider schedules at
 * once, each with its own effective dating window. The service layer
 * verifies both the SA and the schedule belong to the calling tenant
 * before insert; without that guard a stale ID from another tenant
 * would surface as a confusing FK error.
 *
 * Range-overlap exclusion within the same role is deferred to slice
 * 2/3.
 */

const includeShape = {
  rateSchedule: { select: { id: true, name: true, code: true, version: true } },
};

export async function listSAScheduleAssignments(
  utilityId: string,
  query: SAScheduleAssignmentQuery,
) {
  const where: Record<string, unknown> = { utilityId };
  if (query.serviceAgreementId) where.serviceAgreementId = query.serviceAgreementId;
  if (query.rateScheduleId) where.rateScheduleId = query.rateScheduleId;
  return prisma.sAScheduleAssignment.findMany({
    where,
    orderBy: { effectiveDate: "asc" },
    include: includeShape,
  });
}

export async function getSAScheduleAssignment(id: string, utilityId: string) {
  return prisma.sAScheduleAssignment.findUniqueOrThrow({
    where: { id, utilityId },
    include: includeShape,
  });
}

export async function createSAScheduleAssignment(
  utilityId: string,
  data: CreateSAScheduleAssignmentInput,
) {
  // Verify both SA and schedule belong to the tenant. RLS would also
  // catch this, but failing here yields a cleaner error than a
  // stripped-row FK violation.
  await prisma.serviceAgreement.findUniqueOrThrow({
    where: { id: data.serviceAgreementId, utilityId },
  });
  await prisma.rateSchedule.findUniqueOrThrow({
    where: { id: data.rateScheduleId, utilityId },
  });

  return prisma.sAScheduleAssignment.create({
    data: {
      utilityId,
      serviceAgreementId: data.serviceAgreementId,
      rateScheduleId: data.rateScheduleId,
      roleCode: data.roleCode,
      effectiveDate: new Date(data.effectiveDate),
      expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
    },
    include: includeShape,
  });
}

export async function updateSAScheduleAssignment(
  utilityId: string,
  id: string,
  data: UpdateSAScheduleAssignmentInput,
) {
  const updateData: Record<string, unknown> = {};
  if (data.effectiveDate !== undefined) updateData.effectiveDate = new Date(data.effectiveDate);
  if (data.expirationDate !== undefined) {
    updateData.expirationDate = data.expirationDate ? new Date(data.expirationDate) : null;
  }
  if (data.roleCode !== undefined) updateData.roleCode = data.roleCode;

  return prisma.sAScheduleAssignment.update({
    where: { id, utilityId },
    data: updateData,
    include: includeShape,
  });
}

export async function deleteSAScheduleAssignment(utilityId: string, id: string) {
  return prisma.sAScheduleAssignment.delete({
    where: { id, utilityId },
  });
}
