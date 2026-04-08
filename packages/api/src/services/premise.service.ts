import { prisma } from "../lib/prisma.js";
import { domainEvents } from "../events/emitter.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreatePremiseInput, UpdatePremiseInput, PremiseQuery } from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination.js";

export async function listPremises(utilityId: string, query: PremiseQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.status) where.status = query.status;
  if (query.premiseType) where.premiseType = query.premiseType;
  if (query.serviceTerritoryId) where.serviceTerritoryId = query.serviceTerritoryId;

  const [data, total, activeCount, inactiveCount, condemnedCount] = await Promise.all([
    prisma.premise.findMany({
      where,
      ...paginationArgs(query),
      include: {
        _count: {
          select: {
            meters: true,
            serviceAgreements: true,
          },
        },
      },
    }),
    prisma.premise.count({ where }),
    prisma.premise.count({ where: { utilityId, status: "ACTIVE" } }),
    prisma.premise.count({ where: { utilityId, status: "INACTIVE" } }),
    prisma.premise.count({ where: { utilityId, status: "CONDEMNED" } }),
  ]);

  const result = paginatedResponse(data, total, query);
  return {
    ...result,
    stats: { active: activeCount, inactive: inactiveCount, condemned: condemnedCount },
  };
}

export async function getPremise(id: string, utilityId: string) {
  return prisma.premise.findUniqueOrThrow({
    where: { id, utilityId },
    include: {
      meters: {
        where: { status: "ACTIVE" },
      },
      serviceAgreements: {
        where: {
          status: { in: ["ACTIVE", "PENDING"] },
        },
        include: {
          account: true,
          rateSchedule: true,
          billingCycle: true,
        },
      },
    },
  });
}

export async function getPremisesGeo(utilityId: string) {
  const premises = await prisma.premise.findMany({
    where: {
      utilityId,
      geoLat: { not: null },
      geoLng: { not: null },
    },
    select: {
      id: true,
      geoLat: true,
      geoLng: true,
      premiseType: true,
      status: true,
      commodityIds: true,
      addressLine1: true,
      city: true,
      state: true,
    },
  });

  type PremiseGeoRow = (typeof premises)[number];

  return {
    type: "FeatureCollection",
    features: premises.map((p: PremiseGeoRow) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [Number(p.geoLng), Number(p.geoLat)],
      },
      properties: {
        id: p.id,
        premiseType: p.premiseType,
        status: p.status,
        commodityIds: p.commodityIds,
        address: `${p.addressLine1}, ${p.city}, ${p.state}`,
      },
    })),
  };
}

export async function createPremise(
  utilityId: string,
  actorId: string,
  data: CreatePremiseInput
) {
  const premise = await prisma.premise.create({
    data: { ...data, utilityId },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.PREMISE_CREATED,
    entityType: "Premise",
    entityId: premise.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: premise as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return premise;
}

export async function updatePremise(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdatePremiseInput
) {
  const before = await prisma.premise.findUniqueOrThrow({ where: { id, utilityId } });

  const premise = await prisma.premise.update({
    where: { id, utilityId },
    data,
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.PREMISE_UPDATED,
    entityType: "Premise",
    entityId: premise.id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: premise as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return premise;
}
