import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateServiceEventInput,
  ResolveServiceEventInput,
  ServiceEventQuery,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

/**
 * Solid-waste service events — typically pushed in from a RAMS
 * integration. The same endpoint accepts manual-entry events with
 * source=MANUAL so CSRs can record what they hear from customers.
 *
 * Resolution attaches a billing action (credit / charge / no-action)
 * that Phase 3 will hand off to the AdhocCharge module to actually
 * post against the customer's account.
 */

const fullInclude = {
  premise: {
    select: {
      id: true,
      addressLine1: true,
      city: true,
      state: true,
      zip: true,
    },
  },
  serviceAgreement: {
    select: {
      id: true,
      agreementNumber: true,
      accountId: true,
    },
  },
  container: {
    select: {
      id: true,
      containerType: true,
      sizeGallons: true,
    },
  },
} as const;

export async function listServiceEvents(
  utilityId: string,
  query: ServiceEventQuery,
) {
  const where: Record<string, unknown> = { utilityId };
  if (query.premiseId) where.premiseId = query.premiseId;
  if (query.serviceAgreementId) where.serviceAgreementId = query.serviceAgreementId;
  if (query.containerId) where.containerId = query.containerId;
  if (query.eventType) where.eventType = query.eventType;
  if (query.status) where.status = query.status;
  if (query.source) where.source = query.source;
  if (query.fromDate || query.toDate) {
    const range: Record<string, Date> = {};
    if (query.fromDate) range.gte = new Date(query.fromDate);
    if (query.toDate) range.lte = new Date(query.toDate);
    where.eventDate = range;
  }

  return paginatedTenantList(prisma.serviceEvent, where, query, {
    include: fullInclude,
  });
}

export async function getServiceEvent(id: string, utilityId: string) {
  return prisma.serviceEvent.findFirstOrThrow({
    where: { id, utilityId },
    include: fullInclude,
  });
}

export async function eventsForPremise(
  utilityId: string,
  premiseId: string,
  limit = 100,
) {
  return prisma.serviceEvent.findMany({
    where: { utilityId, premiseId },
    orderBy: { eventDatetime: "desc" },
    take: limit,
    include: fullInclude,
  });
}

export async function createServiceEvent(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateServiceEventInput,
) {
  // Idempotency: if the same RAMS event id comes through twice, do not
  // create a duplicate. Return the existing row instead. This matters
  // because RAMS retries on timeout and we don't want double-crediting.
  if (data.ramsEventId) {
    const existing = await prisma.serviceEvent.findFirst({
      where: { utilityId, ramsEventId: data.ramsEventId },
      include: fullInclude,
    });
    if (existing) return existing;
  }

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "ServiceEvent" },
    EVENT_TYPES.SERVICE_AGREEMENT_CREATED,
    () =>
      prisma.serviceEvent.create({
        data: {
          utilityId,
          premiseId: data.premiseId,
          serviceAgreementId: data.serviceAgreementId ?? null,
          containerId: data.containerId ?? null,
          eventType: data.eventType,
          eventDate: new Date(data.eventDate),
          eventDatetime: new Date(data.eventDatetime),
          source: data.source ?? "RAMS",
          ramsEventId: data.ramsEventId ?? null,
          status: "RECEIVED",
          notes: data.notes ?? null,
        },
        include: fullInclude,
      }),
  );
}

export async function resolveServiceEvent(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: ResolveServiceEventInput,
) {
  const before = await prisma.serviceEvent.findFirstOrThrow({
    where: { id, utilityId },
  });

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceEvent" },
    EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    before,
    () =>
      prisma.serviceEvent.update({
        where: { id },
        data: {
          status: "RESOLVED",
          billingAction: data.billingAction,
          billingAmount: data.billingAmount ?? null,
          notes: data.notes ?? before.notes,
        },
        include: fullInclude,
      }),
  );
}
