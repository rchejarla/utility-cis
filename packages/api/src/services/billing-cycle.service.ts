import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateBillingCycleInput, UpdateBillingCycleInput } from "@utility-cis/shared";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

export async function listBillingCycles(utilityId: string) {
  return prisma.billingCycle.findMany({
    where: { utilityId },
    orderBy: { cycleCode: "asc" },
  });
}

export async function getBillingCycle(id: string, utilityId: string) {
  return prisma.billingCycle.findUniqueOrThrow({
    where: { id, utilityId },
  });
}

export async function createBillingCycle(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateBillingCycleInput
) {
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "BillingCycle" },
    EVENT_TYPES.BILLING_CYCLE_CREATED,
    () => prisma.billingCycle.create({ data: { ...data, utilityId } })
  );
}

export async function updateBillingCycle(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateBillingCycleInput
) {
  const before = await prisma.billingCycle.findUniqueOrThrow({ where: { id, utilityId } });
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "BillingCycle" },
    EVENT_TYPES.BILLING_CYCLE_UPDATED,
    before,
    () => prisma.billingCycle.update({ where: { id, utilityId }, data })
  );
}
