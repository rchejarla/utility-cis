import { prisma } from "../lib/prisma.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { assertServiceRequestTypeCode } from "./service-request-type-def.service.js";
import { resolveSlaForRequest } from "./sla.service.js";
import { nextRequestNumber } from "./service-request-counter.service.js";
import type {
  CreateServiceRequestInput,
  UpdateServiceRequestInput,
  AssignServiceRequestInput,
  TransitionServiceRequestInput,
  CompleteServiceRequestInput,
  CancelServiceRequestInput,
  ServiceRequestQuery,
  ServiceRequestStatus,
} from "@utility-cis/shared";

const fullInclude = {
  account: { select: { id: true, accountNumber: true, accountType: true } },
  premise: { select: { id: true, addressLine1: true, city: true, state: true, zip: true } },
  serviceAgreement: {
    select: {
      id: true,
      agreementNumber: true,
      commodity: { select: { name: true } },
      premise: { select: { addressLine1: true } },
    },
  },
  sla: { select: { id: true, responseHours: true, resolutionHours: true } },
  assignee: { select: { id: true, name: true, email: true } },
  creator: { select: { id: true, name: true } },
} as const;

const VALID_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  NEW:           ["ASSIGNED", "CANCELLED"],
  ASSIGNED:      ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS:   ["PENDING_FIELD", "COMPLETED", "FAILED", "CANCELLED"],
  PENDING_FIELD: ["IN_PROGRESS", "COMPLETED", "FAILED"],
  COMPLETED:     [],
  CANCELLED:     [],
  FAILED:        [],
};

export function isValidTransition(from: ServiceRequestStatus, to: ServiceRequestStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

function invalidTransition(from: ServiceRequestStatus, to: ServiceRequestStatus): Error {
  return Object.assign(
    new Error(`Invalid status transition: ${from} -> ${to}`),
    { statusCode: 409, code: "INVALID_SERVICE_REQUEST_TRANSITION", currentStatus: from },
  );
}

function computeSlaDueAt(createdAt: Date, resolutionHours: number): Date {
  return new Date(createdAt.getTime() + resolutionHours * 60 * 60 * 1000);
}

export async function listServiceRequests(utilityId: string, query: ServiceRequestQuery) {
  const where: Record<string, unknown> = { utilityId };
  if (query.type) where.requestType = query.type;
  if (query.status) where.status = Array.isArray(query.status) ? { in: query.status } : query.status;
  if (query.priority) where.priority = Array.isArray(query.priority) ? { in: query.priority } : query.priority;
  if (query.accountId) where.accountId = query.accountId;
  if (query.premiseId) where.premiseId = query.premiseId;
  if (query.assignedTo) where.assignedTo = query.assignedTo;
  if (query.dateFrom || query.dateTo) {
    where.createdAt = {
      ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
      ...(query.dateTo ? { lte: new Date(query.dateTo + "T23:59:59Z") } : {}),
    };
  }
  if (query.q) {
    where.OR = [
      { requestNumber: { contains: query.q, mode: "insensitive" } },
      { description:   { contains: query.q, mode: "insensitive" } },
    ];
  }
  if (query.slaStatus) {
    const now = new Date();
    if (query.slaStatus === "breached") {
      where.slaDueAt = { lt: now };
      where.status = { notIn: ["COMPLETED", "CANCELLED", "FAILED"] };
    } else if (query.slaStatus === "at_risk") {
      // "at_risk" = slaDueAt within the next 8 hours.
      const soon = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      where.slaDueAt = { gte: now, lte: soon };
      where.status = { notIn: ["COMPLETED", "CANCELLED", "FAILED"] };
    } else {
      where.slaDueAt = { gt: new Date(Date.now() + 8 * 60 * 60 * 1000) };
      where.status = { notIn: ["COMPLETED", "CANCELLED", "FAILED"] };
    }
  }
  const take = Math.min((query as { limit?: number }).limit ?? 50, 500);
  const rows = await prisma.serviceRequest.findMany({
    where: where as never,
    include: fullInclude,
    orderBy: [{ createdAt: "desc" }],
    take,
  });
  return { data: rows, total: rows.length };
}

export async function getServiceRequest(id: string, utilityId: string) {
  return prisma.serviceRequest.findFirstOrThrow({
    where: { id, utilityId },
    include: fullInclude,
  });
}

export async function createServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateServiceRequestInput,
) {
  await assertServiceRequestTypeCode(utilityId, data.requestType);
  const now = new Date();
  const sla = await resolveSlaForRequest(utilityId, data.requestType, data.priority);
  const requestNumber = await nextRequestNumber(utilityId, now.getUTCFullYear());
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.created",
    async () =>
      prisma.serviceRequest.create({
        data: {
          utilityId,
          requestNumber,
          accountId: data.accountId ?? null,
          premiseId: data.premiseId ?? null,
          serviceAgreementId: data.serviceAgreementId ?? null,
          requestType: data.requestType,
          requestSubtype: data.requestSubtype ?? null,
          priority: data.priority,
          status: "NEW",
          source: "CSR",
          description: data.description,
          slaId: sla?.id ?? null,
          slaDueAt: sla ? computeSlaDueAt(now, sla.resolutionHours) : null,
          createdBy: actorId,
        },
        include: fullInclude,
      }),
  );
}

export async function updateServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateServiceRequestInput,
) {
  const before = await getServiceRequest(id, utilityId);
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.updated",
    before,
    async () => {
      const priorityChanged = data.priority !== undefined && data.priority !== before.priority;
      let slaPatch: { slaId?: string | null; slaDueAt?: Date | null } = {};
      if (priorityChanged) {
        const sla = await resolveSlaForRequest(utilityId, before.requestType, data.priority!);
        slaPatch = {
          slaId: sla?.id ?? null,
          slaDueAt: sla ? computeSlaDueAt(before.createdAt, sla.resolutionHours) : null,
        };
      }
      return prisma.serviceRequest.update({
        where: { id },
        data: {
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.priority !== undefined ? { priority: data.priority } : {}),
          ...(data.requestSubtype !== undefined ? { requestSubtype: data.requestSubtype } : {}),
          ...slaPatch,
        },
        include: fullInclude,
      });
    },
  );
}

export async function assignServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: AssignServiceRequestInput,
) {
  const before = await getServiceRequest(id, utilityId);
  if (["COMPLETED", "CANCELLED", "FAILED"].includes(before.status)) {
    throw Object.assign(
      new Error("Cannot assign a terminal request"),
      { statusCode: 409, code: "SERVICE_REQUEST_TERMINAL" },
    );
  }
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.assigned",
    before,
    async () =>
      prisma.serviceRequest.update({
        where: { id },
        data: {
          ...(data.assignedTo !== undefined ? { assignedTo: data.assignedTo } : {}),
          ...(data.assignedTeam !== undefined ? { assignedTeam: data.assignedTeam } : {}),
          ...(before.status === "NEW" ? { status: "ASSIGNED" as const } : {}),
        },
        include: fullInclude,
      }),
  );
}

export async function transitionServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: TransitionServiceRequestInput,
) {
  const before = await getServiceRequest(id, utilityId);
  if (!isValidTransition(before.status, data.toStatus)) {
    throw invalidTransition(before.status, data.toStatus);
  }
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.transitioned",
    before,
    async () =>
      prisma.serviceRequest.update({
        where: { id },
        data: {
          status: data.toStatus,
          ...(data.notes
            ? { resolutionNotes: before.resolutionNotes
                ? `${before.resolutionNotes}\n\n${data.notes}`
                : data.notes }
            : {}),
        },
        include: fullInclude,
      }),
  );
}

export async function completeServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: CompleteServiceRequestInput,
) {
  const before = await getServiceRequest(id, utilityId);
  if (!isValidTransition(before.status, "COMPLETED")) {
    throw invalidTransition(before.status, "COMPLETED");
  }
  const now = new Date();
  const breached = before.slaDueAt ? now > before.slaDueAt : false;
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.completed",
    before,
    async () =>
      prisma.serviceRequest.update({
        where: { id },
        data: {
          status: "COMPLETED",
          completedAt: now,
          resolutionNotes: data.resolutionNotes,
          slaBreached: breached,
        },
        include: fullInclude,
      }),
  );
}

export async function cancelServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: CancelServiceRequestInput,
) {
  const before = await getServiceRequest(id, utilityId);
  if (!isValidTransition(before.status, "CANCELLED")) {
    throw invalidTransition(before.status, "CANCELLED");
  }
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.cancelled",
    before,
    async () =>
      prisma.serviceRequest.update({
        where: { id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          resolutionNotes: before.resolutionNotes
            ? `${before.resolutionNotes}\n\nCancelled: ${data.reason}`
            : `Cancelled: ${data.reason}`,
        },
        include: fullInclude,
      }),
  );
}

export async function listByAccount(utilityId: string, accountId: string) {
  return prisma.serviceRequest.findMany({
    where: { utilityId, accountId },
    include: fullInclude,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function listByPremise(utilityId: string, premiseId: string) {
  return prisma.serviceRequest.findMany({
    where: { utilityId, premiseId },
    include: fullInclude,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
