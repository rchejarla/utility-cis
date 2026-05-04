import { prisma } from "../lib/prisma.js";
import type {
  CreateRateComponentInput,
  UpdateRateComponentInput,
} from "@utility-cis/shared";

/**
 * Slice 1 task 5 — RateComponent CRUD service.
 *
 * Components are the pricing leaves of a RateSchedule. The schedule is
 * metadata-only post-task-3; all rate logic lives on these rows
 * (kindCode + predicate + quantitySource + pricing). Tenant scope is
 * carried explicitly into every query as belt-and-suspenders alongside
 * the RLS policy.
 */

export async function listComponentsForSchedule(rateScheduleId: string, utilityId: string) {
  return prisma.rateComponent.findMany({
    where: { rateScheduleId, utilityId },
    orderBy: { sortOrder: "asc" },
  });
}

export async function getRateComponent(id: string, utilityId: string) {
  return prisma.rateComponent.findUniqueOrThrow({
    where: { id, utilityId },
  });
}

export async function createRateComponent(
  utilityId: string,
  rateScheduleId: string,
  data: CreateRateComponentInput,
) {
  // Verify the schedule exists in tenant scope before inserting the
  // component. Without this guard, a client posting a stale schedule
  // ID would get a confusing FK error from Postgres.
  await prisma.rateSchedule.findUniqueOrThrow({
    where: { id: rateScheduleId, utilityId },
  });

  return prisma.rateComponent.create({
    data: {
      utilityId,
      rateScheduleId,
      kindCode: data.kindCode,
      label: data.label,
      predicate: data.predicate,
      quantitySource: data.quantitySource,
      pricing: data.pricing,
      sortOrder: data.sortOrder,
      effectiveDate: new Date(data.effectiveDate),
      expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
    },
  });
}

export async function updateRateComponent(
  utilityId: string,
  id: string,
  data: UpdateRateComponentInput,
) {
  const updateData: Record<string, unknown> = {};
  if (data.kindCode !== undefined) updateData.kindCode = data.kindCode;
  if (data.label !== undefined) updateData.label = data.label;
  if (data.predicate !== undefined) updateData.predicate = data.predicate;
  if (data.quantitySource !== undefined) updateData.quantitySource = data.quantitySource;
  if (data.pricing !== undefined) updateData.pricing = data.pricing;
  if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
  if (data.effectiveDate !== undefined) updateData.effectiveDate = new Date(data.effectiveDate);
  if (data.expirationDate !== undefined) {
    updateData.expirationDate = data.expirationDate ? new Date(data.expirationDate) : null;
  }

  return prisma.rateComponent.update({
    where: { id, utilityId },
    data: updateData,
  });
}

export async function deleteRateComponent(utilityId: string, id: string) {
  return prisma.rateComponent.delete({
    where: { id, utilityId },
  });
}
