import type { FastifyInstance } from "fastify";
import { getAuthMe } from "../services/rbac.service.js";

export async function authRoutes(app: FastifyInstance) {
  // No module/permission config — always accessible to authenticated users
  app.get("/api/v1/auth/me", async (request) => {
    const { id: userId, utilityId, email, name, role } = request.user;
    const authData = await getAuthMe(userId, utilityId);

    return {
      user: {
        id: userId,
        email,
        name,
        roleId: authData.user?.roleId ?? null,
        roleName: authData.user?.roleName ?? role ?? "unknown",
      },
      permissions: authData.permissions,
      enabledModules: authData.enabledModules,
    };
  });
}
