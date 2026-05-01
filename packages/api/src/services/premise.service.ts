import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreatePremiseInput, UpdatePremiseInput, PremiseQuery } from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { validateCustomFields } from "./custom-field-schema.service.js";

export async function listPremises(utilityId: string, query: PremiseQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.status) where.status = query.status;
  if (query.premiseType) where.premiseType = query.premiseType;
  if (query.serviceTerritoryId) where.serviceTerritoryId = query.serviceTerritoryId;
  if (query.ownerId) where.ownerId = query.ownerId;
  if (query.search) {
    where.OR = [
      { addressLine1: { contains: query.search, mode: "insensitive" } },
      { city: { contains: query.search, mode: "insensitive" } },
      { zip: { contains: query.search, mode: "insensitive" } },
    ];
  }

  // Base where without status filter — used for stats so they reflect other active filters
  const baseWhere: Record<string, unknown> = { utilityId };
  if (query.premiseType) baseWhere.premiseType = query.premiseType;
  if (query.serviceTerritoryId) baseWhere.serviceTerritoryId = query.serviceTerritoryId;
  if (query.ownerId) baseWhere.ownerId = query.ownerId;
  if (query.search) {
    baseWhere.OR = [
      { addressLine1: { contains: query.search, mode: "insensitive" } },
      { city: { contains: query.search, mode: "insensitive" } },
      { zip: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [data, total, activeCount, inactiveCount, condemnedCount] = await Promise.all([
    prisma.premise.findMany({
      where,
      ...paginationArgs(query),
      include: {
        owner: true,
        _count: {
          select: {
            meters: true,
            servicePoints: true,
          },
        },
      },
    }),
    prisma.premise.count({ where }),
    prisma.premise.count({ where: { ...baseWhere, status: "ACTIVE" } }),
    prisma.premise.count({ where: { ...baseWhere, status: "INACTIVE" } }),
    prisma.premise.count({ where: { ...baseWhere, status: "CONDEMNED" } }),
  ]);

  const result = paginatedResponse(data, total, query);
  return {
    ...result,
    stats: { active: activeCount, inactive: inactiveCount, condemned: condemnedCount },
  };
}

export async function getPremise(id: string, utilityId: string) {
  const premise = await prisma.premise.findUniqueOrThrow({
    where: { id, utilityId },
    include: {
      owner: true,
      meters: {
        where: { status: "ACTIVE" },
        include: {
          commodity: { select: { id: true, name: true } },
        },
      },
      servicePoints: {
        where: {
          endDate: null,
          serviceAgreement: { status: { in: ["ACTIVE", "PENDING"] } },
        },
        include: {
          serviceAgreement: {
            include: {
              account: true,
              rateSchedule: true,
              billingCycle: true,
              commodity: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });

  // Project SP-traversed agreements back into the legacy
  // `serviceAgreements` array shape the web layer consumes. Dedupe by
  // SA id in case multi-SP-per-SA arrives later.
  const seen = new Set<string>();
  const serviceAgreements = [];
  for (const sp of premise.servicePoints) {
    if (sp.serviceAgreement && !seen.has(sp.serviceAgreement.id)) {
      seen.add(sp.serviceAgreement.id);
      serviceAgreements.push(sp.serviceAgreement);
    }
  }
  return { ...premise, serviceAgreements };
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
  actorName: string,
  data: CreatePremiseInput
) {
  const { customFields: rawCustom, ...core } = data;
  const validatedCustom = await validateCustomFields(
    utilityId,
    "premise",
    rawCustom,
    { mode: "create" },
  );
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Premise" },
    EVENT_TYPES.PREMISE_CREATED,
    (tx) =>
      tx.premise.create({
        data: { ...core, utilityId, customFields: validatedCustom as object },
      }),
  );
}

export async function updatePremise(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdatePremiseInput
) {
  const before = await prisma.premise.findUniqueOrThrow({ where: { id, utilityId } });
  const { customFields: rawCustom, ...core } = data;
  const existingStored = (before.customFields as Record<string, unknown>) ?? {};
  const mergedCustom =
    rawCustom === undefined
      ? existingStored
      : await validateCustomFields(utilityId, "premise", rawCustom, {
          mode: "update",
          existingStored,
        });
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Premise" },
    EVENT_TYPES.PREMISE_UPDATED,
    before,
    (tx) =>
      tx.premise.update({
        where: { id, utilityId },
        data: { ...core, customFields: mergedCustom as object },
      }),
  );
}
