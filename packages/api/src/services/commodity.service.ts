import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateCommodityInput, UpdateCommodityInput } from "@utility-cis/shared";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

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
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Commodity" },
    EVENT_TYPES.COMMODITY_CREATED,
    () =>
      prisma.commodity.create({
        data: { ...data, utilityId },
        include: { defaultUom: true },
      })
  );
}

export async function updateCommodity(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateCommodityInput
) {
  const before = await prisma.commodity.findUniqueOrThrow({ where: { id, utilityId } });
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Commodity" },
    EVENT_TYPES.COMMODITY_UPDATED,
    before,
    () =>
      prisma.commodity.update({
        where: { id, utilityId },
        data,
        include: { defaultUom: true },
      })
  );
}
