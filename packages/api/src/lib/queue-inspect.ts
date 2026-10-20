import { prisma } from "./prisma.js";

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
  if (data && typeof data === "object" && "utilityId" in data) {
    const value = (data as { utilityId?: unknown }).utilityId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
