/**
 * Which crons are armed in Redis, and which of them this build does not
 * know about.
 *
 * **Boot reports; it does not delete.** That is the whole of SCH-NODE-1,
 * and it was the other way round until 2026-10-30.
 *
 * A scheduler record lives in Redis and is armed by whichever node
 * happens to boot. `reconcileSchedulers` deleted every record whose id
 * was not in the booting build's own registry, which is correct on one
 * build and wrong the moment there are two: during a rolling deploy the
 * new node arms `billing-dispatch-cron`, the old node boots, does not
 * recognise it, and removes it. Registration happens only at boot, so
 * the cron is then gone until something restarts — and the deletion was
 * logged at info, which reads like housekeeping succeeding. A month that
 * does not bill is the shape of that failure.
 *
 * The simpler alternative, considered and rejected: keep deleting but
 * skip records younger than some grace period, on the theory that a
 * genuinely removed cron's record is old and a racing node's is new. It
 * works for a short deploy and fails silently for a long one, and it
 * leaves a destructive act automatic. A heuristic guarding a deletion
 * that nobody watches is worth less than a report somebody reads.
 *
 * What is left is the opposite failure, and it is far cheaper: a cron
 * removed in code keeps firing until an operator takes it out. That
 * enqueues a job no handler claims, against a month that does not bill.
 * It is also now *visible* — a WARN per orphan per boot, and a
 * deliberate way to remove one.
 */
import { getQueue, type QueueName } from "./queues.js";
import { logger } from "./logger.js";
import { SUSPENSION_SCHEDULER_ID } from "../workers/suspension-worker.js";
import { NOTIFICATION_SCHEDULER_ID } from "../workers/notification-worker.js";
import { DELINQUENCY_DISPATCH_SCHEDULER_ID } from "../workers/delinquency-dispatcher.js";
import { SLA_BREACH_SCHEDULER_ID } from "../workers/sla-breach-worker.js";
import { AUDIT_RETENTION_SCHEDULER_ID } from "../workers/audit-retention-worker.js";
import { BILLING_DISPATCH_SCHEDULER_ID } from "../workers/billing-dispatcher.js";

/**
 * Every cron this build registers. A worker that arms one MUST name it
 * here, or its own next boot reports it as an orphan.
 *
 * Here rather than in `worker.ts`, where it used to live, because the
 * route that removes an orphan has to consult it — and nothing may
 * import `worker.ts`, which starts a worker process when it loads.
 * `lib` importing from `workers` for five string constants is the wrong
 * way round; it stays because the alternative is a second copy of the
 * list, and a registry that can disagree with itself is worse than an
 * import that points upward.
 */
export const SCHEDULER_REGISTRY: ReadonlySet<string> = new Set<string>([
  SUSPENSION_SCHEDULER_ID,
  NOTIFICATION_SCHEDULER_ID,
  DELINQUENCY_DISPATCH_SCHEDULER_ID,
  SLA_BREACH_SCHEDULER_ID,
  AUDIT_RETENTION_SCHEDULER_ID,
  BILLING_DISPATCH_SCHEDULER_ID,
]);

export interface OrphanedScheduler {
  queue: QueueName;
  schedulerId: string;
  /** The cron expression, where BullMQ reports one. */
  pattern: string | null;
}

/**
 * Armed schedulers on these queues that `registry` does not contain.
 *
 * Only the queues this process serves: `WORKER_QUEUES` can name a
 * subset, and a queue nothing here is attached to is not this process's
 * to judge.
 *
 * Tolerant per queue, as the reconcile it replaces was — a Redis that
 * will not list one queue's schedulers costs that queue and not the
 * sweep.
 */
export async function findOrphanedSchedulers(
  queues: readonly QueueName[],
  registry: ReadonlySet<string>,
): Promise<OrphanedScheduler[]> {
  const orphans: OrphanedScheduler[] = [];

  for (const name of queues) {
    const queue = getQueue(name);
    let armed: Awaited<ReturnType<typeof queue.getJobSchedulers>>;
    try {
      armed = await queue.getJobSchedulers();
    } catch (err) {
      logger.warn(
        { err, component: "scheduler-reconcile", queue: name },
        "Could not list schedulers — skipping this queue",
      );
      continue;
    }

    for (const sched of armed) {
      // Nothing to report and nothing anyone could act on.
      if (!sched.key) continue;
      if (registry.has(sched.key)) continue;

      orphans.push({
        queue: name,
        schedulerId: sched.key,
        pattern: sched.pattern ?? null,
      });
      logger.warn(
        {
          component: "scheduler-reconcile",
          queue: name,
          schedulerId: sched.key,
          pattern: sched.pattern ?? null,
        },
        "A scheduler is armed that this build does not know; it keeps firing until removed",
      );
    }
  }

  return orphans;
}

/**
 * Remove one armed scheduler, on purpose.
 *
 * Takes the registry in order to refuse an id that is in it. Boot can no
 * longer delete a live cron by accident, and this is the only path left
 * that could — a hand doing it deliberately would be the same outage,
 * and "remove the orphan I am looking at" should not be able to become
 * "remove the one that is working".
 */
export async function removeScheduler(
  queue: QueueName,
  schedulerId: string,
  registry: ReadonlySet<string>,
): Promise<void> {
  if (registry.has(schedulerId)) {
    throw Object.assign(
      new Error(
        `${schedulerId} is a scheduler this build registers, not an orphan. Removing it would ` +
          "stop the job firing until a worker restarts and arms it again.",
      ),
      { statusCode: 409, code: "SCHEDULER_IS_REGISTERED" },
    );
  }

  await getQueue(queue).removeJobScheduler(schedulerId);
  logger.warn(
    { component: "scheduler-reconcile", queue, schedulerId },
    "Removed an orphaned scheduler on request",
  );
}
