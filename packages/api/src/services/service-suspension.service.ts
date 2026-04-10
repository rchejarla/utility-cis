import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateSuspensionInput,
  UpdateSuspensionInput,
  SuspensionQuery,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

const fullInclude = {
  serviceAgreement: {
    select: {
      id: true,
      agreementNumber: true,
      accountId: true,
      premiseId: true,
      status: true,
    },
  },
} as const;

export async function listSuspensions(
  utilityId: string,
  query: SuspensionQuery,
) {
  const where: Record<string, unknown> = { utilityId };
  if (query.serviceAgreementId) where.serviceAgreementId = query.serviceAgreementId;
  if (query.suspensionType) where.suspensionType = query.suspensionType;
  if (query.status) where.status = query.status;
  if (query.activeOn) {
    const activeOn = new Date(query.activeOn);
    where.AND = [
      { startDate: { lte: activeOn } },
      {
        OR: [
          { endDate: null },
          { endDate: { gte: activeOn } },
        ],
      },
    ];
  }

  return paginatedTenantList(prisma.serviceSuspension, where, query, {
    include: fullInclude,
  });
}

export async function getSuspension(id: string, utilityId: string) {
  return prisma.serviceSuspension.findFirstOrThrow({
    where: { id, utilityId },
    include: fullInclude,
  });
}

export async function suspensionsForAgreement(
  utilityId: string,
  serviceAgreementId: string,
) {
  return prisma.serviceSuspension.findMany({
    where: { utilityId, serviceAgreementId },
    orderBy: { startDate: "desc" },
  });
}

export async function createSuspension(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateSuspensionInput,
) {
  // Sanity check: endDate (if provided) must not be before startDate —
  // the DB CHECK constraint would catch this but a clearer 400 is nicer.
  if (data.endDate && new Date(data.endDate) < new Date(data.startDate)) {
    throw Object.assign(new Error("end_date must be on or after start_date"), {
      statusCode: 400,
      code: "SUSPENSION_DATES_INVALID",
    });
  }

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "ServiceSuspension" },
    EVENT_TYPES.SERVICE_AGREEMENT_CREATED,
    () =>
      prisma.serviceSuspension.create({
        data: {
          utilityId,
          serviceAgreementId: data.serviceAgreementId,
          suspensionType: data.suspensionType,
          status: "PENDING",
          startDate: new Date(data.startDate),
          endDate: data.endDate ? new Date(data.endDate) : null,
          billingSuspended: data.billingSuspended ?? true,
          prorateOnStart: data.prorateOnStart ?? true,
          prorateOnEnd: data.prorateOnEnd ?? true,
          reason: data.reason ?? null,
          requestedBy: actorId,
        },
        include: fullInclude,
      }),
  );
}

export async function updateSuspension(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateSuspensionInput,
) {
  const before = await prisma.serviceSuspension.findFirstOrThrow({
    where: { id, utilityId },
  });

  const updateData: Record<string, unknown> = {};
  if (data.startDate !== undefined) updateData.startDate = new Date(data.startDate);
  if (data.endDate !== undefined) {
    updateData.endDate = data.endDate ? new Date(data.endDate) : null;
  }
  if (data.billingSuspended !== undefined) updateData.billingSuspended = data.billingSuspended;
  if (data.reason !== undefined) updateData.reason = data.reason;
  if (data.status !== undefined) updateData.status = data.status;

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceSuspension" },
    EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    before,
    () =>
      prisma.serviceSuspension.update({
        where: { id },
        data: updateData,
        include: fullInclude,
      }),
  );
}

/**
 * Explicit completion endpoint — more intentional than a status-only
 * update because it may backfill the end_date if one wasn't set.
 */
export async function completeSuspension(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  endDate?: string,
) {
  const before = await prisma.serviceSuspension.findFirstOrThrow({
    where: { id, utilityId },
  });

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceSuspension" },
    EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    before,
    () =>
      prisma.serviceSuspension.update({
        where: { id },
        data: {
          status: "COMPLETED",
          endDate: endDate ? new Date(endDate) : (before.endDate ?? new Date()),
        },
        include: fullInclude,
      }),
  );
}
