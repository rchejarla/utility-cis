import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuthMe, invalidateUserRoleCache } from "../services/rbac.service.js";
import { prisma } from "../lib/prisma.js";

const IS_PROD = process.env.NODE_ENV === "production";
const DEV_AUTH_ENDPOINTS_ENABLED =
  !IS_PROD && process.env.ENABLE_DEV_AUTH_ENDPOINTS === "true";

const switchRoleSchema = z.object({
  roleId: z.string().uuid(),
});

export async function authRoutes(app: FastifyInstance) {
  app.get("/api/v1/auth/me", async (request) => {
    const { id: userId, utilityId, email, name } = request.user;
    const authData = await getAuthMe(userId, utilityId);

    return {
      user: {
        id: userId,
        email,
        name,
        roleId: authData.user?.roleId ?? null,
        roleName: authData.user?.roleName ?? "unknown",
      },
      permissions: authData.permissions,
      enabledModules: authData.enabledModules,
    };
  });

  if (!DEV_AUTH_ENDPOINTS_ENABLED) {
    app.log.info(
      "[auth] dev-only endpoints disabled (set ENABLE_DEV_AUTH_ENDPOINTS=true in non-prod to enable)"
    );
    return;
  }

  // Dev-only: switch current user's role. Guarded by NODE_ENV + explicit env flag.
  // Marked as settings:EDIT so RBAC middleware enforces permission.
  app.post(
    "/api/v1/auth/switch-role",
    { config: { module: "settings", permission: "EDIT" } },
    async (request, reply) => {
      const { id: userId, utilityId } = request.user;
      const { roleId } = switchRoleSchema.parse(request.body);

      // Verify the role belongs to the same tenant before assignment.
      const role = await prisma.role.findFirst({
        where: { id: roleId, utilityId },
        select: { id: true },
      });
      if (!role) {
        reply.status(404).send({
          error: { code: "ROLE_NOT_FOUND", message: "Role not found in this tenant" },
        });
        return;
      }

      await prisma.cisUser.update({
        where: { id: userId },
        data: { roleId },
      });

      await invalidateUserRoleCache(userId, utilityId);

      const authData = await getAuthMe(userId, utilityId);
      reply.send(authData);
    }
  );

  // Dev-only: list users with roles. Requires settings:VIEW.
  app.get(
    "/api/v1/auth/dev-users",
    { config: { module: "settings", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const users = await prisma.cisUser.findMany({
        where: { utilityId },
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          role: { select: { id: true, name: true } },
        },
        orderBy: { name: "asc" },
      });
      return users;
    }
  );

  // Dev-only: list roles. Requires settings:VIEW.
  app.get(
    "/api/v1/auth/roles",
    { config: { module: "settings", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const roles = await prisma.role.findMany({
        where: { utilityId },
        include: { _count: { select: { users: true } } },
        orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      });
      return roles;
    }
  );
}
