import type { FastifyInstance } from "fastify";
import { getAuthMe, invalidateUserRoleCache } from "../services/rbac.service.js";
import { prisma } from "../lib/prisma.js";

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

  // Dev-only: switch role without permission check (no module/permission config)
  app.post("/api/v1/auth/switch-role", async (request, reply) => {
    const { id: userId, utilityId } = request.user;
    const { roleId } = request.body as { roleId: string };

    await prisma.cisUser.update({
      where: { id: userId },
      data: { roleId },
    });

    await invalidateUserRoleCache(userId);

    const authData = await getAuthMe(userId, utilityId);
    reply.send(authData);
  });
}
