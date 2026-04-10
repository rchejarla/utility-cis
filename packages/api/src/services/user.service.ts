import { prisma } from "../lib/prisma.js";
import { paginatedTenantList } from "../lib/pagination.js";
import { invalidateUserRoleCache } from "./rbac.service.js";
import type { CreateUserInput, UpdateUserInput, UserQuery } from "@utility-cis/shared";

export async function listUsers(utilityId: string, query: UserQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: "insensitive" } },
      { email: { contains: query.search, mode: "insensitive" } },
    ];
  }

  if (query.roleId) where.roleId = query.roleId;
  if (query.isActive !== undefined) where.isActive = query.isActive;

  return paginatedTenantList(prisma.cisUser, where, query, {
    include: { role: true },
  });
}

export async function getUser(id: string, utilityId: string) {
  return prisma.cisUser.findUniqueOrThrow({
    where: { id, utilityId },
    include: { role: true },
  });
}

export async function createUser(utilityId: string, data: CreateUserInput) {
  // invalidateUserRoleCache not called — no cache exists yet for new user
  return prisma.cisUser.create({
    data: { ...data, utilityId },
    include: { role: true },
  });
}

export async function updateUser(utilityId: string, id: string, data: UpdateUserInput) {
  const user = await prisma.cisUser.update({
    where: { id, utilityId },
    data,
    include: { role: true },
  });

  await invalidateUserRoleCache(id, utilityId);

  return user;
}
