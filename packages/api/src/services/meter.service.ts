import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateMeterInput, UpdateMeterInput, MeterQuery } from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { validateCustomFields } from "./custom-field-schema.service.js";

export async function listMeters(utilityId: string, query: MeterQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.premiseId) where.premiseId = query.premiseId;
  if (query.commodityId) where.commodityId = query.commodityId;
  if (query.status) where.status = query.status;
  if (query.search) {
    where.meterNumber = { contains: query.search, mode: "insensitive" };
  }

  return paginatedTenantList(prisma.meter, where, query, {
    include: { premise: true, commodity: true, uom: true },
  });
}

export async function getMeter(id: string, utilityId: string) {
  const meter = await prisma.meter.findUniqueOrThrow({
    where: { id, utilityId },
    include: {
      premise: true,
      commodity: true,
      uom: true,
      servicePointMeters: {
        where: { removedDate: null },
        include: {
          servicePoint: {
            include: { serviceAgreement: true },
          },
        },
      },
      registers: {
        where: { isActive: true },
        orderBy: { registerNumber: "asc" },
        include: { uom: true },
      },
    },
  });

  /*
   * Does this meter report intervals at all?
   *
   * The detail page shows an Intervals tab only when it does, and
   * **`meter_type` is not the test** — spec 03 and the
   * `meter_type_smart_removed` migration both record that how a meter
   * is *read* is not how its usage is *delivered*, and the seeded data
   * shows it in both directions: an AMR meter with three mapped TOU
   * registers, and AMI meters reporting no intervals at all.
   *
   * One indexed row, `(meter_id, interval_start)`, rather than a count:
   * the question is whether there is one, and a month of 15-minute
   * data is 2,976 rows to count for a boolean.
   */
  const anInterval = await prisma.meterReadInterval.findFirst({
    where: { utilityId, meterId: id },
    select: { meterId: true },
  });

  return { ...meter, reportsIntervals: anInterval !== null };
}

export async function createMeter(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateMeterInput
) {
  const premise = await prisma.premise.findUniqueOrThrow({
    where: { id: data.premiseId, utilityId },
  });

  if (!premise.commodityIds.includes(data.commodityId)) {
    throw Object.assign(
      new Error("Commodity is not associated with this premise"),
      { statusCode: 400, code: "COMMODITY_MISMATCH" }
    );
  }

  const { installDate, customFields: rawCustom, ...rest } = data;
  const validatedCustom = await validateCustomFields(
    utilityId,
    "meter",
    rawCustom,
    { mode: "create" },
  );
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Meter" },
    EVENT_TYPES.METER_CREATED,
    (tx) =>
      tx.meter.create({
        data: {
          ...rest,
          utilityId,
          installDate: new Date(installDate),
          customFields: validatedCustom as object,
        },
        include: { premise: true, commodity: true, uom: true },
      })
  );
}

export async function updateMeter(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateMeterInput
) {
  const before = await prisma.meter.findUniqueOrThrow({ where: { id, utilityId } });
  const { customFields: rawCustom, installDate, removalDate, ...core } = data;
  const existingStored = (before.customFields as Record<string, unknown>) ?? {};
  const mergedCustom =
    rawCustom === undefined
      ? existingStored
      : await validateCustomFields(utilityId, "meter", rawCustom, {
          mode: "update",
          existingStored,
        });
  // Date columns: Zod hands us "YYYY-MM-DD" strings, Prisma's Date
  // column wants a Date. Convert explicitly when present (skip when
  // omitted so PATCH semantics stay intact). null is preserved for
  // clearing removalDate.
  const updateData: Record<string, unknown> = {
    ...core,
    customFields: mergedCustom as object,
  };
  if (installDate !== undefined) updateData.installDate = new Date(installDate);
  if (removalDate !== undefined) {
    updateData.removalDate = removalDate === null ? null : new Date(removalDate);
  }
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Meter" },
    EVENT_TYPES.METER_UPDATED,
    before,
    (tx) =>
      tx.meter.update({
        where: { id, utilityId },
        data: updateData,
        include: { premise: true, commodity: true, uom: true },
      })
  );
}
