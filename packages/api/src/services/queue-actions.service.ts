import { EVENT_TYPES } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditRow } from "../lib/audit-wrap.js";
import { ALL_QUEUE_NAMES, getDlqQueue, getQueue, type QueueName } from "../lib/queues.js";
import { JOB_SUBJECT, utilityIdOf } from "../lib/queue-inspect.js";
import type { LifecycleActor } from "./provisioning.service.js";

/**
 * Pushes one job along: retry a failed one, run a delayed one now,
 * replay a dead-lettered one.
 *
 * Bull Board has all three and cannot be opened from a browser, because
 * `authMiddleware` reads only the `authorization` header and a tab
 * navigating to /admin/queues sends none. The alternative was a second
 * authentication path — a cookie — for a UI whose other buttons drain
 * and delete queues. These verbs live here instead, reached with the
 * page's own bearer token, and the operator is on the record.
 *
 * Three verbs and no more. Pause, drain, clean and bulk actions stay
 * out: each is a decision about a whole queue rather than a job, and
 * none of them is what an operator looking at a stuck job needs.
 */

export const QUEUE_ACTIONS = ["retry", "promote", "replay"] as const;
export type QueueActionName = (typeof QUEUE_ACTIONS)[number];

/**
 * Which queues can have an action recorded, and against what: whichever
 * ones name a record, which is `JOB_SUBJECT` in `lib/queue-inspect.ts`.
 *
 * `audit_log` needs a `utility_id` and a uuid `entity_id`, and a BullMQ
 * job id is "80" or "repeat:audit-retention-cron:1792296000000" — so the
 * row has to hang off the entity the job acts on. Only two payloads name
 * one. The sweeps name no tenant at all, and `delinquency-tenant` names
 * a tenant but nothing with an id, so those actions are reported as
 * unaudited rather than recorded against something they are not about.
 *
 * Making `audit_log.utility_id`/`entity_id` nullable would close this,
 * and it is the same migration operator appoint/deactivate is waiting
 * on. Until then that map is the whole of what can be recorded.
 */

/** What each verb requires of the job it is used on. */
const REQUIRED_STATE: Record<QueueActionName, string[]> = {
  retry: ["failed"],
  promote: ["delayed"],
  // The dead-letter copy is added and never worked, so it waits.
  replay: ["waiting", "delayed", "failed", "active"],
};

export interface QueueActionResult {
  queue: string;
  jobId: string;
  action: QueueActionName;
  /** False when nothing in the payload could carry an audit row. */
  audited: boolean;
  auditedAs?: { entityType: string; entityId: string };
}

class QueueActionError extends Error {
  constructor(
    readonly code: "UNKNOWN_QUEUE" | "JOB_NOT_FOUND" | "WRONG_STATE",
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "QueueActionError";
  }
}

function auditTargetOf(
  name: QueueName,
  data: unknown,
): { utilityId: string; entityType: string; entityId: string } | null {
  const mapping = JOB_SUBJECT[name];
  if (!mapping) return null;

  const utilityId = utilityIdOf(data);
  if (!utilityId) return null;

  const entityId =
    data && typeof data === "object"
      ? (data as Record<string, unknown>)[mapping.field]
      : undefined;
  if (typeof entityId !== "string" || entityId.length === 0) return null;

  return { utilityId, entityType: mapping.entityType, entityId };
}

export async function actOnQueueJob(
  queueName: string,
  jobId: string,
  action: QueueActionName,
  actor: LifecycleActor,
): Promise<QueueActionResult> {
  if (!(ALL_QUEUE_NAMES as readonly string[]).includes(queueName)) {
    throw new QueueActionError("UNKNOWN_QUEUE", 404, `No queue named "${queueName}".`);
  }
  const name = queueName as QueueName;

  // Replay reads the dead-letter copy; the other two act on the job in
  // the queue itself.
  const source = action === "replay" ? getDlqQueue(name) : getQueue(name);
  const job = await source.getJob(jobId);
  if (!job) {
    throw new QueueActionError(
      "JOB_NOT_FOUND",
      404,
      `No job ${jobId} in ${action === "replay" ? `dlq-${name}` : name}. It may have moved on.`,
    );
  }

  const state = await job.getState();
  if (!REQUIRED_STATE[action].includes(state)) {
    throw new QueueActionError(
      "WRONG_STATE",
      409,
      `Job ${jobId} is ${state}; ${action} applies to a job that is ${REQUIRED_STATE[action].join(" or ")}.`,
    );
  }

  if (action === "retry") {
    await job.retry();
  } else if (action === "promote") {
    await job.promote();
  } else {
    /*
     * Re-enqueue first, then drop the dead-letter copy. The other order
     * loses the job outright if the add fails, and a duplicate replay is
     * recoverable where a vanished payload is not — the handlers are
     * required to be idempotent for exactly this reason.
     */
    await getQueue(name).add(job.name, job.data);
    await job.remove();
  }

  const target = auditTargetOf(name, job.data);
  if (!target) {
    logger.info(
      { queue: name, jobId, action, actor: actor.id },
      "queue job action not audited: payload names no auditable entity",
    );
    return { queue: name, jobId, action, audited: false };
  }

  await prisma.$transaction(async (tx) => {
    await writeAuditRow(
      tx,
      {
        utilityId: target.utilityId,
        actorId: actor.id,
        actorName: actor.name,
        entityType: target.entityType,
        source: actor.source,
      },
      EVENT_TYPES.QUEUE_JOB_PUSHED,
      target.entityId,
      null,
      { queue: name, jobId, action, jobName: job.name },
    );
  });

  return {
    queue: name,
    jobId,
    action,
    audited: true,
    auditedAs: { entityType: target.entityType, entityId: target.entityId },
  };
}
