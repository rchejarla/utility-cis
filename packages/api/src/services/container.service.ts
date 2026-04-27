import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateContainerInput,
  UpdateContainerInput,
  SwapContainerInput,
  ContainerQuery,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

/**
 * Container (solid-waste cart) lifecycle management. Assignment to
 * premises and agreements, status transitions (ACTIVE → RETURNED /
 * LOST / DAMAGED), and size-upgrade swaps that preserve the old
 * container as a RETURNED row while inserting a new ACTIVE one. The
 * swap operation is atomic — both rows land in a single transaction
 * so a partial swap can't leave a premise with zero containers.
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
} as const;

export async function listContainers(utilityId: string, query: ContainerQuery) {
  const where: Record<string, unknown> = { utilityId };
  if (query.premiseId) where.premiseId = query.premiseId;
  if (query.serviceAgreementId) where.serviceAgreementId = query.serviceAgreementId;
  if (query.containerType) where.containerType = query.containerType;
  if (query.status) where.status = query.status;
  if (query.search) {
    where.OR = [
      { serialNumber: { contains: query.search, mode: "insensitive" } },
      { rfidTag: { contains: query.search, mode: "insensitive" } },
      { ramsContainerId: { contains: query.search, mode: "insensitive" } },
    ];
  }

  return paginatedTenantList(prisma.container, where, query, { include: fullInclude });
}

export async function getContainer(id: string, utilityId: string) {
  return prisma.container.findFirstOrThrow({
    where: { id, utilityId },
    include: fullInclude,
  });
}

export async function containersForPremise(utilityId: string, premiseId: string) {
  return prisma.container.findMany({
    where: { utilityId, premiseId },
    orderBy: [{ status: "asc" }, { deliveryDate: "desc" }],
    include: fullInclude,
  });
}

export async function containersForAgreement(
  utilityId: string,
  serviceAgreementId: string,
) {
  return prisma.container.findMany({
    where: { utilityId, serviceAgreementId },
    orderBy: [{ status: "asc" }, { deliveryDate: "desc" }],
    include: fullInclude,
  });
}

export async function createContainer(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateContainerInput,
) {
  // Enforce BR: one container of each type/size per active agreement
  // unless quantity > 1. Ignored if no service agreement yet.
  if (data.serviceAgreementId && data.quantity === 1) {
    const existing = await prisma.container.findFirst({
      where: {
        utilityId,
        serviceAgreementId: data.serviceAgreementId,
        containerType: data.containerType,
        sizeGallons: data.sizeGallons,
        status: "ACTIVE",
      },
    });
    if (existing) {
      throw Object.assign(
        new Error(
          "An active container of this type and size already exists on this service agreement. Use quantity > 1 for multi-unit dwellings.",
        ),
        { statusCode: 400, code: "CONTAINER_DUPLICATE" },
      );
    }
  }

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Container" },
    EVENT_TYPES.METER_CREATED,
    (tx) =>
      tx.container.create({
        data: {
          utilityId,
          premiseId: data.premiseId,
          serviceAgreementId: data.serviceAgreementId ?? null,
          containerType: data.containerType,
          sizeGallons: data.sizeGallons,
          quantity: data.quantity ?? 1,
          serialNumber: data.serialNumber ?? null,
          rfidTag: data.rfidTag ?? null,
          status: "ACTIVE",
          deliveryDate: new Date(data.deliveryDate),
          ramsContainerId: data.ramsContainerId ?? null,
          locationNotes: data.locationNotes ?? null,
        },
        include: fullInclude,
      }),
  );
}

export async function updateContainer(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateContainerInput,
) {
  const before = await prisma.container.findFirstOrThrow({
    where: { id, utilityId },
  });

  const updateData: Record<string, unknown> = {};
  if (data.serviceAgreementId !== undefined) updateData.serviceAgreementId = data.serviceAgreementId;
  if (data.containerType !== undefined) updateData.containerType = data.containerType;
  if (data.sizeGallons !== undefined) updateData.sizeGallons = data.sizeGallons;
  if (data.quantity !== undefined) updateData.quantity = data.quantity;
  if (data.serialNumber !== undefined) updateData.serialNumber = data.serialNumber;
  if (data.rfidTag !== undefined) updateData.rfidTag = data.rfidTag;
  if (data.ramsContainerId !== undefined) updateData.ramsContainerId = data.ramsContainerId;
  if (data.locationNotes !== undefined) updateData.locationNotes = data.locationNotes;
  if (data.status !== undefined) updateData.status = data.status;
  if (data.deliveryDate !== undefined) updateData.deliveryDate = new Date(data.deliveryDate);
  if (data.removalDate !== undefined) {
    updateData.removalDate = data.removalDate ? new Date(data.removalDate) : null;
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Container" },
    EVENT_TYPES.METER_UPDATED,
    before,
    (tx) =>
      tx.container.update({
        where: { id },
        data: updateData,
        include: fullInclude,
      }),
  );
}

/**
 * Atomic container swap: marks the current one RETURNED with removal_date,
 * inserts a new ACTIVE container on the same premise/agreement with the
 * new size and optionally a new type. A single $transaction so a crashed
 * swap can't leave the premise with a removed-but-not-replaced container.
 */
export async function swapContainer(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: SwapContainerInput,
) {
  const original = await prisma.container.findFirstOrThrow({
    where: { id, utilityId },
  });

  const newContainer = await prisma.$transaction(async (tx) => {
    await tx.container.update({
      where: { id },
      data: {
        status: "RETURNED",
        removalDate: new Date(data.swapDate),
      },
    });
    return tx.container.create({
      data: {
        utilityId,
        premiseId: original.premiseId,
        serviceAgreementId: original.serviceAgreementId,
        containerType: data.newContainerType ?? original.containerType,
        sizeGallons: data.newSizeGallons,
        quantity: original.quantity,
        serialNumber: null,
        rfidTag: null,
        status: "ACTIVE",
        deliveryDate: new Date(data.swapDate),
        locationNotes: original.locationNotes,
      },
      include: fullInclude,
    });
  });

  // Emit a single logical "swap" event rather than two separate update/create events.
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Container" },
    EVENT_TYPES.METER_UPDATED,
    original,
    async (_tx) => newContainer,
  );
}
