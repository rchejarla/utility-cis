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

export async function deleteUom(utilityId: string, id: string) {
  // BR-UO-005: Cannot delete if referenced by active meters
  const meterCount = await prisma.meter.count({ where: { uomId: id, utilityId } });
  if (meterCount > 0) {
    throw Object.assign(
      new Error(`Cannot delete UOM — ${meterCount} meter(s) are using it (BR-UO-005)`),
      { statusCode: 400, code: "UOM_IN_USE" }
    );
  }
  return prisma.unitOfMeasure.delete({ where: { id, utilityId } });
}
