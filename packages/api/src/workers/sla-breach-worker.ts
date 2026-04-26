import { Worker } from "bullmq";
import { queueRedisConnection } from "../lib/queue-redis.js";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import { QUEUE_NAMES, QUEUE_DEFAULTS, getQueue } from "../lib/queues.js";
import { sweepBreachedSRs } from "../services/service-request.service.js";

/**
 * BullMQ worker for the sla-breach-sweep queue.
 *
 * Cron: every 5 minutes. Single-tick semantics, concurrency 1 — the
 * sweep is one cross-tenant SQL statement; overlapping ticks would
 * race (idempotently) and waste DB connections.
 *
 * Tenant gating happens inside the SQL JOIN with tenant_config; this
 * worker is dumb glue.
 */

export const SLA_BREACH_SCHEDULER_ID = "sla-breach-cron";
export const SLA_BREACH_JOB_NAME = "sweep-for-sla-breaches";

export function buildSlaBreachWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.slaBreachSweep,
    async () => {
      const result = await withTelemetry(
        QUEUE_NAMES.slaBreachSweep,
        () => sweepBreachedSRs(new Date()),
      );
      if (result.flipped > 0) {
        logger.info(
          { component: "sla-breach-worker", flipped: result.flipped },
          "SLA breach sweep flagged service requests",
        );
      }
      return result;
    },
    {
      connection: queueRedisConnection.duplicate(),
      concurrency: QUEUE_DEFAULTS[QUEUE_NAMES.slaBreachSweep].concurrency,
    },
  );

  worker.on("error", (err) => {
    logger.error(
      { err, component: "sla-breach-worker" },
      "Worker emitted error event",
    );
  });

  return worker;
}

export async function registerSlaBreachScheduler(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.slaBreachSweep);
  await queue.upsertJobScheduler(
    SLA_BREACH_SCHEDULER_ID,
    { pattern: "*/5 * * * *", tz: "UTC" },
    { name: SLA_BREACH_JOB_NAME },
  );
  logger.info(
    {
      component: "sla-breach-worker",
      schedulerId: SLA_BREACH_SCHEDULER_ID,
      pattern: "*/5 * * * *",
    },
    "SLA breach cron registered",
  );
}
