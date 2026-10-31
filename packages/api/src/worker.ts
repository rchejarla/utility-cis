import { config, resolveWorkerQueues } from "./config.js";
import { assertRlsEnforced } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { queueRedisConnection } from "./lib/queue-redis.js";
import { startHealthServer } from "./lib/health-server.js";
import {
  ALL_QUEUE_NAMES,
  closeAllQueues,
  QUEUE_NAMES,
  workerId,
  type QueueName,
} from "./lib/queues.js";
import { applyPerNodeLimits } from "./lib/queue-limits.js";
import { findOrphanedSchedulers, SCHEDULER_REGISTRY } from "./lib/schedulers.js";
import { startDlqMonitor, stopDlqMonitor } from "./workers/dlq-monitor.js";
import {
  buildSuspensionWorker,
  registerSuspensionScheduler,
} from "./workers/suspension-worker.js";
import {
  buildNotificationWorker,
  registerNotificationScheduler,
} from "./workers/notification-worker.js";
import {
  buildDelinquencyDispatcher,
  registerDelinquencyDispatchScheduler,
} from "./workers/delinquency-dispatcher.js";
import { buildDelinquencyWorker } from "./workers/delinquency-worker.js";
import {
  buildBillingDispatcher,
  registerBillingDispatchScheduler,
} from "./workers/billing-dispatcher.js";
import {
  buildSlaBreachWorker,
  registerSlaBreachScheduler,
} from "./workers/sla-breach-worker.js";
import {
  buildAuditRetentionWorker,
  registerAuditRetentionScheduler,
} from "./workers/audit-retention-worker.js";
import {
  buildBillingRunWorker,
  reclaimZombieBillingRuns,
} from "./workers/billing-run-worker.js";
import {
  buildImportWorker,
  reclaimAndEnqueueZombies,
} from "./workers/import-worker.js";
// Side-effect import: registers every import-kind handler at module
// load. The worker calls getKindHandler() inside processBatch, so the
// registry must be populated before any job runs — same reason app.ts
// imports it on the API side.
import "./imports/handlers/index.js";

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
  /**
   * The queue this worker is attached to — BullMQ's first constructor
   * argument, not the connection name in `opts.name`.
   */
  readonly name: string;
  /**
   * Max in-flight jobs on this process. Settable, which is how a stored
   * per-node limit reaches a worker that is already built.
   */
  concurrency: number;
  close(): Promise<void>;
}

const activeWorkers: WorkerLike[] = [];

/**
 * Report the crons this build does not know about.
 *
 * It used to delete them, which is wrong with more than one build in
 * flight — see `lib/schedulers.ts` for the whole account. The registry
 * itself moved there too, because a *route* needs it to refuse removing
 * a live cron, and nothing may import this file: it is the worker entry
 * point and running it starts a worker.
 */
async function reportOrphanedSchedulers(activeQueues: readonly QueueName[]): Promise<void> {
  const orphans = await findOrphanedSchedulers(activeQueues, SCHEDULER_REGISTRY);
  if (orphans.length > 0) {
    logger.warn(
      { component: "worker", orphans: orphans.map((o) => o.schedulerId) },
      "Armed schedulers this build does not know; they keep firing until removed",
    );
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

  /*
   * The same gate the API has, and it matters more here: six of the
   * eight queues sweep every tenant, so a worker on a database that is
   * not enforcing isolation is the one process whose every job is
   * cross-tenant by design and cannot tell the difference.
   */
  await assertRlsEnforced();

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

  /*
   * The id goes in the log because it is the name every other view of
   * this process uses: the platform registry's key, and the `:w:<id>`
   * suffix BullMQ puts on each of this worker's Redis connections. One
   * grep ties a log line to a row on the console.
   */
  logger.info(
    {
      component: "worker",
      workerId: workerId(),
      activeQueues,
      replicaSelective: requestedQueues !== null,
    },
    "Worker starting",
  );

  /*
   * The health server also carries the shutdown request, because a
   * signal cannot do this job on both platforms: Windows has no POSIX
   * signals, and Node emulates `process.kill(pid, "SIGTERM")` there as
   * an unconditional termination — so none of the draining below would
   * run and an in-flight job would lose its lock mid-run. Over HTTP it
   * is the same path on Windows and Linux. SIGTERM from `docker stop` or
   * a pod eviction still arrives at the handlers registered further
   * down; this adds a second door to the same room.
   */
  startHealthServer(config.WORKER_HTTP_PORT, {
    onShutdown: () => void shutdown("http"),
  });
  await reportOrphanedSchedulers(activeQueues);
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

  if (activeQueues.includes(QUEUE_NAMES.slaBreachSweep)) {
    activeWorkers.push(buildSlaBreachWorker());
    await registerSlaBreachScheduler();
  }

  if (activeQueues.includes(QUEUE_NAMES.auditRetention)) {
    activeWorkers.push(buildAuditRetentionWorker());
    await registerAuditRetentionScheduler();
  }

  if (activeQueues.includes(QUEUE_NAMES.imports)) {
    activeWorkers.push(buildImportWorker());
    await reclaimAndEnqueueZombies();
  }

  if (activeQueues.includes(QUEUE_NAMES.billingDispatch)) {
    activeWorkers.push(buildBillingDispatcher());
    await registerBillingDispatchScheduler();
  }

  if (activeQueues.includes(QUEUE_NAMES.billingRuns)) {
    activeWorkers.push(buildBillingRunWorker());
    // A replica that died holding a run leaves it looking busy forever;
    // the status filter makes picking it up again safe.
    const requeued = await reclaimZombieBillingRuns();
    if (requeued > 0) {
      logger.warn({ component: "worker", requeued }, "Re-enqueued interrupted billing runs");
    }
  }

  /*
   * Apply the stored per-node limits, now that every worker exists.
   *
   * After construction rather than inside `workerOptions`, which is
   * synchronous and would have to become async for every caller to read
   * one Redis hash. BullMQ's `concurrency` setter is a plain assignment
   * the fetch loop reads, so this is the same thing a constructor option
   * would have done.
   *
   * Boot is when a per-node change takes effect — the cluster limit is
   * the one honoured passively, since its gate lives in Redis. See
   * `docs/specs/27-job-scheduling.md` §6 SCH-CONC-4.
   */
  await applyPerNodeLimits(activeWorkers);

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info({ component: "worker" }, "Worker ready");
}

void main().catch((err) => {
  logger.error({ err, component: "worker" }, "Worker bootstrap failed");
  process.exit(1);
});
