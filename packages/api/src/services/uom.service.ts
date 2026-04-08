import { prisma } from "../lib/prisma.js";
import { domainEvents } from "../events/emitter.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateUomInput, UpdateUomInput } from "@utility-cis/shared";

export async function listUom(utilityId: string, commodityId?: string) {
  return prisma.unitOfMeasure.findMany({
    where: { utilityId, ...(commodityId ? { commodityId } : {}) },
    orderBy: { code: "asc" },
    include: { commodity: true },
  });
}

export async function createUom(
  utilityId: string,
  actorId: string,
  data: CreateUomInput
) {
  const uom = await prisma.unitOfMeasure.create({
    data: { ...data, utilityId },
    include: { commodity: true },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.UOM_CREATED,
    entityType: "UnitOfMeasure",
    entityId: uom.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: uom as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return uom;
}

export async function updateUom(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateUomInput
) {
  const before = await prisma.unitOfMeasure.findUniqueOrThrow({ where: { id, utilityId } });

  const uom = await prisma.unitOfMeasure.update({
    where: { id, utilityId },
    data,
    include: { commodity: true },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.UOM_UPDATED,
    entityType: "UnitOfMeasure",
    entityId: uom.id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: uom as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return uom;
}
