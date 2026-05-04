import { prisma } from "../lib/prisma.js";
import { cacheDel } from "../lib/cache-redis.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateRateScheduleInput,
  RateScheduleQuery,
  ReviseRateScheduleInput,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

const fullInclude = {
  commodity: true,
};

export async function listRateSchedules(utilityId: string, query: RateScheduleQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.commodityId) where.commodityId = query.commodityId;
  if (query.active === true) where.expirationDate = null;
  if (query.active === false) where.expirationDate = { not: null };

  return paginatedTenantList(prisma.rateSchedule, where, query, { include: fullInclude });
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
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "RateSchedule" },
    EVENT_TYPES.RATE_SCHEDULE_CREATED,
    async (tx) => {
      const schedule = await tx.rateSchedule.create({
        data: {
          utilityId,
          name: data.name,
          code: data.code,
          commodityId: data.commodityId,
          effectiveDate: new Date(data.effectiveDate),
          expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
          description: data.description,
          regulatoryRef: data.regulatoryRef,
          version: 1,
        },
        include: fullInclude,
      });
      await cacheDel(`rate-schedule:${utilityId}:${data.code}`);
      return schedule;
    }
  );
}

export async function reviseRateSchedule(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: ReviseRateScheduleInput
) {
  const predecessor = await prisma.rateSchedule.findUniqueOrThrow({ where: { id, utilityId } });

  const newEffectiveDate = new Date(data.effectiveDate);
  if (newEffectiveDate <= predecessor.effectiveDate) {
    throw Object.assign(
      new Error("Revision effective date must be after the predecessor's"),
      { statusCode: 400, code: "REVISE_DATE_NOT_AFTER_PREDECESSOR" },
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "RateSchedule" },
    EVENT_TYPES.RATE_SCHEDULE_REVISED,
    predecessor,
    async (tx) => {
      await tx.rateSchedule.update({
        where: { id },
        data: { expirationDate: newEffectiveDate },
      });
      const newSchedule = await tx.rateSchedule.create({
        data: {
          utilityId,
          name: predecessor.name,
          code: predecessor.code,
          commodityId: predecessor.commodityId,
          effectiveDate: newEffectiveDate,
          expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
          description: data.description ?? predecessor.description,
          regulatoryRef: data.regulatoryRef ?? predecessor.regulatoryRef,
          version: predecessor.version + 1,
          supersedesId: id,
        },
        include: fullInclude,
      });
      await cacheDel(`rate-schedule:${utilityId}:${predecessor.code}`);
      return newSchedule;
    }
  );
}
