import { logger } from "../lib/logger.js";
import { ALL_QUEUE_NAMES, getDlqQueue, getQueue, type QueueName } from "../lib/queues.js";
import { utilityIdOf, utilityNames, withQueueTimeout } from "../lib/queue-inspect.js";

/**
 * Lists the jobs sitting in one state of one queue.
 *
 * The summary says "80 waiting", which raises the question it cannot
 * answer: waiting since when, for whom, and is that single delayed job
 * the scheduler's repeatable or a retry backing off. Fetched per state
 * when asked rather than sampled into the summary, so the page an
 * operator opens to see "all clear" stays one cheap call.
 *
 * **It never returns the payload.** Job data holds account ids, run ids,
 * customer ids and file names, and D6 sizes this actor by the rule that
 * every capability added to it can reach every customer's data. So this
 * answers with the tenant, the timing, the attempt count and the failure
 * reason. Bull Board still shows a whole payload to an operator who
 * deliberately opens one job — a different act from a list that prints
 * everyone's data by default.
 */

export const QUEUE_JOB_STATES = ["waiting", "active", "delayed", "failed", "dlq"] as const;
export type QueueJobState = (typeof QUEUE_JOB_STATES)[number];

/** Enough to see a pattern; past this, Bull Board is the tool. */
const MAX_JOBS = 100;
const DEFAULT_TIMEOUT_MS = 3_000;

export interface QueueJobSummary {
  jobId: string | null;
  jobName: string;
  /** Null for the sweeps, which belong to no single tenant. */
  utilityId: string | null;
  utilityName: string | null;
  enqueuedAt: string | null;
  /** Delayed only: when it is due to run. */
  runsAt: string | null;
  /** The cron pattern, when this is a repeatable job rather than a retry. */
  repeats: string | null;
  attemptsMade: number;
  /** Failed and dead-lettered only. */
  reason: string | null;
}

export interface QueueJobsResult {
  queue: string;
  state: QueueJobState;
  reachable: boolean;
  jobs: QueueJobSummary[];
}

class QueueInspectionError extends Error {
  constructor(
    readonly code: "UNKNOWN_QUEUE",
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "QueueInspectionError";
  }
}

type RawJob = {
  id?: string | null;
  name?: string;
  timestamp?: number | null;
  finishedOn?: number | null;
  processedOn?: number | null;
  attemptsMade?: number;
  failedReason?: string | null;
  repeatJobKey?: string | null;
  opts?: { delay?: number; repeat?: { pattern?: string; every?: number } };
  data?: unknown;
};

/**
 * BullMQ's own state names, except `dlq` — which is not a state at all
 * but the paired `dlq-<name>` queue. Jobs are added there and never
 * worked, so they sit in `waiting`; the other states are read too, so a
 * replayed job that failed again is still listed rather than vanishing
 * from the view that is meant to account for everything parked.
 */
const DLQ_STATES = ["waiting", "active", "delayed", "failed"] as const;

function isoOf(ms: number | null | undefined): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

/**
 * When a delayed job is due.
 *
 * Computed from the enqueue time plus its delay rather than read off the
 * job: BullMQ keeps the due time as the score in the delayed set, which
 * is not exposed on the job object.
 */
function runsAtOf(job: RawJob): string | null {
  const delay = job.opts?.delay;
  if (typeof delay !== "number" || typeof job.timestamp !== "number") return null;
  return new Date(job.timestamp + delay).toISOString();
}

function repeatsOf(job: RawJob): string | null {
  const pattern = job.opts?.repeat?.pattern;
  if (pattern) return pattern;
  const every = job.opts?.repeat?.every;
  if (typeof every === "number") return `every ${Math.round(every / 1000)}s`;
  // A repeatable job whose options did not survive the round trip still
  // carries the key BullMQ built from them.
  return job.repeatJobKey ?? null;
}

export async function getQueueJobs(
  queueName: string,
  state: QueueJobState,
  limit = 20,
  opts: { timeoutMs?: number } = {},
): Promise<QueueJobsResult> {
  if (!(ALL_QUEUE_NAMES as readonly string[]).includes(queueName)) {
    throw new QueueInspectionError(
      "UNKNOWN_QUEUE",
      404,
      `No queue named "${queueName}". Adding a queue means adding it to QUEUE_NAMES.`,
    );
  }
  const name = queueName as QueueName;
  const take = Math.min(Math.max(limit, 1), MAX_JOBS);

  const unreachable: QueueJobsResult = { queue: name, state, reachable: false, jobs: [] };

  try {
    const summaries = await withQueueTimeout(async () => {
      const queue = state === "dlq" ? getDlqQueue(name) : getQueue(name);
      const states = state === "dlq" ? [...DLQ_STATES] : [state];
      const raw = (await queue.getJobs(states as never, 0, take - 1)) as RawJob[];

      const names = await utilityNames(raw.map((job) => utilityIdOf(job.data)));

      return raw.map<QueueJobSummary>((job) => {
        const utilityId = utilityIdOf(job.data);
        return {
          jobId: job.id ?? null,
          jobName: job.name ?? name,
          utilityId,
          // A tenant that no longer exists keeps its id and no name: the
          // job is still parked and still a fact.
          utilityName: utilityId ? (names.get(utilityId) ?? null) : null,
          enqueuedAt: isoOf(job.timestamp),
          runsAt: state === "delayed" ? runsAtOf(job) : null,
          repeats: repeatsOf(job),
          attemptsMade: job.attemptsMade ?? 0,
          reason: job.failedReason ?? null,
        };
      });
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    if (summaries === null) {
      logger.warn({ queue: name, state }, "queue job listing timed out");
      return unreachable;
    }

    return { queue: name, state, reachable: true, jobs: summaries };
  } catch (err) {
    if (err instanceof QueueInspectionError) throw err;
    logger.warn({ err, queue: name, state }, "queue job listing failed");
    return unreachable;
  }
}
