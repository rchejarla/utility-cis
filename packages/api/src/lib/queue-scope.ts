import type { Job } from "bullmq";
import { QUEUE_TENANCY, type QueueName } from "./queues.js";
import { runAsPlatform, runAsTenant } from "./tenant-context.js";

/**
 * Run a queue's work under the authority its tenancy implies.
 *
 * Six of the nine queues sweep every tenant in one pass, and under an
 * enforcing policy a sweep with no tenant set reads nothing and reports
 * success: no rows flipped, no error raised, and nobody's SLA breached
 * overnight. The other three name a tenant in their payload and must be
 * confined to it — a per-tenant job is exactly where cross-tenant
 * authority would be a defect rather than a feature.
 *
 * **Derived from `QUEUE_TENANCY`, never applied by hand.** The tenancy
 * of each queue is already declared there, read off the handlers rather
 * than assumed, and deriving the scope from that declaration is the only
 * arrangement in which the two cannot drift apart. A seventh
 * all-tenants queue gets platform authority by being declared one; a
 * builder that forgets to call this gets no scope at all, which is
 * fail-closed rather than quietly cross-tenant.
 *
 * Wrapping happens at the nine worker builders rather than inside each
 * service, because a service is also reachable from a route, where the
 * request's own scope is the right one.
 */
export function scopedJob<D, R>(
  queue: QueueName,
  handler: (job: Job<D>) => Promise<R>,
): (job: Job<D>) => Promise<R> {
  if (QUEUE_TENANCY[queue] === "all-tenants") {
    return (job) => runAsPlatform(() => handler(job));
  }
  return (job) => {
    const utilityId = (job.data as { utilityId?: string } | undefined)?.utilityId;
    if (!utilityId) {
      /*
       * Refused rather than widened. Falling back to platform authority
       * here would turn one missing field in a job payload into a
       * cross-tenant sweep — the single mistake most able to undo all
       * of this, and the least visible, since the work would appear to
       * succeed.
       */
      return Promise.reject(
        new Error(
          `Queue "${queue}" is per-tenant but its job carries no utilityId; refusing to run it unscoped`,
        ),
      );
    }
    return runAsTenant(utilityId, () => handler(job));
  };
}
