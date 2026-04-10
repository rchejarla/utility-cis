import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import type { PermissionMap } from "@utility-cis/shared";

interface UserRoleResult {
  userId: string;
  roleId: string;
  roleName: string;
  permissions: PermissionMap;
  isActive: boolean;
}

export async function getUserRole(
  userId: string,
  utilityId: string
): Promise<UserRoleResult | null> {
  const cacheKey = `user-role:${userId}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as UserRoleResult;
  }

  const cisUser = await prisma.cisUser.findUnique({
    where: { id: userId },
    include: { role: true },
  }).catch(() => null);

  if (!cisUser) {
    return null;
  }

  const result: UserRoleResult = {
    userId: cisUser.id,
    roleId: cisUser.roleId,
    roleName: cisUser.role.name,
    permissions: cisUser.role.permissions as PermissionMap,
    isActive: cisUser.isActive,
  };

  await redis.setex(cacheKey, 300, JSON.stringify(result));

  return result;
}

export async function getTenantModules(utilityId: string): Promise<string[]> {
  const cacheKey = `tenant-modules:${utilityId}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as string[];
  }

  const modules = await prisma.tenantModule.findMany({
    where: { utilityId, isEnabled: true },
    select: { moduleKey: true },
  });

  const moduleKeys = modules.map((m) => m.moduleKey);

  await redis.setex(cacheKey, 600, JSON.stringify(moduleKeys));

  return moduleKeys;
}

export async function invalidateUserRoleCache(userId: string): Promise<void> {
  await redis.del(`user-role:${userId}`);
}

export async function invalidateTenantModulesCache(utilityId: string): Promise<void> {
  await redis.del(`tenant-modules:${utilityId}`);
}

export async function getAuthMe(
  userId: string,
  utilityId: string
): Promise<{
  user: UserRoleResult | null;
  permissions: PermissionMap;
  enabledModules: string[];
}> {
  const [userRole, enabledModules] = await Promise.all([
    getUserRole(userId, utilityId),
    getTenantModules(utilityId),
  ]);

  return {
    user: userRole,
    permissions: userRole?.permissions ?? {},
    enabledModules,
  };
}
