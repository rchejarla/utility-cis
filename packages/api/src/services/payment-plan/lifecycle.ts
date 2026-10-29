import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import { sendNotification } from "../notification.service.js";
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
  defaulted: number;
  /** Plans told this pass that they are behind. */
  notified: number;
  /** Every live plan that is behind, and by how much. */
  late: Array<{ planId: string; lateInstallments: number }>;
}

function err(code: string, message: string, statusCode = 422): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

/** The columns `planProgress` judges a plan by, all frozen at agreement. */
export interface PlanTermsSnapshot {
  totalBalance: Prisma.Decimal | string;
  downPayment: Prisma.Decimal | string | null;
  installmentAmount: Prisma.Decimal | string;
  installmentCount: number;
  installmentFrequency: "WEEKLY" | "BIWEEKLY" | "MONTHLY";
  startDate: Date;
  graceDays: number;
  missedBeforeDefault: number;
  partialInstallmentCounts: boolean;
}

export interface PlanProgress {
  /** Scheduled payments whose date has arrived, down payment included. */
  due: number;
  /** Of those, how many are not satisfied by what has been paid. */
  late: number;
  /** Of the late ones, how many are also past their grace days. */
  missed: number;
  /** True when nothing due is unpaid. The status enum cannot say this. */
  onTrack: boolean;
  /** What the plan still has to collect, as a 2dp string. */
  remaining: string;
  /** Whether `missed` has reached the plan's own threshold. */
  broken: boolean;
}

/**
 * The same date arithmetic `createPaymentPlan` used to build the
 * schedule, so the two cannot disagree about when instalment *n* fell
 * due. Month arithmetic clamps rather than rolling over.
 */
function addPeriods(
  start: Date,
  n: number,
  frequency: PlanTermsSnapshot["installmentFrequency"],
): Date {
  if (frequency === "WEEKLY") return new Date(start.getTime() + n * 7 * 86_400_000);
  if (frequency === "BIWEEKLY") return new Date(start.getTime() + n * 14 * 86_400_000);
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth() + n;
  const daysInTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(start.getUTCDate(), daysInTarget)));
}

/**
 * What each scheduled payment asks for, in order, starting with the
 * down payment.
 *
 * The first instalment carries the rounding remainder, exactly as
 * `createPaymentPlan` put it there, so the cumulative figures here are
 * the ones the customer was shown.
 */
function scheduleAmounts(plan: PlanTermsSnapshot): Prisma.Decimal[] {
  const total = new Prisma.Decimal(plan.totalBalance);
  const down = new Prisma.Decimal(plan.downPayment ?? 0);
  const base = new Prisma.Decimal(plan.installmentAmount);
  const first = total.minus(down).minus(base.times(plan.installmentCount - 1));
  return [
    down,
    first,
    ...Array.from({ length: Math.max(plan.installmentCount - 1, 0) }, () => base),
  ];
}

/**
 * Is this plan being kept, and by how much is it not?
 *
 * Pure, and exported, because the CSR panel and the default sweep must
 * not be able to disagree. `PaymentPlan.status` says ACTIVE whether the
 * customer is current or three payments behind, and "are they keeping
 * to it" is the first thing anyone asks on a call.
 *
 * `paidToDate` is what has reached the covered debits — the frozen
 * balance less what is still open on them — not a count of payments
 * received. Money arrives by cash, cheque and lockbox, and a waiver
 * takes a debt to zero with no payment at all; the ledger is the only
 * thing that knows.
 *
 * **Late is not missed.** A payment is late once its date has passed
 * and what has been paid does not cover it; it is missed only once its
 * grace days have also passed. An instalment inside grace leaves the
 * plan ACTIVE with suppression intact, which is the state the panel
 * calls "1 payment behind".
 *
 * `partialInstallmentCounts` is the difference between "paying $30 of a
 * $75 instalment is not paying the instalment" and crediting it pro
 * rata: strictly, a payment is met when the cumulative total through it
 * has arrived; leniently, when anything at all has arrived toward it.
 */
export function planProgress(
  plan: PlanTermsSnapshot,
  paidToDate: Prisma.Decimal | string,
  asOf: Date = new Date(),
): PlanProgress {
  const paid = new Prisma.Decimal(paidToDate);
  const amounts = scheduleAmounts(plan);

  let cumulative = new Prisma.Decimal(0);
  let due = 0;
  let late = 0;
  let missed = 0;

  for (let i = 0; i < amounts.length; i++) {
    const before = cumulative;
    cumulative = cumulative.plus(amounts[i]!);

    const dueDate = addPeriods(plan.startDate, i, plan.installmentFrequency);
    if (dueDate > asOf) break;
    due++;

    const met = plan.partialInstallmentCounts
      ? paid.greaterThan(before)
      : paid.greaterThanOrEqualTo(cumulative);
    if (met) continue;

    late++;
    const missedOn = new Date(dueDate.getTime() + plan.graceDays * 86_400_000);
    if (missedOn <= asOf) missed++;
  }

  return {
    due,
    late,
    missed,
    onTrack: late === 0,
    remaining: Prisma.Decimal.max(
      new Prisma.Decimal(plan.totalBalance).minus(paid),
      new Prisma.Decimal(0),
    ).toFixed(2),
    broken: missed >= plan.missedBeforeDefault,
  };
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
export async function sweepPaymentPlans(
  utilityId: string,
  asOf: Date = new Date(),
): Promise<PlanSweepResult> {
  const satisfied = new Set(await satisfiedPlanIds(prisma, utilityId));

  let completed = 0;
  if (satisfied.size > 0) {
    const closed = await prisma.paymentPlan.updateMany({
      // `status: "ACTIVE"` again here, not only in the query above: two
      // sweeps racing must not both close the same plan.
      where: { utilityId, id: { in: [...satisfied] }, status: "ACTIVE" },
      data: { status: "COMPLETED", statusChangedAt: asOf },
    });
    completed = closed.count;
  }

  /*
   * Then the plans that are behind. A plan cannot be both satisfied and
   * broken, and the satisfied ones have just been closed — so they are
   * excluded here rather than left to the order of two passes. A
   * customer who settled late completes; they do not default because a
   * sweep asked the questions the other way round.
   */
  const live = await prisma.paymentPlan.findMany({
    where: { utilityId, status: "ACTIVE", id: { notIn: [...satisfied] } },
    select: {
      id: true,
      accountId: true,
      totalBalance: true,
      downPayment: true,
      installmentAmount: true,
      installmentCount: true,
      installmentFrequency: true,
      startDate: true,
      graceDays: true,
      missedBeforeDefault: true,
      partialInstallmentCounts: true,
      currentBillCounts: true,
      lateNoticeInstallment: true,
    },
  });

  const late: PlanSweepResult["late"] = [];
  let defaulted = 0;
  let notified = 0;

  for (const plan of live) {
    const paid = await paidTowardPlan(utilityId, plan.id, plan.totalBalance);
    const progress = planProgress(plan, paid, asOf);

    /*
     * Either test breaks the plan. The second is Illinois': keeping to
     * the instalments is not enough if the current bill goes unpaid —
     * the hole an earlier draft had, where paying every instalment
     * while never paying a new bill kept the plan and its suppression
     * alive indefinitely.
     *
     * "Nothing uncovered" is not "an unpaid current bill": an account
     * with no uncovered debt has nothing for this test to look at, and
     * must not default because the question found no rows.
     */
    const brokenByBill =
      plan.currentBillCounts &&
      (await hasUncoveredPastDue(utilityId, plan.accountId, asOf));

    if (progress.broken || brokenByBill) {
      const updated = await prisma.paymentPlan.updateMany({
        where: { id: plan.id, utilityId, status: "ACTIVE" },
        data: { status: "DEFAULTED", statusChangedAt: asOf },
      });
      if (updated.count > 0) {
        defaulted += updated.count;
        await prisma.$transaction(async (tx) =>
          writeAuditRow(
            tx,
            {
              utilityId,
              actorId: null,
              actorName: "Payment plan sweep",
              entityType: "PaymentPlan",
            },
            EVENT_TYPES.PAYMENT_PLAN_DEFAULTED,
            plan.id,
            { status: "ACTIVE" },
            {
              status: "DEFAULTED",
              missedInstallments: progress.missed,
              uncoveredBillPastDue: brokenByBill,
            },
          ),
        );
      }
      continue;
    }

    if (progress.late === 0) continue;
    late.push({ planId: plan.id, lateInstallments: progress.late });

    /*
     * Told once per instalment, not once per sweep. This runs nightly,
     * so a notice keyed on "is late" alone would mail the customer
     * every night until they paid or defaulted.
     *
     * The watermark is the index of the latest late payment — 0 for the
     * down payment — so a second instalment going late notifies again
     * while the first one going late a fourth night does not.
     */
    const watermark = progress.due - 1;
    if (plan.lateNoticeInstallment !== null && plan.lateNoticeInstallment >= watermark) {
      continue;
    }

    await sendNotification(utilityId, {
      eventType: "payment_plan.installment_late",
      channel: "EMAIL",
      recipientId: await customerOf(utilityId, plan.accountId),
      context: {
        accountId: plan.accountId,
        paymentPlanId: plan.id,
        paymentPlanRemaining: progress.remaining,
        paymentPlanLateInstallments: String(progress.late),
      },
    });
    await prisma.paymentPlan.update({
      where: { id: plan.id },
      data: { lateNoticeInstallment: watermark },
    });
    notified++;
  }

  return { completed, defaulted, notified, late };
}

/**
 * What has reached this plan's covered debits.
 *
 * The frozen balance less what is still open on them, rather than a sum
 * of payments: money arrives by cash, cheque and lockbox, and a waiver
 * takes a debt to zero with no payment at all. Only the ledger knows.
 */
async function paidTowardPlan(
  utilityId: string,
  planId: string,
  totalBalance: Prisma.Decimal,
): Promise<Prisma.Decimal> {
  const [row] = await prisma.$queryRaw<Array<{ still_open: Prisma.Decimal }>>`
    SELECT COALESCE(SUM(GREATEST(e.open_amount, 0)), 0) AS still_open
      FROM payment_plan_debit pd
      JOIN ledger_entry e
        ON e.utility_id = pd.utility_id AND e.id = pd.entry_id
     WHERE pd.utility_id = ${utilityId}::uuid
       AND pd.plan_id = ${planId}::uuid`;

  const open = new Prisma.Decimal(row?.still_open ?? 0);
  return Prisma.Decimal.max(totalBalance.minus(open), new Prisma.Decimal(0));
}

/**
 * Does this account owe anything, past due, that no live plan covers?
 *
 * Joins through to `payment_plan.status` rather than testing membership,
 * for the reason every other predicate here does: those rows survive
 * the plan.
 */
async function hasUncoveredPastDue(
  utilityId: string,
  accountId: string,
  asOf: Date,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one
      FROM ledger_entry e
     WHERE e.utility_id = ${utilityId}::uuid
       AND e.account_id = ${accountId}::uuid
       AND e.open_amount > 0
       AND e.due_date IS NOT NULL
       AND e.due_date < ${asOf}::timestamptz
       AND e.type <> 'DEPOSIT'
       AND NOT EXISTS (
         SELECT 1
           FROM payment_plan_debit pd
           JOIN payment_plan p
             ON p.utility_id = pd.utility_id AND p.id = pd.plan_id
          WHERE pd.utility_id = e.utility_id
            AND pd.entry_id = e.id
            AND p.status = 'ACTIVE'
       )
     LIMIT 1`;
  return rows.length > 0;
}

/** Who to tell. Empty when the account has no customer, as notices allow. */
async function customerOf(utilityId: string, accountId: string): Promise<string> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, utilityId },
    select: { customerId: true },
  });
  return account?.customerId ?? "";
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
