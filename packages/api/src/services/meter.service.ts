import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateMeterInput, UpdateMeterInput, MeterQuery } from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

export async function listMeters(utilityId: string, query: MeterQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.premiseId) where.premiseId = query.premiseId;
  if (query.commodityId) where.commodityId = query.commodityId;
  if (query.status) where.status = query.status;
  if (query.search) {
    where.meterNumber = { contains: query.search, mode: "insensitive" };
  }

  return paginatedTenantList(prisma.meter, where, query, {
    include: { premise: true, commodity: true, uom: true },
  });
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
  actorName: string,
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

  const { installDate, ...rest } = data;
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Meter" },
    EVENT_TYPES.METER_CREATED,
    () =>
      prisma.meter.create({
        data: { ...rest, utilityId, installDate: new Date(installDate) },
        include: { premise: true, commodity: true, uom: true },
      })
  );
}

export async function updateMeter(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateMeterInput
) {
  const before = await prisma.meter.findUniqueOrThrow({ where: { id, utilityId } });
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Meter" },
    EVENT_TYPES.METER_UPDATED,
    before,
    () =>
      prisma.meter.update({
        where: { id, utilityId },
        data,
        include: { premise: true, commodity: true, uom: true },
      })
  );
}
