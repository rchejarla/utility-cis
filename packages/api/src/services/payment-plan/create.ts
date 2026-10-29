import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import { lockAccount, type TxClient } from "../ar/posting.service.js";
import { resolveAccount } from "../delinquency.service.js";
import { resolvePlanTerms } from "./terms.js";
import type { PaymentPlanTerms } from "@utility-cis/shared";

/**
 * Agreeing a deferred payment agreement.
 *
 * Design: docs/superpowers/specs/2026-10-26-payment-plans-design.md.
 *
 * **Nothing here touches the ledger.** No entry is posted, no debt is
 * moved and `Account.balance` is not recomputed, because a plan governs
 * *when* money is chased rather than *what* is owed. That is what lets
 * every balance query in this codebase stay ignorant of plans. Oracle
 * CC&B does the opposite — a payment arrangement is its own service
 * agreement and the overdue debt is transferred onto it — and its model
 * is built for transfers between agreements in a way this one is not.
 *
 * One transaction, account locked first, like every other writer that
 * touches an account's financial state. The account's live delinquency
 * actions are resolved inside it: a plan with the account still in the
 * shut-off queue is exactly what the old `PAYMENT_PLAN` button
 * produced.
 */

export interface CreatePaymentPlanInput {
  /** The debits the customer is agreeing a schedule for. */
  entryIds: string[];
  /** Omitted means the tenant's percentage of the frozen balance. */
  downPayment?: string;
  installmentCount: number;
  /** ISO date. The down payment falls due on it. */
  startDate: string;
  notes?: string;
}

export interface PaymentPlanScheduleRow {
  dueDate: string;
  amount: string;
}

export interface PaymentPlanResult {
  planId: string;
  totalBalance: string;
  downPayment: string | null;
  installmentAmount: string;
  schedule: PaymentPlanScheduleRow[];
  coveredEntryIds: string[];
  actionsResolved: number;
}

function err(code: string, message: string, statusCode = 422): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

const money = (d: Prisma.Decimal) => d.toFixed(2);

/** A UTC-midnight date from an ISO day, so no timezone shifts the day. */
function utcDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) throw err("START_DATE_INVALID", `Not a date: ${iso}`, 400);
  return new Date(Date.UTC(y, m - 1, d));
}

function todayUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Instalment *n* falls one frequency after instalment *n-1*.
 *
 * Month arithmetic clamps: a plan starting on the 31st pays on the 30th
 * in November rather than slipping into December, which is what every
 * schedule a customer has ever been handed does.
 */
function addPeriods(
  start: Date,
  n: number,
  frequency: PaymentPlanTerms["frequency"],
): Date {
  if (frequency === "WEEKLY") {
    return new Date(start.getTime() + n * 7 * 86_400_000);
  }
  if (frequency === "BIWEEKLY") {
    return new Date(start.getTime() + n * 14 * 86_400_000);
  }
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth() + n;
  const targetMonthDays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(start.getUTCDate(), targetMonthDays)));
}

/**
 * Split what remains after the down payment into equal instalments,
 * with the rounding remainder on the **first**.
 *
 * $377.38 over six is $62.896…; six of $62.90 would collect two cents
 * too much and six of $62.89 four cents too little. Putting the
 * remainder first means the schedule sums to the balance exactly and
 * the customer's final payment is the round one — a stray cent on the
 * last line is what makes a plan look wrong at the moment it is being
 * closed.
 */
function splitInstallments(
  remainder: Prisma.Decimal,
  count: number,
): { base: Prisma.Decimal; first: Prisma.Decimal } {
  const base = remainder.div(count).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  const first = remainder.minus(base.times(count - 1));
  return { base, first };
}

export async function createPaymentPlan(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: CreatePaymentPlanInput,
): Promise<PaymentPlanResult> {
  const terms = await resolvePlanTerms(utilityId);

  if (input.installmentCount < terms.minInstallments) {
    throw err(
      "INSTALLMENTS_BELOW_MINIMUM",
      `This utility agrees plans of at least ${terms.minInstallments} instalments.`,
    );
  }
  if (input.installmentCount > terms.maxInstallments) {
    throw err(
      "INSTALLMENTS_ABOVE_MAXIMUM",
      `This utility agrees plans of at most ${terms.maxInstallments} instalments.`,
    );
  }

  const startDate = utcDay(input.startDate);
  const today = todayUtc();
  if (startDate < today) {
    throw err("START_DATE_IN_PAST", "The first payment cannot be due before today.");
  }
  const latestStart = new Date(today.getTime() + terms.maxStartDateDays * 86_400_000);
  if (startDate > latestStart) {
    throw err(
      "START_DATE_TOO_FAR",
      `This utility sets the first payment within ${terms.maxStartDateDays} days.`,
    );
  }

  if (input.entryIds.length === 0) {
    throw err("NOTHING_TO_COVER", "A plan has to cover at least one open debt.");
  }

  return prisma.$transaction(async (tx) => {
    await lockAccount(tx, utilityId, accountId);

    /*
     * One ACTIVE plan per account. Nothing in the schema stops two —
     * `payment_plan_debit`'s key stops a *debit* belonging to two plans,
     * which is not the same thing — so a second plan over different
     * debts would otherwise be created and both would suppress.
     */
    const live = await tx.paymentPlan.findFirst({
      where: { utilityId, accountId, status: "ACTIVE" },
      select: { id: true },
    });
    if (live) {
      throw err(
        "PLAN_ALREADY_ACTIVE",
        "This account is already on a payment plan. Cancel it before agreeing another.",
      );
    }

    const entries = await tx.ledgerEntry.findMany({
      where: { utilityId, id: { in: input.entryIds } },
      select: { id: true, accountId: true, openAmount: true },
    });

    const found = new Set(entries.map((e) => e.id));
    const missing = input.entryIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw err("ENTRY_NOT_FOUND", `No such ledger entry: ${missing.join(", ")}`, 404);
    }

    const foreign = entries.filter((e) => e.accountId !== accountId);
    if (foreign.length > 0) {
      throw err(
        "ENTRY_NOT_ON_ACCOUNT",
        "A plan can only cover debts on its own account.",
      );
    }

    /*
     * Already-in-plan is checked rather than left to the primary key.
     * A P2002 names a constraint, which tells a CSR nothing about which
     * debt is the problem or why.
     */
    const taken = await tx.paymentPlanDebit.findMany({
      where: { utilityId, entryId: { in: input.entryIds } },
      select: { entryId: true },
    });
    if (taken.length > 0) {
      throw err(
        "DEBIT_ALREADY_IN_PLAN",
        `Already covered by a plan: ${taken.map((t) => t.entryId).join(", ")}`,
      );
    }

    /*
     * The frozen balance is the sum of what is still **open**, not the
     * face value: a $110.75 charge with $55.37 left owes $55.37, and a
     * plan covering its face value would collect money the customer
     * does not owe.
     */
    const totalBalance = entries.reduce(
      (sum, e) => sum.plus(e.openAmount),
      new Prisma.Decimal(0),
    );

    if (totalBalance.lessThanOrEqualTo(0)) {
      throw err(
        "NOTHING_TO_COVER",
        "Every debt named is already settled; there is nothing to collect.",
      );
    }

    const downPayment =
      input.downPayment !== undefined
        ? new Prisma.Decimal(input.downPayment)
        : totalBalance
            .times(terms.downPaymentPercent)
            .div(100)
            .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    if (downPayment.lessThan(0)) {
      throw err("DOWN_PAYMENT_NEGATIVE", "A down payment cannot be negative.");
    }

    const remainder = totalBalance.minus(downPayment);
    if (remainder.lessThanOrEqualTo(0)) {
      throw err(
        "DOWN_PAYMENT_LEAVES_NOTHING",
        "That down payment covers the whole balance — take it as a payment instead.",
      );
    }

    const { base, first } = splitInstallments(remainder, input.installmentCount);

    const plan = await tx.paymentPlan.create({
      data: {
        utilityId,
        accountId,
        status: "ACTIVE",
        totalBalance,
        downPayment,
        installmentAmount: base,
        installmentFrequency: terms.frequency,
        installmentCount: input.installmentCount,
        startDate,
        approvedBy: actorId,
        notes: input.notes ?? null,
        // Frozen: a tenant editing its terms next month must not
        // thereby re-term a plan already running.
        graceDays: terms.graceDays,
        missedBeforeDefault: terms.missedInstallmentsBeforeDefault,
        partialInstallmentCounts: terms.partialInstallmentCounts,
        currentBillCounts: terms.currentBillCountsTowardDefault,
        suppressFeesWhileKept: terms.suppressFeesWhileKept,
        assessSuppressedFeesOnDefault: terms.assessSuppressedFeesOnDefault,
      },
      select: { id: true },
    });

    await tx.paymentPlanDebit.createMany({
      data: entries.map((e) => ({ utilityId, planId: plan.id, entryId: e.id })),
    });

    /*
     * Take the account off the ladder, in this transaction.
     * `resolutionType: "PAYMENT_PLAN"` is what that enum value has
     * always meant; what changes is that the word now records a real
     * agreement instead of standing in for one.
     */
    const actionsResolved = await resolveAccount(
      utilityId,
      accountId,
      "PAYMENT_PLAN",
      input.notes,
      actorId,
      tx as TxClient,
    );

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "PaymentPlan" },
      EVENT_TYPES.PAYMENT_PLAN_AGREED,
      plan.id,
      null,
      {
        accountId,
        totalBalance: money(totalBalance),
        downPayment: money(downPayment),
        installmentCount: input.installmentCount,
        installmentFrequency: terms.frequency,
        startDate: input.startDate,
        coveredEntryIds: entries.map((e) => e.id),
      },
    );

    const schedule: PaymentPlanScheduleRow[] = [
      { dueDate: input.startDate, amount: money(downPayment) },
      ...Array.from({ length: input.installmentCount }, (_, i) => ({
        dueDate: addPeriods(startDate, i + 1, terms.frequency).toISOString().slice(0, 10),
        amount: money(i === 0 ? first : base),
      })),
    ];

    return {
      planId: plan.id,
      totalBalance: money(totalBalance),
      downPayment: money(downPayment),
      installmentAmount: money(base),
      schedule,
      coveredEntryIds: entries.map((e) => e.id),
      actionsResolved,
    };
  });
}
