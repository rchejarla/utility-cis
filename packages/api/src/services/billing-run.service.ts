import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import { auditCreate } from "../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import { computeBillPeriod, generateBillForAccount } from "./bill.service.js";
import { postBill } from "./ar/posting.service.js";
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
  windowStart: Date;
  windowEnd: Date;
  billDate: Date;
  dueDate: Date;
  status: string;
  accountCount: number;
  billedCount: number;
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
 * Start a run: write it and its PENDING items, then let the worker bill.
 *
 * Eligibility is a query, so this is fast and bounded even at twelve
 * thousand accounts — the slow part is rating, which is the worker's.
 * An account is in the run when it belongs to the cycle, its status
 * bills, and it has an agreement overlapping the window. Everything
 * else is an exception with a reason; an account that is simply not due
 * is not in the run at all.
 */
export async function createBillingRun(
  utilityId: string,
  actorId: string,
  actorName: string,
  args: CreateBillingRunArgs,
): Promise<BillingRunSummary> {
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

  const existing = await prisma.billingRun.findFirst({
    where: { utilityId, billingCycleId: cycle.id, windowEnd: window.periodEnd },
    select: { id: true, status: true },
  });
  if (existing) {
    throw Object.assign(
      new Error(
        `Billing cycle ${cycle.cycleCode} already has a run for the window ending ` +
          `${window.periodEnd.toISOString().slice(0, 10)} (${existing.status}). ` +
          "Resume or cancel that run rather than starting a second one.",
      ),
      {
        statusCode: 409,
        code: "RUN_ALREADY_EXISTS_FOR_WINDOW",
        existingRunId: existing.id,
      },
    );
  }

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

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "BillingRun" },
    EVENT_TYPES.BILLING_RUN_CREATED,
    async (tx) => {
      const run = await tx.billingRun.create({
        data: {
          utilityId,
          billingCycleId: cycle.id,
          windowStart: window.periodStart,
          windowEnd: window.periodEnd,
          billDate,
          dueDate,
          accountCount: accounts.length,
          createdBy: actorId,
        },
      });
      if (accounts.length > 0) {
        await tx.billingRunItem.createMany({
          data: accounts.map((a) => ({
            utilityId,
            billingRunId: run.id,
            accountId: a.id,
          })),
        });
      }
      return toSummary(run);
    },
  );
}

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
  exceptionCount: number;
  postedAt: Date | null;
  cancelRequested: boolean;
  lastProgressAt: Date | null;
  createdAt: Date;
}): BillingRunSummary {
  return {
    id: run.id,
    billingCycleId: run.billingCycleId,
    windowStart: run.windowStart,
    windowEnd: run.windowEnd,
    billDate: run.billDate,
    dueDate: run.dueDate,
    status: run.status,
    accountCount: run.accountCount,
    billedCount: run.billedCount,
    exceptionCount: run.exceptionCount,
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
      await createBillSegmentForServiceAgreement(utilityId, actorId, actorName, sa.id, {});
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
  const exceptions = by("FAILED") + by("SKIPPED");

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
      exceptionCount: exceptions,
      lastProgressAt: new Date(),
    },
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
): Promise<{ posted: number; alreadyPosted: number; failed: number }> {
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
  for (const item of items) {
    const billId = item.billId as string;
    const bill = await prisma.bill.findFirst({
      where: { id: billId, utilityId },
      select: { postedAt: true },
    });
    if (!bill) continue;
    if (bill.postedAt) {
      alreadyPosted += 1;
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

  return { posted, alreadyPosted, failed };
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
  });
  return toSummary(updated);
}

export async function listBillingRuns(utilityId: string): Promise<BillingRunSummary[]> {
  const runs = await prisma.billingRun.findMany({
    where: { utilityId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return runs.map(toSummary);
}

export async function getBillingRun(utilityId: string, runId: string): Promise<BillingRunSummary> {
  const run = await prisma.billingRun.findFirst({ where: { id: runId, utilityId } });
  if (!run) {
    throw Object.assign(new Error(`Billing run ${runId} not found`), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }
  return toSummary(run);
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
      account: { select: { accountNumber: true } },
    },
    orderBy: [{ status: "asc" }, { id: "asc" }],
    take: query.limit,
    skip: query.offset,
  });
  return items.map((i) => ({
    id: i.id,
    accountId: i.accountId,
    accountNumber: i.account.accountNumber,
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
