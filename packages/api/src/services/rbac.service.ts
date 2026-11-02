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
    // The proved parameter, not `cisUser.utilityId`, which is nullable
    // since the platform actor landed (Q2). The lookup above names the
    // tenant and `utility_id = $1` cannot match NULL, so a platform user
    // never reaches here — this keeps the result non-nullable without
    // asserting that.
    utilityId,
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

  const modules = await prisma.utilityModule.findMany({
    where: { utilityId, isEnabled: true },
    select: { moduleKey: true },
  });

  const moduleKeys = modules.map((m) => m.moduleKey);

  await cacheSet(cacheKey, 600, JSON.stringify(moduleKeys));

  return moduleKeys;
}

/**
 * The tenant's own status, cached beside its modules.
 *
 * Read on every authenticated tenant request, because suspension that
 * only bit at login would leave every token minted beforehand working
 * for its whole lifetime — which is the half of "suspended" that
 * matters.
 *
 * Null means "could not tell", not "suspended": the global prisma mock
 * returns null for an unstubbed `findUnique`, and more importantly a
 * tenant whose status cannot be read must not have its staff locked out
 * by accident. A missing row is not a real case either way — utility_id
 * is a foreign key with ON DELETE RESTRICT, so a utility with users
 * cannot be deleted.
 *
 * The 300s TTL bounds how long a suspension applied outside this service
 * (by SQL, say) takes to bite; `suspendUtility` invalidates the key
 * directly, so the API path is immediate.
 */
/**
 * The two things about a tenant that gate every request: whether it may
 * be used at all, and whether this system is its system of record.
 *
 * One row, one cache entry, one round trip. They are fetched together
 * because they are read together — the authorization pass needs both on
 * every authenticated request, and that pass once added a flat two
 * seconds to every request by fetching its inputs in sequence. A second
 * accessor with a second cache key would have put that back.
 *
 * `null` means the row could not be read, which is deliberately not the
 * same as any particular state: a blip must not take a tenant offline
 * or quietly change what it is allowed to do.
 *
 * The cache key is `utility-guards:`, not the old `utility-status:`, so
 * that a cached bare status string from a previous build can never be
 * parsed as this object — it would yield `operatingMode: undefined`,
 * which reads as FULL, which is the one wrong answer that matters.
 */
export interface UtilityGuards {
  status: "ACTIVE" | "SUSPENDED";
  operatingMode: "FULL" | "OVERLAY";
}

export async function getUtilityGuards(utilityId: string): Promise<UtilityGuards | null> {
  const cacheKey = `utility-guards:${utilityId}`;

  const cached = await cacheGet(cacheKey);
  if (cached) {
    return JSON.parse(cached) as UtilityGuards;
  }

  const utility = await prisma.utility
    .findUnique({
      where: { id: utilityId },
      select: { status: true, operatingMode: true },
    })
    .catch(() => null);

  if (!utility) return null;

  const guards: UtilityGuards = {
    status: utility.status,
    operatingMode: utility.operatingMode,
  };
  await cacheSet(cacheKey, 300, JSON.stringify(guards));
  return guards;
}

/** The status alone, for callers that do not care about the mode. */
export async function getUtilityStatus(
  utilityId: string,
): Promise<"ACTIVE" | "SUSPENDED" | null> {
  return (await getUtilityGuards(utilityId))?.status ?? null;
}

/**
 * Drop a tenant's cached guards, so a suspension — or a conversion out
 * of overlay mode — bites at once rather than up to 300s later.
 *
 * The old key is cleared too: a build that wrote it may have left an
 * entry behind, and nothing else will ever remove it.
 */
export async function invalidateUtilityStatusCache(utilityId: string): Promise<void> {
  await cacheDel(`utility-guards:${utilityId}`);
  await cacheDel(`utility-status:${utilityId}`);
}

/**
 * Resolve the platform actor, or null.
 *
 * This lookup *is* the authorization for a platform route. The token's
 * `platform: true` claim only selects which lookup runs — the authority
 * is a real row with no tenant and an active flag, so a tenant user's id
 * minted into a platform-claiming token resolves to nothing.
 *
 * No role, and no permission map: being the platform actor is the whole
 * authority (D6). A second class of platform actor is what would earn a
 * matrix, and none exists.
 *
 * Both predicates are part of the query rather than checks after it, so
 * a deactivated actor is simply not found.
 */
export async function getPlatformActor(
  userId: string,
): Promise<{ id: string; email: string; name: string } | null> {
  const cacheKey = `platform-actor:${userId}`;

  const cached = await cacheGet(cacheKey);
  if (cached) {
    return JSON.parse(cached) as { id: string; email: string; name: string };
  }

  const actor = await prisma.cisUser
    .findFirst({
      where: { id: userId, utilityId: null, isActive: true },
      select: { id: true, email: true, name: true },
    })
    .catch(() => null);

  if (!actor) return null;

  await cacheSet(cacheKey, 300, JSON.stringify(actor));
  return actor;
}

/**
 * Drop a platform actor's cached row — on deactivation or deletion,
 * which is the window in which a revoked actor would otherwise keep
 * working for up to the TTL.
 */
export async function invalidatePlatformActorCache(userId: string): Promise<void> {
  await cacheDel(`platform-actor:${userId}`);
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
