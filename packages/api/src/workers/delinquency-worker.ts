import { Worker, type Job } from "bullmq";
import { queueRedisConnection } from "../lib/queue-redis.js";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import { QUEUE_NAMES, QUEUE_DEFAULTS } from "../lib/queues.js";
import { evaluateDelinquencyForTenant } from "../services/delinquency.service.js";

/**
 * Per-tenant consumer for the delinquency-tenant queue.
 *
 * Concurrency 5 (per spec §3.3): five tenants in parallel per worker
 * replica. Each evaluation does multiple DB queries; with the default
 * Prisma connection pool this stays comfortably below saturation.
 *
 * The handler updates tenant_config.delinquencyLastRunAt on success
 * (inside evaluateDelinquencyForTenant) so the dispatcher's
 * missed-tick recovery sees this tenant as "ran today."
 */

interface DelinquencyTenantJobData {
  utilityId: string;
  reason?: string;
}

export function buildDelinquencyWorker(): Worker<DelinquencyTenantJobData> {
  const worker = new Worker<DelinquencyTenantJobData>(
    QUEUE_NAMES.delinquencyTenant,
    async (job: Job<DelinquencyTenantJobData>) => {
      const { utilityId, reason } = job.data;
      const result = await withTelemetry(
        QUEUE_NAMES.delinquencyTenant,
        () => evaluateDelinquencyForTenant(utilityId, new Date()),
      );
      if (result.actionsCreated > 0) {
        logger.info(
          {
            component: "delinquency-worker",
            utilityId,
            reason: reason ?? "unknown",
            ...result,
          },
          "Delinquency evaluation produced actions",
        );
      }
      return result;
    },
    {
      connection: queueRedisConnection.duplicate(),
      concurrency: QUEUE_DEFAULTS[QUEUE_NAMES.delinquencyTenant].concurrency,
    },
  );

  worker.on("error", (err) => {
    logger.error(
      { err, component: "delinquency-worker" },
      "Worker emitted error event",
    );
  });

  return worker;
}
