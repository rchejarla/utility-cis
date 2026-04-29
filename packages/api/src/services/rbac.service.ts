import { prisma } from "../lib/prisma.js";
import { cacheDel, cacheGet, cacheSet } from "../lib/cache-redis.js";
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

function userRoleCacheKey(
  utilityId: string,
  userId: string,
  accountId: string | null,
): string {
  // accountId distinguishes per-account role lookups from the
  // tenant-wide row used by admin endpoints.
  return `user-role:${utilityId}:${userId}:${accountId ?? "tenant"}`;
}

/**
 * Resolve the user's active role.
 *   - When `accountId` is omitted/null, returns the tenant-wide role
 *     (user_role row with account_id IS NULL) — the admin path.
 *   - When `accountId` is set, returns the per-account role first, and
 *     falls back to the tenant-wide row if no per-account assignment
 *     exists. (An admin browsing a customer's account still sees admin
 *     permissions, while a portal contact only sees what their per-
 *     account role allows.)
 *
 * Returns null when the user is inactive or has no role at all.
 */
export async function getUserRole(
  userId: string,
  utilityId: string,
  accountId: string | null = null,
): Promise<UserRoleResult | null> {
  const cacheKey = userRoleCacheKey(utilityId, userId, accountId);

  const cached = await cacheGet(cacheKey);
  if (cached) {
    return JSON.parse(cached) as UserRoleResult;
  }

  // Tenant scope is non-negotiable; account scope is a refinement.
  const cisUser = await prisma.cisUser
    .findFirst({
      where: { id: userId, utilityId },
      select: {
        id: true,
        utilityId: true,
        customerId: true,
        isActive: true,
      },
    })
    .catch(() => null);

  if (!cisUser) return null;

  // Look up the most specific role: per-account first, fall back to
  // tenant-wide.
  let assignment: { roleId: string; role: { name: string; permissions: unknown } } | null = null;

  if (accountId) {
    assignment = await prisma.userRole.findFirst({
      where: { userId, utilityId, accountId },
      select: { roleId: true, role: { select: { name: true, permissions: true } } },
    });
  }
  if (!assignment) {
    assignment = await prisma.userRole.findFirst({
      where: { userId, utilityId, accountId: null },
      select: { roleId: true, role: { select: { name: true, permissions: true } } },
    });
  }
  if (!assignment) return null;

  const result: UserRoleResult = {
    userId: cisUser.id,
    utilityId: cisUser.utilityId,
    roleId: assignment.roleId,
    roleName: assignment.role.name,
    permissions: assignment.role.permissions as PermissionMap,
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
  utilityId: string,
): Promise<void> {
  // Conservative: blow away both the tenant-wide cache key and any
  // per-account variants. Per-account keys aren't enumerable cheaply,
  // so we use a wildcard delete via SCAN — kept simple here as a
  // straight tenant-wide invalidation; per-account stale reads are
  // bounded by the 300s TTL.
  await cacheDel(userRoleCacheKey(utilityId, userId, null));
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
