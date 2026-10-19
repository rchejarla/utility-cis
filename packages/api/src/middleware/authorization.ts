import type { FastifyRequest, FastifyReply } from "fastify";
import {
  getUserRole,
  getTenantModules,
  getPlatformActor,
  getUtilityStatus,
} from "../services/rbac.service.js";
import { config as appConfig } from "../config.js";

export async function authorizationMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const routeConfig = request.routeOptions?.config as
    | { module?: string; permission?: string; platform?: boolean }
    | undefined;

  /*
   * Platform surfaces whose routes we do not own, and so cannot
   * annotate. Bull Board mounts its own route tree under
   * /admin/queues; its queues are shared rather than tenant-scoped and
   * their payloads carry other tenants' ids (§1.6, D4), so the whole
   * subtree is the platform operator's.
   *
   * A prefix list is the lesser of two evils here: the alternative is
   * relaxing the tenant-context refusal for every route that declares
   * no module, which would admit a platform token to /auth/me and
   * anything else unannotated — and /auth/me reads request.user.
   */
  const isPlatformRoute =
    routeConfig?.platform === true ||
    (request.url ?? "").startsWith("/admin/queues");

  /*
   * Platform routes are authorized by identity, not by permission.
   *
   * A route says `{ platform: true }` instead of naming a module,
   * because being the platform actor is the whole authority (D6) — a
   * tenant's own System Admin holds every permission a tenant can grant
   * and still must not act above tenants (§1.2).
   *
   * `getPlatformActor` is the gate: a real row, no tenant, active. The
   * token's claim only chose this branch. Note what is deliberately
   * absent — the tenant path's "no CisUser row ⇒ allow" fallback, which
   * waves through any token whose subject does not exist. A positive
   * lookup cannot have that shape.
   */
  if (isPlatformRoute) {
    const actor = request.platformActor;
    if (!actor) {
      reply.status(403).send({
        error: {
          code: "PLATFORM_REQUIRED",
          message: "This operation is reserved to the platform operator",
        },
      });
      return;
    }
    if (!(await getPlatformActor(actor.id))) {
      reply.status(403).send({
        error: { code: "FORBIDDEN", message: "Not an active platform operator" },
      });
      return;
    }
    return;
  }

  /*
   * And the other direction: a platform token on a tenant route.
   *
   * `request.user` is undefined for a platform request, so without this
   * the handler would read `user.utilityId` off undefined and answer 500
   * — and every tenant-scoped query below would be scoped by undefined.
   * This refusal is what lets `request.user.utilityId` stay a plain
   * string at all 243 of its read sites.
   */
  if (request.platformActor) {
    reply.status(403).send({
      error: {
        code: "TENANT_CONTEXT_REQUIRED",
        message: "This operation acts on one tenant and needs a tenant's user",
      },
    });
    return;
  }

  // No module declared = unprotected route
  if (!routeConfig?.module) {
    // Log warning in dev for unprotected /api/v1/* routes (except /auth/me)
    if (appConfig.NODE_ENV !== "production" && request.url.startsWith("/api/v1/") && !request.url.startsWith("/api/v1/auth/")) {
      request.log.warn(`Unprotected route: ${request.method} ${request.url}`);
    }
    return;
  }

  const { module, permission } = routeConfig;
  const user = request.user;
  if (!user) return; // auth middleware already handled this

  /*
   * Both lookups at once, then the checks in order.
   *
   * Neither depends on the other — one asks what the tenant has turned
   * on, the other what this user may do — so awaiting them in sequence
   * served no purpose but doubled whatever a lookup costs. On a healthy
   * cache that is two round trips instead of one; on a sick one it was
   * two full timeouts, and this pass was adding a flat two seconds to
   * every authenticated request.
   *
   * The checks below stay in their original order, so a disabled module
   * is still reported as MODULE_DISABLED before anything is said about
   * the user's role. Only the fetching moved.
   */
  const [utilityStatus, enabledModules, userRole] = await Promise.all([
    getUtilityStatus(user.utilityId),
    getTenantModules(user.utilityId),
    getUserRole(user.id, user.utilityId),
  ]);

  // 0. The tenant itself has to be active, and this is checked before
  //    the module is, because "module not enabled" for a suspended
  //    tenant sends an operator to the wrong screen entirely. A null
  //    status means the status could not be read, which is not a
  //    suspension — see getUtilityStatus.
  if (utilityStatus === "SUSPENDED") {
    reply.status(403).send({
      error: {
        code: "TENANT_SUSPENDED",
        message: "This utility is suspended. Contact the platform operator.",
      },
    });
    return;
  }

  // 1. Check tenant module is enabled
  if (!enabledModules.includes(module)) {
    reply.status(403).send({
      error: { code: "MODULE_DISABLED", message: `Module "${module}" is not enabled for this tenant` },
    });
    return;
  }

  // 2. Check user role has permission
  // 2. The token has to name a user who exists and holds a role.
  //
  //    This used to return early and allow the request — "backwards
  //    compatibility during migration", from the RBAC migration, which is
  //    long done. What it actually did was hand every permission on every
  //    tenant route to any token whose subject had no `cis_user` row, and
  //    the web login form mints exactly that: its credentials provider
  //    returns a fixed user id which is not in the database. So the
  //    app's own sign-in page was the one caller relying on it.
  //
  //    Closing it was a migration rather than a one-line change (see
  //    architecture §7.1): three suites authenticated with tokens that
  //    had no role mocked and were carried by this branch. Two of them
  //    hung `role` off their `cisUser` mock, which `getUserRole` never
  //    reads — so they looked like they granted permissions and did not.
  if (!userRole) {
    reply.status(403).send({
      error: {
        code: "USER_NOT_PROVISIONED",
        message: "No user record for this token",
      },
    });
    return;
  }

  if (!userRole.isActive) {
    reply.status(403).send({
      error: { code: "USER_INACTIVE", message: "User account is deactivated (BR-RB-009)" },
    });
    return;
  }

  if (permission) {
    const modulePerms = (userRole.permissions as Record<string, string[]>)[module] ?? [];
    if (!modulePerms.includes(permission)) {
      reply.status(403).send({
        error: { code: "FORBIDDEN", message: `Insufficient permissions: requires ${module}:${permission}` },
      });
      return;
    }
  }
}
