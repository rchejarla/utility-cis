import { prisma } from "../lib/prisma.js";
import { domainEvents } from "../events/emitter.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateCommodityInput, UpdateCommodityInput } from "@utility-cis/shared";

export async function listCommodities(utilityId: string) {
  return prisma.commodity.findMany({
    where: { utilityId },
    orderBy: { displayOrder: "asc" },
    include: { defaultUom: true },
  });
}

export async function createCommodity(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateCommodityInput
) {
  const commodity = await prisma.commodity.create({
    data: { ...data, utilityId },
    include: { defaultUom: true },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.COMMODITY_CREATED,
    entityType: "Commodity",
    entityId: commodity.id,
    utilityId,
    actorId,
    actorName,
    beforeState: null,
    afterState: commodity as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return commodity;
}

export async function updateCommodity(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateCommodityInput
) {
  const before = await prisma.commodity.findUniqueOrThrow({ where: { id, utilityId } });

  const commodity = await prisma.commodity.update({
    where: { id, utilityId },
    data,
    include: { defaultUom: true },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.COMMODITY_UPDATED,
    entityType: "Commodity",
    entityId: commodity.id,
    utilityId,
    actorId,
    actorName,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: commodity as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return commodity;
}
