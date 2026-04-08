import { prisma } from "../lib/prisma.js";
import { domainEvents } from "../events/emitter.js";
import { EVENT_TYPES, isValidStatusTransition } from "@utility-cis/shared";
import type {
  CreateServiceAgreementInput,
  UpdateServiceAgreementInput,
  ServiceAgreementQuery,
} from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination.js";

const fullInclude = {
  account: true,
  premise: true,
  commodity: true,
  rateSchedule: true,
  billingCycle: true,
  meters: {
    where: { removedDate: null as null },
    orderBy: { addedDate: "asc" as const },
    include: {
      meter: {
        include: { uom: true },
      },
    },
  },
};

export async function listServiceAgreements(
  utilityId: string,
  query: ServiceAgreementQuery
) {
  const where: Record<string, unknown> = { utilityId };

  if (query.accountId) where.accountId = query.accountId;
  if (query.premiseId) where.premiseId = query.premiseId;
  if (query.status) where.status = query.status;

  const [data, total] = await Promise.all([
    prisma.serviceAgreement.findMany({
      where,
      ...paginationArgs(query),
      include: fullInclude,
    }),
    prisma.serviceAgreement.count({ where }),
  ]);

  return paginatedResponse(data, total, query);
}

export async function getServiceAgreement(id: string) {
  return prisma.serviceAgreement.findUniqueOrThrow({
    where: { id },
    include: fullInclude,
  });
}

export async function createServiceAgreement(
  utilityId: string,
  actorId: string,
  data: CreateServiceAgreementInput
) {
  // Rule 1: Check meter uniqueness per commodity
  for (const m of data.meters) {
    const existing = await prisma.serviceAgreementMeter.findFirst({
      where: {
        meterId: m.meterId,
        removedDate: null,
        serviceAgreement: {
          commodityId: data.commodityId,
          status: { in: ["PENDING", "ACTIVE"] },
        },
      },
    });
    if (existing) {
      throw Object.assign(
        new Error("Meter is already assigned to an active agreement for this commodity"),
        { statusCode: 400, code: "METER_ALREADY_ASSIGNED" }
      );
    }
  }

  // Rule 2: Ensure at least one primary meter
  const metersToCreate = [...data.meters];
  const hasPrimary = metersToCreate.some((m) => m.isPrimary);
  if (!hasPrimary && metersToCreate.length > 0) {
    metersToCreate[0] = { ...metersToCreate[0], isPrimary: true };
  }

  // Rule 3: Create the agreement with nested meters
  const agreement = await prisma.serviceAgreement.create({
    data: {
      utilityId,
      agreementNumber: data.agreementNumber,
      accountId: data.accountId,
      premiseId: data.premiseId,
      commodityId: data.commodityId,
      rateScheduleId: data.rateScheduleId,
      billingCycleId: data.billingCycleId,
      startDate: new Date(data.startDate),
      endDate: data.endDate ? new Date(data.endDate) : null,
      status: data.status || "PENDING",
      readSequence: data.readSequence,
      meters: {
        create: metersToCreate.map((m) => ({
          utilityId,
          meterId: m.meterId,
          isPrimary: m.isPrimary,
          addedDate: new Date(data.startDate),
        })),
      },
    },
    include: fullInclude,
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.SERVICE_AGREEMENT_CREATED,
    entityType: "ServiceAgreement",
    entityId: agreement.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: agreement as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return agreement;
}

export async function updateServiceAgreement(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateServiceAgreementInput
) {
  const before = await prisma.serviceAgreement.findUniqueOrThrow({
    where: { id, utilityId },
  });

  // Validate status transition if status is changing
  if (data.status !== undefined && data.status !== before.status) {
    if (!isValidStatusTransition(before.status as Parameters<typeof isValidStatusTransition>[0], data.status)) {
      throw Object.assign(
        new Error(`Invalid status transition from ${before.status} to ${data.status}`),
        { statusCode: 400, code: "INVALID_STATUS_TRANSITION" }
      );
    }
  }

  // Build update data from non-undefined fields
  const updateData: Record<string, unknown> = {};
  if (data.rateScheduleId !== undefined) updateData.rateScheduleId = data.rateScheduleId;
  if (data.billingCycleId !== undefined) updateData.billingCycleId = data.billingCycleId;
  if (data.endDate !== undefined) updateData.endDate = new Date(data.endDate);
  if (data.status !== undefined) updateData.status = data.status;
  if (data.readSequence !== undefined) updateData.readSequence = data.readSequence;

  const agreement = await prisma.serviceAgreement.update({
    where: { id, utilityId },
    data: updateData,
    include: fullInclude,
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    entityType: "ServiceAgreement",
    entityId: agreement.id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: agreement as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return agreement;
}
