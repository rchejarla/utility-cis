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
  // BR-UO-003: Only one base unit per commodity — unmark existing if setting new one
  if (data.isBaseUnit) {
    await prisma.unitOfMeasure.updateMany({
      where: { utilityId, commodityId: data.commodityId, isBaseUnit: true },
      data: { isBaseUnit: false },
    });
  }

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

  // BR-UO-003: Only one base unit per commodity — unmark existing if setting new one
  if (data.isBaseUnit) {
    await prisma.unitOfMeasure.updateMany({
      where: { utilityId, commodityId: before.commodityId, isBaseUnit: true, id: { not: id } },
      data: { isBaseUnit: false },
    });
  }

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
  const meterCount = await prisma.meter.count({ where: { uomId: id } });
  if (meterCount > 0) {
    throw Object.assign(
      new Error(`Cannot delete UOM — ${meterCount} meter(s) are using it (BR-UO-005)`),
      { statusCode: 400, code: "UOM_IN_USE" }
    );
  }

  // Also check if this is the default UOM for a commodity
  const commodityCount = await prisma.commodity.count({ where: { defaultUomId: id } });
  if (commodityCount > 0) {
    throw Object.assign(
      new Error("Cannot delete UOM — it is the default unit for a commodity. Change the default first."),
      { statusCode: 400, code: "UOM_IS_DEFAULT" }
    );
  }

  // Use deleteMany with id filter — works with RLS since it doesn't require unique lookup
  const result = await prisma.unitOfMeasure.deleteMany({ where: { id, utilityId } });
  if (result.count === 0) {
    throw Object.assign(new Error("UOM not found"), { statusCode: 404 });
  }
  return result;
}
