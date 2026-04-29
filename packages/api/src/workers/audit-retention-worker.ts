import { Worker } from "bullmq";
import { queueRedisConnection } from "../lib/queue-redis.js";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import { QUEUE_NAMES, QUEUE_DEFAULTS, WORKER_LOCK_DURATION_MS, getQueue } from "../lib/queues.js";
import { sweepExpiredSchedulerAudits } from "../services/audit-retention.service.js";

/**
 * BullMQ worker for audit-retention.
 *
 * Cron: daily at 04:00 UTC (off-peak). The sweep is bounded to 10
 * minutes per run and idempotent — a partial run resumes the next
 * day from where it stopped.
 *
 * Concurrency 1 — overlap would race on the DELETE batches, wasting
 * round trips. The sweep is one-tenant-table-wide so there's no
 * value to running parallel batches.
 *
 * No tenant gate: every tenant's scheduler-emitted audits are
 * subject to retention. The per-tenant `scheduler_audit_retention_days`
 * column drives the cutoff inside the SQL itself.
 */

export const AUDIT_RETENTION_SCHEDULER_ID = "audit-retention-cron";
export const AUDIT_RETENTION_JOB_NAME = "sweep-expired-audits";

export function buildAuditRetentionWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.auditRetention,
    async () => {
      const result = await withTelemetry(
        QUEUE_NAMES.auditRetention,
        () => sweepExpiredSchedulerAudits(new Date()),
      );
      // The service already logs at info on a non-empty sweep, so we
      // only need to surface a worker-level log line on timeout (the
      // operator-actionable signal).
      if (result.timedOut) {
        logger.warn(
          {
            component: "audit-retention-worker",
            deleted: result.deleted,
            batches: result.batches,
          },
          "Audit retention sweep hit 10-minute time budget; remaining rows deferred to next run",
        );
      }
      return result;
    },
    {
      connection: queueRedisConnection.duplicate(),
      concurrency: QUEUE_DEFAULTS[QUEUE_NAMES.auditRetention].concurrency,
      lockDuration: WORKER_LOCK_DURATION_MS,
    },
  );

  worker.on("error", (err) => {
    logger.error(
      { err, component: "audit-retention-worker" },
      "Worker emitted error event",
    );
  });

  return worker;
}

export async function registerAuditRetentionScheduler(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.auditRetention);
  await queue.upsertJobScheduler(
    AUDIT_RETENTION_SCHEDULER_ID,
    { pattern: "0 4 * * *", tz: "UTC" },
    { name: AUDIT_RETENTION_JOB_NAME },
  );
  logger.info(
    {
      component: "audit-retention-worker",
      schedulerId: AUDIT_RETENTION_SCHEDULER_ID,
      pattern: "0 4 * * *",
    },
    "Audit retention cron registered",
  );
}
