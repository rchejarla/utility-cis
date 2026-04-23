import { prisma } from "../lib/prisma.js";
import { cacheDel, cacheGet, cacheSet } from "../lib/redis.js";
import type { PermissionMap } from "@utility-cis/shared";

interface UserRoleResult {
  userId: string;
  utilityId: string;
  roleId: string;
  roleName: string;
  permissions: PermissionMap;
  isActive: boolean;
  customerId: string | null;
}

function userRoleCacheKey(utilityId: string, userId: string): string {
  return `user-role:${utilityId}:${userId}`;
}

export async function getUserRole(
  userId: string,
  utilityId: string
): Promise<UserRoleResult | null> {
  const cacheKey = userRoleCacheKey(utilityId, userId);

  const cached = await cacheGet(cacheKey);
  if (cached) {
    return JSON.parse(cached) as UserRoleResult;
  }

  // Always scope by tenant. A user ID should never be trusted across tenants.
  const cisUser = await prisma.cisUser
    .findFirst({
      where: { id: userId, utilityId },
      include: { role: true },
    })
    .catch(() => null);

  if (!cisUser) {
    return null;
  }

  const result: UserRoleResult = {
    userId: cisUser.id,
    utilityId: cisUser.utilityId,
    roleId: cisUser.roleId,
    roleName: cisUser.role.name,
    permissions: cisUser.role.permissions as PermissionMap,
    isActive: cisUser.isActive,
    customerId: cisUser.customerId ?? null,
  };

  await cacheSet(cacheKey, 300, JSON.stringify(result));

  return result;
}

export async function getTenantModules(utilityId: string): Promise<string[]> {
  const cacheKey = `tenant-modules:${utilityId}`;

  const cached = await cacheGet(cacheKey);
  if (cached) {
    return JSON.parse(cached) as string[];
  }

  const modules = await prisma.tenantModule.findMany({
    where: { utilityId, isEnabled: true },
    select: { moduleKey: true },
  });

  const moduleKeys = modules.map((m) => m.moduleKey);

  await cacheSet(cacheKey, 600, JSON.stringify(moduleKeys));

  return moduleKeys;
}

export async function invalidateUserRoleCache(
  userId: string,
  utilityId: string
): Promise<void> {
  await cacheDel(userRoleCacheKey(utilityId, userId));
}

export async function invalidateTenantModulesCache(utilityId: string): Promise<void> {
  await cacheDel(`tenant-modules:${utilityId}`);
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
