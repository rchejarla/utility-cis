import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import { deliverBill } from "./bill-delivery.service.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import { computeBillPeriod, generateBillForAccount } from "./bill.service.js";
import { postBill } from "./ar/posting.service.js";
import { displayCustomerName } from "./ar/customer-name.js";
import {
  createBillSegmentForServiceAgreement,
  resolveServicePeriod,
} from "./bill-segment.service.js";
import { logger } from "../lib/logger.js";

/**
 * Billing runs — one initiated pass over a cycle, account by account.
 *
 * Design: `docs/superpowers/specs/2026-10-14-billing-run-design.md`.
 *
 * The run calculates; posting is a separate act over the finished run.
 * A run is exactly when a bad rate change becomes twelve thousand wrong
 * charges, and reversing those is far worse than discarding unposted
 * bills — so the review step between the two is the point, not an
 * omission.
 */

/** Statuses that bill. FINAL and CLOSED are handled by Req 134, not here. */
const BILLABLE_ACCOUNT_STATUSES = ["ACTIVE"] as const;

export interface BillingRunSummary {
  id: string;
  billingCycleId: string;
  /**
   * The cycle's own name and code, carried on every summary.
   *
   * Not a convenience: a run's identity to an operator *is* its cycle and
   * window ("the October residential run"), and a list showing a cycle
   * UUID would be a list nobody can read. Required by the type rather
   * than nullable, so a query that forgets the relation fails to compile
   * instead of rendering a blank column.
   */
  billingCycleName: string;
  billingCycleCode: string;
  windowStart: Date;
  windowEnd: Date;
  billDate: Date;
  dueDate: Date;
  status: string;
  accountCount: number;
  billedCount: number;
  failedCount: number;
  skippedCount: number;
  /**
   * `failedCount + skippedCount`, derived rather than stored.
   *
   * Carried because one figure is sometimes what a caller wants — a log
   * line, a list column — but never stored, so it cannot drift from the
   * two numbers it is made of. Anything deciding whether somebody has
   * work to do should read `failedCount`.
   */
  exceptionCount: number;
  postedAt: Date | null;
  cancelRequested: boolean;
  lastProgressAt: Date | null;
  createdAt: Date;
}

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
  actorId: string,
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

/** The columns and the one relation every summary is built from. */
const RUN_CYCLE_SELECT = { select: { name: true, cycleCode: true } } as const;

function toSummary(run: {
  id: string;
  billingCycleId: string;
  windowStart: Date;
  windowEnd: Date;
  billDate: Date;
  dueDate: Date;
  status: string;
  accountCount: number;
  billedCount: number;
  failedCount: number;
  skippedCount: number;
  postedAt: Date | null;
  cancelRequested: boolean;
  lastProgressAt: Date | null;
  createdAt: Date;
  cycle: { name: string; cycleCode: string };
}): BillingRunSummary {
  return {
    id: run.id,
    billingCycleId: run.billingCycleId,
    billingCycleName: run.cycle.name,
    billingCycleCode: run.cycle.cycleCode,
    windowStart: run.windowStart,
    windowEnd: run.windowEnd,
    billDate: run.billDate,
    dueDate: run.dueDate,
    status: run.status,
    accountCount: run.accountCount,
    billedCount: run.billedCount,
    failedCount: run.failedCount,
    skippedCount: run.skippedCount,
    exceptionCount: run.failedCount + run.skippedCount,
    postedAt: run.postedAt,
    cancelRequested: run.cancelRequested,
    lastProgressAt: run.lastProgressAt,
    createdAt: run.createdAt,
  };
}

/** What a failed or skipped account looks like to the item list. */
function classify(err: unknown): { status: "SKIPPED" | "FAILED"; code: string; message: string } {
  const code = (err as { code?: string }).code ?? "UNKNOWN";
  const message = err instanceof Error ? err.message : String(err);
  /*
   * Skipped is "nothing to bill", failed is "should have billed and
   * could not". The distinction is the entire value of the exception
   * list: one is noise an operator scrolls past, the other is a work
   * queue. Getting it wrong in either direction makes the list useless —
   * a skipped account in the failures wastes attention, and a failure
   * among the skips is never looked at.
   */
  const skip = new Set([
    "NO_READ_IN_WINDOW",
    "NO_SEGMENTS_TO_BILL",
    "BILL_ALREADY_EXISTS_FOR_PERIOD",
    "NO_ACTIVE_ASSIGNMENTS",
  ]);
  return { status: skip.has(code) ? "SKIPPED" : "FAILED", code, message };
}

/**
 * Bill every PENDING account in a run.
 *
 * Per item, in its own transaction — not one transaction for the run. A
 * single transaction over twelve thousand accounts holds locks for
 * minutes and lets one bad rate assignment roll back eleven thousand
 * good bills. So a run is deliberately not atomic: a partially complete
 * run with forty exceptions is the normal, useful outcome.
 *
 * Resume comes free from the status filter. A BILLED item is not PENDING,
 * so re-enqueueing a half-finished run cannot bill it twice.
 */
export async function processBillingRun(args: {
  runId: string;
  utilityId: string;
  actorId: string;
  actorName: string;
}): Promise<BillingRunSummary> {
  const { runId, utilityId, actorId, actorName } = args;
  const run = await prisma.billingRun.findFirstOrThrow({
    where: { id: runId, utilityId },
  });

  await prisma.billingRun.update({
    where: { id: runId },
    data: { status: "RUNNING", lastProgressAt: new Date() },
  });

  const items = await prisma.billingRunItem.findMany({
    where: { billingRunId: runId, status: "PENDING" },
    select: { id: true, accountId: true },
    orderBy: { id: "asc" },
  });

  let cancelled = false;
  for (const item of items) {
    // Checked between items rather than mid-account: cancelling must not
    // leave an account half-rated, and one account is quick.
    const fresh = await prisma.billingRun.findUniqueOrThrow({
      where: { id: runId },
      select: { cancelRequested: true },
    });
    if (fresh.cancelRequested) {
      cancelled = true;
      break;
    }

    try {
      const billed = await billOneAccount({
        utilityId,
        actorId,
        actorName,
        accountId: item.accountId,
        windowEnd: run.windowEnd,
      });
      await prisma.billingRunItem.update({
        where: { id: item.id },
        data: {
          status: "BILLED",
          billId: billed.billId,
          servicePeriodStart: billed.servicePeriodStart,
          servicePeriodEnd: billed.servicePeriodEnd,
          segmentCount: billed.segmentCount,
          total: billed.total,
          processedAt: new Date(),
        },
      });
    } catch (err) {
      const { status, code, message } = classify(err);
      await prisma.billingRunItem.update({
        where: { id: item.id },
        data: {
          status,
          errorCode: code,
          errorMessage: message.slice(0, 2000),
          processedAt: new Date(),
        },
      });
      if (status === "FAILED") {
        logger.warn(
          { component: "billing-run", runId, accountId: item.accountId, code },
          "Account failed in billing run",
        );
      }
    }

    await prisma.billingRun.update({
      where: { id: runId },
      data: { lastProgressAt: new Date() },
    });
  }

  return finalise(runId, utilityId, cancelled);
}

/**
 * One account: rate each overlapping agreement for its own read-to-read
 * period, then aggregate.
 *
 * Rating and aggregation share one transaction boundary on purpose.
 * Segment creation marks the period's reads `billedAt`, so rating that
 * succeeds followed by an aggregation that fails would leave reads
 * marked billed against segments with no bill — true of the manual path
 * already, and a run would make it true twelve thousand times.
 */
async function billOneAccount(args: {
  utilityId: string;
  actorId: string;
  actorName: string;
  accountId: string;
  windowEnd: Date;
}): Promise<{
  billId: string;
  servicePeriodStart: Date;
  servicePeriodEnd: Date;
  segmentCount: number;
  total: Prisma.Decimal;
}> {
  const { utilityId, actorId, actorName, accountId, windowEnd } = args;

  const agreements = await prisma.serviceAgreement.findMany({
    where: {
      utilityId,
      accountId,
      startDate: { lte: windowEnd },
      OR: [{ endDate: null }, { endDate: { gte: windowEnd } }],
    },
    select: { id: true },
    orderBy: { agreementNumber: "asc" },
  });
  if (agreements.length === 0) {
    throw Object.assign(new Error(`Account ${accountId} has no agreement in the window`), {
      statusCode: 400,
      code: "NO_ACTIVE_ASSIGNMENTS",
    });
  }

  /*
   * Resolve before rating, so an account with nothing to bill is skipped
   * without side effects. Resolution is read-only; rating writes.
   */
  let anyPeriod = false;
  for (const sa of agreements) {
    try {
      await resolveServicePeriod(utilityId, sa.id, { asOf: windowEnd });
      anyPeriod = true;
    } catch (err) {
      // An agreement with no read is skipped; the account is only
      // skipped when none of them has one.
      if ((err as { code?: string }).code !== "NO_READ_IN_WINDOW") throw err;
    }
  }
  if (!anyPeriod) {
    throw Object.assign(
      new Error(
        `No unbilled read on or before ${windowEnd.toISOString().slice(0, 10)} for any agreement on account ${accountId}`,
      ),
      { statusCode: 400, code: "NO_READ_IN_WINDOW" },
    );
  }

  for (const sa of agreements) {
    try {
      // The same bound the eligibility check above used. Resolving the
      // period twice against two different "nows" is what let a read
      // taken after the window closed into this run's bill.
      await createBillSegmentForServiceAgreement(utilityId, actorId, actorName, sa.id, {
        asOf: windowEnd,
      });
    } catch (err) {
      if ((err as { code?: string }).code === "NO_READ_IN_WINDOW") continue;
      throw err;
    }
  }

  /*
   * suppressAutoPost: the run's whole shape depends on it. Bill
   * creation auto-posts by default (resolveAutoPostBills), so without
   * this a run would raise every receivable as it went and the
   * exception review would happen after the money had already moved.
   * The run posts itself, once, when somebody has looked at it.
   */
  const bill = await generateBillForAccount(utilityId, actorId, actorName, accountId, {
    asOfDate: windowEnd,
    suppressAutoPost: true,
  });

  return {
    billId: bill.id,
    servicePeriodStart: bill.periodStart,
    servicePeriodEnd: bill.periodEnd,
    segmentCount: bill.segments?.length ?? 0,
    total: new Prisma.Decimal(bill.total),
  };
}

/** COMPLETE, PARTIAL, FAILED or CANCELLED, from what the items say. */
async function finalise(
  runId: string,
  utilityId: string,
  cancelled: boolean,
): Promise<BillingRunSummary> {
  const counts = await prisma.billingRunItem.groupBy({
    by: ["status"],
    where: { billingRunId: runId },
    _count: { _all: true },
  });
  const by = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
  const billed = by("BILLED");

  const status = cancelled
    ? "CANCELLED"
    : by("FAILED") === 0 && by("PENDING") === 0
      ? "COMPLETE"
      : billed === 0 && by("PENDING") === 0
        ? "FAILED"
        : "PARTIAL";

  const run = await prisma.billingRun.update({
    where: { id: runId },
    data: {
      status,
      billedCount: billed,
      failedCount: by("FAILED"),
      skippedCount: by("SKIPPED"),
      lastProgressAt: new Date(),
    },
    include: { cycle: RUN_CYCLE_SELECT },
  });
  if (run.utilityId !== utilityId) {
    throw Object.assign(new Error("Run does not belong to this utility"), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }
  return toSummary(run);
}

/**
 * Post every bill this run produced.
 *
 * The second act. Only bills this run made, and only ones still
 * unposted: a bill somebody posted by hand in between is left alone
 * rather than failing the operation, because the operator's intent and
 * ours agree about the outcome.
 */
export async function postBillingRun(
  utilityId: string,
  actorId: string,
  actorName: string,
  runId: string,
): Promise<{ posted: number; alreadyPosted: number; failed: number; held: number }> {
  const run = await prisma.billingRun.findFirst({ where: { id: runId, utilityId } });
  if (!run) {
    throw Object.assign(new Error(`Billing run ${runId} not found`), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }
  if (run.status === "PENDING" || run.status === "RUNNING") {
    throw Object.assign(
      new Error(`Billing run ${runId} is still ${run.status}; wait for it to finish before posting`),
      { statusCode: 409, code: "RUN_NOT_FINISHED" },
    );
  }

  const items = await prisma.billingRunItem.findMany({
    where: { billingRunId: runId, status: "BILLED", billId: { not: null } },
    select: { billId: true },
  });

  let posted = 0;
  let alreadyPosted = 0;
  let failed = 0;
  let held = 0;
  for (const item of items) {
    const billId = item.billId as string;
    const bill = await prisma.bill.findFirst({
      where: { id: billId, utilityId },
      select: {
        postedAt: true,
        holdReason: true,
        account: { select: { billingHoldReason: true } },
      },
    });
    if (!bill) continue;
    if (bill.postedAt) {
      alreadyPosted += 1;
      continue;
    }
    /*
     * Counted apart from `failed`, for the reason this run's whole
     * design rests on: a held bill is a decision somebody made, not work
     * to investigate. Reporting "3 could not post" against three bills
     * an operator deliberately stopped would send them looking for a
     * fault that is not there.
     */
    if (bill.holdReason ?? bill.account.billingHoldReason) {
      held += 1;
      continue;
    }
    try {
      await postBill(utilityId, actorId, actorName, billId);
      posted += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, component: "billing-run", runId, billId }, "Posting a run's bill failed");
    }
  }

  await prisma.billingRun.update({
    where: { id: runId },
    data: { postedAt: new Date(), postedBy: actorId },
  });

  return { posted, alreadyPosted, failed, held };
}

/** One reason bills were not sent, and how much of the run it accounts for. */
export interface SendSkip {
  code: string;
  accountCount: number;
  sampleAccounts: string[];
  message: string;
}

/**
 * Queue every bill this run produced for delivery.
 *
 * Sending existed one bill at a time, and a run of twelve thousand
 * accounts cannot be worked that way — the same objection as a per-bill
 * hold button. The run already knows which bills it made, and posting
 * is already the act that precedes sending, so this is where the
 * trigger belongs.
 *
 * It does not stop at the first problem. A customer with no address, a
 * bill nobody rendered, a held account: each is one account's
 * exception, not a reason the other eleven thousand go unsent. Each
 * refusal `deliverBill` already makes is caught and counted by its
 * code, and the result reads like the pre-flight and the exception
 * list — by cause, with examples — because one fix usually clears a
 * whole group.
 *
 * Pressing it twice does not send twice: `deliverBill` refuses a bill
 * already queued, so the second pass reports every bill as in flight
 * and makes no copies.
 */
export async function sendBillingRun(
  utilityId: string,
  runId: string,
): Promise<{ queued: number; skipped: SendSkip[] }> {
  const run = await prisma.billingRun.findFirst({
    where: { id: runId, utilityId },
    select: { id: true, postedAt: true },
  });
  if (!run) {
    throw Object.assign(new Error(`Billing run ${runId} not found`), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }
  /*
   * An unposted run is a calculation. Sending it would ask every
   * customer on the cycle for money the utility has not decided to
   * charge — the same rule `deliverBill` applies per bill, stated once
   * here so twelve thousand refusals are not how an operator finds out.
   */
  if (!run.postedAt) {
    throw Object.assign(
      new Error(
        "This run has not been posted. Nobody owes a bill until it is posted, so there is nothing to send. Post the run first.",
      ),
      { statusCode: 409, code: "RUN_NOT_POSTED" },
    );
  }

  const items = await prisma.billingRunItem.findMany({
    where: { utilityId, billingRunId: runId, status: "BILLED", billId: { not: null } },
    select: { billId: true, account: { select: { accountNumber: true } } },
    orderBy: { id: "asc" },
  });

  let queued = 0;
  const groups = new Map<string, { message: string; accounts: string[] }>();

  for (const item of items) {
    try {
      await deliverBill(utilityId, item.billId!);
      queued += 1;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // Anything without a code is a fault rather than a refusal, and
      // swallowing it would report a run as fully sent while a defect
      // ate half of it.
      if (!e.code) throw err;
      const group = groups.get(e.code) ?? { message: e.message ?? e.code, accounts: [] };
      group.accounts.push(item.account.accountNumber);
      groups.set(e.code, group);
    }
  }

  const skipped: SendSkip[] = [...groups.entries()]
    .map(([code, g]) => ({
      code,
      accountCount: g.accounts.length,
      sampleAccounts: g.accounts.slice(0, 3),
      message: g.message,
    }))
    .sort((a, b) => b.accountCount - a.accountCount);

  return { queued, skipped };
}

/** Ask a run to stop; it finishes the account it is on. */
export async function cancelBillingRun(
  utilityId: string,
  runId: string,
): Promise<BillingRunSummary> {
  const run = await prisma.billingRun.findFirst({ where: { id: runId, utilityId } });
  if (!run) {
    throw Object.assign(new Error(`Billing run ${runId} not found`), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }
  const updated = await prisma.billingRun.update({
    where: { id: runId },
    data: { cancelRequested: true },
    include: { cycle: RUN_CYCLE_SELECT },
  });
  return toSummary(updated);
}

/**
 * The states a run can be resumed from.
 *
 * `CANCELLED` is in the list because one run per window is a database
 * constraint (`@@unique([utilityId, billingCycleId, windowEnd])`), so a
 * cancelled run cannot be superseded by a new one — without resume,
 * cancelling would close the period permanently. `COMPLETE` has nothing
 * unbilled; `PENDING` and `RUNNING` are already being worked.
 */
const RESUMABLE_STATUSES = ["FAILED", "PARTIAL", "CANCELLED"] as const;

/**
 * Put a run's unbilled accounts back in the queue.
 *
 * `FAILED` is not a different state from `PARTIAL` — the status rule in
 * `finaliseRun` reads "nothing billed and nothing pending" — so both
 * mean the same thing: some accounts are not billed. A run is a
 * worklist, open until every item resolves, and the ordinary operating
 * loop is run → fix the cause an exception names → resume. Before this
 * existed, the only way past a failed run was to edit rows by hand, and
 * `resolveRunPlan`'s guard would not let a new run near the window
 * either.
 *
 * Resume is deliberately the retry mechanism rather than BullMQ's:
 * `billing-run-worker` sets `attempts: 1` precisely so an automatic
 * retry cannot restart a run whose early accounts are already billed.
 * This resets only what is *not* `BILLED`, and `processBillingRun`
 * selects `PENDING` items, so an account cannot be billed twice.
 *
 * `SKIPPED` is reset along with `FAILED`, because a skip is "not ready"
 * rather than "nothing to do": `NO_READ_IN_WINDOW` resolves the moment
 * a reader submits, and re-checking one that genuinely has nothing to
 * bill costs an eligibility query and skips again.
 */
export async function resumeBillingRun(
  utilityId: string,
  actorId: string,
  actorName: string,
  runId: string,
): Promise<BillingRunSummary> {
  const run = await prisma.billingRun.findFirst({ where: { id: runId, utilityId } });
  if (!run) {
    throw Object.assign(new Error(`Billing run ${runId} not found`), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }

  if (!(RESUMABLE_STATUSES as readonly string[]).includes(run.status)) {
    throw Object.assign(
      new Error(
        `Billing run ${runId} is ${run.status}. Only a ${RESUMABLE_STATUSES.join(" or ")} ` +
          "run has unbilled accounts to retry; a live run is already working through them.",
      ),
      { statusCode: 409, code: "RUN_NOT_RESUMABLE" },
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "BillingRun" },
    EVENT_TYPES.BILLING_RUN_RESUMED,
    run,
    async (tx) => {
      await tx.billingRunItem.updateMany({
        where: { billingRunId: runId, status: { in: ["FAILED", "SKIPPED"] } },
        // The reason is cleared with the retry: a stale error_code
        // describes an attempt that is no longer the latest one, and the
        // exception list reads it as current.
        data: { status: "PENDING", errorCode: null, errorMessage: null, processedAt: null },
      });

      const updated = await tx.billingRun.update({
        where: { id: runId },
        data: {
          status: "PENDING",
          // A cancel asked for during the previous pass must not carry
          // over, or the worker would stop on the first item again.
          cancelRequested: false,
          lastProgressAt: new Date(),
        },
        include: { cycle: RUN_CYCLE_SELECT },
      });
      return toSummary(updated);
    },
  );
}

export async function listBillingRuns(utilityId: string): Promise<BillingRunSummary[]> {
  const runs = await prisma.billingRun.findMany({
    where: { utilityId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { cycle: RUN_CYCLE_SELECT },
  });
  return runs.map(toSummary);
}

/**
 * One run, with what it would raise if posted.
 *
 * `billedTotal` is on the detail and not on the list, because the number
 * exists for one question — "what am I about to put on customers'
 * accounts?" — asked at the moment of posting. A column of run totals
 * would be read as revenue, which it is not: an unposted run's total is
 * owed by nobody, and a posted one's is already in the ledger.
 */
export interface BillingRunDetail extends BillingRunSummary {
  billedTotal: string;
  /**
   * How many of this run's bills have actually been delivered.
   *
   * Bills, not attempts: a resend is a second row against the same bill
   * and must not make the figure claim two went out. Derived on read
   * rather than stored, so it stays true as the outbox drains — the
   * send panel answers this for ten seconds and a reload loses it,
   * while a run is the thing an operator comes back to days later.
   */
  sentCount: number;
  /** How many of this run's bills are posted and so actually owed. */
  postedCount: number;
  /**
   * How many of this run's bills a Post would still act on.
   *
   * Not `billedCount - postedCount`: a held bill is deliberately
   * unposted, and a screen gating on the difference would offer a Post
   * whose only possible outcome is to report it held again. Nor can the
   * two be subtracted anyway — holding a bill after it posts is allowed,
   * so the sets overlap.
   *
   * This is the figure a Post button belongs on, in place of
   * `!postedAt`: that stamp says a posting pass ran, which is not the
   * same as nothing being left. It is written unconditionally at the end
   * of the loop, so a run where three bills threw is marked posted with
   * three unposted bills still in it — and the screen hid the only way
   * to finish them.
   */
  awaitingPostCount: number;
}

export async function getBillingRun(utilityId: string, runId: string): Promise<BillingRunDetail> {
  const run = await prisma.billingRun.findFirst({
    where: { id: runId, utilityId },
    include: { cycle: RUN_CYCLE_SELECT },
  });
  if (!run) {
    throw Object.assign(new Error(`Billing run ${runId} not found`), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }
  const billed = await prisma.billingRunItem.aggregate({
    where: { utilityId, billingRunId: runId, status: "BILLED" },
    _sum: { total: true },
  });
  /*
   * Distinct bills with a delivery that reached a provider. Grouped
   * rather than counted, because `count` would total the attempts and
   * a resent bill would read as two.
   */
  const billIds = (
    await prisma.billingRunItem.findMany({
      where: { utilityId, billingRunId: runId, status: "BILLED", billId: { not: null } },
      select: { billId: true },
    })
  ).map((i) => i.billId!);
  const sent =
    billIds.length === 0
      ? []
      : await prisma.notification.groupBy({
          by: ["billId"],
          where: { utilityId, status: "SENT", billId: { in: billIds } },
        });

  /*
   * Counted with the same predicate `postBillingRun`'s loop skips on, so
   * the figure a Post button is gated on cannot disagree with what a
   * Post would actually do: posted bills are done, and a bill held
   * either on itself or through its account is somebody's decision
   * rather than work outstanding.
   */
  const [postedCount, awaitingPostCount] =
    billIds.length === 0
      ? [0, 0]
      : await Promise.all([
          prisma.bill.count({
            where: { utilityId, id: { in: billIds }, postedAt: { not: null } },
          }),
          prisma.bill.count({
            where: {
              utilityId,
              id: { in: billIds },
              postedAt: null,
              holdReason: null,
              account: { billingHoldReason: null },
            },
          }),
        ]);

  return {
    ...toSummary(run),
    // Summed at 4dp like the column, and rounded by whatever prints it —
    // the same order as a bill's own subtotals.
    billedTotal: (billed._sum.total ?? new Prisma.Decimal(0)).toFixed(4),
    sentCount: sent.length,
    postedCount,
    awaitingPostCount,
  };
}

/** One cause, and how much of the run it accounts for. */
export interface RunExceptionGroup {
  /** FAILED or SKIPPED — never merged, since only one of them is work. */
  status: string;
  code: string;
  accountCount: number;
  /** A few account numbers, to recognise the group by. */
  sampleAccounts: string[];
  /** One account's sentence, as the reason in full. */
  message: string;
}

/**
 * A run's exceptions by cause.
 *
 * The item list answers "what happened to this account". An operator
 * working a run needs the other question first — "how many things do I
 * have to fix" — and the two differ by orders of magnitude: twelve
 * thousand accounts failing on one unpublished schedule is one job
 * reported forty times. `billing-runs/[id]/page.tsx` already says as
 * much next to the reason column, and `previewBillingRun` groups the
 * same way before a run, so this is that view after the fact.
 *
 * Grouped on `errorCode`, not the message: the messages name the account
 * they belong to, so grouping by sentence would reproduce the list it
 * replaces. Counted in the database rather than over the fetched page,
 * because the list is capped and the whole point is the size of the
 * group.
 */
export async function summariseRunExceptions(
  utilityId: string,
  runId: string,
): Promise<RunExceptionGroup[]> {
  const groups = await prisma.billingRunItem.groupBy({
    by: ["status", "errorCode"],
    where: {
      utilityId,
      billingRunId: runId,
      status: { in: ["FAILED", "SKIPPED"] },
    },
    _count: { _all: true },
    orderBy: { _count: { id: "desc" } },
  });

  // One query per group for its examples. Bounded by the number of
  // distinct codes, which is small by construction — a run with forty
  // different causes has a problem no grouping will help with.
  return Promise.all(
    groups.map(async (group) => {
      const samples = await prisma.billingRunItem.findMany({
        where: {
          utilityId,
          billingRunId: runId,
          status: group.status,
          errorCode: group.errorCode,
        },
        select: { errorMessage: true, account: { select: { accountNumber: true } } },
        orderBy: { id: "asc" },
        take: 3,
      });
      return {
        status: group.status,
        code: group.errorCode ?? "UNKNOWN",
        accountCount: group._count._all,
        sampleAccounts: samples.map((s) => s.account.accountNumber),
        message: samples[0]?.errorMessage ?? "",
      };
    }),
  );
}

export async function listBillingRunItems(
  utilityId: string,
  runId: string,
  query: { status?: string; limit: number; offset: number },
) {
  const items = await prisma.billingRunItem.findMany({
    where: {
      utilityId,
      billingRunId: runId,
      ...(query.status ? { status: query.status as "PENDING" } : {}),
    },
    include: {
      /*
       * The customer's name, because "who is this?" is the next question
       * after an account number on every exception an operator works,
       * and one join answers it rather than a page of lookups.
       */
      account: {
        select: {
          accountNumber: true,
          customer: {
            select: {
              customerType: true,
              firstName: true,
              lastName: true,
              organizationName: true,
            },
          },
        },
      },
    },
    orderBy: [{ status: "asc" }, { id: "asc" }],
    take: query.limit,
    skip: query.offset,
  });
  return items.map((i) => ({
    id: i.id,
    accountId: i.accountId,
    accountNumber: i.account.accountNumber,
    customerName: displayCustomerName(i.account.customer),
    status: i.status,
    billId: i.billId,
    servicePeriodStart: i.servicePeriodStart,
    servicePeriodEnd: i.servicePeriodEnd,
    segmentCount: i.segmentCount,
    total: i.total === null ? null : i.total.toFixed(4),
    errorCode: i.errorCode,
    errorMessage: i.errorMessage,
    processedAt: i.processedAt,
  }));
}
