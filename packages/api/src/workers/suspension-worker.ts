import { Worker } from "bullmq";
import { queueRedisConnection } from "../lib/queue-redis.js";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import { QUEUE_NAMES, QUEUE_DEFAULTS } from "../lib/queues.js";
import { getQueue } from "../lib/queues.js";
import { sweepSuspensionsAllTenants } from "../services/service-suspension.service.js";

/**
 * BullMQ worker for the suspension-transitions queue.
 *
 * Single-tick semantics: every fire of the cron enqueues exactly one
 * `transition-suspensions` job (BullMQ's repeatable-job mechanism
 * guarantees this across N replicas). One worker claims it, calls
 * `sweepSuspensionsAllTenants` which is a single-query cross-tenant
 * sweep wrapped in a transaction. Concurrency is 1 because overlapping
 * sweeps would race on the same rows — handled by the queue config.
 *
 * Empty-tick logging policy: only emit a log line when at least one
 * row flipped. Keeps the log scannable for actual events instead of
 * 24 heartbeats a day.
 */

export const SUSPENSION_SCHEDULER_ID = "suspension-cron";
export const SUSPENSION_JOB_NAME = "transition-suspensions";

export function buildSuspensionWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.suspensionTransitions,
    async () => {
      const result = await withTelemetry(
        QUEUE_NAMES.suspensionTransitions,
        () => sweepSuspensionsAllTenants(new Date()),
      );
      if (result.activated > 0 || result.completed > 0) {
        logger.info(
          {
            component: "suspension-worker",
            activated: result.activated,
            completed: result.completed,
          },
          "Suspension sweep transitioned holds",
        );
      }
      return result;
    },
    {
      connection: queueRedisConnection.duplicate(),
      concurrency: QUEUE_DEFAULTS[QUEUE_NAMES.suspensionTransitions].concurrency,
    },
  );

  worker.on("error", (err) => {
    logger.error(
      { err, component: "suspension-worker" },
      "Worker emitted error event",
    );
  });

  return worker;
}

/**
 * Idempotent registration of the hourly cron. Pinned to UTC; tenant-
 * local timing for suspension transitions doesn't matter because the
 * sweep filters by `start_date <= now()` / `end_date <= now()` in DB
 * time. UTC keeps the schedule predictable across deploys.
 */
export async function registerSuspensionScheduler(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.suspensionTransitions);
  await queue.upsertJobScheduler(
    SUSPENSION_SCHEDULER_ID,
    { pattern: "0 * * * *", tz: "UTC" },
    { name: SUSPENSION_JOB_NAME },
  );
  logger.info(
    {
      component: "suspension-worker",
      schedulerId: SUSPENSION_SCHEDULER_ID,
      pattern: "0 * * * *",
    },
    "Suspension cron scheduler registered",
  );
}
