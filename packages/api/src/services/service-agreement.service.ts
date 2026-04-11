import { prisma } from "../lib/prisma.js";
import { generateNumber } from "../lib/number-generator.js";
import { validateCustomFields } from "./custom-field-schema.service.js";
import { EVENT_TYPES, isValidStatusTransition } from "@utility-cis/shared";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import type {
  CreateServiceAgreementInput,
  UpdateServiceAgreementInput,
  ServiceAgreementQuery,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";

const fullInclude = {
  account: true,
  premise: true,
  commodity: true,
  rateSchedule: true,
  billingCycle: true,
  meters: {
    where: { removedDate: null as null },
    orderBy: { addedDate: "asc" as const },
    include: {
      meter: {
        include: { uom: true },
      },
    },
  },
};

export async function listServiceAgreements(
  utilityId: string,
  query: ServiceAgreementQuery
) {
  const where: Record<string, unknown> = { utilityId };

  if (query.accountId) where.accountId = query.accountId;
  if (query.premiseId) where.premiseId = query.premiseId;
  if (query.status) where.status = query.status;
  if (query.search) {
    where.agreementNumber = { contains: query.search, mode: "insensitive" };
  }

  return paginatedTenantList(prisma.serviceAgreement, where, query, { include: fullInclude });
}

export async function getServiceAgreement(id: string, utilityId: string) {
  return prisma.serviceAgreement.findUniqueOrThrow({
    where: { id, utilityId },
    include: fullInclude,
  });
}

export async function createServiceAgreement(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateServiceAgreementInput
) {
  // Rule 2: Ensure at least one primary meter (computed before transaction)
  const metersToCreate = [...data.meters];
  const hasPrimary = metersToCreate.some((m) => m.isPrimary);
  if (!hasPrimary && metersToCreate.length > 0) {
    metersToCreate[0] = { ...metersToCreate[0], isPrimary: true };
  }

  // Validate custom fields against the tenant schema before opening
  // the transaction. The validator does its own DB read so it can
  // run outside the tx safely.
  const validatedCustom = await validateCustomFields(
    utilityId,
    "service_agreement",
    data.customFields,
    { mode: "create" },
  );

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "ServiceAgreement" },
    EVENT_TYPES.SERVICE_AGREEMENT_CREATED,
    () => prisma.$transaction(async (tx) => {
    // Rule 1: Check meter uniqueness per commodity
    for (const m of metersToCreate) {
      const existing = await tx.serviceAgreementMeter.findFirst({
        where: {
          meterId: m.meterId,
          removedDate: null,
          serviceAgreement: {
            commodityId: data.commodityId,
            status: { in: ["PENDING", "ACTIVE"] },
          },
        },
      });
      if (existing) {
        throw Object.assign(
          new Error("Meter is already assigned to an active agreement for this commodity"),
          { statusCode: 400, code: "METER_ALREADY_ASSIGNED" }
        );
      }
    }

    // Rule 3: Create the agreement with nested meters. If the caller
    // didn't supply an agreementNumber, generate one from the tenant
    // template inside this same tx so the max-query sees any rows
    // the caller has already inserted.
    const agreementNumber =
      data.agreementNumber ??
      (await generateNumber({
        utilityId,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db: tx,
      }));
    return tx.serviceAgreement.create({
      data: {
        utilityId,
        agreementNumber,
        accountId: data.accountId,
        premiseId: data.premiseId,
        commodityId: data.commodityId,
        rateScheduleId: data.rateScheduleId,
        billingCycleId: data.billingCycleId,
        startDate: new Date(data.startDate),
        endDate: data.endDate ? new Date(data.endDate) : null,
        status: data.status || "PENDING",
        readSequence: data.readSequence,
        customFields: validatedCustom as object,
        meters: {
          create: metersToCreate.map((m) => ({
            utilityId,
            meterId: m.meterId,
            isPrimary: m.isPrimary,
            addedDate: new Date(data.startDate),
          })),
        },
      },
      include: fullInclude,
    });
  })
  );
}

export async function addMeterToAgreement(
  utilityId: string,
  agreementId: string,
  meterId: string
) {
  const agreement = await prisma.serviceAgreement.findUniqueOrThrow({
    where: { id: agreementId, utilityId },
  });

  const existing = await prisma.serviceAgreementMeter.findFirst({
    where: {
      meterId,
      removedDate: null,
      serviceAgreement: {
        commodityId: agreement.commodityId,
        status: { in: ["PENDING", "ACTIVE"] },
      },
    },
  });
  if (existing) {
    throw Object.assign(
      new Error("Meter is already assigned to an active agreement for this commodity (BR-SA-004)"),
      { statusCode: 400, code: "METER_ALREADY_ASSIGNED" }
    );
  }

  return prisma.serviceAgreementMeter.create({
    data: {
      utilityId,
      serviceAgreementId: agreementId,
      meterId,
      isPrimary: false,
      addedDate: new Date(),
    },
    include: {
      meter: {
        include: { commodity: true, uom: true },
      },
    },
  });
}

export async function removeMeterFromAgreement(utilityId: string, samId: string) {
  return prisma.serviceAgreementMeter.update({
    where: { id: samId, utilityId },
    data: { removedDate: new Date() },
  });
}

export async function updateServiceAgreement(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateServiceAgreementInput
) {
  const before = await prisma.serviceAgreement.findUniqueOrThrow({
    where: { id, utilityId },
  });

  // Validate status transition if status is changing
  if (data.status !== undefined && data.status !== before.status) {
    if (!isValidStatusTransition(before.status as Parameters<typeof isValidStatusTransition>[0], data.status)) {
      throw Object.assign(
        new Error(`Invalid status transition from ${before.status} to ${data.status}`),
        { statusCode: 400, code: "INVALID_STATUS_TRANSITION" }
      );
    }
  }

  // Build update data from non-undefined fields
  const updateData: Record<string, unknown> = {};
  if (data.rateScheduleId !== undefined) updateData.rateScheduleId = data.rateScheduleId;
  if (data.billingCycleId !== undefined) updateData.billingCycleId = data.billingCycleId;
  if (data.endDate !== undefined) updateData.endDate = new Date(data.endDate);
  if (data.status !== undefined) updateData.status = data.status;
  if (data.readSequence !== undefined) updateData.readSequence = data.readSequence;

  // Custom fields: validate against tenant schema and merge with
  // existing stored values (preserving deprecated keys).
  if (data.customFields !== undefined) {
    const existingStored = (before.customFields as Record<string, unknown>) ?? {};
    const merged = await validateCustomFields(
      utilityId,
      "service_agreement",
      data.customFields,
      { mode: "update", existingStored },
    );
    updateData.customFields = merged as object;
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceAgreement" },
    EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    before,
    () =>
      prisma.serviceAgreement.update({
        where: { id, utilityId },
        data: updateData,
        include: fullInclude,
      })
  );
}
