import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateMeterEventInput,
  UpdateMeterEventInput,
  MeterEventQuery,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

const fullInclude = {
  meter: {
    select: {
      id: true,
      meterNumber: true,
      premiseId: true,
      commodityId: true,
    },
  },
} as const;

export async function listMeterEvents(utilityId: string, query: MeterEventQuery) {
  const where: Record<string, unknown> = { utilityId };
  if (query.meterId) where.meterId = query.meterId;
  if (query.eventType) where.eventType = query.eventType;
  if (query.status) where.status = query.status;
  if (query.minSeverity) where.severity = { gte: query.minSeverity };

  return paginatedTenantList(prisma.meterEvent, where, query, { include: fullInclude });
}

export async function getMeterEvent(id: string, utilityId: string) {
  return prisma.meterEvent.findFirstOrThrow({
    where: { id, utilityId },
    include: fullInclude,
  });
}

export async function createMeterEvent(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateMeterEventInput,
) {
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "MeterEvent" },
    EVENT_TYPES.METER_CREATED,
    () =>
      prisma.meterEvent.create({
        data: {
          utilityId,
          meterId: data.meterId,
          eventType: data.eventType,
          severity: data.severity ?? 1,
          eventDatetime: new Date(data.eventDatetime),
          source: data.source ?? "MANUAL",
          description: data.description ?? null,
        },
        include: fullInclude,
      }),
  );
}

export async function updateMeterEvent(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateMeterEventInput,
) {
  const before = await prisma.meterEvent.findFirstOrThrow({
    where: { id, utilityId },
  });

  const updateData: Record<string, unknown> = {};
  if (data.status !== undefined) {
    updateData.status = data.status;
    if (data.status === "RESOLVED" || data.status === "DISMISSED") {
      updateData.resolvedAt = new Date();
      updateData.resolvedBy = actorId;
    }
  }
  if (data.severity !== undefined) updateData.severity = data.severity;
  if (data.resolutionNotes !== undefined) updateData.resolutionNotes = data.resolutionNotes;

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "MeterEvent" },
    EVENT_TYPES.METER_UPDATED,
    before,
    () =>
      prisma.meterEvent.update({
        where: { id },
        data: updateData,
        include: fullInclude,
      }),
  );
}
