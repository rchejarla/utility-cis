import { prisma } from "../lib/prisma.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import type {
  CreateSlaInput,
  UpdateSlaInput,
  SlaQuery,
  SlaDTO,
  ServiceRequestPriority,
} from "@utility-cis/shared";

/**
 * SLA service. SLAs bind (requestType, priority) -> response/resolution
 * hour targets plus optional escalation metadata. The resolver is
 * called by the service-request lifecycle code to stamp due_at on
 * creation.
 */

const fullInclude = {
  escalationUser: { select: { id: true, name: true } },
} as const;

type SlaRow = {
  id: string;
  requestType: string;
  priority: ServiceRequestPriority;
  responseHours: unknown;
  resolutionHours: unknown;
  escalationHours: unknown;
  escalationUserId: string | null;
  isActive: boolean;
  escalationUser?: { id: string; name: string } | null;
};

function toDto(row: SlaRow): SlaDTO {
  return {
    id: row.id,
    requestType: row.requestType,
    priority: row.priority,
    responseHours: Number(row.responseHours),
    resolutionHours: Number(row.resolutionHours),
    escalationHours: row.escalationHours === null ? null : Number(row.escalationHours),
    escalationUserId: row.escalationUserId,
    escalationUser: row.escalationUser ?? null,
    isActive: row.isActive,
  };
}

export async function listSlas(utilityId: string, query: SlaQuery): Promise<SlaDTO[]> {
  const rows = await prisma.sla.findMany({
    where: {
      utilityId,
      ...(query.requestType ? { requestType: query.requestType } : {}),
      ...(query.includeInactive ? {} : { isActive: true }),
    },
    include: fullInclude,
    orderBy: [{ requestType: "asc" }, { priority: "asc" }],
  });
  return (rows as SlaRow[]).map(toDto);
}

export async function getSla(id: string, utilityId: string): Promise<SlaDTO> {
  const row = await prisma.sla.findFirstOrThrow({
    where: { id, utilityId },
    include: fullInclude,
  });
  return toDto(row as SlaRow);
}

export async function createSla(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateSlaInput,
): Promise<SlaDTO> {
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Sla" },
    "sla.created",
    async () => {
      const row = await prisma.sla.create({
        data: {
          utilityId,
          requestType: data.requestType,
          priority: data.priority,
          responseHours: data.responseHours,
          resolutionHours: data.resolutionHours,
          escalationHours: data.escalationHours ?? null,
          escalationUserId: data.escalationUserId ?? null,
        },
        include: fullInclude,
      });
      return toDto(row as SlaRow);
    },
  );
}

export async function updateSla(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateSlaInput,
): Promise<SlaDTO> {
  const before = await getSla(id, utilityId);
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Sla" },
    "sla.updated",
    before,
    async () => {
      const row = await prisma.sla.update({
        where: { id },
        data: {
          ...(data.responseHours !== undefined ? { responseHours: data.responseHours } : {}),
          ...(data.resolutionHours !== undefined ? { resolutionHours: data.resolutionHours } : {}),
          ...(data.escalationHours !== undefined ? { escalationHours: data.escalationHours } : {}),
          ...(data.escalationUserId !== undefined ? { escalationUserId: data.escalationUserId } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
        include: fullInclude,
      });
      return toDto(row as SlaRow);
    },
  );
}

export async function deactivateSla(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
): Promise<SlaDTO> {
  return updateSla(utilityId, actorId, actorName, id, { isActive: false });
}

export async function resolveSlaForRequest(
  utilityId: string,
  requestType: string,
  priority: ServiceRequestPriority,
): Promise<{ id: string; resolutionHours: number; responseHours: number } | null> {
  const row = await prisma.sla.findFirst({
    where: { utilityId, requestType, priority, isActive: true },
    select: { id: true, responseHours: true, resolutionHours: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    responseHours: Number(row.responseHours),
    resolutionHours: Number(row.resolutionHours),
  };
}
