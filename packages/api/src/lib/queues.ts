import { randomUUID } from "node:crypto";
import { Queue, type JobsOptions } from "bullmq";
import { queueRedisConnection } from "./queue-redis.js";
import { logger } from "./logger.js";

/**
 * Queue registry — the canonical list of every BullMQ queue the
 * system uses. Adding a new queue means adding an entry here AND a
 * worker handler in `src/workers/`.
 *
 * Job-name conventions: each queue has one canonical job name. The
 * name is queue-scoped metadata that shows up in Bull Board and logs.
 *
 * Per-queue defaults bake in retry, backoff, and Redis-side retention
 * (`removeOnComplete` / `removeOnFail`) so individual call sites can
 * stay terse.
 */

export const QUEUE_NAMES = {
  suspensionTransitions: "suspension-transitions",
  notificationSend: "notification-send",
  slaBreachSweep: "sla-breach-sweep",
  delinquencyDispatch: "delinquency-dispatch",
  billingDispatch: "billing-dispatch",
  delinquencyTenant: "delinquency-tenant",
  auditRetention: "audit-retention",
  imports: "imports",
  billingRuns: "billing-runs",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUE_NAMES);

/**
 * Whether each queue's jobs name one tenant, or sweep across all of them.
 *
 * Read off the handlers rather than assumed. The five `all-tenants`
 * queues are enqueued by nothing but `worker.ts` — grep for their
 * `QUEUE_NAMES` constants — and each fire runs a single cross-tenant
 * sweep: `sweepSuspensionsAllTenants`, `sweepExpiredSchedulerAudits` and
 * their siblings. `delinquency-dispatch` is the same shape: it reads
 * every tenant's config and fans out onto `delinquency-tenant`. The
 * other three are enqueued per tenant, from a request or from the
 * dispatcher, and their payloads carry `utilityId`.
 *
 * Worth writing down because the two cases looked identical in the
 * platform job list — a blank tenant. On a sweep that is correct; on
 * `billing-runs` it is a job that cannot run.
 */
export const QUEUE_TENANCY: Record<QueueName, "all-tenants" | "per-tenant"> = {
  "suspension-transitions": "all-tenants",
  "notification-send": "all-tenants",
  "sla-breach-sweep": "all-tenants",
  "delinquency-dispatch": "all-tenants",
  "billing-dispatch": "all-tenants",
  "delinquency-tenant": "per-tenant",
  "audit-retention": "all-tenants",
  imports: "per-tenant",
  "billing-runs": "per-tenant",
};

const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 604_800;

/**
 * Per-Worker lock duration. BullMQ default is 30s; we bump to 60s to
 * tolerate one missed lock-renewal round-trip (Redis pause, GC stall,
 * Docker Desktop hiccup) without releasing the job to a competing
 * worker. The renewal timer fires at lockDuration/2 = 30s, so a
 * single missed renewal still leaves 30s of headroom before the lock
 * actually expires.
 *
 * Handlers MUST still be idempotent — this just reduces the rate of
 * spurious "Missing lock for job" errors during normal Redis flakes.
 */
export const WORKER_LOCK_DURATION_MS = 60_000;

const RETENTION_OPTS: Pick<JobsOptions, "removeOnComplete" | "removeOnFail"> = {
  removeOnComplete: { age: DAY_SECONDS, count: 1000 },
  removeOnFail: { age: WEEK_SECONDS },
};

export interface QueueDefaults {
  /** Max in-flight jobs per Worker instance. */
  concurrency: number;
  /** Per-queue defaults applied at enqueue time. */
  defaultJobOptions: JobsOptions;
}

export const QUEUE_DEFAULTS: Record<QueueName, QueueDefaults> = {
  "suspension-transitions": {
    concurrency: 1,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      ...RETENTION_OPTS,
    },
  },
  "notification-send": {
    concurrency: 1,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      ...RETENTION_OPTS,
    },
  },
  "sla-breach-sweep": {
    concurrency: 1,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      ...RETENTION_OPTS,
    },
  },
  "delinquency-dispatch": {
    concurrency: 1,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "fixed", delay: 60_000 },
      ...RETENTION_OPTS,
    },
  },
  "billing-dispatch": {
    // One cross-tenant read and a run per due cycle. Nothing to
    // parallelise, and two dispatchers at once would race for the same
    // `@@unique([utilityId, billingCycleId, windowEnd])` — which is
    // safe, and noisy for no gain.
    concurrency: 1,
    defaultJobOptions: {
      // Two attempts, like the delinquency dispatcher: creating a run
      // is idempotent on that unique constraint, so a retry after a
      // transient database error cannot produce a second set of bills.
      attempts: 2,
      backoff: { type: "fixed", delay: 60_000 },
      ...RETENTION_OPTS,
    },
  },
  "delinquency-tenant": {
    concurrency: 5,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      ...RETENTION_OPTS,
    },
  },
  "audit-retention": {
    concurrency: 1,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "fixed", delay: 300_000 },
      ...RETENTION_OPTS,
    },
  },
  "billing-runs": {
    // One run at a time per replica. A run is already a loop over
    // thousands of accounts hammering the rate engine and the database;
    // two in parallel would halve neither's wall clock and would make a
    // slow run look like a broken one.
    concurrency: 1,
    // attempts=1, as with imports and for the same reason: an auto-retry
    // would restart a run whose early accounts are already BILLED. The
    // resume path is deliberate — re-enqueue and the status filter skips
    // what is done.
    defaultJobOptions: {
      attempts: 1,
      ...RETENTION_OPTS,
    },
  },
  imports: {
    concurrency: 4,
    // attempts=1: failed batches stay FAILED until the user explicitly
    // hits Retry. Auto-retry from row 1 would double-import already-
    // processed rows; user-driven retry uses scope="errors-only".
    defaultJobOptions: {
      attempts: 1,
      ...RETENTION_OPTS,
    },
  },
};

/**
 * This worker process's own id.
 *
 * Handed to every `Worker` as its `name`, which makes BullMQ name that
 * connection `bull:<queue>:w:<id>` — and that is how a worker's liveness
 * becomes readable from another host, where `process.kill(pid, 0)` means
 * nothing at all. See `lib/connected-clients.ts`.
 *
 * `WORKER_ID` from the environment when something started this process
 * deliberately (the platform console does), and a fresh uuid otherwise,
 * so a worker launched by hand is still identifiable. Read from the
 * environment rather than from `config`, because `config` parses at
 * import and the id may be set after that.
 */
let cachedWorkerId: string | undefined;

export function workerId(): string {
  cachedWorkerId ??= process.env.WORKER_ID || randomUUID();
  return cachedWorkerId;
}

/**
 * The options every `Worker` in this codebase takes, in one place.
 *
 * All four were repeated in all eight worker files, which is how the
 * identity above would otherwise have been eight separate edits — and
 * eight chances to miss one, where a missed one is a worker that cannot
 * be seen from another node.
 */
export function workerOptions(name: QueueName): {
  connection: ReturnType<typeof queueRedisConnection.duplicate>;
  concurrency: number;
  lockDuration: number;
  name: string;
} {
  return {
    connection: queueRedisConnection.duplicate(),
    concurrency: QUEUE_DEFAULTS[name].concurrency,
    lockDuration: WORKER_LOCK_DURATION_MS,
    name: workerId(),
  };
}

const queueCache = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queueCache.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: queueRedisConnection,
      defaultJobOptions: QUEUE_DEFAULTS[name].defaultJobOptions,
    });
    queueCache.set(name, q);
  }
  return q;
}

/**
 * Naming convention: every queue has a paired `dlq-<name>` queue for
 * exhausted jobs. The DLQ uses no retries — jobs there are awaiting
 * manual replay.
 */
export function dlqNameFor(name: QueueName): string {
  return `dlq-${name}`;
}

const dlqQueueCache = new Map<QueueName, Queue>();

export function getDlqQueue(sourceName: QueueName): Queue {
  let q = dlqQueueCache.get(sourceName);
  if (!q) {
    q = new Queue(dlqNameFor(sourceName), {
      connection: queueRedisConnection,
      defaultJobOptions: {
        attempts: 1,
        ...RETENTION_OPTS,
      },
    });
    dlqQueueCache.set(sourceName, q);
  }
  return q;
}

/**
 * Wrap `Queue.add` so a Redis-down enqueue from the API request path
 * doesn't propagate as a 500 to the user. Scheduled work is
 * eventually-consistent; an enqueue failure is no worse than a job
 * running late. Logs the failure at error level and returns null.
 */
export async function enqueueSafely(
  queueName: QueueName,
  jobName: string,
  data: Record<string, unknown>,
  opts?: JobsOptions,
): Promise<string | null> {
  try {
    const job = await getQueue(queueName).add(jobName, data, opts);
    return job.id ?? null;
  } catch (err) {
    logger.error(
      { err, component: "enqueue", queue: queueName, jobName },
      "Failed to enqueue job — Redis unreachable?",
    );
    return null;
  }
}

/**
 * Close every cached queue (and DLQ queue) connection. Called from
 * the worker process's SIGTERM handler.
 */
export async function closeAllQueues(): Promise<void> {
  const queues = [...queueCache.values(), ...dlqQueueCache.values()];
  await Promise.all(queues.map((q) => q.close().catch(() => {})));
  queueCache.clear();
  dlqQueueCache.clear();
}
