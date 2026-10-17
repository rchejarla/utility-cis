import type { FastifyRequest, FastifyReply } from "fastify";
import { getUserRole, getTenantModules } from "../services/rbac.service.js";
import { config as appConfig } from "../config.js";

export async function authorizationMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const routeConfig = request.routeOptions?.config as { module?: string; permission?: string } | undefined;

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
  const [enabledModules, userRole] = await Promise.all([
    getTenantModules(user.utilityId),
    getUserRole(user.id, user.utilityId),
  ]);

  // 1. Check tenant module is enabled
  if (!enabledModules.includes(module)) {
    reply.status(403).send({
      error: { code: "MODULE_DISABLED", message: `Module "${module}" is not enabled for this tenant` },
    });
    return;
  }

  // 2. Check user role has permission
  if (!userRole) {
    // User not in CIS User table — allow for now (backwards compatibility during migration)
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
