import { Worker } from "bullmq";
import { queueRedisConnection } from "../lib/queue-redis.js";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import { QUEUE_NAMES, QUEUE_DEFAULTS, getQueue } from "../lib/queues.js";
import { processPendingNotificationsWithQuietHours } from "../services/notification.service.js";

/**
 * BullMQ worker for the notification-send queue.
 *
 * Replaces the in-process startNotificationSendJob setInterval drain.
 * Cadence: every 10 seconds (the cron pattern in the spec is
 * "*\/10 * * * * *" — six-field cron, the leading "every-10-seconds"
 * shape).
 *
 * Concurrency 1 is deliberate: overlapping ticks would dual-process
 * the outbox. The queue is a singleton drainer.
 *
 * Tenant gating + quiet hours are inside
 * processPendingNotificationsWithQuietHours, not here. This worker
 * is dumb glue.
 */

export const NOTIFICATION_SCHEDULER_ID = "notification-send-cron";
export const NOTIFICATION_JOB_NAME = "process-notification-batch";

export function buildNotificationWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.notificationSend,
    async () => {
      const result = await withTelemetry(
        QUEUE_NAMES.notificationSend,
        () => processPendingNotificationsWithQuietHours(new Date()),
      );
      // Log only when something happened to keep the 10s cron from
      // flooding the log (8,640 ticks/day per replica).
      if (result.attempted > 0 || result.skippedQuietHours > 0) {
        logger.info(
          {
            component: "notification-worker",
            attempted: result.attempted,
            sent: result.sent,
            failed: result.failed,
            skippedQuietHours: result.skippedQuietHours,
          },
          "Notification batch processed",
        );
      }
      return result;
    },
    {
      connection: queueRedisConnection.duplicate(),
      concurrency: QUEUE_DEFAULTS[QUEUE_NAMES.notificationSend].concurrency,
    },
  );

  worker.on("error", (err) => {
    logger.error(
      { err, component: "notification-worker" },
      "Worker emitted error event",
    );
  });

  return worker;
}

/**
 * Idempotent registration of the every-10-seconds cron. UTC-pinned
 * so cadence is stable across deploys; quiet-hour and run-hour
 * timing math uses tenant-local time elsewhere.
 *
 * Six-field cron pattern is BullMQ + cron-parser convention:
 *   second minute hour day month weekday
 */
export async function registerNotificationScheduler(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.notificationSend);
  await queue.upsertJobScheduler(
    NOTIFICATION_SCHEDULER_ID,
    { pattern: "*/10 * * * * *", tz: "UTC" },
    { name: NOTIFICATION_JOB_NAME },
  );
  logger.info(
    {
      component: "notification-worker",
      schedulerId: NOTIFICATION_SCHEDULER_ID,
      pattern: "*/10 * * * * *",
    },
    "Notification cron scheduler registered",
  );
}
