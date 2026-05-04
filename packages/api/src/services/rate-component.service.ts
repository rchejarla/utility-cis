import { prisma } from "../lib/prisma.js";
import type {
  CreateRateComponentInput,
  UpdateRateComponentInput,
  CycleCheckRequest,
} from "@utility-cis/shared";
import { detectCycles } from "../lib/rate-engine/index.js";
import type { RateComponentSnapshot } from "../lib/rate-engine/types.js";

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

/**
 * Slice 2 task 2 — cycle-check for a proposed RateComponent.
 *
 * Loads the schedule's existing components, swaps in the proposed
 * component (replacing by id when editing, or appending when new),
 * and runs the rate engine's `detectCycles`. Returns either
 * `{ valid: true }` or `{ valid: false, cycle }` so the route can
 * render either an HTTP 200 success or an HTTP 400 with the cycle
 * path.
 */
export async function checkComponentCycle(
  utilityId: string,
  rateScheduleId: string,
  proposed: CycleCheckRequest,
): Promise<{ valid: boolean; cycle?: string[] }> {
  // Verify the schedule belongs to the tenant before doing any work.
  // Without this guard a cross-tenant id would silently load an empty
  // component list and falsely report "valid".
  await prisma.rateSchedule.findUniqueOrThrow({
    where: { id: rateScheduleId, utilityId },
  });

  const current = await prisma.rateComponent.findMany({
    where: { rateScheduleId, utilityId },
  });

  const proposedSnapshot: RateComponentSnapshot = {
    id: proposed.componentId ?? "PROPOSED-NEW",
    rateScheduleId,
    kindCode: proposed.kindCode,
    label: proposed.label,
    predicate: proposed.predicate,
    quantitySource: proposed.quantitySource,
    pricing: proposed.pricing,
    sortOrder: proposed.sortOrder,
    effectiveDate: new Date(),
    expirationDate: null,
  };

  const merged: RateComponentSnapshot[] = [
    ...current
      .filter((c) => c.id !== proposed.componentId)
      .map((c) => ({
        id: c.id,
        rateScheduleId: c.rateScheduleId,
        kindCode: c.kindCode,
        label: c.label,
        predicate: c.predicate,
        quantitySource: c.quantitySource,
        pricing: c.pricing,
        sortOrder: c.sortOrder,
        effectiveDate: c.effectiveDate,
        expirationDate: c.expirationDate,
      })),
    proposedSnapshot,
  ];

  const result = detectCycles(merged);
  if (result === null) return { valid: true };
  return { valid: false, cycle: result.cycle };
}
