import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { planProgress, uncoveredPastDue, type PlanProgress } from "./lifecycle.js";

/**
 * What a CSR reads about a plan.
 *
 * Four questions, in the order a phone call asks them: is there a plan
 * and is it being kept, what is left, what the schedule is, and what it
 * covers. The first and third are derived — `status` says ACTIVE whether
 * the customer is current or three payments behind, and the schedule has
 * no table behind it because a stored copy of a derivable figure can
 * disagree with the ledger.
 */

/** A covered debt, with the provenance the AR tab's Bill column uses. */
export interface CoveredDebtRow {
  entryId: string;
  type: string;
  amount: string;
  openAmount: string;
  dueDate: string | null;
  reasonLabel: string | null;
  /** The bill this debit charged, when it charged one. */
  billNumber: string | null;
  billId: string | null;
  /**
   * The bill this debit was raised ON, which is a different question. A
   * late fee carries no `bill_id` — it is its own receivable — and
   * `assessed_on_id` names the overdue debit it punishes. Null when no
   * bill produced it, which an opening balance never does.
   */
  assessedOnBillNumber: string | null;
  assessedOnBillId: string | null;
}

export interface PaymentPlanDetail {
  id: string;
  accountId: string;
  status: string;
  totalBalance: string;
  downPayment: string | null;
  installmentAmount: string;
  installmentCount: number;
  installmentFrequency: string;
  startDate: string;
  notes: string | null;
  approvedBy: string;
  statusChangedAt: string;
  createdAt: string;
  /** What the customer has actually paid toward the covered debts. */
  paidToDate: string;
  progress: PlanProgress & {
    /** `late`, under the name the panel reads out. */
    installmentsBehind: number;
  };
  schedule: Array<{ dueDate: string; amount: string }>;
  covers: CoveredDebtRow[];
  /**
   * The debt that puts this plan at risk: unpaid, past due, and covered
   * by no live plan.
   *
   * Answered here rather than left to the caller because it is the
   * failure a customer most easily trips while paying every instalment
   * faithfully, and it is only knowable by reading two screens unless
   * the plan carries it. Null when `currentBillCounts` is false, since
   * then no such debt can break this plan and a warning would be a
   * lie.
   */
  atRisk: { entryId: string; billNumber: string | null; amount: string } | null;
}

export interface PaymentPlanSummary {
  id: string;
  status: string;
  totalBalance: string;
  remaining: string;
  installmentAmount: string;
  installmentCount: number;
  installmentFrequency: string;
  startDate: string;
  onTrack: boolean;
  installmentsBehind: number;
  createdAt: string;
}

const money = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2));
const day = (d: Date | null) => (d === null ? null : d.toISOString().slice(0, 10));

function addPeriods(start: Date, n: number, frequency: string): Date {
  if (frequency === "WEEKLY") return new Date(start.getTime() + n * 7 * 86_400_000);
  if (frequency === "BIWEEKLY") return new Date(start.getTime() + n * 14 * 86_400_000);
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth() + n;
  const daysInTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(start.getUTCDate(), daysInTarget)));
}

/**
 * The schedule, rebuilt from `start_date`, the frequency and the count.
 *
 * The first instalment carries the rounding remainder, exactly where
 * `createPaymentPlan` put it, so what a CSR reads out is what the
 * customer agreed to down to the cent.
 */
function scheduleOf(plan: {
  totalBalance: Prisma.Decimal;
  downPayment: Prisma.Decimal | null;
  installmentAmount: Prisma.Decimal;
  installmentCount: number;
  installmentFrequency: string;
  startDate: Date;
}): Array<{ dueDate: string; amount: string }> {
  const down = plan.downPayment ?? new Prisma.Decimal(0);
  const base = plan.installmentAmount;
  const first = plan.totalBalance.minus(down).minus(base.times(plan.installmentCount - 1));

  return [
    { dueDate: day(plan.startDate)!, amount: down.toFixed(2) },
    ...Array.from({ length: plan.installmentCount }, (_, i) => ({
      dueDate: day(addPeriods(plan.startDate, i + 1, plan.installmentFrequency))!,
      amount: (i === 0 ? first : base).toFixed(2),
    })),
  ];
}

/** What has reached the covered debits: the frozen balance less what is open. */
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

export async function listAccountPaymentPlans(
  utilityId: string,
  accountId: string,
): Promise<PaymentPlanSummary[]> {
  const plans = await prisma.paymentPlan.findMany({
    where: { utilityId, accountId },
    orderBy: { createdAt: "desc" },
  });

  const out: PaymentPlanSummary[] = [];
  for (const plan of plans) {
    const paid = await paidTowardPlan(utilityId, plan.id, plan.totalBalance);
    const progress = planProgress(plan, paid);
    out.push({
      id: plan.id,
      status: plan.status,
      totalBalance: money(plan.totalBalance)!,
      remaining: progress.remaining,
      installmentAmount: money(plan.installmentAmount)!,
      installmentCount: plan.installmentCount,
      installmentFrequency: plan.installmentFrequency,
      startDate: day(plan.startDate)!,
      onTrack: progress.onTrack,
      installmentsBehind: progress.late,
      createdAt: plan.createdAt.toISOString(),
    });
  }
  return out;
}

export async function getPaymentPlan(
  utilityId: string,
  planId: string,
): Promise<PaymentPlanDetail | null> {
  const plan = await prisma.paymentPlan.findFirst({ where: { id: planId, utilityId } });
  if (!plan) return null;

  const links = await prisma.paymentPlanDebit.findMany({
    where: { utilityId, planId },
    select: { entryId: true },
  });

  const entries = await prisma.ledgerEntry.findMany({
    where: { utilityId, id: { in: links.map((l) => l.entryId) } },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    select: {
      id: true,
      type: true,
      amount: true,
      openAmount: true,
      dueDate: true,
      reason: { select: { label: true } },
      bill: { select: { id: true, billNumber: true } },
      assessedOn: { select: { bill: { select: { id: true, billNumber: true } } } },
    },
  });

  const paid = await paidTowardPlan(utilityId, plan.id, plan.totalBalance);
  const progress = planProgress(plan, paid);

  return {
    id: plan.id,
    accountId: plan.accountId,
    status: plan.status,
    totalBalance: money(plan.totalBalance)!,
    downPayment: money(plan.downPayment),
    installmentAmount: money(plan.installmentAmount)!,
    installmentCount: plan.installmentCount,
    installmentFrequency: plan.installmentFrequency,
    startDate: day(plan.startDate)!,
    notes: plan.notes,
    approvedBy: plan.approvedBy,
    statusChangedAt: plan.statusChangedAt.toISOString(),
    createdAt: plan.createdAt.toISOString(),
    paidToDate: paid.toFixed(2),
    progress: { ...progress, installmentsBehind: progress.late },
    atRisk:
      plan.status === "ACTIVE" && plan.currentBillCounts
        ? await uncoveredPastDue(utilityId, plan.accountId)
        : null,
    schedule: scheduleOf(plan),
    covers: entries.map((e) => ({
      entryId: e.id,
      type: e.type,
      amount: money(e.amount)!,
      openAmount: money(e.openAmount)!,
      dueDate: day(e.dueDate),
      reasonLabel: e.reason?.label ?? null,
      billNumber: e.bill?.billNumber ?? null,
      billId: e.bill?.id ?? null,
      assessedOnBillNumber: e.assessedOn?.bill?.billNumber ?? null,
      assessedOnBillId: e.assessedOn?.bill?.id ?? null,
    })),
  };
}
