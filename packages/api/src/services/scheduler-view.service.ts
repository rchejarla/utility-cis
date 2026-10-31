/**
 * What is meant to run, and when.
 *
 * `/platform/cluster/queues` answers "what is waiting". This answers the
 * question before it — *is anything going to fire at all* — which
 * nothing in the product could. Three silent failures hide there:
 *
 * - **Nothing armed it.** `worker.ts` registers schedulers only at boot,
 *   so a deployment where no worker ever started has crons that were
 *   never armed, not merely un-run. `WORKER_QUEUES` naming a subset does
 *   the same to the rest. `unarmed` below is that list, and it is the
 *   one thing on this page that cannot be inferred from any other.
 * - **Nothing promotes it.** An armed scheduler on a queue with no
 *   attached worker goes overdue and stays there, and its record looks
 *   perfectly healthy. Found while writing this spec: audit-retention
 *   due 2026-10-18 with the date at the 20th.
 * - **Redis holds one the code does not.** Since 2026-10-30 worker boot
 *   reports those instead of deleting them (SCH-NODE-1), so showing them
 *   is the only way anyone sees one outside a log line.
 *
 * Read-only, and it writes nothing: removing an orphan is the platform
 * route's job, and deliberate.
 */
import { ALL_QUEUE_NAMES, getQueue, type QueueName } from "../lib/queues.js";
import { SCHEDULER_REGISTRY } from "../lib/schedulers.js";
import { readQueueAttachment } from "./queue-health.service.js";
import { logger } from "../lib/logger.js";

/**
 * How many completed jobs to look back through for a last run.
 *
 * Completed jobs are retained 24h / 1000 per queue (`RETENTION_OPTS`),
 * so this is a window and not a history: a null `lastRunAt` means "not
 * in the retained window", never "never". The page says which.
 */
const COMPLETED_WINDOW = 50;

/** Schedulers per queue to read. Today each queue has at most one. */
const SCHEDULERS_PER_QUEUE = 50;

export interface SchedulerView {
  queue: QueueName;
  /** BullMQ's scheduler key — what `SCHEDULER_REGISTRY` holds. */
  schedulerId: string;
  /** The job name each occurrence is enqueued under. */
  jobName: string;
  /** The cron expression, or null where the scheduler uses an interval. */
  pattern: string | null;
  /** A fixed interval in ms, where there is no cron. */
  everyMs: number | null;
  timezone: string | null;
  nextRunAt: string | null;
  /**
   * Its next run is in the past, so nothing promoted it.
   *
   * Derived here rather than left to the page: a bare timestamp makes
   * the reader do the subtraction, which is exactly how a stalled
   * scheduler goes unnoticed.
   */
  overdue: boolean;
  /** Null means "nothing of its own in the retained window". */
  lastRunAt: string | null;
  /** How many occurrences BullMQ has armed, where it reports it. */
  iterations: number | null;
  /** Armed in Redis, absent from this build's registry. */
  orphan: boolean;
  /** Attached workers on its queue; null where Redis would not say. */
  workers: number | null;
  /** A paused queue promotes nothing, however many workers are attached. */
  paused: boolean;
}

export interface SchedulerReport {
  /** False when no queue could be read at all. */
  reachable: boolean;
  checkedAt: string;
  schedulers: SchedulerView[];
  /**
   * Registered crons that no queue has armed.
   *
   * Not an orphan — the mirror of one. An orphan is armed and
   * unrecognised; this is recognised and armed nowhere, which is what a
   * worker that never started leaves behind.
   */
  unarmed: string[];
}

type RawScheduler = {
  key?: string;
  name?: string;
  pattern?: string;
  every?: number;
  tz?: string;
  next?: number;
  iterationCount?: number;
};

type RawCompleted = {
  name?: string;
  repeatJobKey?: string;
  finishedOn?: number | null;
};

const iso = (ms: number | null | undefined): string | null =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/**
 * When this scheduler last finished something.
 *
 * `repeatJobKey` first, which is the scheduler's own stamp. The job-name
 * fallback is belt and braces: were BullMQ ever to stop stamping it, a
 * null last run would be indistinguishable from a cron that has not
 * fired — a wrong answer with no error to show for it. The names on
 * these queues are the cron's own, so a hand-enqueued one is the same
 * work and reporting it as the last run tells no lie worth the extra
 * precision.
 */
function lastRunOf(sched: RawScheduler, completed: RawCompleted[]): string | null {
  let newest: number | null = null;
  for (const job of completed) {
    const mine =
      job.repeatJobKey !== undefined
        ? job.repeatJobKey === sched.key
        : job.name !== undefined && job.name === sched.name;
    if (!mine) continue;
    const at = job.finishedOn ?? null;
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return iso(newest);
}

/**
 * One queue's armed schedulers.
 *
 * Tolerant per queue, like the queue report beside it: a Redis that will
 * not answer for one queue costs that queue and not the page. Returns
 * null to say "could not read", which is not the same as "none armed".
 */
async function readQueue(name: QueueName): Promise<SchedulerView[] | null> {
  const queue = getQueue(name);

  let armed: RawScheduler[];
  try {
    armed = (await queue.getJobSchedulers(0, SCHEDULERS_PER_QUEUE)) as RawScheduler[];
  } catch (err) {
    logger.warn(
      { err, component: "scheduler-view", queue: name },
      "Could not list schedulers for this queue",
    );
    return null;
  }

  const withKeys = armed.filter((s): s is RawScheduler & { key: string } => Boolean(s.key));
  if (withKeys.length === 0) return [];

  // Only now, and only for a queue that has something armed: both of
  // these are round trips, and no queue holds more than one scheduler —
  // most hold none.
  const [attachment, completed] = await Promise.all([
    readQueueAttachment(name),
    queue.getCompleted(0, COMPLETED_WINDOW).catch(() => [] as RawCompleted[]) as Promise<
      RawCompleted[]
    >,
  ]);

  const now = Date.now();
  return withKeys.map((sched) => ({
    queue: name,
    schedulerId: sched.key,
    jobName: sched.name ?? sched.key,
    pattern: sched.pattern ?? null,
    everyMs: typeof sched.every === "number" ? sched.every : null,
    timezone: sched.tz ?? null,
    nextRunAt: iso(sched.next),
    overdue: typeof sched.next === "number" && sched.next < now,
    lastRunAt: lastRunOf(sched, completed),
    iterations: typeof sched.iterationCount === "number" ? sched.iterationCount : null,
    orphan: !SCHEDULER_REGISTRY.has(sched.key),
    workers: attachment.workers,
    paused: attachment.paused,
  }));
}

export async function getSchedulerReport(): Promise<SchedulerReport> {
  const checkedAt = new Date().toISOString();

  const perQueue = await Promise.all(ALL_QUEUE_NAMES.map((name) => readQueue(name)));
  const schedulers = perQueue.flatMap((rows) => rows ?? []);

  /*
   * Unreachable only when *no* queue answered. One queue failing is a
   * gap in the page; every queue failing is a Redis that is not there,
   * and the difference matters because an empty list otherwise reads as
   * "nothing is scheduled" — which is the reassuring version of the
   * worst case.
   */
  const reachable = perQueue.some((rows) => rows !== null);

  const armedIds = new Set(schedulers.map((s) => s.schedulerId));
  const unarmed = [...SCHEDULER_REGISTRY].filter((id) => !armedIds.has(id));

  return { reachable, checkedAt, schedulers, unarmed };
}
