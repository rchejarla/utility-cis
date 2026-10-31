import { logger } from "../lib/logger.js";
import {
  ALL_QUEUE_NAMES,
  dlqNameFor,
  getDlqQueue,
  getQueue,
  type QueueName,
} from "../lib/queues.js";
import { utilityIdOf, utilityNames, withQueueTimeout } from "../lib/queue-inspect.js";
import { effectiveLimit, readQueueLimits } from "../lib/queue-limits.js";
import { readPauseRecord, type PauseRecord } from "../lib/queue-pause.js";

/**
 * Reports what is in each queue, who is attached to work it, and what
 * has recently failed.
 *
 * Bull Board already lists every job and is the right tool for the deep
 * verbs — read a payload, retry, promote. What it cannot answer is the
 * question an operator arrives with: *is anything broken right now, and
 * whose*. It has no notion of a tenant, and a dead-lettered job today
 * increments `dlqDepthGauge` and writes a log line, so nobody learns of
 * it unless they think to go looking.
 *
 * **Worker attachment is read with the counts, not beside them.** The
 * counts alone cannot answer "why is nothing moving": workers are a
 * separate process from the API (`src/worker.ts`, started by
 * `pnpm dev:worker` — `start_dev.bat` deliberately does not), so an
 * unattended queue fills up and sits, and its counts look identical to a
 * healthy queue's. Same page, same question, so the same call.
 */

/** Three per queue: enough to see a pattern, short enough to scan. */
const FAILURES_PER_QUEUE = 3;

/** See `withQueueTimeout` for why this is a deadline and not a catch. */
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
  /**
   * `completed` is retained by `removeOnComplete` — 24h, 1000 max — and
   * is the only evidence a quiet cron queue is working: its handler logs
   * nothing on an empty tick, deliberately, at up to 8,640 ticks a day.
   */
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
  };
  /** Jobs parked in `dlq-<name>` awaiting manual replay. */
  dlqDepth: number;
  /**
   * Worker processes attached to this queue, or null where Redis would
   * not say. Zero means nothing in it will run.
   */
  workers: number | null;
  /**
   * How long the longest-attached worker's connection has been open, in
   * seconds — null when none is attached. A value that keeps resetting
   * across reloads is a worker restarting, or a Redis that keeps
   * dropping it; a single long-lived number is a worker that has been up.
   */
  workerAgeSeconds: number | null;
  /** A paused queue processes nothing, however many workers are attached. */
  paused: boolean;
  /**
   * Who paused it, when and why — null when it is running.
   *
   * Withheld rather than printed for a running queue: resuming straight
   * in Redis leaves the record behind, and showing it beside a working
   * queue would report a stop that has ended.
   */
  pauseRecord: PauseRecord | null;
  /** Max in-flight jobs on one worker process. */
  perNodeLimit: number;
  /** The cluster-wide ceiling, or null when none is set. */
  clusterLimit: number | null;
  /**
   * What will actually run: the smaller of the cluster limit and
   * `workers × perNodeLimit`. Null when the worker count is unknown.
   *
   * Reported with the two settings because neither one answers the
   * question on its own: a cluster limit of 4 against three nodes that
   * each take one job runs 3, so a page showing only the 4 would be
   * showing a number that does nothing.
   */
  effectiveLimit: number | null;
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

/** One row of Redis's `CLIENT LIST`, as BullMQ hands it over. */
type RawWorker = { addr?: string; age?: string };

export type Attachment = Pick<QueueHealth, "workers" | "workerAgeSeconds" | "paused">;

const UNKNOWN_ATTACHMENT: Attachment = {
  workers: null,
  workerAgeSeconds: null,
  paused: false,
};

/**
 * Who is attached to this queue, and whether it is accepting work.
 *
 * `getWorkers()` rather than a hand-rolled `CLIENT LIST` scan, because
 * the name to match on is not the queue's: BullMQ sets a worker's
 * connection name to `bull:<base64 of the queue name>` — verified
 * against a running worker, which showed up as
 * `bull:ZGVsaW5xdWVuY3ktdGVuYW50`. Matching the plain name would have
 * found nothing, forever, and read as "no workers".
 *
 * Tolerant on its own, so an unlistable Redis costs the attachment and
 * not the whole report: a managed Redis (GCP Memorystore) refuses
 * CLIENT LIST, and BullMQ answers that either by throwing or by
 * returning one entry that carries a message and no address. Counting
 * that array would report a phantom worker, so an entry without an
 * `addr` means "not known".
 */
export async function readQueueAttachment(name: QueueName): Promise<Attachment> {
  try {
    const queue = getQueue(name);
    const [clients, paused] = await Promise.all([
      queue.getWorkers() as Promise<RawWorker[]>,
      queue.isPaused(),
    ]);

    if (clients.some((client) => !client.addr)) {
      return { ...UNKNOWN_ATTACHMENT, paused };
    }

    const ages = clients
      .map((client) => Number(client.age))
      .filter((age) => Number.isFinite(age));

    return {
      workers: clients.length,
      workerAgeSeconds: ages.length > 0 ? Math.max(...ages) : null,
      paused,
    };
  } catch (err) {
    logger.warn({ err, queue: name }, "could not read queue worker attachment");
    return UNKNOWN_ATTACHMENT;
  }
}

async function readQueue(name: QueueName): Promise<QueueHealth> {
  const queue = getQueue(name);
  const dlq = getDlqQueue(name);

  const [counts, dlqCounts, failedJobs, attachment, limits, pauseRecord] = await Promise.all([
    queue.getJobCounts(),
    dlq.getJobCounts(),
    /*
     * A window rather than the first three. BullMQ reads the failed set
     * with a range query whose direction is its own business, so the
     * newest failures are sorted out here instead of trusted to arrive
     * first.
     */
    queue.getFailed(0, 19) as Promise<RawJob[]>,
    readQueueAttachment(name),
    readQueueLimits(name),
    readPauseRecord(name),
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
      completed: counts.completed ?? 0,
    },
    dlqDepth: depthOf(dlqCounts as Record<string, number>),
    ...attachment,
    pauseRecord: attachment.paused ? pauseRecord : null,
    perNodeLimit: limits.perNode,
    clusterLimit: limits.cluster,
    effectiveLimit: effectiveLimit(limits, attachment.workers),
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

/** Fills in the names for whichever tenants the failures named. */
async function nameTenants(queues: QueueHealth[]): Promise<void> {
  const names = await utilityNames(
    queues.flatMap((q) => q.recentFailures.map((f) => f.utilityId)),
  );
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

  try {
    const queues = await withQueueTimeout(async () => {
      const read = await Promise.all(ALL_QUEUE_NAMES.map((name) => readQueue(name)));
      await nameTenants(read);
      return read;
    }, timeoutMs);

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
  }
}
