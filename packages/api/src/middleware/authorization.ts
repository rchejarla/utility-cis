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

  // 1. Check tenant module is enabled
  const enabledModules = await getTenantModules(user.utilityId);
  if (!enabledModules.includes(module)) {
    reply.status(403).send({
      error: { code: "MODULE_DISABLED", message: `Module "${module}" is not enabled for this tenant` },
    });
    return;
  }

  // 2. Check user role has permission
  const userRole = await getUserRole(user.id, user.utilityId);
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
