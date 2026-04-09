import { prisma } from "../lib/prisma.js";
import { domainEvents } from "../events/emitter.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateMeterInput, UpdateMeterInput, MeterQuery } from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination.js";

export async function listMeters(utilityId: string, query: MeterQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.premiseId) where.premiseId = query.premiseId;
  if (query.commodityId) where.commodityId = query.commodityId;
  if (query.status) where.status = query.status;

  const [data, total] = await Promise.all([
    prisma.meter.findMany({
      where,
      ...paginationArgs(query),
      include: {
        premise: true,
        commodity: true,
        uom: true,
      },
    }),
    prisma.meter.count({ where }),
  ]);

  return paginatedResponse(data, total, query);
}

export async function getMeter(id: string, utilityId: string) {
  return prisma.meter.findUniqueOrThrow({
    where: { id, utilityId },
    include: {
      premise: true,
      commodity: true,
      uom: true,
      serviceAgreementMeters: {
        where: { removedDate: null },
        include: {
          serviceAgreement: true,
        },
      },
    },
  });
}

export async function createMeter(
  utilityId: string,
  actorId: string,
  data: CreateMeterInput
) {
  const premise = await prisma.premise.findUniqueOrThrow({
    where: { id: data.premiseId, utilityId },
  });

  if (!premise.commodityIds.includes(data.commodityId)) {
    throw Object.assign(
      new Error("Commodity is not associated with this premise"),
      { statusCode: 400, code: "COMMODITY_MISMATCH" }
    );
  }

  const { installDate, removalDate, ...rest } = data;
  const meter = await prisma.meter.create({
    data: {
      ...rest,
      utilityId,
      installDate: new Date(installDate),
      ...(removalDate ? { removalDate: new Date(removalDate) } : {}),
    },
    include: {
      premise: true,
      commodity: true,
      uom: true,
    },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.METER_CREATED,
    entityType: "Meter",
    entityId: meter.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: meter as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return meter;
}

export async function updateMeter(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateMeterInput
) {
  const before = await prisma.meter.findUniqueOrThrow({ where: { id, utilityId } });

  const meter = await prisma.meter.update({
    where: { id, utilityId },
    data,
    include: {
      premise: true,
      commodity: true,
      uom: true,
    },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.METER_UPDATED,
    entityType: "Meter",
    entityId: meter.id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: meter as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return meter;
}
