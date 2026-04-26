import { config, resolveWorkerQueues } from "./config.js";
import { logger } from "./lib/logger.js";
import { queueRedisConnection } from "./lib/queue-redis.js";
import { startHealthServer } from "./lib/health-server.js";
import { ALL_QUEUE_NAMES, closeAllQueues, getQueue, QUEUE_NAMES, type QueueName } from "./lib/queues.js";
import { startDlqMonitor, stopDlqMonitor } from "./workers/dlq-monitor.js";
import {
  buildSuspensionWorker,
  registerSuspensionScheduler,
  SUSPENSION_SCHEDULER_ID,
} from "./workers/suspension-worker.js";
import {
  buildNotificationWorker,
  registerNotificationScheduler,
  NOTIFICATION_SCHEDULER_ID,
} from "./workers/notification-worker.js";
import {
  buildDelinquencyDispatcher,
  registerDelinquencyDispatchScheduler,
  DELINQUENCY_DISPATCH_SCHEDULER_ID,
} from "./workers/delinquency-dispatcher.js";
import { buildDelinquencyWorker } from "./workers/delinquency-worker.js";

/**
 * Worker process entry point.
 *
 * Layout (built up across Tasks 1-9):
 *   1. Load + validate config (already happened on import).
 *   2. Resolve which queues this replica should serve from
 *      `WORKER_QUEUES` ("all" → every queue, otherwise comma-list).
 *   3. Open the BullMQ Redis connection.
 *   4. Start the health server on `WORKER_HTTP_PORT`.
 *   5. Reconcile schedulers — delete Redis-resident orphans whose IDs
 *      no longer appear in `SCHEDULER_REGISTRY` (filled in by Tasks 2-8).
 *   6. Subscribe DLQ monitors for every active queue.
 *   7. Register `Worker` instances + `upsertJobScheduler` cron entries
 *      (Tasks 2-8 add these one at a time).
 *   8. Optional: mount Bull Board if `BULL_BOARD_ENABLED=true`.
 *   9. Wire SIGTERM / SIGINT handlers — drain workers, close queues,
 *      quit Redis, exit cleanly.
 *
 * `DISABLE_SCHEDULERS=true` short-circuits the whole bootstrap so
 * test suites that import this file (e.g., to verify the registry
 * shape) don't accidentally start consuming jobs.
 */

interface WorkerLike {
  close(): Promise<void>;
}

const activeWorkers: WorkerLike[] = [];

/**
 * Centralized scheduler registry. Each cron a worker registers MUST
 * appear here; `reconcileSchedulers` deletes anything in Redis whose
 * id isn't in this set so removed crons don't keep firing.
 *
 * Tasks 2-8 add entries: suspension-cron, notification-send-cron,
 * sla-breach-cron, delinquency-dispatch-cron, audit-retention-cron.
 */
export const SCHEDULER_REGISTRY: ReadonlySet<string> = new Set<string>([
  SUSPENSION_SCHEDULER_ID,
  NOTIFICATION_SCHEDULER_ID,
  DELINQUENCY_DISPATCH_SCHEDULER_ID,
  // future: sla-breach-cron, audit-retention-cron
]);

async function reconcileSchedulers(activeQueues: readonly QueueName[]): Promise<void> {
  for (const name of activeQueues) {
    const queue = getQueue(name);
    let schedulers: Awaited<ReturnType<typeof queue.getJobSchedulers>>;
    try {
      schedulers = await queue.getJobSchedulers();
    } catch (err) {
      logger.warn(
        { err, component: "scheduler-reconcile", queue: name },
        "Could not list schedulers — skipping reconcile for this queue",
      );
      continue;
    }
    for (const sched of schedulers) {
      if (!sched.key) continue;
      if (SCHEDULER_REGISTRY.has(sched.key)) continue;
      try {
        await queue.removeJobScheduler(sched.key);
        logger.info(
          { component: "scheduler-reconcile", queue: name, schedulerId: sched.key },
          "Removed orphaned scheduler",
        );
      } catch (err) {
        logger.warn(
          { err, component: "scheduler-reconcile", queue: name, schedulerId: sched.key },
          "Failed to remove orphaned scheduler",
        );
      }
    }
  }
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ component: "worker", signal }, "Shutdown initiated");

  // 60s drain timeout per worker — long enough for in-flight jobs to
  // finish, short enough that a stuck handler doesn't hold a deploy.
  const DRAIN_TIMEOUT_MS = 60_000;
  const closeWithTimeout = async (w: WorkerLike): Promise<void> => {
    await Promise.race([
      w.close(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("worker close timeout")), DRAIN_TIMEOUT_MS),
      ),
    ]).catch((err) => {
      logger.warn({ err, component: "worker" }, "Worker close timed out or errored");
    });
  };

  await Promise.all(activeWorkers.map(closeWithTimeout));
  await stopDlqMonitor();
  await closeAllQueues();
  await queueRedisConnection.quit().catch(() => {});

  logger.info({ component: "worker" }, "Shutdown complete");
  process.exit(0);
}

async function main(): Promise<void> {
  if (config.DISABLE_SCHEDULERS) {
    logger.info(
      { component: "worker", workerQueues: config.WORKER_QUEUES },
      "DISABLE_SCHEDULERS=true — skipping queue registration and exiting",
    );
    process.exit(0);
  }

  const requestedQueues = resolveWorkerQueues();
  const activeQueues: readonly QueueName[] =
    requestedQueues === null
      ? ALL_QUEUE_NAMES
      : ALL_QUEUE_NAMES.filter((q) => requestedQueues.includes(q));

  if (activeQueues.length === 0) {
    logger.error(
      { component: "worker", requested: requestedQueues, knownQueues: ALL_QUEUE_NAMES },
      "WORKER_QUEUES resolved to an empty set — nothing to do",
    );
    process.exit(1);
  }

  logger.info(
    { component: "worker", activeQueues, replicaSelective: requestedQueues !== null },
    "Worker starting",
  );

  startHealthServer(config.WORKER_HTTP_PORT);
  await reconcileSchedulers(activeQueues);
  await startDlqMonitor(activeQueues);

  if (activeQueues.includes(QUEUE_NAMES.suspensionTransitions)) {
    activeWorkers.push(buildSuspensionWorker());
    await registerSuspensionScheduler();
  }

  if (activeQueues.includes(QUEUE_NAMES.notificationSend)) {
    activeWorkers.push(buildNotificationWorker());
    await registerNotificationScheduler();
  }

  if (activeQueues.includes(QUEUE_NAMES.delinquencyDispatch)) {
    activeWorkers.push(buildDelinquencyDispatcher());
    await registerDelinquencyDispatchScheduler();
  }
  if (activeQueues.includes(QUEUE_NAMES.delinquencyTenant)) {
    activeWorkers.push(buildDelinquencyWorker());
  }

  // Tasks 8-9 register additional workers here:
  //   sla-breach-sweep, audit-retention.

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info({ component: "worker" }, "Worker ready");
}

void main().catch((err) => {
  logger.error({ err, component: "worker" }, "Worker bootstrap failed");
  process.exit(1);
});
