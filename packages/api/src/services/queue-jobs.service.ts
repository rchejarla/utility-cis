import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import {
  ALL_QUEUE_NAMES,
  getDlqQueue,
  getQueue,
  QUEUE_TENANCY,
  type QueueName,
} from "../lib/queues.js";
import {
  JOB_SUBJECT,
  subjectIdOf,
  utilityIdOf,
  utilityNames,
  withQueueTimeout,
} from "../lib/queue-inspect.js";

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
 *
 * **It also says when a parked job is already impossible.** Withholding
 * the payload means the operator cannot check it themselves, and a job
 * can reference a tenant or a record that no longer exists — 80 waiting
 * billing-run jobs in the dev stack name runs that were never committed,
 * and 22 import jobs name a tenant that is not a row in `utility`. Every
 * one fails the moment a worker claims it, because the tenant FK is
 * ON DELETE RESTRICT. Listing those as "waiting" states the opposite of
 * the truth, so each job carries what is already wrong with it.
 */

export const QUEUE_JOB_STATES = [
  "waiting",
  "active",
  "delayed",
  "failed",
  "completed",
  "dlq",
] as const;
export type QueueJobState = (typeof QUEUE_JOB_STATES)[number];

/** Enough to see a pattern; past this, Bull Board is the tool. */
const MAX_JOBS = 100;
const DEFAULT_TIMEOUT_MS = 3_000;

export interface QueueJobSummary {
  /**
   * Which queue it is in. Redundant for a single-queue read and the
   * whole point of a merged one — a list of failures across the
   * deployment is unreadable without it.
   */
  queue: QueueName;
  jobId: string | null;
  jobName: string;
  /** Null for the sweeps, which belong to no single tenant. */
  utilityId: string | null;
  utilityName: string | null;
  /**
   * Whether this queue's jobs name one tenant or sweep across all of
   * them — the difference between a blank tenant that is correct and one
   * that means the job has lost its owner.
   */
  tenancy: "all-tenants" | "per-tenant";
  /**
   * What is already wrong with this job, in a sentence, where that is
   * knowable without running it. Null when nothing is. Carries no ids,
   * for the same reason the payload is withheld.
   */
  invalid: string | null;
  enqueuedAt: string | null;
  /** Delayed only: when it is due to run. */
  runsAt: string | null;
  /** The cron pattern, when this is a repeatable job rather than a retry. */
  repeats: string | null;
  attemptsMade: number;
  /** Failed and dead-lettered only. */
  reason: string | null;
  /**
   * When it last finished — successfully for a completed job, by failing
   * for a failed or dead-lettered one. Both senses, because it is the
   * same field on the job and it is what a merged list sorts by.
   */
  finishedAt: string | null;
  /** Completed only: how long the handler took. */
  durationMs: number | null;
  /**
   * Completed only: what the handler returned, scalar fields only.
   *
   * Every handler returns aggregate counts — `{attempted, sent, failed}`,
   * `{deleted, batches, timedOut}`, `{status, billedCount}` — which is
   * exactly what an operator needs and the only evidence a quiet cron
   * queue is working. But it is a generic field, so it is filtered
   * rather than trusted: see `scalarsOf`.
   */
  result: Record<string, string | number | boolean> | null;
}

export interface QueueJobsResult {
  /** The queue asked for, or `all`. */
  queue: string;
  state: QueueJobState;
  reachable: boolean;
  jobs: QueueJobSummary[];
  /**
   * Whether there is a further page. Asked by fetching one more than the
   * page and seeing whether it arrived, which beats a count: the sets
   * move under us, and a total that was true a second ago is a worse
   * answer than "there is more".
   */
  hasMore: boolean;
}

/**
 * Every queue at once.
 *
 * The same sentinel `WORKER_QUEUES` already uses, rather than a second
 * endpoint: "where are all the failures" is a question about the
 * deployment, and making an operator try eight queues in turn is not an
 * answer to it. Not a queue name, and `ALL_QUEUE_NAMES` is the guard
 * that keeps it from becoming one.
 */
export const ALL_QUEUES = "all";

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
  returnvalue?: unknown;
};

/** How many fields of a result to carry; a handler returns a handful. */
const MAX_RESULT_FIELDS = 12;
/** Long enough for a status, short enough not to be a payload. */
const MAX_RESULT_STRING = 80;

/**
 * The scalar fields of a handler's return value, and nothing else.
 *
 * Objects and arrays are dropped rather than rendered: they are where an
 * id, an address or a file name would be, and this service's whole line
 * is that it never returns a payload. A count is not a payload; a nested
 * object might be, and the boundary is enforced here instead of being
 * re-decided every time a handler's return type changes.
 */
function scalarsOf(value: unknown): Record<string, string | number | boolean> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const out: Record<string, string | number | boolean> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_RESULT_FIELDS) break;
    if (typeof field === "number" || typeof field === "boolean") out[key] = field;
    else if (typeof field === "string" && field.length <= MAX_RESULT_STRING) out[key] = field;
  }
  return Object.keys(out).length > 0 ? out : null;
}

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

/**
 * Which of the named records still exist — one query for the page, not
 * one per job, which is what makes this check affordable on every open.
 */
async function existingSubjects(name: QueueName, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();

  const rows =
    name === "billing-runs"
      ? await prisma.billingRun.findMany({ where: { id: { in: unique } }, select: { id: true } })
      : name === "imports"
        ? await prisma.importBatch.findMany({
            where: { id: { in: unique } },
            select: { id: true },
          })
        : [];

  return new Set(rows.map((row) => row.id));
}

/**
 * What is already wrong with one job.
 *
 * Tenant first: with `ON DELETE RESTRICT` on every tenant FK, a job
 * whose tenant is gone cannot write anything at all, which makes the
 * state of its named record beside the point.
 */
function invalidityOf(
  name: QueueName,
  utilityId: string | null,
  utilityName: string | null,
  subjectId: string | null,
  subjectExists: boolean,
): string | null {
  if (QUEUE_TENANCY[name] === "per-tenant") {
    if (!utilityId) return "No tenant named in the payload; a job on this queue must name one.";
    if (!utilityName) return "Its tenant no longer exists, so nothing can be written for it.";
  }

  const subject = JOB_SUBJECT[name];
  if (subject) {
    if (!subjectId) return `No ${subject.label.toLowerCase()} named in the payload.`;
    if (!subjectExists) return `The ${subject.label.toLowerCase()} it names no longer exists.`;
  }

  return null;
}

/**
 * When a job last mattered, for ordering a merged list.
 *
 * One rule across every state rather than a field per state: finished if
 * it has, else due if it is waiting on a clock, else enqueued. Descending
 * by this is "most recently relevant first", which is the order each
 * queue's own page already arrives in.
 */
function sortKeyOf(job: QueueJobSummary): number {
  const when = job.finishedAt ?? job.runsAt ?? job.enqueuedAt;
  return when ? Date.parse(when) : 0;
}

/** One queue's page, mapped to summaries. */
async function readOneQueue(
  name: QueueName,
  state: QueueJobState,
  start: number,
  end: number,
): Promise<QueueJobSummary[]> {
  const queue = state === "dlq" ? getDlqQueue(name) : getQueue(name);
  const states = state === "dlq" ? [...DLQ_STATES] : [state];
  /*
   * `asc: false` explicitly, not by default. With it BullMQ's Lua reads
   * a set with ZREVRANGE — verified in `getRanges-1.lua` — so each page
   * is newest-first and page two continues where page one stopped. A
   * local sort cannot do that job: it can only order the page it is
   * given, and layering one on top would quietly become wrong the day
   * this flag changed.
   */
  const raw = (await queue.getJobs(states as never, start, end, false)) as RawJob[];

  const [names, subjects] = await Promise.all([
    utilityNames(raw.map((job) => utilityIdOf(job.data))),
    existingSubjects(
      name,
      raw.map((job) => subjectIdOf(name, job.data)).filter((id): id is string => id !== null),
    ),
  ]);

  return raw.map<QueueJobSummary>((job) => {
        const utilityId = utilityIdOf(job.data);
        // A tenant that no longer exists keeps its id and no name: the
        // job is still parked and still a fact.
        const utilityName = utilityId ? (names.get(utilityId) ?? null) : null;
        const subjectId = subjectIdOf(name, job.data);
        return {
          queue: name,
          jobId: job.id ?? null,
          jobName: job.name ?? name,
          utilityId,
          utilityName,
          tenancy: QUEUE_TENANCY[name],
          /*
           * Not asked of a job that has already run. The record it names
           * may well have been cleaned up since, and calling a finished
           * job invalid because its billing run is gone would be
           * backwards — the point of the check is work that cannot
           * succeed, and this already did.
           */
          invalid:
            state === "completed"
              ? null
              : invalidityOf(
                  name,
                  utilityId,
                  utilityName,
                  subjectId,
                  subjectId !== null && subjects.has(subjectId),
                ),
          enqueuedAt: isoOf(job.timestamp),
          runsAt: state === "delayed" ? runsAtOf(job) : null,
          repeats: repeatsOf(job),
          attemptsMade: job.attemptsMade ?? 0,
          reason: job.failedReason ?? null,
          // Both senses of finished: succeeded, or stopped trying.
          finishedAt:
            state === "completed" || state === "failed" || state === "dlq"
              ? isoOf(job.finishedOn)
              : null,
          durationMs:
            state === "completed" &&
            typeof job.finishedOn === "number" &&
            typeof job.processedOn === "number"
              ? job.finishedOn - job.processedOn
              : null,
          result: state === "completed" ? scalarsOf(job.returnvalue) : null,
        };
      });
}

export async function getQueueJobs(
  queueName: string,
  state: QueueJobState,
  limit = 20,
  opts: { timeoutMs?: number; offset?: number } = {},
): Promise<QueueJobsResult> {
  const everyQueue = queueName === ALL_QUEUES;
  if (!everyQueue && !(ALL_QUEUE_NAMES as readonly string[]).includes(queueName)) {
    throw new QueueInspectionError(
      "UNKNOWN_QUEUE",
      404,
      `No queue named "${queueName}". Adding a queue means adding it to QUEUE_NAMES.`,
    );
  }

  const take = Math.min(Math.max(limit, 1), MAX_JOBS);
  const offset = Math.max(opts.offset ?? 0, 0);

  const unreachable: QueueJobsResult = {
    queue: queueName,
    state,
    reachable: false,
    jobs: [],
    hasMore: false,
  };

  try {
    const summaries = await withQueueTimeout(async () => {
      /*
       * One past the page, so "is there more" is answered by whether it
       * arrived. A count would be a worse answer: these sets move under
       * us, and a total that was true a second ago is not a total.
       */
      if (!everyQueue) {
        return readOneQueue(queueName as QueueName, state, offset, offset + take);
      }

      /*
       * Every queue, merged. Each is read from the start of its own set
       * up to the page's end, because the merged order is not any one
       * queue's — then sorted and sliced. Bounded by MAX_JOBS per queue,
       * which is also why deep paging across all of them is not offered:
       * "the newest hundred failures anywhere" is the question, and page
       * fifty of it is not.
       */
      const perQueue = Math.min(offset + take + 1, MAX_JOBS);
      const pages = await Promise.all(
        ALL_QUEUE_NAMES.map((name) => readOneQueue(name, state, 0, perQueue - 1)),
      );
      return pages
        .flat()
        .sort((a, b) => sortKeyOf(b) - sortKeyOf(a))
        .slice(offset, offset + take + 1);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    if (summaries === null) {
      logger.warn({ queue: queueName, state }, "queue job listing timed out");
      return unreachable;
    }

    return {
      queue: queueName,
      state,
      reachable: true,
      jobs: summaries.slice(0, take),
      hasMore: summaries.length > take,
    };
  } catch (err) {
    if (err instanceof QueueInspectionError) throw err;
    logger.warn({ err, queue: queueName, state }, "queue job listing failed");
    return unreachable;
  }
}
