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

  /*
   * Day boundaries, because every date here is a calendar day.
   *
   * `start_date` is a DATE, so `addPeriods` returns UTC midnight, while
   * `asOf` is an instant. Comparing them directly makes a payment late
   * the moment its date arrives — the sweep runs at 03:00, so a plan
   * starting on the customer's payday was reported as a payment behind
   * that same morning and the notice fired before the money could
   * arrive. Design §7: **due** is "the date has arrived, nothing has
   * happened yet"; **late** is "the date has **passed**".
   */
  const todayUtc = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());

  for (let i = 0; i < amounts.length; i++) {
    const before = cumulative;
    cumulative = cumulative.plus(amounts[i]!);

    const dueDate = addPeriods(plan.startDate, i, plan.installmentFrequency);
    if (dueDate.getTime() > todayUtc) break;
    due++;

    const met = plan.partialInstallmentCounts
      ? paid.greaterThan(before)
      : paid.greaterThanOrEqualTo(cumulative);
    if (met) continue;

    // Due today and unpaid is not yet late.
    if (dueDate.getTime() === todayUtc) continue;

    late++;
    // Missed once grace has also run out, counted in whole days.
    const missedOn = dueDate.getTime() + plan.graceDays * 86_400_000;
    if (missedOn < todayUtc) missed++;
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
  for (const planId of satisfied) {
    /*
     * One transaction per plan, status and audit row together, for the
     * reason the default below does it: a closed plan with no record of
     * when is a plan nobody can account for later. Per plan rather than
     * one `updateMany`, so a single audit failure cannot roll back
     * every other closure in the tenant.
     *
     * `status: "ACTIVE"` again in the filter, not only in the query
     * that selected the ids: two sweeps racing must not both close the
     * same plan, and only the one whose update takes effect counts it.
     */
    const count = await prisma.$transaction(async (tx) => {
      const closed = await tx.paymentPlan.updateMany({
        where: { utilityId, id: planId, status: "ACTIVE" },
        data: { status: "COMPLETED", statusChangedAt: asOf },
      });
      if (closed.count === 0) return 0;
      await writeAuditRow(
        tx,
        {
          utilityId,
          actorId: null,
          actorName: "Payment plan sweep",
          entityType: "PaymentPlan",
        },
        EVENT_TYPES.PAYMENT_PLAN_COMPLETED,
        planId,
        { status: "ACTIVE" },
        { status: "COMPLETED" },
      );
      return closed.count;
    });
    completed += count;
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
      (await hasUncoveredPastDue(utilityId, plan.accountId, asOf, plan.graceDays));

    if (progress.broken || brokenByBill) {
      /*
       * The status and its audit row in **one** transaction. Written
       * separately, a crash or a pool error between them left a
       * DEFAULTED plan with no record of why or when it broke — and
       * the record is the only thing a customer disputing the default
       * has to go on.
       */
      const count = await prisma.$transaction(async (tx) => {
        const updated = await tx.paymentPlan.updateMany({
          where: { id: plan.id, utilityId, status: "ACTIVE" },
          data: { status: "DEFAULTED", statusChangedAt: asOf },
        });
        if (updated.count === 0) return 0;
        await writeAuditRow(
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
        );
        return updated.count;
      });
      defaulted += count;
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

    const notificationId = await sendNotification(utilityId, {
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

    /*
     * The watermark moves only when a notice actually went out.
     *
     * `sendNotification` answers null when the tenant has no template
     * for the event, and advancing anyway recorded that the customer
     * had been told when nothing had been sent — then defaulted them
     * days later. "Nobody is defaulted silently" is the stated reason
     * the Late state and this column exist, so a tenant that has not
     * configured the template should keep being asked rather than have
     * the question quietly marked answered.
     *
     * Notify first, then mark: a crash between the two re-notifies,
     * which is the right way round to fail.
     */
    if (!notificationId) continue;

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
export async function uncoveredPastDue(
  utilityId: string,
  accountId: string,
  asOf: Date = new Date(),
): Promise<{ entryId: string; billNumber: string | null; amount: string } | null> {
  const [row] = await prisma.$queryRaw<
    Array<{ id: string; bill_number: string | null; open_amount: Prisma.Decimal }>
  >`
    SELECT e.id, b.bill_number, e.open_amount
      FROM ledger_entry e
      LEFT JOIN bill b ON b.id = e.bill_id AND b.utility_id = e.utility_id
     WHERE e.utility_id = ${utilityId}::uuid
       AND e.account_id = ${accountId}::uuid
       AND e.open_amount > 0
       AND e.due_date IS NOT NULL
       AND e.due_date < ${asOf}::date
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
     ORDER BY e.due_date ASC, e.id ASC
     LIMIT 1`;

  if (!row) return null;
  return {
    entryId: row.id,
    billNumber: row.bill_number,
    amount: new Prisma.Decimal(row.open_amount).toFixed(2),
  };
}

async function hasUncoveredPastDue(
  utilityId: string,
  accountId: string,
  asOf: Date,
  graceDays: number,
): Promise<boolean> {
  /*
   * Strictly **before** today, not before this instant, and then only
   * once the plan's own grace days have run out.
   *
   * `due_date` is a DATE, so `due_date < now()` is true from 00:00 on
   * the due date itself — and this sweep runs at 03:00. A customer on a
   * kept plan whose bill fell due that day and who posted a cheque that
   * afternoon was defaulted before the post arrived; and because plans
   * are swept before the ladder, the same tick then charged every tier
   * the released arrears qualified for. The design says "unpaid **past**
   * its due date", and the Illinois rule it cites allows until the
   * second day after. This is also the boundary the ladder beside it
   * uses, where `daysPastDue <= 0` skips the account.
   *
   * **The same `grace_days` as an instalment, not a second window.**
   * `planProgress` will not call an instalment *missed* until grace has
   * passed, so judging the uncovered bill without it gave the customer
   * who skipped an instalment outright five days and the customer who
   * paid every instalment faithfully but was slow on one new bill a
   * single day — the harsher test applied to the obligation the plan is
   * less about. `uncoveredPastDue`, which feeds the CSR panel's at-risk
   * warning, keeps no grace on purpose: the warning appears the day
   * after the bill goes past due, so grace becomes a window somebody
   * can act inside instead of a warning and a default arriving on the
   * same morning.
   */
  const rows = await prisma.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one
      FROM ledger_entry e
     WHERE e.utility_id = ${utilityId}::uuid
       AND e.account_id = ${accountId}::uuid
       AND e.open_amount > 0
       AND e.due_date IS NOT NULL
       AND e.due_date < (${asOf}::date - ${graceDays}::int)
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
