import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateBillingCycleInput, UpdateBillingCycleInput } from "@utility-cis/shared";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

/**
 * BR-BC-001's ordering half, checked where the whole truth is.
 *
 * The create schema can enforce it alone, because both days are in the
 * payload. An update cannot: `PATCH { readDayOfMonth: 20 }` against a
 * row billing on the 10th is invalid, and the payload on its own looks
 * fine. So the rule is applied to the merged state, which only the
 * service has.
 */
function assertReadPrecedesBill(readDay: number, billDay: number) {
  if (readDay >= billDay) {
    throw Object.assign(
      new Error(
        `readDayOfMonth ${readDay} must be before billDayOfMonth ${billDay}, ` +
          "so reads are in before bills generate",
      ),
      { statusCode: 400, code: "READ_DAY_AFTER_BILL_DAY" },
    );
  }
}

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
    (tx) => tx.billingCycle.create({ data: { ...data, utilityId } })
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
  assertReadPrecedesBill(
    data.readDayOfMonth ?? before.readDayOfMonth,
    data.billDayOfMonth ?? before.billDayOfMonth,
  );
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "BillingCycle" },
    EVENT_TYPES.BILLING_CYCLE_UPDATED,
    before,
    (tx) => tx.billingCycle.update({ where: { id, utilityId }, data })
  );
}
