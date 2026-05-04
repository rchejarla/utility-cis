import { prisma } from "../lib/prisma.js";
import { generateNumber } from "../lib/number-generator.js";
import { validateCustomFields } from "./custom-field-schema.service.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import type {
  CreateServiceAgreementInput,
  UpdateServiceAgreementInput,
  ServiceAgreementQuery,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";

const fullInclude = {
  account: true,
  commodity: true,
  billingCycle: true,
  rateServiceClass: true,
  rateScheduleAssignments: {
    where: { expirationDate: null as null },
    orderBy: { effectiveDate: "asc" as const },
    include: {
      rateSchedule: {
        include: {
          components: { orderBy: { sortOrder: "asc" as const } },
        },
      },
    },
  },
  servicePoints: {
    where: { endDate: null as null },
    orderBy: { startDate: "asc" as const },
    include: {
      premise: true,
      meters: {
        where: { removedDate: null as null },
        orderBy: { addedDate: "asc" as const },
        include: {
          meter: {
            include: { uom: true },
          },
        },
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
  if (query.premiseId) {
    where.servicePoints = { some: { premiseId: query.premiseId } };
  }
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
  // Initial meter list (isPrimary on the input is no longer persisted —
  // Oracle's SP holds at most one meter at a time, so primacy is implicit.
  // The flag is still accepted on the input for API compatibility, just
  // dropped before write).
  const metersToCreate = [...data.meters];

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
    async (tx) => {
      // Rule 1: Check meter uniqueness per commodity (now via SPM → SP → SA).
      for (const m of metersToCreate) {
        const existing = await tx.servicePointMeter.findFirst({
          where: {
            meterId: m.meterId,
            removedDate: null,
            servicePoint: {
              serviceAgreement: {
                commodityId: data.commodityId,
                status: { in: ["PENDING", "ACTIVE"] },
              },
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

      // Rule 3: Create the agreement. If the caller didn't supply an
      // agreementNumber, generate one from the tenant template inside
      // this same tx so the max-query sees any rows the caller has
      // already inserted.
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
      const status = data.status || "PENDING";
      const startDate = new Date(data.startDate);
      const sa = await tx.serviceAgreement.create({
        data: {
          utilityId,
          agreementNumber,
          accountId: data.accountId,
          commodityId: data.commodityId,
          billingCycleId: data.billingCycleId,
          startDate,
          endDate: data.endDate ? new Date(data.endDate) : null,
          status,
          readSequence: data.readSequence,
          customFields: validatedCustom as object,
        },
      });

      // Create one ServicePoint mirroring the SA's status. METERED type
      // for slice 1 (item-based / non-badged come later).
      const sp = await tx.servicePoint.create({
        data: {
          utilityId,
          serviceAgreementId: sa.id,
          premiseId: data.premiseId,
          type: "METERED",
          status: status === "PENDING" ? "PENDING" : "ACTIVE",
          startDate,
        },
      });

      // Attach initial meters via SPM (replaces the old SAM nested write).
      if (metersToCreate.length > 0) {
        await tx.servicePointMeter.createMany({
          data: metersToCreate.map((m) => ({
            utilityId,
            servicePointId: sp.id,
            meterId: m.meterId,
            addedDate: startDate,
          })),
        });
      }

      return tx.serviceAgreement.findUniqueOrThrow({
        where: { id: sa.id },
        include: fullInclude,
      });
    },
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

  const existing = await prisma.servicePointMeter.findFirst({
    where: {
      meterId,
      removedDate: null,
      servicePoint: {
        serviceAgreement: {
          commodityId: agreement.commodityId,
          status: { in: ["PENDING", "ACTIVE"] },
        },
      },
    },
  });
  if (existing) {
    throw Object.assign(
      new Error("Meter is already assigned to an active agreement for this commodity (BR-SA-004)"),
      { statusCode: 400, code: "METER_ALREADY_ASSIGNED" }
    );
  }

  // Find the SA's open ServicePoint to attach the meter under. Slice 1
  // creates exactly one SP per SA at create time; if we don't find one
  // here, the SA pre-dates the SP backfill or was created via a path
  // that didn't make one — surface that as an error rather than
  // silently inventing an SP without a premise.
  const sp = await prisma.servicePoint.findFirst({
    where: { serviceAgreementId: agreementId, utilityId, endDate: null },
    orderBy: { startDate: "asc" },
  });
  if (!sp) {
    throw Object.assign(
      new Error("Service agreement has no open service point to attach the meter to"),
      { statusCode: 400, code: "NO_OPEN_SERVICE_POINT" }
    );
  }

  return prisma.servicePointMeter.create({
    data: {
      utilityId,
      servicePointId: sp.id,
      meterId,
      addedDate: new Date(),
    },
    include: {
      meter: {
        include: { commodity: true, uom: true },
      },
    },
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

  // Lifecycle fields (startDate, endDate, status) are NOT settable via
  // generic PATCH. The Zod schema rejects them at the route layer; this
  // service builds its update payload only from non-lifecycle fields.
  // Closing an SA goes through `closeServiceAgreement` (in
  // effective-dating.service.ts) which cascades onto child meter
  // assignments — see FR-EFF-006.
  const updateData: Record<string, unknown> = {};
  if (data.billingCycleId !== undefined) updateData.billingCycleId = data.billingCycleId;
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
    (tx) =>
      tx.serviceAgreement.update({
        where: { id, utilityId },
        data: updateData,
        include: fullInclude,
      })
  );
}
