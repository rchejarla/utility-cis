import type { FastifyInstance } from "fastify";
import { getAuthMe } from "../services/rbac.service.js";
import { MODULES, PERMISSIONS } from "@utility-cis/shared";

// Full permissions fallback for users not yet in the CisUser table
const FULL_PERMISSIONS = Object.fromEntries(
  MODULES.map((m) => [m, [...PERMISSIONS]])
);
const ALL_MODULES = [...MODULES];

export async function authRoutes(app: FastifyInstance) {
  // No module/permission config — always accessible to authenticated users
  app.get("/api/v1/auth/me", async (request) => {
    const { id: userId, utilityId, email, name, role } = request.user;
    const authData = await getAuthMe(userId, utilityId);

    // If no CisUser record found, grant full permissions (backwards compatibility)
    const hasUser = authData.user !== null;
    const permissions = hasUser ? authData.permissions : FULL_PERMISSIONS;
    const enabledModules = authData.enabledModules.length > 0 ? authData.enabledModules : ALL_MODULES;

    return {
      user: {
        id: userId,
        email,
        name,
        roleId: authData.user?.roleId ?? null,
        roleName: authData.user?.roleName ?? role ?? "admin",
      },
      permissions,
      enabledModules,
    };
  });
}
