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

/**
 * Editability gate for component mutations. Slice 2 follow-up: a
 * RateSchedule is editable iff
 *   publishedAt IS NULL AND supersededById IS NULL
 * Once published the components freeze (historical bills calculated
 * against this schedule must not silently change). Once superseded the
 * predecessor is locked too — further changes ride on the new revision.
 *
 * Surfaces 409 SCHEDULE_NOT_EDITABLE so the UI can render an
 * informative message rather than a generic "save failed".
 */
async function assertScheduleEditable(
  rateScheduleId: string,
  utilityId: string,
): Promise<void> {
  const sched = await prisma.rateSchedule.findUniqueOrThrow({
    where: { id: rateScheduleId, utilityId },
    select: { publishedAt: true, supersededById: true },
  });
  if (sched.publishedAt !== null) {
    throw Object.assign(
      new Error(
        "Schedule has been published — components are immutable. Revise the schedule to create a new draft version.",
      ),
      { statusCode: 409, code: "SCHEDULE_NOT_EDITABLE" },
    );
  }
  if (sched.supersededById !== null) {
    throw Object.assign(
      new Error(
        "Schedule has been superseded by a newer version — components are immutable.",
      ),
      { statusCode: 409, code: "SCHEDULE_NOT_EDITABLE" },
    );
  }
}

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
  // Editability gate: must be a draft, not-yet-superseded schedule.
  // Also covers the existing-in-tenant-scope check (findUniqueOrThrow
  // inside assertScheduleEditable will 404 on cross-tenant ids).
  await assertScheduleEditable(rateScheduleId, utilityId);

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
  // Look up the parent schedule via the existing component first, then
  // assert editability. Done before validating the patch payload so
  // locked-schedule writes fail fast with the canonical 409.
  const existing = await prisma.rateComponent.findUniqueOrThrow({
    where: { id, utilityId },
    select: { rateScheduleId: true },
  });
  await assertScheduleEditable(existing.rateScheduleId, utilityId);

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
  // Same editability gate as update — fetch parent schedule first.
  const existing = await prisma.rateComponent.findUniqueOrThrow({
    where: { id, utilityId },
    select: { rateScheduleId: true },
  });
  await assertScheduleEditable(existing.rateScheduleId, utilityId);

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
  // Editability gate: cycle-check is only useful when a save is going
  // to be permitted. On a published/superseded schedule, fail fast with
  // 409 SCHEDULE_NOT_EDITABLE rather than running the engine.
  await assertScheduleEditable(rateScheduleId, utilityId);

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
