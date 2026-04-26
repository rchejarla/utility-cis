import { Worker } from "bullmq";
import { queueRedisConnection } from "../lib/queue-redis.js";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import { QUEUE_NAMES, QUEUE_DEFAULTS, getQueue, enqueueSafely } from "../lib/queues.js";
import { localHour, formatInTimeZone } from "../lib/iana-tz.js";
import { priorityForTenant } from "../services/automation-config.service.js";
import { prisma } from "../lib/prisma.js";

/**
 * Hourly dispatcher for delinquency evaluation (pattern #2 — fan-out).
 *
 * Reads tenant_config for every tenant with delinquencyEnabled=true
 * and decides which ones are due for evaluation in this tick:
 *   - On schedule: tenant-local hour matches delinquencyRunHourLocal.
 *   - Missed-tick recovery: delinquencyLastRunAt is null OR > 23h ago.
 *
 * For each due tenant, enqueues an `evaluate` job onto the
 * delinquency-tenant queue with:
 *   - data: { utilityId }
 *   - priority: 1/2/3 based on account count (small first, large last)
 *   - jobId: deterministic per (utilityId, UTC-hour) so a re-fire
 *     within the same hour is BullMQ-deduped at insert time.
 *
 * Account count drives priority. Cached at dispatch time (one COUNT
 * per tenant per hour); priority is set on the per-tenant job.
 */

export const DELINQUENCY_DISPATCH_SCHEDULER_ID = "delinquency-dispatch-cron";
export const DELINQUENCY_DISPATCH_JOB_NAME = "dispatch-delinquency";

const MISSED_TICK_HOURS = 23;

export interface DispatchResult {
  candidatesConsidered: number;
  enqueued: number;
  reasons: { onSchedule: number; missedRecovery: number };
}

export async function dispatchDelinquency(now: Date = new Date()): Promise<DispatchResult> {
  const candidates = await prisma.tenantConfig.findMany({
    where: { delinquencyEnabled: true },
    select: {
      utilityId: true,
      timezone: true,
      delinquencyRunHourLocal: true,
      delinquencyLastRunAt: true,
    },
  });

  let onSchedule = 0;
  let missedRecovery = 0;

  for (const c of candidates) {
    const localHourNow = localHour(now, c.timezone);
    const matchesSchedule = localHourNow === c.delinquencyRunHourLocal;

    // Missed-tick recovery only fires for tenants that previously
    // ran AND haven't run in over 23 hours. A brand-new tenant
    // (delinquencyLastRunAt = null) waits for its first on-schedule
    // hour rather than firing immediately — otherwise enabling
    // delinquency on a fresh tenant would dispatch every dispatcher
    // tick until the first run, regardless of run-hour config.
    const missedToday =
      c.delinquencyLastRunAt !== null &&
      (now.getTime() - c.delinquencyLastRunAt.getTime()) / 3_600_000 >= MISSED_TICK_HOURS;

    if (!matchesSchedule && !missedToday) continue;

    const reason = matchesSchedule ? "onSchedule" : "missedRecovery";
    if (matchesSchedule) onSchedule++;
    else missedRecovery++;

    const accountCount = await prisma.account.count({
      where: { utilityId: c.utilityId, status: "ACTIVE" },
    });
    const priority = priorityForTenant(accountCount);

    const jobId = `delinquency:${c.utilityId}:${formatInTimeZone(now, "UTC", "yyyyMMddHH")}`;
    await enqueueSafely(
      QUEUE_NAMES.delinquencyTenant,
      "evaluate",
      { utilityId: c.utilityId, reason },
      { jobId, priority },
    );
  }

  return {
    candidatesConsidered: candidates.length,
    enqueued: onSchedule + missedRecovery,
    reasons: { onSchedule, missedRecovery },
  };
}

export function buildDelinquencyDispatcher(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.delinquencyDispatch,
    async () => {
      const result = await withTelemetry(
        QUEUE_NAMES.delinquencyDispatch,
        () => dispatchDelinquency(new Date()),
      );
      if (result.enqueued > 0) {
        logger.info(
          {
            component: "delinquency-dispatcher",
            ...result,
          },
          "Delinquency dispatch enqueued per-tenant jobs",
        );
      }
      return result;
    },
    {
      connection: queueRedisConnection.duplicate(),
      concurrency: QUEUE_DEFAULTS[QUEUE_NAMES.delinquencyDispatch].concurrency,
    },
  );

  worker.on("error", (err) => {
    logger.error(
      { err, component: "delinquency-dispatcher" },
      "Worker emitted error event",
    );
  });

  return worker;
}

export async function registerDelinquencyDispatchScheduler(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.delinquencyDispatch);
  await queue.upsertJobScheduler(
    DELINQUENCY_DISPATCH_SCHEDULER_ID,
    { pattern: "0 * * * *", tz: "UTC" },
    { name: DELINQUENCY_DISPATCH_JOB_NAME },
  );
  logger.info(
    {
      component: "delinquency-dispatcher",
      schedulerId: DELINQUENCY_DISPATCH_SCHEDULER_ID,
      pattern: "0 * * * *",
    },
    "Delinquency dispatch cron registered",
  );
}
