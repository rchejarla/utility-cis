import { Worker } from "bullmq";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import {
  QUEUE_NAMES,
  enqueueSafely,
  workerOptions,
} from "../lib/queues.js";
import { scopedJob } from "../lib/queue-scope.js";
import { processBillingRun, postBillingRun } from "../services/billing-run.service.js";
import { prisma } from "../lib/prisma.js";

/**
 * BullMQ worker for the `billing-runs` queue.
 *
 * One job = one run. Concurrency 1: a run is already a loop over
 * thousands of accounts through the rate engine, and two at once would
 * halve neither's wall clock.
 *
 * `attempts: 1`, as the queue config sets — an auto-retry would restart
 * a run whose early accounts are already BILLED. Resume is deliberate
 * instead: re-enqueue the run and `processBillingRun`'s status filter
 * bills only what is still PENDING, so a BILLED account cannot be
 * billed twice.
 *
 * On crash mid-run the boot sweep below re-enqueues anything left
 * RUNNING, which is the same shape as the import worker's zombie
 * reclaim and exists for the same reason: a replica that dies holding a
 * run leaves it looking busy forever.
 */

export const BILLING_RUN_JOB_NAME = "process-billing-run";
/**
 * Posting a whole run, on the same queue as generating it.
 *
 * The same queue because the two must not run concurrently over one
 * run, and concurrency 1 already guarantees that — a second queue would
 * reintroduce the overlap. The same reason the queue holds concurrency 1
 * at all applies here: posting is a loop over thousands of accounts,
 * one transaction each.
 *
 * Posting a *single* bill stays synchronous on `routes/ar.ts`. A CSR
 * posting one bill wants the answer in the response, and one bill is one
 * transaction — there is nothing to background.
 */
export const BILLING_RUN_POST_JOB_NAME = "post-billing-run";

export interface BillingRunJobData {
  runId: string;
  utilityId: string;
  actorId: string;
  actorName: string;
}

export function buildBillingRunWorker(): Worker<BillingRunJobData> {
  const worker = new Worker<BillingRunJobData>(
    QUEUE_NAMES.billingRuns,
    scopedJob(QUEUE_NAMES.billingRuns, async (job) => {
      const { runId, utilityId, actorId, actorName } = job.data;

      if (job.name === BILLING_RUN_POST_JOB_NAME) {
        const result = await withTelemetry(QUEUE_NAMES.billingRuns, () =>
          postBillingRun(utilityId, actorId, actorName, runId),
        );
        logger.info(
          { component: "billing-run-worker", runId, ...result },
          "Billing run posting finished",
        );
        return result;
      }

      const result = await withTelemetry(QUEUE_NAMES.billingRuns, () =>
        processBillingRun({ runId, utilityId, actorId, actorName }),
      );
      logger.info(
        {
          component: "billing-run-worker",
          runId,
          finalStatus: result.status,
          accountCount: result.accountCount,
          billedCount: result.billedCount,
          failedCount: result.failedCount,
          skippedCount: result.skippedCount,
        },
        "Billing run finished",
      );
      return result;
    }),
    {
      ...workerOptions(QUEUE_NAMES.billingRuns),
    },
  );

  worker.on("error", (err) => {
    logger.error({ err, component: "billing-run-worker" }, "Worker emitted error event");
  });

  return worker;
}

/**
 * Re-enqueue runs a dead replica left RUNNING.
 *
 * Safe to call repeatedly, and finding none is the steady state. The
 * status filter in `processBillingRun` is what makes it safe at all:
 * accounts already billed are not PENDING, so a reclaimed run picks up
 * where it stopped rather than starting over.
 *
 * `actorId` is taken from the run's own `createdBy`, so the audit trail
 * of a resumed run still names the person who started it rather than
 * the machine that finished it.
 */
export async function reclaimZombieBillingRuns(): Promise<number> {
  const stuck = await prisma.billingRun.findMany({
    where: { status: "RUNNING" },
    select: { id: true, utilityId: true, createdBy: true },
  });
  /*
   * And the posting equivalent. A pass that began and never reached the
   * end leaves `postingStartedAt` set with `postedAt` still null —
   * `postedAt` is stamped after the loop, so it cannot mark the middle.
   *
   * Resuming is safe for the same reason resuming generation is: the
   * loop re-reads each bill and `postBill` claims atomically, so a bill
   * posted by the dead pass comes back as `alreadyPosted` rather than
   * being charged twice.
   *
   * A pass that *finished* with failures is not a zombie — `postedAt`
   * is set, so it is excluded. That run is not stuck, it has work left,
   * and the Post button on the run page is what finishes it.
   */
  const stuckPosting = await prisma.billingRun.findMany({
    where: { postingStartedAt: { not: null }, postedAt: null },
    select: { id: true, utilityId: true, createdBy: true },
  });

  let requeued = 0;
  for (const run of stuck) {
    const jobId = await enqueueSafely(QUEUE_NAMES.billingRuns, BILLING_RUN_JOB_NAME, {
      runId: run.id,
      utilityId: run.utilityId,
      actorId: run.createdBy,
      actorName: "billing run (resumed)",
    });
    if (jobId) {
      requeued += 1;
      logger.warn(
        { component: "billing-run-worker", runId: run.id, jobId },
        "Re-enqueued a billing run left RUNNING by a previous process",
      );
    }
  }
  for (const run of stuckPosting) {
    const jobId = await enqueueSafely(QUEUE_NAMES.billingRuns, BILLING_RUN_POST_JOB_NAME, {
      runId: run.id,
      utilityId: run.utilityId,
      actorId: run.createdBy,
      actorName: "billing run posting (resumed)",
    });
    if (jobId) {
      requeued += 1;
      logger.warn(
        { component: "billing-run-worker", runId: run.id, jobId },
        "Re-enqueued a billing run whose posting was left in flight by a previous process",
      );
    }
  }
  return requeued;
}
