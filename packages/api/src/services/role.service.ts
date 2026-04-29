import { prisma } from "../lib/prisma.js";
import { invalidateUserRoleCache } from "./rbac.service.js";
import type { CreateRoleInput, UpdateRoleInput } from "@utility-cis/shared";

/**
 * Slice 1 reshape: role assignments live on user_role, not directly on
 * cis_user. The legacy `_count.users` shape on the API response is
 * preserved by mapping `_count.userRoles → _count.users` so the
 * existing /users-roles UI keeps rendering. The count now reflects
 * total user_role assignments (including per-account portal roles)
 * rather than the prior cis_user.role_id headcount.
 */

type RoleWithCount = Awaited<ReturnType<typeof loadOne>>;

async function loadOne(id: string, utilityId: string) {
  return prisma.role.findUniqueOrThrow({
    where: { id, utilityId },
    include: { _count: { select: { userRoles: true } } },
  });
}

function withLegacyUsersCount<T extends { _count: { userRoles: number } }>(role: T) {
  const { _count, ...rest } = role;
  return { ...rest, _count: { users: _count.userRoles } };
}

export async function listRoles(utilityId: string) {
  const rows = await prisma.role.findMany({
    where: { utilityId },
    include: { _count: { select: { userRoles: true } } },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
  return rows.map(withLegacyUsersCount);
}

export async function getRole(id: string, utilityId: string) {
  const role = await loadOne(id, utilityId);
  return withLegacyUsersCount(role);
}

export async function createRole(utilityId: string, data: CreateRoleInput) {
  const role = await prisma.role.create({
    data: { ...data, utilityId },
    include: { _count: { select: { userRoles: true } } },
  });
  return withLegacyUsersCount(role);
}

export async function updateRole(utilityId: string, id: string, data: UpdateRoleInput) {
  const role = await prisma.role.update({
    where: { id, utilityId },
    data,
    include: { _count: { select: { userRoles: true } } },
  });

  // Invalidate cache for every user with this role (any scope).
  const assignments = await prisma.userRole.findMany({
    where: { roleId: id, utilityId },
    select: { userId: true },
    distinct: ["userId"],
  });
  await Promise.all(
    assignments.map((a) => invalidateUserRoleCache(a.userId, utilityId)),
  );

  return withLegacyUsersCount(role);
}

export async function deleteRole(utilityId: string, id: string) {
  // BR-RB-002: System roles cannot be deleted
  const role = await prisma.role.findUnique({ where: { id, utilityId } });
  if (!role) {
    throw Object.assign(new Error("Role not found"), { statusCode: 404 });
  }
  if (role.isSystem) {
    throw Object.assign(
      new Error("Cannot delete a system role (BR-RB-002)"),
      { statusCode: 400, code: "SYSTEM_ROLE" },
    );
  }

  // BR-RB-003: Roles in use (assigned to any user, on any scope) can't
  // be deleted. The check is now over user_role rather than
  // cis_user.role_id.
  const assignmentCount = await prisma.userRole.count({ where: { roleId: id, utilityId } });
  if (assignmentCount > 0) {
    throw Object.assign(
      new Error(
        `Cannot delete role — ${assignmentCount} assignment(s) reference it (BR-RB-003)`,
      ),
      { statusCode: 400, code: "ROLE_IN_USE" },
    );
  }

  const result = await prisma.role.deleteMany({ where: { id, utilityId } });
  if (result.count === 0) {
    throw Object.assign(new Error("Role not found"), { statusCode: 404 });
  }
  return result;
}
