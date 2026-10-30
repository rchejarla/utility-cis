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
  /**
   * How much of the covered debt is gone: the balance frozen at
   * agreement less what is still open on those debits.
   *
   * Deliberately not `paidToDate`. Money is only one of the ways a debt
   * reaches zero — a waiver or a write-off clears it with no payment at
   * all — and the ledger is the only thing that knows which happened.
   * Naming it "paid" invited a CSR to read it as the customer's payment
   * record, which it is not.
   */
  clearedToDate: string;
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

/**
 * What is still open on each plan's covered debits, keyed by plan.
 *
 * One query for however many plans are asked about. The list read used
 * to call a single-plan version of this inside its loop, so an account
 * with thirty plans cost thirty round trips to render one panel; a plan
 * absent from the result has no covered debits left and is treated as
 * nothing open, exactly as the single-plan version's `COALESCE` did.
 */
async function openAmountByPlan(
  utilityId: string,
  planIds: string[],
): Promise<Map<string, Prisma.Decimal>> {
  // `IN ()` is a syntax error, and an empty list has no answer to give.
  if (planIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<Array<{ plan_id: string; still_open: Prisma.Decimal }>>`
    SELECT pd.plan_id, COALESCE(SUM(GREATEST(e.open_amount, 0)), 0) AS still_open
      FROM payment_plan_debit pd
      JOIN ledger_entry e
        ON e.utility_id = pd.utility_id AND e.id = pd.entry_id
     WHERE pd.utility_id = ${utilityId}::uuid
       AND pd.plan_id IN (${Prisma.join(planIds.map((id) => Prisma.sql`${id}::uuid`))})
     GROUP BY pd.plan_id`;

  return new Map(rows.map((r) => [r.plan_id, new Prisma.Decimal(r.still_open)]));
}

/** The frozen balance less what is still open, floored at zero. */
function clearedOf(totalBalance: Prisma.Decimal, open: Prisma.Decimal): Prisma.Decimal {
  return Prisma.Decimal.max(totalBalance.minus(open), new Prisma.Decimal(0));
}

/**
 * Capped, because an account that has re-agreed a plan every month for
 * years would otherwise return all of them to a browser. The same shape
 * the ledger list beside it uses.
 */
const DEFAULT_PLAN_LIMIT = 50;
const MAX_PLAN_LIMIT = 200;

export interface PaymentPlanListPage {
  data: PaymentPlanSummary[];
  /** `total` is how many exist, which tells a caller the page is partial. */
  meta: {
    total: number;
    limit: number;
    /**
     * How many of this account's debts a new plan could cover.
     *
     * Answered here because this is the one request the panel already
     * makes, and the question it needs before offering "Agree a plan":
     * with nothing to cover, the dialog opened on "Arrears covered —
     * $0.00", built no schedule, and answered its own button with "Pick
     * at least one debt for the plan to cover". The alternative was a
     * second ledger fetch beside the one the AR tab makes a moment
     * later.
     */
    coverableDebts: number;
  };
}

export async function listAccountPaymentPlans(
  utilityId: string,
  accountId: string,
  opts: { limit?: number } = {},
): Promise<PaymentPlanListPage> {
  /*
   * A non-numeric `?limit=` arrives as NaN, and `take: NaN` reaches
   * Prisma as a 500 rather than a refusal. Falling back to the default
   * is the same answer as omitting the parameter, which is what the
   * caller meant if they sent nonsense.
   */
  const requested = Number.isFinite(opts.limit) ? Math.trunc(opts.limit!) : DEFAULT_PLAN_LIMIT;
  const take = Math.min(Math.max(requested, 1), MAX_PLAN_LIMIT);

  const where = { utilityId, accountId };
  const [plans, total, coverableDebts] = await Promise.all([
    /*
     * Newest first, which also keeps the live plan on the first page:
     * a plan can only be agreed once the previous one has ended, so an
     * ACTIVE plan is always the most recent row. The panel picks the
     * ACTIVE one out of this list, and a cap that could push it off
     * page one would show "no plan" on an account that has one.
     */
    prisma.paymentPlan.findMany({ where, orderBy: { createdAt: "desc" }, take }),
    prisma.paymentPlan.count({ where }),
    /*
     * The debts the agree dialog would list: open, and owed rather than
     * held. A positive `open_amount` is the whole test — a credit's is
     * negative and so is a deposit's, since both are money the customer
     * has already handed over — so no type filter is needed and adding
     * one would only invite the question of which types belong in it.
     *
     * Counted across the account, never this page: it is a fact about
     * what could be covered, not about the plans returned.
     */
    prisma.ledgerEntry.count({ where: { utilityId, accountId, openAmount: { gt: 0 } } }),
  ]);

  const openByPlan = await openAmountByPlan(
    utilityId,
    plans.map((p) => p.id),
  );

  const data = plans.map((plan) => {
    const open = openByPlan.get(plan.id) ?? new Prisma.Decimal(0);
    const progress = planProgress(plan, clearedOf(plan.totalBalance, open));
    return {
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
    };
  });

  return { data, meta: { total, limit: take, coverableDebts } };
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

  const openByPlan = await openAmountByPlan(utilityId, [plan.id]);
  const cleared = clearedOf(
    plan.totalBalance,
    openByPlan.get(plan.id) ?? new Prisma.Decimal(0),
  );
  const progress = planProgress(plan, cleared);

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
    clearedToDate: cleared.toFixed(2),
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
