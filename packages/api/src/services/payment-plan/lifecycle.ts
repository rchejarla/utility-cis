import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { TxClient } from "../ar/posting.service.js";

/**
 * What ends a payment plan, short of breaking it.
 *
 * Both acts read state rather than counting events, so both are
 * idempotent: a second sweep closes nothing twice, and cancelling an
 * already-ended plan is a no-op rather than an error.
 *
 * **COMPLETED is derived, not counted.** A plan is satisfied when every
 * debit it covers is at `open_amount = 0` — not when `installment_count`
 * payments have arrived. The two differ whenever money reaches the debts
 * by another route: a waiver, a write-off, or simply a customer who paid
 * more than the schedule asked for. Counting instalments would hold a
 * plan open over debts that no longer exist, suppressing a ladder with
 * nothing to suppress and waiting for money that will never arrive.
 *
 * **There is no activation step.** A plan is ACTIVE from agreement; the
 * down payment is its first payment, and an unpaid one is the default
 * sweep's business. An earlier draft had a PENDING state and two
 * transitions to leave it, and they changed nothing the system did,
 * because suppression began at agreement either way.
 *
 * **Nothing here touches the ledger.** Ending a plan writes no entry,
 * reverses none and moves no debt: the covered debts return to the
 * ladder exactly as they were, at their real ages.
 */

export interface PlanSweepResult {
  completed: number;
}

function err(code: string, message: string, statusCode = 422): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

/**
 * ACTIVE plans whose covered debits are all settled.
 *
 * One query for the tenant rather than one per plan: this runs on a
 * worker over every live plan, and a per-plan round trip would make the
 * cost of a quiet night proportional to how many customers are keeping
 * to their arrangements.
 *
 * `GREATEST(open_amount, 0)` because `open_amount` is signed and a
 * covered debit that has been over-applied would otherwise net against
 * a sibling that still owes money, completing a plan with a debt left
 * on it.
 *
 * The `HAVING` also catches a plan with no covered debits left at all.
 * `createPaymentPlan` refuses to create one, but a reversal could in
 * principle produce it, and such a plan should close rather than hang
 * open suppressing nothing.
 */
async function satisfiedPlanIds(client: TxClient, utilityId: string): Promise<string[]> {
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT p.id
      FROM payment_plan p
      LEFT JOIN payment_plan_debit pd
        ON pd.utility_id = p.utility_id AND pd.plan_id = p.id
      LEFT JOIN ledger_entry e
        ON e.utility_id = pd.utility_id AND e.id = pd.entry_id
     WHERE p.utility_id = ${utilityId}::uuid
       AND p.status = 'ACTIVE'
     GROUP BY p.id
    HAVING COALESCE(SUM(GREATEST(e.open_amount, 0)), 0) = 0`;

  return rows.map((r) => r.id);
}

/**
 * Close every ACTIVE plan whose debts are gone.
 *
 * Task 9 extends this with the default tests. They belong in one pass
 * because a plan cannot be both satisfied and broken, and asking in two
 * passes would let the scheduling order decide which answer a customer
 * got.
 */
export async function sweepPaymentPlans(utilityId: string): Promise<PlanSweepResult> {
  const satisfied = await satisfiedPlanIds(prisma, utilityId);
  if (satisfied.length === 0) return { completed: 0 };

  const result = await prisma.paymentPlan.updateMany({
    // `status: "ACTIVE"` again here, not only in the query above: two
    // sweeps racing must not both close the same plan.
    where: { utilityId, id: { in: satisfied }, status: "ACTIVE" },
    data: { status: "COMPLETED", statusChangedAt: new Date() },
  });

  return { completed: result.count };
}

/**
 * End a plan by hand.
 *
 * The same shape as defaulting, by design: the difference is who decided
 * and what the record says, not what happens to the money.
 */
export async function cancelPaymentPlan(
  utilityId: string,
  actorId: string,
  actorName: string,
  planId: string,
  notes?: string,
): Promise<{ status: string; alreadyEnded: boolean }> {
  return prisma.$transaction(async (tx) => {
    const plan = await tx.paymentPlan.findFirst({
      where: { id: planId, utilityId },
      select: { id: true, status: true, notes: true },
    });
    if (!plan) throw err("PLAN_NOT_FOUND", `No such payment plan: ${planId}`, 404);

    if (plan.status !== "ACTIVE") {
      return { status: plan.status, alreadyEnded: true };
    }

    await tx.paymentPlan.update({
      where: { id: planId },
      data: {
        status: "CANCELLED",
        statusChangedAt: new Date(),
        notes: notes ?? plan.notes,
      },
    });

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "PaymentPlan" },
      EVENT_TYPES.PAYMENT_PLAN_CANCELLED,
      planId,
      { status: "ACTIVE" },
      { status: "CANCELLED", notes: notes ?? plan.notes },
    );

    return { status: "CANCELLED", alreadyEnded: false };
  });
}
