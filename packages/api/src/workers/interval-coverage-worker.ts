import { Worker } from "bullmq";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import { QUEUE_NAMES, getQueue, workerOptions } from "../lib/queues.js";
import { scopedJob } from "../lib/queue-scope.js";
import { sweepIntervalCoverage } from "../services/interval-coverage-sweep.service.js";

/**
 * BullMQ worker for the interval-coverage-sweep queue.
 *
 * Fires **hourly** although the sweep is daily, because the run hour is
 * per tenant and local: the only way a tenant in Auckland and one in
 * Denver both get swept at 04:00 their own time is to look every hour
 * and act for whoever's hour has come round. The gate is inside
 * `sweepIntervalCoverage`, the same arrangement the delinquency
 * dispatcher uses.
 *
 * All-tenants, read-only, concurrency 1 — nothing here writes, so
 * overlapping ticks would only duplicate reads and log lines.
 *
 * Twenty-five past the hour rather than on it, so it does not contend
 * with the other hourly dispatchers for the same connections.
 */

export const INTERVAL_COVERAGE_SCHEDULER_ID = "interval-coverage-cron";
export const INTERVAL_COVERAGE_JOB_NAME = "sweep-interval-coverage";
const PATTERN = "25 * * * *";

export function buildIntervalCoverageWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.intervalCoverage,
    scopedJob(QUEUE_NAMES.intervalCoverage, async () => {
      const result = await withTelemetry(QUEUE_NAMES.intervalCoverage, () =>
        sweepIntervalCoverage(new Date()),
      );
      if (result.findings.length > 0) {
        /*
         * One summary beside the per-finding warnings the service
         * writes, because the count is the thing worth alerting on and
         * a hundred lines is not.
         */
        logger.warn(
          {
            component: "interval-coverage-worker",
            tenantsSwept: result.tenantsSwept,
            metersChecked: result.metersChecked,
            meterDaysAffected: result.findings.length,
            minutesAffected: result.findings.reduce((a, f) => a + f.minutesAffected, 0),
          },
          "Interval coverage sweep found days with missing data",
        );
      }
      // Returned, not only logged: the platform console's jobs page
      // shows a job's result, which is where an operator looks after
      // the fact.
      return result;
    }),
    { ...workerOptions(QUEUE_NAMES.intervalCoverage) },
  );

  worker.on("error", (err) => {
    logger.error({ err, component: "interval-coverage-worker" }, "Worker emitted error event");
  });

  return worker;
}

export async function registerIntervalCoverageScheduler(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.intervalCoverage);
  await queue.upsertJobScheduler(
    INTERVAL_COVERAGE_SCHEDULER_ID,
    { pattern: PATTERN, tz: "UTC" },
    { name: INTERVAL_COVERAGE_JOB_NAME },
  );
  logger.info(
    {
      component: "interval-coverage-worker",
      schedulerId: INTERVAL_COVERAGE_SCHEDULER_ID,
      pattern: PATTERN,
    },
    "Interval coverage cron registered",
  );
}
