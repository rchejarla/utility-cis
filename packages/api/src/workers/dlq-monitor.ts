import { QueueEvents, type Job } from "bullmq";
import { queueRedisConnection } from "../lib/queue-redis.js";
import { getQueue, getDlqQueue, ALL_QUEUE_NAMES, type QueueName } from "../lib/queues.js";
import { dlqDepthGauge } from "../lib/telemetry.js";
import { logger } from "../lib/logger.js";

/**
 * Dead-letter monitor.
 *
 * BullMQ doesn't have a first-class DLQ concept, but it exposes the
 * `failed` event with `attemptsMade` and `failedReason` on each job.
 * This monitor subscribes to `QueueEvents` for every queue and, when a
 * job has exhausted its retries, copies the job payload into a paired
 * `dlq-<name>` queue and increments the dlq_depth gauge.
 *
 * Operators replay DLQ jobs manually from Bull Board if appropriate,
 * or leave them parked for forensic analysis.
 *
 * QueueEvents subscriptions are passive — they don't claim jobs and
 * don't affect throughput. Multiple worker replicas can each run the
 * monitor; the move-to-DLQ step is idempotent because the source
 * queue's `removeOnFail` retention will eventually drop the original
 * failed entry, but until then the DLQ may briefly contain duplicates.
 * Acceptable.
 */

interface MonitorState {
  events: QueueEvents;
  // Bound listener references so we can detach cleanly on shutdown.
  failedHandler: (args: { jobId: string; failedReason: string }) => Promise<void>;
}

const monitors = new Map<QueueName, MonitorState>();

async function moveJobToDlq(sourceQueue: QueueName, jobId: string, failedReason: string): Promise<void> {
  const job: Job | undefined = await getQueue(sourceQueue).getJob(jobId);
  if (!job) {
    logger.warn(
      { component: "dlq-monitor", sourceQueue, jobId },
      "Failed job vanished before DLQ move — likely already removed by retention",
    );
    return;
  }
  // BullMQ tracks attemptsMade on the job; only escalate when no
  // attempts remain. Without this guard we'd DLQ jobs that are about
  // to retry.
  const attemptsMade = job.attemptsMade ?? 0;
  const maxAttempts = job.opts.attempts ?? 1;
  if (attemptsMade < maxAttempts) return;

  const dlq = getDlqQueue(sourceQueue);
  await dlq.add(
    `dlq:${job.name}`,
    {
      originalJobId: job.id,
      originalName: job.name,
      originalData: job.data,
      failedReason,
      failedAt: new Date().toISOString(),
      attemptsMade,
    },
    { attempts: 1 },
  );

  const depth = await dlq.getJobCountByTypes("waiting", "active", "delayed");
  dlqDepthGauge.set({ queue: sourceQueue }, depth);

  logger.error(
    {
      component: "dlq-monitor",
      sourceQueue,
      jobId,
      jobName: job.name,
      attemptsMade,
      failedReason,
    },
    "Job exhausted retries — moved to DLQ",
  );
}

export async function startDlqMonitor(queueNames: readonly QueueName[] = ALL_QUEUE_NAMES): Promise<void> {
  for (const name of queueNames) {
    if (monitors.has(name)) continue;
    const events = new QueueEvents(name, { connection: queueRedisConnection.duplicate() });
    const failedHandler = async (args: { jobId: string; failedReason: string }) => {
      try {
        await moveJobToDlq(name, args.jobId, args.failedReason);
      } catch (err) {
        logger.error(
          { err, component: "dlq-monitor", queue: name, jobId: args.jobId },
          "DLQ move failed — job may need manual replay",
        );
      }
    };
    events.on("failed", failedHandler);
    monitors.set(name, { events, failedHandler });
    logger.info({ component: "dlq-monitor", queue: name }, "subscribed");
  }
}

export async function stopDlqMonitor(): Promise<void> {
  const closures = Array.from(monitors.values()).map(async ({ events }) => {
    await events.close();
  });
  await Promise.all(closures);
  monitors.clear();
}
