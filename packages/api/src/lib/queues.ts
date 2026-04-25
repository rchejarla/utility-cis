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
  delinquencyTenant: "delinquency-tenant",
  auditRetention: "audit-retention",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUE_NAMES);

const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 604_800;

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
};

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
