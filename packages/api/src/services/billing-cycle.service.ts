import { prisma } from "../lib/prisma.js";
import { domainEvents } from "../events/emitter.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateBillingCycleInput, UpdateBillingCycleInput } from "@utility-cis/shared";

export async function listBillingCycles(utilityId: string) {
  return prisma.billingCycle.findMany({
    where: { utilityId },
    orderBy: { cycleCode: "asc" },
  });
}

export async function createBillingCycle(
  utilityId: string,
  actorId: string,
  data: CreateBillingCycleInput
) {
  const billingCycle = await prisma.billingCycle.create({
    data: { ...data, utilityId },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.BILLING_CYCLE_CREATED,
    entityType: "BillingCycle",
    entityId: billingCycle.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: billingCycle as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return billingCycle;
}

export async function updateBillingCycle(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateBillingCycleInput
) {
  const before = await prisma.billingCycle.findUniqueOrThrow({ where: { id, utilityId } });

  const billingCycle = await prisma.billingCycle.update({
    where: { id, utilityId },
    data,
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.BILLING_CYCLE_UPDATED,
    entityType: "BillingCycle",
    entityId: billingCycle.id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: billingCycle as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return billingCycle;
}
