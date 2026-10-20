import { prisma } from "./prisma.js";
import type { QueueName } from "./queues.js";

/**
 * The two things every read of a queue needs: a deadline, and the names
 * behind the tenant ids in job payloads.
 *
 * Shared by the health summary and the per-state drill-down so neither
 * can quietly disagree with the other about how long it waits or how it
 * resolves a tenant.
 */

/**
 * Give up after `timeoutMs` and report nothing rather than waiting.
 *
 * A deadline rather than a try/catch, because ioredis queues commands
 * while disconnected and retries indefinitely: a call against a Redis
 * that is down does not reject, it simply never answers, so a `catch`
 * cannot see it. Both of these reads happen on page load, where hanging
 * would hang the page.
 *
 * Losing the race is not an error — it is an answer the caller renders
 * as "could not be read", which must never be shown as "nothing here".
 */
export async function withQueueTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One query for the whole set, not one per job. */
export async function utilityNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();

  const utilities = await prisma.utility.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(utilities.map((u) => [u.id, u.name]));
}

/** The tenant a job acts for, where its payload names one. */
export function utilityIdOf(data: unknown): string | null {
  return stringField(data, "utilityId");
}

/**
 * The record a job's payload names, for the two queues whose payloads
 * name one at all.
 *
 * One table, because two readers need the same fact. An operator's
 * action on a job is audited against this entity — `audit_log.entity_id`
 * is a uuid column and a BullMQ job id is "80" or
 * "repeat:audit-retention-cron:1792296000000" — and the job list checks
 * the record still exists before calling a parked job merely "waiting".
 * The sweeps name nothing, and `delinquency-tenant` names a tenant but
 * no record, so they are absent here rather than guessed at.
 */
export const JOB_SUBJECT: Partial<
  Record<QueueName, { entityType: string; field: string; label: string }>
> = {
  "billing-runs": { entityType: "BillingRun", field: "runId", label: "Billing run" },
  imports: { entityType: "ImportBatch", field: "batchId", label: "Import batch" },
};

/** The id of the record a job's payload names, where it names one. */
export function subjectIdOf(name: QueueName, data: unknown): string | null {
  const subject = JOB_SUBJECT[name];
  return subject ? stringField(data, subject.field) : null;
}

function stringField(data: unknown, field: string): string | null {
  if (data && typeof data === "object" && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
