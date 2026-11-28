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
  // Slice 5b.1 — billingCycle now lives on Account; nest the include so
  // existing consumers that read `sa.account.billingCycle` keep working
  // and any UI that read `sa.billingCycle` migrates explicitly.
  // `customer` because the transfer wizard names the source account's
  // holder from this list, and without it printed "(no customer)" for
  // every agreement.
  account: { include: { billingCycle: true, customer: true } },
  commodity: true,
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
          // Commodity too: the Meters tab shows it, and showed "–" without.
          meter: {
            include: { uom: true, commodity: true },
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

/**
 * The agreement's service class must be one of **its commodity's** active
 * classes. Classes are defined per commodity because each service's tariff
 * defines its own (water says "single family" where electric says
 * "residential"); rating compares only the code, so a class from another
 * commodity would match by accident or not at all. Exported for the other
 * paths that create agreements — move-in, transfer, import.
 */
export async function assertServiceClass(
  db: Pick<typeof prisma, "rateServiceClass">,
  utilityId: string,
  commodityId: string,
  rateServiceClassId: string,
): Promise<void> {
  const cls = await db.rateServiceClass.findFirst({
    where: { id: rateServiceClassId, utilityId },
    select: { commodityId: true, isActive: true, label: true },
  });
  if (!cls) {
    throw Object.assign(new Error("Service class not found"), {
      statusCode: 400,
      code: "SERVICE_CLASS_INVALID",
    });
  }
  if (cls.commodityId !== commodityId) {
    throw Object.assign(
      new Error(`"${cls.label}" is a class for a different service than this agreement's`),
      { statusCode: 400, code: "SERVICE_CLASS_INVALID" },
    );
  }
  if (!cls.isActive) {
    throw Object.assign(new Error(`"${cls.label}" is retired; pick an active class`), {
      statusCode: 400,
      code: "SERVICE_CLASS_INVALID",
    });
  }
}

/** The active classes an agreement for this commodity may be put in, in display order. */
export async function listServiceClassesForCommodity(utilityId: string, commodityId: string) {
  return prisma.rateServiceClass.findMany({
    where: { utilityId, commodityId, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    select: { id: true, code: true, label: true },
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
  await assertServiceClass(prisma, utilityId, data.commodityId, data.rateServiceClassId);

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
          rateServiceClassId: data.rateServiceClassId,
          startDate,
          endDate: data.endDate ? new Date(data.endDate) : null,
          status,
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

  // The service class — a correction, audited with the rest of the update.
  if (data.rateServiceClassId !== undefined) {
    await assertServiceClass(prisma, utilityId, before.commodityId, data.rateServiceClassId);
    updateData.rateServiceClassId = data.rateServiceClassId;
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
