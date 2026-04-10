import { prisma } from "../lib/prisma.js";
import { invalidateUserRoleCache } from "./rbac.service.js";
import type { CreateRoleInput, UpdateRoleInput } from "@utility-cis/shared";

export async function listRoles(utilityId: string) {
  return prisma.cisRole.findMany({
    where: { utilityId },
    include: { _count: { select: { users: true } } },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
}

export async function getRole(id: string, utilityId: string) {
  return prisma.cisRole.findUniqueOrThrow({
    where: { id, utilityId },
    include: { _count: { select: { users: true } } },
  });
}

export async function createRole(utilityId: string, data: CreateRoleInput) {
  return prisma.cisRole.create({
    data: { ...data, utilityId },
    include: { _count: { select: { users: true } } },
  });
}

export async function updateRole(utilityId: string, id: string, data: UpdateRoleInput) {
  const role = await prisma.cisRole.update({
    where: { id, utilityId },
    data,
    include: { _count: { select: { users: true } } },
  });

  // Invalidate cache for all users with this role
  const usersWithRole = await prisma.cisUser.findMany({ where: { roleId: id, utilityId }, select: { id: true } });
  for (const u of usersWithRole) {
    await invalidateUserRoleCache(u.id);
  }

  return role;
}

export async function deleteRole(utilityId: string, id: string) {
  // BR-RB-002: System roles cannot be deleted
  const role = await prisma.cisRole.findUnique({ where: { id, utilityId } });
  if (!role) {
    throw Object.assign(new Error("Role not found"), { statusCode: 404 });
  }
  if (role.isSystem) {
    throw Object.assign(
      new Error("Cannot delete a system role (BR-RB-002)"),
      { statusCode: 400, code: "SYSTEM_ROLE" }
    );
  }

  // BR-RB-003: Roles with users cannot be deleted
  const userCount = await prisma.cisUser.count({ where: { roleId: id } });
  if (userCount > 0) {
    throw Object.assign(
      new Error(`Cannot delete role — ${userCount} user(s) are assigned to it (BR-RB-003)`),
      { statusCode: 400, code: "ROLE_IN_USE" }
    );
  }

  const result = await prisma.cisRole.deleteMany({ where: { id, utilityId } });
  if (result.count === 0) {
    throw Object.assign(new Error("Role not found"), { statusCode: 404 });
  }
  return result;
}
