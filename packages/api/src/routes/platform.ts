import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createRoleSchema, updateRoleSchema } from "@utility-cis/shared";
import * as roleService from "../services/role.service.js";
import {
  provisionTenant,
  listUtilities,
  getUtilityDetail,
  suspendUtility,
  reactivateUtility,
  setUtilityModule,
  assertUtilityExists,
  listUtilityHistory,
} from "../services/provisioning.service.js";
import { getUtilityReadiness } from "../services/utility-readiness.service.js";
import { getQueueHealth } from "../services/queue-health.service.js";
import { getQueueJobs, QUEUE_JOB_STATES } from "../services/queue-jobs.service.js";
import { actOnQueueJob, QUEUE_ACTIONS } from "../services/queue-actions.service.js";
import {
  getWorkerProcessStatus,
  startWorkerProcess,
  stopWorkerProcess,
} from "../services/worker-process.service.js";
import { getPlatformActor } from "../services/rbac.service.js";
import {
  listPlatformUsers,
  createPlatformUser,
  setPlatformUserActive,
} from "../services/platform-user.service.js";

/**
 * The platform operator's routes: tenant lifecycle, and nothing else.
 *
 * These replace `/api/v1/dev/tenants`, which was fenced to non-production
 * builds because the authority it needed did not exist. The objection was
 * never the screen — it was that before a platform actor existed, a
 * provisioning page had nowhere to live but a tenant's own
 * Administration section, gated on a tenant permission, which is one
 * tenant's admin acting above tenants (the borrowing §1.6 flags with
 * Bull Board).
 *
 * `{ platform: true }` is that authority. It is not a permission a
 * tenant can hold and no role grants it: the gate is a `cis_user` row
 * with no tenant (D6, Q2). A tenant's own System Admin — which holds
 * every permission a tenant can grant — is refused here, which is the
 * §1.2 misreading made impossible rather than merely documented.
 *
 * Scope is D6's six lifecycle responsibilities. Impersonation, purge,
 * per-tenant credentials and cross-tenant reporting are deferred out of
 * v1 by name, and each would widen the one identity in the system that
 * can cross the tenant boundary.
 *
 * **This is not a claim that the deployment is safe.** Nothing in this
 * application authenticates anyone yet — there is no password column,
 * and the web login form returns a fixed user for any input — so what
 * un-fencing buys is the right authority model, not a secure console.
 * Real identity is Q2's destination (apptorID) and its own piece of
 * work. Fencing this one route while every other admin route is equally
 * reachable would have protected one door in a building with no front
 * door.
 */

const provisionBodySchema = z
  .object({
    utilityId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(255),
    firstAdmin: z
      .object({
        email: z.string().email().max(255),
        name: z.string().trim().min(1).max(255),
      })
      .optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

const tenantParamsSchema = z.object({ id: z.string().uuid() });

const moduleParamsSchema = z.object({
  id: z.string().uuid(),
  // Not validated against MODULES here — the service owns that refusal,
  // so the route cannot drift from it.
  moduleKey: z.string().min(1).max(50),
});

const moduleBodySchema = z.object({ isEnabled: z.boolean() }).strict();

const roleParamsSchema = z.object({ id: z.string().uuid(), roleId: z.string().uuid() });

const historyQuerySchema = z
  .object({ limit: z.coerce.number().int().positive().max(200).default(50) })
  .strict();

const platformUserBodySchema = z
  .object({
    email: z.string().email().max(255),
    name: z.string().trim().min(1).max(255),
  })
  .strict();


/**
 * The signed-in operator, shaped for a lifecycle audit row.
 *
 * `request.platformActor` is set by the auth middleware and the route is
 * `{ platform: true }`, so authorization has already resolved it against
 * a real row by the time a handler runs.
 */
function actorOf(request: { platformActor?: { id: string; name: string } }) {
  const actor = request.platformActor!;
  return { id: actor.id, name: actor.name, source: `platform:${actor.id}` };
}

/** The same operator, shaped for role.service's audit context. */
function roleActorOf(request: { platformActor?: { id: string; name: string } }) {
  const actor = request.platformActor!;
  return { actorId: actor.id, actorName: actor.name, source: `platform:${actor.id}` };
}

export async function platformRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/platform/me",
    { config: { platform: true } },
    async (request, reply) => {
      // The console's "who am I". `/auth/me` cannot serve it: that route
      // reads `request.user`, which a platform request leaves unset, and
      // answers with permissions and enabled modules that mean nothing
      // for an identity with no tenant.
      //
      // Answered from the row rather than from the token's claims. The
      // token is a bearer of identity; the row is the truth, so a
      // renamed operator sees their new name. Authorization has already
      // resolved this id, so it is a cache hit.
      const actor = await getPlatformActor(request.platformActor!.id);
      return reply.send({ actor });
    },
  );

  app.get(
    "/api/v1/platform/utilities",
    { config: { platform: true } },
    async (_request, reply) => {
      return reply.send({ data: await listUtilities() });
    },
  );

  /*
   * Queue health: counts, dead-letter depth and the newest failures,
   * with the tenant named where a job payload names one.
   *
   * Reads only, and 200 even when Redis did not answer — the body says
   * `reachable: false`. A 503 would be indistinguishable, on screen,
   * from "nothing is queued", which is the one thing an operator must
   * not conclude by mistake. Every verb that changes a job stays in Bull
   * Board.
   */
  app.get("/api/v1/platform/queues", { config: { platform: true } }, async (_request, reply) => {
    /*
     * Composed here, not inside `getQueueHealth`: one answers "what is in
     * the queues", the other "is there a worker process on this host",
     * and only the page needs both at once. Keeping them apart also means
     * a Redis that will not list its clients costs the attachment and
     * not the counts.
     */
    const [health, workerProcess] = await Promise.all([
      getQueueHealth(),
      getWorkerProcessStatus(),
    ]);
    return reply.send({ ...health, workerProcess });
  });

  /*
   * Start and stop the worker process on this host.
   *
   * The worker is a separate Node process and `start_dev.bat` does not
   * start it, so a dev stack normally has eight queues filling up with
   * nothing attached. `spawn` with a fixed argv and no shell: the only
   * operator input is the queue selection, which travels in the
   * environment after being checked against the registry.
   *
   * Off outside development unless `WORKER_CONTROL_ENABLED` says
   * otherwise — see `workerControlAllowed()`. A worker an API container
   * spawns is a process the orchestrator does not manage.
   */
  app.post(
    "/api/v1/platform/workers/start",
    { config: { platform: true } },
    async (request, reply) => {
      const { queues } = z
        .object({ queues: z.array(z.string().min(1).max(64)).max(16).default([]) })
        .strict()
        .parse(request.body ?? {});

      return reply.send(await startWorkerProcess(queues, actorOf(request)));
    },
  );

  app.post(
    "/api/v1/platform/workers/stop",
    { config: { platform: true } },
    async (request, reply) => {
      return reply.send(await stopWorkerProcess(actorOf(request)));
    },
  );

  /*
   * Inside one count. The state is validated rather than passed
   * through: an unknown one would reach BullMQ and come back as an empty
   * list, which reads as "nothing waiting" when the truth is "that is
   * not a state".
   */
  app.get(
    "/api/v1/platform/queues/:name/jobs",
    { config: { platform: true } },
    async (request, reply) => {
      const { name } = z.object({ name: z.string().min(1).max(64) }).parse(request.params);
      const { state, limit } = z
        .object({
          state: z.enum(QUEUE_JOB_STATES),
          limit: z.coerce.number().int().positive().max(100).default(20),
        })
        .strict()
        .parse(request.query);

      return reply.send(await getQueueJobs(name, state, limit));
    },
  );

  /*
   * The three verbs Bull Board holds and cannot be reached to use.
   *
   * A POST carrying the operator's bearer token, like every other call
   * this console makes — which is the whole reason they are here rather
   * than behind a cookie that would let any page re-run work. The action
   * is validated against a closed list: pause, drain and clean are
   * deliberately absent, each being a decision about a queue rather than
   * about the job an operator is looking at.
   */
  app.post(
    "/api/v1/platform/queues/:name/jobs/:id/:action",
    { config: { platform: true } },
    async (request, reply) => {
      const { name, id, action } = z
        .object({
          name: z.string().min(1).max(64),
          // Not a uuid: BullMQ ids are "80" and
          // "repeat:audit-retention-cron:1792296000000".
          id: z.string().min(1).max(200),
          action: z.enum(QUEUE_ACTIONS),
        })
        .parse(request.params);

      return reply.send(await actOnQueueJob(name, id, action, actorOf(request)));
    },
  );

  app.get(
    "/api/v1/platform/utilities/:id",
    { config: { platform: true } },
    async (request, reply) => {
      const { id } = tenantParamsSchema.parse(request.params);
      /*
       * Composed here rather than inside `getUtilityDetail`, because
       * `utility-readiness.service` imports `assertUtilityExists` from
       * `provisioning.service` and the reverse import would close a
       * cycle. Each service keeps answering one question; the route is
       * what needs both at once.
       *
       * Readiness is on the detail response rather than an endpoint of
       * its own: the panel is always visible on that page, so a second
       * request would buy a second loading state and nothing else.
       */
      const [detail, readiness] = await Promise.all([
        getUtilityDetail(id),
        getUtilityReadiness(id),
      ]);
      return reply.send({ ...detail, readiness });
    },
  );

  app.post(
    "/api/v1/platform/utilities",
    { config: { platform: true } },
    async (request, reply) => {
      const body = provisionBodySchema.parse(request.body);

      const result = await provisionTenant({
        utilityId: body.utilityId ?? crypto.randomUUID(),
        name: body.name,
        firstAdmin: body.firstAdmin,
        dryRun: body.dryRun,
      }, actorOf(request));

      // 200, not 201, for a dry run: nothing was created, and a client
      // reading the status rather than the body should not be told it was.
      return reply.status(body.dryRun ? 200 : 201).send(result);
    },
  );

  // ─── a utility's roles, from above it ──────────────────────────
  //
  // The tenant administers its own roles at /api/v1/roles, gated on
  // `settings`. These are the same operations against a utility named in
  // the path, which is authority no tenant holds — and what a utility
  // with no working admin needs, since nothing else can act on it.
  //
  // No new business logic: `role.service.ts` already takes utilityId as
  // its scoping argument and already carries BR-RB-002, BR-RB-003 and
  // the cache invalidation for every assignee. These routes hand it the
  // id from the path rather than from the token, so there is one set of
  // rules rather than two that can drift.

  app.get(
    "/api/v1/platform/utilities/:id/history",
    { config: { platform: true } },
    async (request, reply) => {
      // Only what was done from outside the utility — see
      // `listUtilityHistory` for why this is not the tenant's audit log.
      const { id } = tenantParamsSchema.parse(request.params);
      const { limit } = historyQuerySchema.parse(request.query);
      return reply.send({ data: await listUtilityHistory(id, limit) });
    },
  );

  app.get(
    "/api/v1/platform/utilities/:id/roles",
    { config: { platform: true } },
    async (request, reply) => {
      const { id } = tenantParamsSchema.parse(request.params);
      await assertUtilityExists(id);
      return reply.send({ data: await roleService.listRoles(id) });
    },
  );

  app.post(
    "/api/v1/platform/utilities/:id/roles",
    { config: { platform: true } },
    async (request, reply) => {
      const { id } = tenantParamsSchema.parse(request.params);
      await assertUtilityExists(id);
      const body = createRoleSchema.parse(request.body);
      return reply.status(201).send(
        await roleService.createRole(id, body, roleActorOf(request)),
      );
    },
  );

  app.patch(
    "/api/v1/platform/utilities/:id/roles/:roleId",
    { config: { platform: true } },
    async (request, reply) => {
      const { id, roleId } = roleParamsSchema.parse(request.params);
      await assertUtilityExists(id);
      const body = updateRoleSchema.parse(request.body);
      // The scoping comes from the path: `updateRole` filters on
      // { id, utilityId }, so a role belonging to another utility is not
      // found rather than edited.
      return reply.send(await roleService.updateRole(id, roleId, body, roleActorOf(request)));
    },
  );

  app.delete(
    "/api/v1/platform/utilities/:id/roles/:roleId",
    { config: { platform: true } },
    async (request, reply) => {
      const { id, roleId } = roleParamsSchema.parse(request.params);
      await assertUtilityExists(id);
      await roleService.deleteRole(id, roleId, roleActorOf(request));
      return reply.status(204).send();
    },
  );

  // ─── the platform's own operators ──────────────────────────────

  app.get(
    "/api/v1/platform/users",
    { config: { platform: true } },
    async (_request, reply) => {
      return reply.send({ data: await listPlatformUsers() });
    },
  );

  app.post(
    "/api/v1/platform/users",
    { config: { platform: true } },
    async (request, reply) => {
      const body = platformUserBodySchema.parse(request.body);
      return reply.status(201).send(await createPlatformUser(body));
    },
  );

  app.post(
    "/api/v1/platform/users/:id/deactivate",
    { config: { platform: true } },
    async (request, reply) => {
      const { id } = tenantParamsSchema.parse(request.params);
      return reply.send(await setPlatformUserActive(id, false));
    },
  );

  app.post(
    "/api/v1/platform/users/:id/reactivate",
    { config: { platform: true } },
    async (request, reply) => {
      const { id } = tenantParamsSchema.parse(request.params);
      return reply.send(await setPlatformUserActive(id, true));
    },
  );

  app.patch(
    "/api/v1/platform/utilities/:id/modules/:moduleKey",
    { config: { platform: true } },
    async (request, reply) => {
      // PATCH with the new state in the body rather than enable/disable
      // verbs: this is one boolean field on one row, and a toggle that
      // says which way it should end up cannot be applied twice by
      // mistake.
      const { id, moduleKey } = moduleParamsSchema.parse(request.params);
      const { isEnabled } = moduleBodySchema.parse(request.body);
      return reply.send(await setUtilityModule(id, moduleKey, isEnabled, actorOf(request)));
    },
  );

  app.post(
    "/api/v1/platform/utilities/:id/suspend",
    { config: { platform: true } },
    async (request, reply) => {
      const { id } = tenantParamsSchema.parse(request.params);
      return reply.send(await suspendUtility(id, actorOf(request)));
    },
  );

  app.post(
    "/api/v1/platform/utilities/:id/reactivate",
    { config: { platform: true } },
    async (request, reply) => {
      const { id } = tenantParamsSchema.parse(request.params);
      return reply.send(await reactivateUtility(id, actorOf(request)));
    },
  );
}
