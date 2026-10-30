/**
 * Working a run down, account by account.
 *
 * The pass itself: what it bills, what it records against an account it
 * could not, and how it decides the status it ends in.
 */
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { RUN_CYCLE_SELECT, toSummary, type BillingRunSummary } from "./summary.js";
import { generateBillForAccount } from "./../bill.service.js";
import {
  createBillSegmentForServiceAgreement,
  resolveServicePeriod,
} from "./../bill-segment.service.js";
import { logger } from "../../lib/logger.js";
import { claimForGeneration } from "./claim.js";

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
  /**
   * Null when the schedule started this run rather than a person.
   *
   * It travels unchanged to the audit context, which has always taken
   * `string | null` — the sweeps' convention. The services between here
   * and there were typed `string` only because nothing had ever handed
   * them a system-initiated run.
   */
  actorId: string | null;
  actorName: string;
}): Promise<BillingRunSummary> {
  const { runId, utilityId, actorId, actorName } = args;
  const run = await prisma.billingRun.findFirstOrThrow({
    where: { id: runId, utilityId },
    include: { cycle: RUN_CYCLE_SELECT },
  });

  /*
   * Claim it, or leave it to whoever has it.
   *
   * Returning the run as it stands rather than raising: a second job for
   * a run already in hand is a race, not a fault — an operator pressing
   * Resume while a reclaim job for the same run is still waiting is
   * enough to produce one. Raising would fail the job and log an error
   * for the correct outcome.
   *
   * It must not fall through to `finalise`, which would write a terminal
   * status over the live pass's unfinished work and report its counts as
   * final.
   */
  if (!(await claimForGeneration(runId, utilityId))) {
    logger.warn(
      { component: "billing-run", runId },
      "A live pass already holds this run; leaving it to that process",
    );
    return toSummary(run);
  }

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
  actorId: string | null;
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
