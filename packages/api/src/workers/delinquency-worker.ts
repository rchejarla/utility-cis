import { Worker, type Job } from "bullmq";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import {
  QUEUE_NAMES,
  workerOptions,
} from "../lib/queues.js";
import { scopedJob } from "../lib/queue-scope.js";
import { evaluateDelinquencyForTenant } from "../services/delinquency.service.js";
import { sweepDelinquencyWorkOrders } from "../services/delinquency-work-order.service.js";

/**
 * Per-tenant consumer for the delinquency-tenant queue.
 *
 * Concurrency 5 (per spec §3.3): five tenants in parallel per worker
 * replica. Each evaluation does multiple DB queries; with the default
 * Prisma connection pool this stays comfortably below saturation.
 *
 * The handler updates utility_config.delinquencyLastRunAt on success
 * (inside evaluateDelinquencyForTenant) so the dispatcher's
 * missed-tick recovery sees this tenant as "ran today."
 */

interface DelinquencyTenantJobData {
  utilityId: string;
  reason?: string;
}

export function buildDelinquencyWorker(): Worker<DelinquencyTenantJobData> {
  const worker = new Worker<DelinquencyTenantJobData>(
    QUEUE_NAMES.delinquencyTenant,
    scopedJob(QUEUE_NAMES.delinquencyTenant, async (job: Job<DelinquencyTenantJobData>) => {
      const { utilityId, reason } = job.data;
      const result = await withTelemetry(
        QUEUE_NAMES.delinquencyTenant,
        () => evaluateDelinquencyForTenant(utilityId, new Date()),
      );

      /*
       * The field work the evaluation implies, in the same tenant scope.
       * A separate pass because it is keyed on state rather than on the
       * evaluation's own result: an action whose work order could not be
       * raised last tick is picked up by this one.
       */
      const workOrders = await sweepDelinquencyWorkOrders(utilityId);
      if (workOrders.created > 0) {
        logger.info(
          { component: "delinquency-worker", utilityId, ...workOrders },
          "Delinquency dispatched field work",
        );
      }

      if (result.actionsCreated > 0) {
        logger.info(
          {
            component: "delinquency-worker",
            utilityId,
            reason: reason ?? "unknown",
            ...result,
          },
          "Delinquency evaluation produced actions",
        );
      }
      return result;
    }),
    {
      ...workerOptions(QUEUE_NAMES.delinquencyTenant),
    },
  );

  worker.on("error", (err) => {
    logger.error(
      { err, component: "delinquency-worker" },
      "Worker emitted error event",
    );
  });

  return worker;
}
