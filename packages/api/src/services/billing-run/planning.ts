/**
 * What a run would be, and committing to it.
 *
 * Preview and create are one module because they must decide the window
 * and the dates identically — the whole reason preview exists is that
 * the operator approves the thing that then happens.
 */
import { prisma } from "../../lib/prisma.js";
import { computeBillPeriod } from "./../bill.service.js";
import { auditCreate } from "../../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import { BILLABLE_ACCOUNT_STATUSES } from "./statuses.js";
import { RUN_CYCLE_SELECT, toSummary, type BillingRunSummary } from "./summary.js";

export interface CreateBillingRunArgs {
  billingCycleId: string;
  windowEnd?: Date;
  billDate?: Date;
  dueDate?: Date;
}

/** Days from bill date to due date when the caller does not say. */
const DEFAULT_DUE_DAYS = 30;

function addDays(d: Date, days: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
}

/**
 * What a run would be, without writing it.
 *
 * The one place the window, the dates and the eligible accounts are
 * decided, so the preview an operator approves and the run that then
 * happens cannot be computed two different ways. It reports an existing
 * run for the window rather than refusing: a preview's job is to
 * describe, and `createBillingRun` is where the same fact becomes a 409.
 */
export interface BillingRunPlan {
  billingCycleId: string;
  billingCycleName: string;
  billingCycleCode: string;
  windowStart: Date;
  windowEnd: Date;
  billDate: Date;
  dueDate: Date;
  /** Accounts the run would bill, in the order it would bill them. */
  accountIds: string[];
  existingRun: { id: string; status: string } | null;
}

async function resolveRunPlan(
  utilityId: string,
  args: CreateBillingRunArgs,
): Promise<BillingRunPlan> {
  const cycle = await prisma.billingCycle.findFirst({
    where: { id: args.billingCycleId, utilityId },
  });
  if (!cycle) {
    throw Object.assign(new Error(`Billing cycle ${args.billingCycleId} not found`), {
      statusCode: 404,
      code: "CYCLE_NOT_FOUND",
    });
  }
  if (!cycle.active) {
    throw Object.assign(
      new Error(`Billing cycle ${cycle.cycleCode} is inactive, so it has nothing due`),
      { statusCode: 409, code: "CYCLE_INACTIVE" },
    );
  }

  /*
   * The window comes from the cycle's own calendar, which is what
   * `computeBillPeriod` has always computed — it is a scheduling window
   * and always was, even while the code used it as a service period.
   * Reusing it keeps one definition of "the October window".
   */
  const asOf = args.windowEnd ?? new Date();
  /*
   * `createdAt` at the epoch so the per-account clamp inside
   * `computeBillPeriod` never fires: a run's window belongs to the
   * cycle, not to any one account, and clamping it to an account's
   * creation date would give the run a different window per account —
   * which is the thing a run exists to avoid.
   */
  const window = computeBillPeriod({ createdAt: new Date(0), billingCycle: cycle }, asOf);
  const billDate = args.billDate ?? window.periodEnd;
  const dueDate = args.dueDate ?? addDays(billDate, DEFAULT_DUE_DAYS);

  if (dueDate < billDate) {
    throw Object.assign(new Error("dueDate must be on or after billDate"), {
      statusCode: 400,
      code: "INVALID_DATES",
    });
  }

  /*
   * Any run for the window blocks a new one, whatever its status, and
   * deliberately so: `@@unique([utilityId, billingCycleId, windowEnd])`
   * enforces one run per window in the database. This check exists to
   * say *which* run and what to do about it, because without it the
   * insert fails as an opaque UNIQUE_CONSTRAINT naming three columns.
   *
   * It was briefly relaxed to let a FAILED or CANCELLED run be
   * superseded, on the reasoning that a run which billed nothing should
   * not close its period. The constraint makes that impossible, and the
   * relaxation only degraded the error — so **resume is the only way
   * forward from a run that did not finish**, which is why
   * `resumeBillingRun` accepts CANCELLED as well as FAILED and PARTIAL.
   */
  const existing = await prisma.billingRun.findFirst({
    where: { utilityId, billingCycleId: cycle.id, windowEnd: window.periodEnd },
    select: { id: true, status: true },
  });

  /*
   * Eligibility is a query, so this is fast and bounded even at twelve
   * thousand accounts — the slow part is rating, which is the worker's.
   * An account is in the run when it belongs to the cycle, its status
   * bills, and it has an agreement overlapping the window. Everything
   * else is an exception with a reason; an account that is simply not
   * due is not in the run at all.
   */
  const accounts = await prisma.account.findMany({
    where: {
      utilityId,
      billingCycleId: cycle.id,
      status: { in: [...BILLABLE_ACCOUNT_STATUSES] },
      serviceAgreements: {
        some: {
          startDate: { lte: window.periodEnd },
          OR: [{ endDate: null }, { endDate: { gte: window.periodStart } }],
        },
      },
    },
    select: { id: true },
    orderBy: { accountNumber: "asc" },
  });

  return {
    billingCycleId: cycle.id,
    billingCycleName: cycle.name,
    billingCycleCode: cycle.cycleCode,
    windowStart: window.periodStart,
    windowEnd: window.periodEnd,
    billDate,
    dueDate,
    accountIds: accounts.map((a) => a.id),
    existingRun: existing,
  };
}

/**
 * A reason some of the eligible accounts cannot be billed, and what to
 * fix. Grouped by cause rather than listed per account: one publish or
 * one assignment usually clears the whole group.
 */
export interface RunBlocker {
  code: "NO_ACTIVE_ASSIGNMENTS" | "SCHEDULE_NOT_PUBLISHED";
  accountCount: number;
  /** The thing to go and fix — schedule codes, or the agreements. */
  detail: string;
  /** A few account numbers, so the group is recognisable. */
  sampleAccounts: string[];
}

/**
 * Which of the eligible accounts a run would fail or skip on config,
 * before it is started.
 *
 * Eligibility answers "is this account due"; it says nothing about
 * whether the account *can* be billed, so these two faults used to be
 * discovered one account at a time during a run and reported only
 * afterwards. Both are invisible until then and both are usually one
 * fix for many accounts.
 *
 * Two set-based queries rather than a walk: the per-agreement checks
 * `createBillSegmentForServiceAgreement` performs are the expensive
 * part and they belong to rating, not to a preview that has to answer
 * while someone waits.
 *
 * Reads are deliberately not checked here. `NO_READ_IN_WINDOW` is a
 * skip rather than a failure — not-ready rather than misconfigured —
 * and the operator already knows whether reading is done, whereas a
 * draft schedule is invisible. Adding it would also mean resolving a
 * service period per agreement, which is the work of a run.
 */
async function findRunBlockers(
  utilityId: string,
  accountIds: string[],
  window: { periodStart: Date; periodEnd: Date },
): Promise<{ blockers: RunBlocker[]; blockedAccountIds: Set<string> }> {
  if (accountIds.length === 0) return { blockers: [], blockedAccountIds: new Set() };

  const agreements = await prisma.serviceAgreement.findMany({
    where: {
      utilityId,
      accountId: { in: accountIds },
      startDate: { lte: window.periodEnd },
      OR: [{ endDate: null }, { endDate: { gte: window.periodStart } }],
    },
    select: {
      id: true,
      agreementNumber: true,
      account: { select: { id: true, accountNumber: true } },
      rateScheduleAssignments: {
        where: {
          effectiveDate: { lte: window.periodEnd },
          OR: [{ expirationDate: null }, { expirationDate: { gte: window.periodStart } }],
        },
        select: {
          rateSchedule: { select: { code: true, version: true, publishedAt: true } },
        },
      },
    },
  });

  const unassigned = new Map<string, string>();
  const unpublished = new Map<string, string>();
  const unpublishedSchedules = new Set<string>();
  const unassignedAgreements = new Set<string>();

  for (const sa of agreements) {
    if (sa.rateScheduleAssignments.length === 0) {
      unassigned.set(sa.account.id, sa.account.accountNumber);
      unassignedAgreements.add(sa.agreementNumber);
      continue;
    }
    const drafts = sa.rateScheduleAssignments.filter((a) => !a.rateSchedule.publishedAt);
    if (drafts.length > 0) {
      unpublished.set(sa.account.id, sa.account.accountNumber);
      for (const d of drafts) {
        unpublishedSchedules.add(`${d.rateSchedule.code} v${d.rateSchedule.version}`);
      }
    }
  }

  const blockers: RunBlocker[] = [];
  const describe = (items: Set<string>, max = 5) => {
    const all = [...items].sort();
    return all.length <= max
      ? all.join(", ")
      : `${all.slice(0, max).join(", ")} and ${all.length - max} more`;
  };

  if (unassigned.size > 0) {
    blockers.push({
      code: "NO_ACTIVE_ASSIGNMENTS",
      accountCount: unassigned.size,
      detail: describe(unassignedAgreements),
      sampleAccounts: [...unassigned.values()].sort().slice(0, 5),
    });
  }
  if (unpublished.size > 0) {
    blockers.push({
      code: "SCHEDULE_NOT_PUBLISHED",
      accountCount: unpublished.size,
      detail: describe(unpublishedSchedules),
      sampleAccounts: [...unpublished.values()].sort().slice(0, 5),
    });
  }

  return {
    blockers,
    blockedAccountIds: new Set([...unassigned.keys(), ...unpublished.keys()]),
  };
}

/**
 * Describe the run a cycle would produce right now.
 *
 * Exists because the window and both dates are computed from the
 * cycle's calendar, so a screen cannot tell an operator what the button
 * will do without asking — and the alternative, re-deriving
 * `computeBillPeriod` in the browser, would put the second definition of
 * "the October window" in the place least able to keep it right.
 */
export async function previewBillingRun(
  utilityId: string,
  args: CreateBillingRunArgs,
): Promise<
  Omit<BillingRunPlan, "accountIds"> & {
    accountCount: number;
    /** Of those, how many are actually billable as configured. */
    billableCount: number;
    blockers: RunBlocker[];
  }
> {
  const { accountIds, ...rest } = await resolveRunPlan(utilityId, args);
  const { blockers, blockedAccountIds } = await findRunBlockers(utilityId, accountIds, {
    periodStart: rest.windowStart,
    periodEnd: rest.windowEnd,
  });
  return {
    ...rest,
    accountCount: accountIds.length,
    // Both numbers, not one: "240 of 12,000 cannot be billed" is a
    // different instruction from either figure alone.
    billableCount: accountIds.filter((id) => !blockedAccountIds.has(id)).length,
    blockers,
  };
}

/**
 * Start a run: write it and its PENDING items, then let the worker bill.
 */
export async function createBillingRun(
  utilityId: string,
  /**
   * Null when the billing dispatcher started this run rather than a
   * person. It lands in `billing_run.created_by`, which is nullable for
   * exactly that, and in the audit context, which has always taken one.
   */
  actorId: string | null,
  actorName: string,
  args: CreateBillingRunArgs,
): Promise<BillingRunSummary> {
  const plan = await resolveRunPlan(utilityId, args);
  const { windowStart, windowEnd, billDate, dueDate, accountIds } = plan;

  if (plan.existingRun) {
    throw Object.assign(
      new Error(
        `Billing cycle ${plan.billingCycleCode} already has a run for the window ending ` +
          `${windowEnd.toISOString().slice(0, 10)} (${plan.existingRun.status}). ` +
          (plan.existingRun.status === "COMPLETE"
            ? "It billed this window already."
            : plan.existingRun.status === "PENDING" || plan.existingRun.status === "RUNNING"
              ? "It is still running; wait for it to finish or cancel it."
              : // FAILED, PARTIAL, CANCELLED: one run per window is a
                // database constraint, so a second cannot be started —
                // resume is the way to bill what it did not.
                "Resume it to bill the accounts it did not; one run per window is enforced, so a second cannot be started."),
      ),
      {
        statusCode: 409,
        code: "RUN_ALREADY_EXISTS_FOR_WINDOW",
        existingRunId: plan.existingRun.id,
      },
    );
  }

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "BillingRun" },
    EVENT_TYPES.BILLING_RUN_CREATED,
    async (tx) => {
      const run = await tx.billingRun.create({
        data: {
          utilityId,
          billingCycleId: plan.billingCycleId,
          windowStart,
          windowEnd,
          billDate,
          dueDate,
          accountCount: accountIds.length,
          createdBy: actorId,
        },
        include: { cycle: RUN_CYCLE_SELECT },
      });
      if (accountIds.length > 0) {
        await tx.billingRunItem.createMany({
          data: accountIds.map((accountId) => ({
            utilityId,
            billingRunId: run.id,
            accountId,
          })),
        });
      }
      return toSummary(run);
    },
  );
}
