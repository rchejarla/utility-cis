import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { createBillingRunSchema, billingRunItemQuerySchema } from "@utility-cis/shared";
import {
  createBillingRun,
  listBillingRuns,
  getBillingRun,
  listBillingRunItems,
  postBillingRun,
  cancelBillingRun,
} from "../services/billing-run.service.js";
import { QUEUE_NAMES, enqueueSafely } from "../lib/queues.js";
import { BILLING_RUN_JOB_NAME } from "../workers/billing-run-worker.js";

/**
 * Billing runs.
 *
 * `accounts:EDIT` to start or post one — the same authority that creates
 * and posts a single bill, because a run is that act repeated rather
 * than a new kind of power. Reading is `accounts:VIEW`.
 *
 * Starting a run returns 202 and a PENDING run: the work is minutes
 * long, so the response is the record to watch rather than the result.
 */
export async function billingRunRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/billing-runs",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const body = createBillingRunSchema.parse(request.body ?? {});
      const run = await createBillingRun(utilityId, actorId, actorName, {
        billingCycleId: body.billingCycleId,
        windowEnd: body.windowEnd ? new Date(body.windowEnd) : undefined,
        billDate: body.billDate ? new Date(body.billDate) : undefined,
        dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      });

      /*
       * Enqueued after the run and its items are committed, so a worker
       * that picks the job up immediately finds something to do. A
       * failed enqueue is logged and swallowed by `enqueueSafely` — the
       * run stays PENDING and the boot sweep or a re-enqueue will take
       * it, which is better than a 500 on a run that exists.
       */
      const jobId = await enqueueSafely(QUEUE_NAMES.billingRuns, BILLING_RUN_JOB_NAME, {
        runId: run.id,
        utilityId,
        actorId,
        actorName,
      });

      return reply.status(202).send({ ...run, queued: jobId !== null });
    },
  );

  app.get(
    "/api/v1/billing-runs",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      return reply.send(await listBillingRuns(utilityId));
    },
  );

  app.get(
    "/api/v1/billing-runs/:id",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await getBillingRun(utilityId, id));
    },
  );

  /** The exception list. `?status=FAILED` is the work queue. */
  app.get(
    "/api/v1/billing-runs/:id/items",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const query = billingRunItemQuerySchema.parse(request.query ?? {});
      return reply.send(await listBillingRunItems(utilityId, id, query));
    },
  );

  app.post(
    "/api/v1/billing-runs/:id/post",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const result = await postBillingRun(utilityId, actorId, actorName, id);
      return reply.status(201).send(result);
    },
  );

  app.post(
    "/api/v1/billing-runs/:id/cancel",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await cancelBillingRun(utilityId, id));
    },
  );
}
