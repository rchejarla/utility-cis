import { Worker } from "bullmq";
import { queueRedisConnection } from "../lib/queue-redis.js";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import { QUEUE_NAMES, QUEUE_DEFAULTS, enqueueSafely } from "../lib/queues.js";
import {
  processBatch,
  type ProcessScope,
} from "../services/imports/process-batch.service.js";
import { emitImportTerminalNotifications } from "../services/imports/notify.service.js";
import { reclaimZombieBatches } from "../services/imports/zombie-sweep.service.js";
import { prisma } from "../lib/prisma.js";

/**
 * BullMQ worker for the `imports` queue.
 *
 * One job = one batch. Concurrency 4 per replica (multiple batches
 * run in parallel; one batch is always one worker). attempts=1 — the
 * queue config disables auto-retry, because re-running a batch from
 * row 1 after a transient failure would re-process IMPORTED rows.
 * User-driven retry goes through processBatch with
 * scope="errors-only".
 *
 * On crash mid-batch: the next API/worker boot's reclaimZombieBatches
 * sweep flips the batch back to PENDING and re-enqueues; processBatch
 * scope="pending" picks up where it left off (IMPORTED rows are
 * skipped because they're not in the status filter).
 */

export const IMPORT_WORKER_JOB_NAME = "process-import-batch";

export interface ImportJobData {
  batchId: string;
  utilityId: string;
  actorId: string;
  actorName: string;
  scope?: ProcessScope;
}

export function buildImportWorker(): Worker<ImportJobData> {
  const worker = new Worker<ImportJobData>(
    QUEUE_NAMES.imports,
    async (job) => {
      const { batchId, utilityId, actorId, actorName, scope } = job.data;
      const result = await withTelemetry(QUEUE_NAMES.imports, () =>
        processBatch({ batchId, utilityId, actorId, actorName, scope }),
      );
      try {
        const batch = await prisma.importBatch.findUniqueOrThrow({
          where: { id: batchId },
        });
        await emitImportTerminalNotifications(batch);
      } catch (err) {
        logger.error(
          { err, component: "import-worker", batchId },
          "Failed to emit terminal notifications",
        );
      }
      logger.info(
        {
          component: "import-worker",
          batchId,
          finalStatus: result.status,
          importedCount: result.importedCount,
          errorCount: result.errorCount,
        },
        "Import batch finalised",
      );
      return result;
    },
    {
      connection: queueRedisConnection.duplicate(),
      concurrency: QUEUE_DEFAULTS[QUEUE_NAMES.imports].concurrency,
    },
  );

  worker.on("error", (err) => {
    logger.error({ err, component: "import-worker" }, "Worker emitted error event");
  });

  return worker;
}

/**
 * Run on worker boot. Re-enqueues anything the previous replica was
 * mid-processing when it died. Safe to call repeatedly — finding zero
 * zombies is the steady state.
 */
export async function reclaimAndEnqueueZombies(): Promise<void> {
  const ids = await reclaimZombieBatches(new Date());
  for (const batchId of ids) {
    const batch = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { utilityId: true, createdBy: true },
    });
    if (!batch) continue;
    const user = await prisma.cisUser.findUnique({
      where: { id: batch.createdBy },
      select: { name: true },
    });
    await enqueueSafely(QUEUE_NAMES.imports, IMPORT_WORKER_JOB_NAME, {
      batchId,
      utilityId: batch.utilityId,
      actorId: batch.createdBy,
      actorName: user?.name ?? "system",
      scope: "pending",
    });
    logger.info(
      { component: "import-worker", batchId },
      "Re-enqueued zombie batch",
    );
  }
}
