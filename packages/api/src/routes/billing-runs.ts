import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import {
  createBillingRunSchema,
  previewBillingRunSchema,
  billingRunItemQuerySchema,
} from "@utility-cis/shared";
import {
  createBillingRun,
  previewBillingRun,
  listBillingRuns,
  getBillingRun,
  listBillingRunItems,
  postBillingRun,
  cancelBillingRun,
  resumeBillingRun,
  summariseRunExceptions,
  sendBillingRun,
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

  /**
   * What starting a run would do, before it is done.
   *
   * `VIEW`, because it writes nothing. It sits next to `/:id`, which
   * find-my-way resolves in favour of the static segment whichever order
   * they are declared in; it is written first so a reader does not have
   * to know that.
   */
  app.get(
    "/api/v1/billing-runs/preview",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = previewBillingRunSchema.parse(request.query ?? {});
      return reply.send(
        await previewBillingRun(utilityId, {
          billingCycleId: query.billingCycleId,
          windowEnd: query.windowEnd ? new Date(query.windowEnd) : undefined,
          billDate: query.billDate ? new Date(query.billDate) : undefined,
          dueDate: query.dueDate ? new Date(query.dueDate) : undefined,
        }),
      );
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

  /*
   * The same exceptions, counted by cause.
   *
   * Beside `/items` rather than inside it: one answers "what happened to
   * this account" and the other "how many things are there to fix", and
   * a page shows both at once.
   */
  app.get(
    "/api/v1/billing-runs/:id/exception-summary",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await summariseRunExceptions(utilityId, id));
    },
  );

  /*
   * Send every bill this run produced.
   *
   * `EDIT` like posting, and after it: a run that has not been posted
   * is refused outright rather than per bill, so twelve thousand
   * identical refusals are not how an operator discovers the order.
   *
   * 202, because each bill is queued for the notification worker. The
   * body reports what could not be queued, by cause — one address to
   * fix usually clears a group.
   */
  app.post(
    "/api/v1/billing-runs/:id/send",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.status(202).send(await sendBillingRun(utilityId, id));
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

  /**
   * Put the run's unbilled accounts back in the queue.
   *
   * `EDIT` like starting one, because it is the same act continued: the
   * run is a worklist and this works it down. The enqueue mirrors
   * create — after the reset is committed, and swallowed on failure,
   * since the run sitting PENDING is recoverable by the boot sweep or
   * another resume, while a 500 on a run that was genuinely reset is
   * not.
   */
  app.post(
    "/api/v1/billing-runs/:id/resume",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const run = await resumeBillingRun(utilityId, actorId, actorName, id);

      const jobId = await enqueueSafely(QUEUE_NAMES.billingRuns, BILLING_RUN_JOB_NAME, {
        runId: run.id,
        utilityId,
        actorId,
        actorName,
      });

      return reply.status(202).send({ ...run, queued: jobId !== null });
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
