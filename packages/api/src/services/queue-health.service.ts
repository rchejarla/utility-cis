import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import {
  ALL_QUEUE_NAMES,
  dlqNameFor,
  getDlqQueue,
  getQueue,
  type QueueName,
} from "../lib/queues.js";

/**
 * Reports what each queue is doing and what has recently failed.
 *
 * Bull Board already lists every job and is the right tool for the deep
 * verbs — read a payload, retry, promote. What it cannot answer is the
 * question an operator arrives with: *is anything broken right now, and
 * whose*. It has no notion of a tenant, and a dead-lettered job today
 * increments `dlqDepthGauge` and writes a log line, so nobody learns of
 * it unless they think to go looking.
 *
 * Reads only. Every verb that changes a job stays in Bull Board, where
 * it is one operator acting deliberately on one job rather than a button
 * on a dashboard.
 */

/** Three per queue: enough to see a pattern, short enough to scan. */
const FAILURES_PER_QUEUE = 3;

/**
 * How long the whole report may take before it is called unreachable.
 *
 * A timeout rather than a try/catch, because ioredis queues commands
 * while disconnected and retries indefinitely: a call against a down
 * Redis does not reject, it simply never answers. This endpoint is read
 * on page load, so hanging would hang the page.
 */
const DEFAULT_TIMEOUT_MS = 3_000;

export interface QueueFailure {
  jobId: string | null;
  jobName: string;
  /** When it last failed, ISO, or null if BullMQ recorded neither. */
  failedAt: string | null;
  reason: string | null;
  /** Null for the sweeps, which belong to no single tenant. */
  utilityId: string | null;
  utilityName: string | null;
}

export interface QueueHealth {
  name: string;
  counts: { waiting: number; active: number; delayed: number; failed: number };
  /** Jobs parked in `dlq-<name>` awaiting manual replay. */
  dlqDepth: number;
  recentFailures: QueueFailure[];
}

export interface QueueHealthReport {
  /** False when Redis did not answer in time — not an empty deployment. */
  reachable: boolean;
  checkedAt: string;
  queues: QueueHealth[];
  totals: { waiting: number; active: number; failed: number; dlq: number };
}

type RawJob = {
  id?: string | null;
  name?: string;
  failedReason?: string | null;
  finishedOn?: number | null;
  timestamp?: number | null;
  data?: unknown;
};

/** The tenant a job acts for, where its payload names one. */
function utilityIdOf(data: unknown): string | null {
  if (data && typeof data === "object" && "utilityId" in data) {
    const value = (data as { utilityId?: unknown }).utilityId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function failedAtOf(job: RawJob): number | null {
  return job.finishedOn ?? job.timestamp ?? null;
}

/**
 * A DLQ is written to and never worked, so its jobs sit in `waiting`.
 * The other states are summed anyway rather than assumed empty: a
 * replayed job that failed again would otherwise go uncounted, and
 * "depth" should mean everything still parked there.
 */
function depthOf(counts: Record<string, number>): number {
  return (
    (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) + (counts.failed ?? 0)
  );
}

async function readQueue(name: QueueName): Promise<QueueHealth> {
  const queue = getQueue(name);
  const dlq = getDlqQueue(name);

  const [counts, dlqCounts, failedJobs] = await Promise.all([
    queue.getJobCounts(),
    dlq.getJobCounts(),
    /*
     * A window rather than the first three. BullMQ reads the failed set
     * with a range query whose direction is its own business, so the
     * newest failures are sorted out here instead of trusted to arrive
     * first.
     */
    queue.getFailed(0, 19) as Promise<RawJob[]>,
  ]);

  const ordered = [...failedJobs]
    .sort((a, b) => (failedAtOf(b) ?? 0) - (failedAtOf(a) ?? 0))
    .slice(0, FAILURES_PER_QUEUE);

  return {
    name,
    counts: {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    },
    dlqDepth: depthOf(dlqCounts as Record<string, number>),
    recentFailures: ordered.map((job) => ({
      jobId: job.id ?? null,
      jobName: job.name ?? dlqNameFor(name),
      failedAt: failedAtOf(job) ? new Date(failedAtOf(job) as number).toISOString() : null,
      reason: job.failedReason ?? null,
      utilityId: utilityIdOf(job.data),
      utilityName: null,
    })),
  };
}

/** One query for every tenant named by a failure, not one per failure. */
async function nameTenants(queues: QueueHealth[]): Promise<void> {
  const ids = [
    ...new Set(
      queues.flatMap((q) =>
        q.recentFailures.map((f) => f.utilityId).filter((id): id is string => Boolean(id)),
      ),
    ),
  ];
  if (ids.length === 0) return;

  const utilities = await prisma.utility.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const names = new Map(utilities.map((u) => [u.id, u.name]));

  for (const queue of queues) {
    for (const failure of queue.recentFailures) {
      // A tenant that no longer exists keeps its id and no name, rather
      // than being dropped: the job is still parked and still a fact.
      if (failure.utilityId) failure.utilityName = names.get(failure.utilityId) ?? null;
    }
  }
}

export async function getQueueHealth(
  opts: { timeoutMs?: number } = {},
): Promise<QueueHealthReport> {
  const checkedAt = new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const unreachable: QueueHealthReport = {
    reachable: false,
    checkedAt,
    queues: [],
    totals: { waiting: 0, active: 0, failed: 0, dlq: 0 },
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    const queues = await Promise.race([
      (async () => {
        const read = await Promise.all(ALL_QUEUE_NAMES.map((name) => readQueue(name)));
        await nameTenants(read);
        return read;
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);

    if (queues === null) {
      logger.warn({ timeoutMs }, "queue health check timed out");
      return unreachable;
    }

    return {
      reachable: true,
      checkedAt,
      queues,
      totals: {
        waiting: queues.reduce((n, q) => n + q.counts.waiting, 0),
        active: queues.reduce((n, q) => n + q.counts.active, 0),
        failed: queues.reduce((n, q) => n + q.counts.failed, 0),
        dlq: queues.reduce((n, q) => n + q.dlqDepth, 0),
      },
    };
  } catch (err) {
    logger.warn({ err }, "queue health check failed");
    return unreachable;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
