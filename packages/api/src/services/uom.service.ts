import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateUomInput, UpdateUomInput } from "@utility-cis/shared";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

export async function listUom(utilityId: string, commodityId?: string) {
  return prisma.unitOfMeasure.findMany({
    where: { utilityId, ...(commodityId ? { commodityId } : {}) },
    orderBy: { code: "asc" },
    include: { commodity: true, measureType: true },
  });
}

export async function createUom(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateUomInput
) {
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "UnitOfMeasure" },
    EVENT_TYPES.UOM_CREATED,
    async () => {
      // BR-UO-003: One base unit per (commodity, measure_type) group —
      // base-unit is the conversion anchor, and conversions only make
      // sense within a measure-type group (you can't convert kWh to
      // kW). Unmark any existing base in the same group before we
      // set a new one. Enforced at the DB layer as well via a
      // partial unique index; this keeps the UX "set base here"
      // instead of forcing the admin to un-base the other first.
      if (data.isBaseUnit) {
        await prisma.unitOfMeasure.updateMany({
          where: {
            utilityId,
            commodityId: data.commodityId,
            measureTypeId: data.measureTypeId,
            isBaseUnit: true,
          },
          data: { isBaseUnit: false },
        });
      }
      return prisma.unitOfMeasure.create({
        data: { ...data, utilityId },
        include: { commodity: true, measureType: true },
      });
    }
  );
}

export async function updateUom(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateUomInput
) {
  const before = await prisma.unitOfMeasure.findUniqueOrThrow({ where: { id, utilityId } });
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "UnitOfMeasure" },
    EVENT_TYPES.UOM_UPDATED,
    before,
    async () => {
      // BR-UO-003 (scoped) — if flipping this row to base, unmark any
      // existing base in the target (commodity, measure_type) group.
      // Use the incoming measureTypeId if the admin is moving the UOM
      // between groups, else fall back to the existing one.
      if (data.isBaseUnit) {
        const targetMeasureTypeId = data.measureTypeId ?? before.measureTypeId;
        await prisma.unitOfMeasure.updateMany({
          where: {
            utilityId,
            commodityId: before.commodityId,
            measureTypeId: targetMeasureTypeId,
            isBaseUnit: true,
            id: { not: id },
          },
          data: { isBaseUnit: false },
        });
      }
      return prisma.unitOfMeasure.update({
        where: { id, utilityId },
        data,
        include: { commodity: true, measureType: true },
      });
    }
  );
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
