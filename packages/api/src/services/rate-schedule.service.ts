import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { domainEvents } from "../events/emitter.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateRateScheduleInput, RateScheduleQuery } from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination.js";

const fullInclude = {
  commodity: true,
};

export async function listRateSchedules(utilityId: string, query: RateScheduleQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.commodityId) where.commodityId = query.commodityId;
  if (query.rateType) where.rateType = query.rateType;
  if (query.active === true) where.expirationDate = null;
  if (query.active === false) where.expirationDate = { not: null };

  const [data, total] = await Promise.all([
    prisma.rateSchedule.findMany({
      where,
      ...paginationArgs(query),
      include: fullInclude,
    }),
    prisma.rateSchedule.count({ where }),
  ]);

  return paginatedResponse(data, total, query);
}

export async function getRateSchedule(id: string, utilityId: string) {
  return prisma.rateSchedule.findUniqueOrThrow({
    where: { id, utilityId },
    include: {
      commodity: true,
      supersedes: true,
      supersededBy: true,
    },
  });
}

export async function createRateSchedule(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateRateScheduleInput
) {
  const schedule = await prisma.rateSchedule.create({
    data: {
      utilityId,
      name: data.name,
      code: data.code,
      commodityId: data.commodityId,
      rateType: data.rateType,
      effectiveDate: new Date(data.effectiveDate),
      expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
      description: data.description,
      regulatoryRef: data.regulatoryRef,
      rateConfig: data.rateConfig,
      version: 1,
    },
    include: fullInclude,
  });

  await redis.del(`rate-schedule:${utilityId}:${data.code}`);

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.RATE_SCHEDULE_CREATED,
    entityType: "RateSchedule",
    entityId: schedule.id,
    utilityId,
    actorId,
    actorName,
    beforeState: null,
    afterState: schedule as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return schedule;
}

export async function reviseRateSchedule(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: CreateRateScheduleInput
) {
  const predecessor = await prisma.rateSchedule.findUniqueOrThrow({ where: { id } });

  const [, newSchedule] = await prisma.$transaction([
    prisma.rateSchedule.update({
      where: { id },
      data: { expirationDate: new Date(data.effectiveDate) },
    }),
    prisma.rateSchedule.create({
      data: {
        utilityId,
        name: data.name,
        code: predecessor.code,
        commodityId: data.commodityId,
        rateType: data.rateType,
        effectiveDate: new Date(data.effectiveDate),
        expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
        description: data.description,
        regulatoryRef: data.regulatoryRef,
        rateConfig: data.rateConfig,
        version: predecessor.version + 1,
        supersedesId: id,
      },
      include: fullInclude,
    }),
  ]);

  await redis.del(`rate-schedule:${utilityId}:${predecessor.code}`);

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.RATE_SCHEDULE_REVISED,
    entityType: "RateSchedule",
    entityId: newSchedule.id,
    utilityId,
    actorId,
    actorName,
    beforeState: predecessor as unknown as Record<string, unknown>,
    afterState: newSchedule as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return newSchedule;
}
