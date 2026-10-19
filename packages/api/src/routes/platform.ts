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
} from "../services/provisioning.service.js";
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

const platformUserBodySchema = z
  .object({
    email: z.string().email().max(255),
    name: z.string().trim().min(1).max(255),
  })
  .strict();

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

  app.get(
    "/api/v1/platform/utilities/:id",
    { config: { platform: true } },
    async (request, reply) => {
      const { id } = tenantParamsSchema.parse(request.params);
      return reply.send(await getUtilityDetail(id));
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
      });

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
      return reply.status(201).send(await roleService.createRole(id, body));
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
      return reply.send(await roleService.updateRole(id, roleId, body));
    },
  );

  app.delete(
    "/api/v1/platform/utilities/:id/roles/:roleId",
    { config: { platform: true } },
    async (request, reply) => {
      const { id, roleId } = roleParamsSchema.parse(request.params);
      await assertUtilityExists(id);
      await roleService.deleteRole(id, roleId);
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
      return reply.send(await setUtilityModule(id, moduleKey, isEnabled));
    },
  );

  app.post(
    "/api/v1/platform/utilities/:id/suspend",
    { config: { platform: true } },
    async (request, reply) => {
      const { id } = tenantParamsSchema.parse(request.params);
      return reply.send(await suspendUtility(id));
    },
  );

  app.post(
    "/api/v1/platform/utilities/:id/reactivate",
    { config: { platform: true } },
    async (request, reply) => {
      const { id } = tenantParamsSchema.parse(request.params);
      return reply.send(await reactivateUtility(id));
    },
  );
}
