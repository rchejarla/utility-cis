import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuthMe, invalidateUserRoleCache } from "../services/rbac.service.js";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";

const IS_PROD = config.NODE_ENV === "production";
const DEV_AUTH_ENDPOINTS_ENABLED = !IS_PROD && config.ENABLE_DEV_AUTH_ENDPOINTS;

const switchRoleSchema = z.object({
  roleId: z.string().uuid(),
});

export async function authRoutes(app: FastifyInstance) {
  app.get("/api/v1/auth/me", async (request) => {
    const { id: userId, utilityId, email, name, customerId } = request.user;
    const authData = await getAuthMe(userId, utilityId);

    return {
      user: {
        id: userId,
        email,
        name,
        roleId: authData.user?.roleId ?? null,
        roleName: authData.user?.roleName ?? "unknown",
        customerId: customerId ?? authData.user?.customerId ?? null,
      },
      permissions: authData.permissions,
      enabledModules: authData.enabledModules,
    };
  });

  // Dev-login: unauthenticated, available in non-prod only. Takes an email
  // and returns a dev JWT with the right claims (including customer_id for
  // portal users). Used by the /login page and the /dev card launcher.
  if (!IS_PROD) {
    const devLoginSchema = z.object({
      email: z.string().email(),
      utilityId: z.string().uuid().default("00000000-0000-4000-8000-000000000001"),
    });

    app.post(
      "/api/v1/auth/dev-login",
      { config: { skipAuth: true } },
      async (request, reply) => {
        const { email, utilityId } = devLoginSchema.parse(request.body);

        const user = await prisma.cisUser.findFirst({
          where: { utilityId, email: email.toLowerCase(), isActive: true },
        });

        if (!user) {
          return reply.status(401).send({
            error: { code: "USER_NOT_FOUND", message: "No active user found with this email" },
          });
        }

        // Tenant-wide role lives in user_role with account_id NULL.
        // Per-account portal roles are resolved by the portal's active-
        // account middleware later; this dev-login token captures the
        // tenant-wide identity only.
        const tenantWide = await prisma.userRole.findFirst({
          where: { userId: user.id, utilityId, accountId: null },
          include: { role: { select: { name: true } } },
        });
        const roleName = tenantWide?.role.name ?? "Portal Customer";

        const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({
          sub: user.id,
          utility_id: utilityId,
          email: user.email,
          name: user.name,
          role: roleName,
          customer_id: user.customerId ?? undefined,
        })).toString("base64url");
        const token = `${header}.${payload}.dev`;

        const isPortal = user.customerId !== null;

        return reply.send({
          token,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            roleName,
            customerId: user.customerId ?? null,
          },
          isPortal,
          redirectTo: isPortal ? "/portal/dashboard" : "/premises",
        });
      },
    );
  }

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

      // Tenant-wide row is unique-by-user via the partial index; can't
      // use Prisma's upsert with a composite key that includes a
      // nullable column (Postgres treats NULL as distinct, so the
      // composite key isn't a single matching row to upsert against).
      const existing = await prisma.userRole.findFirst({
        where: { userId, utilityId, accountId: null },
        select: { id: true },
      });
      if (existing) {
        await prisma.userRole.update({ where: { id: existing.id }, data: { roleId } });
      } else {
        await prisma.userRole.create({
          data: { utilityId, userId, accountId: null, roleId },
        });
      }

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
      // Resolve each user's tenant-wide role (account_id NULL). Users
      // who only have per-account roles (portal-only) show as null.
      const users = await prisma.cisUser.findMany({
        where: { utilityId },
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          customerId: true,
          userRoles: {
            where: { accountId: null },
            select: { role: { select: { id: true, name: true } } },
            take: 1,
          },
        },
        orderBy: { name: "asc" },
      });
      return users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        isActive: u.isActive,
        customerId: u.customerId,
        role: u.userRoles[0]?.role ?? null,
      }));
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
        include: { _count: { select: { userRoles: true } } },
        orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      });
      // Preserve the legacy response shape (`_count.users`) so the
      // /users-roles UI doesn't need to change.
      return roles.map((r) => ({
        ...r,
        _count: { users: r._count.userRoles },
      }));
    }
  );
}
