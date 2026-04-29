import { prisma } from "../lib/prisma.js";
import { invalidateUserRoleCache } from "./rbac.service.js";
import type { CreateUserInput, UpdateUserInput, UserQuery } from "@utility-cis/shared";

/**
 * User CRUD service. After Slice 1, role assignments live on
 * user_role, not on cis_user.role_id. The CreateUserInput / UpdateUser
 * Input still carries `roleId` for ergonomic admin API parity — we
 * persist it as a tenant-wide user_role row (account_id NULL). Per-
 * account portal roles are managed through a separate user-role
 * service (Slice 2).
 *
 * The list/get response shape preserves the pre-migration `role`
 * field so the existing /users-roles UI keeps rendering: we hydrate
 * each user with their tenant-wide role on the way out.
 */

interface RoleSummary {
  id: string;
  name: string;
  permissions: unknown;
  isSystem: boolean;
}

interface UserDTO {
  id: string;
  utilityId: string;
  externalId: string | null;
  email: string;
  name: string;
  customerId: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  role: RoleSummary | null;
}

async function hydrateRole(
  utilityId: string,
  userId: string,
): Promise<RoleSummary | null> {
  const assignment = await prisma.userRole.findFirst({
    where: { userId, utilityId, accountId: null },
    select: { role: { select: { id: true, name: true, permissions: true, isSystem: true } } },
  });
  return assignment?.role ?? null;
}

async function toDto(
  utilityId: string,
  user: {
    id: string;
    utilityId: string;
    externalId: string | null;
    email: string;
    name: string;
    customerId: string | null;
    isActive: boolean;
    lastLoginAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
): Promise<UserDTO> {
  return { ...user, role: await hydrateRole(utilityId, user.id) };
}

export async function listUsers(utilityId: string, query: UserQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: "insensitive" } },
      { email: { contains: query.search, mode: "insensitive" } },
    ];
  }
  if (query.isActive !== undefined) where.isActive = query.isActive;
  // roleId filter now joins through user_role.
  if (query.roleId) {
    where.userRoles = { some: { roleId: query.roleId, accountId: null } };
  }

  const page = Math.max(1, query.page ?? 1);
  const limit = Math.max(1, Math.min(500, query.limit ?? 20));
  const [data, total] = await Promise.all([
    prisma.cisUser.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.cisUser.count({ where }),
  ]);
  const hydrated = await Promise.all(data.map((u) => toDto(utilityId, u)));
  return {
    data: hydrated,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getUser(id: string, utilityId: string) {
  const user = await prisma.cisUser.findUniqueOrThrow({
    where: { id, utilityId },
  });
  return toDto(utilityId, user);
}

export async function createUser(utilityId: string, data: CreateUserInput) {
  const { roleId, ...userData } = data;
  return prisma.$transaction(async (tx) => {
    const created = await tx.cisUser.create({
      data: { ...userData, utilityId },
    });
    if (roleId) {
      await tx.userRole.create({
        data: { utilityId, userId: created.id, accountId: null, roleId },
      });
    }
    return toDto(utilityId, created);
  });
}

export async function updateUser(utilityId: string, id: string, data: UpdateUserInput) {
  const { roleId, ...userData } = data;
  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.cisUser.update({
      where: { id, utilityId },
      data: userData,
    });
    if (roleId !== undefined) {
      // Replace the tenant-wide assignment.
      const existing = await tx.userRole.findFirst({
        where: { userId: id, utilityId, accountId: null },
        select: { id: true },
      });
      if (existing) {
        await tx.userRole.update({ where: { id: existing.id }, data: { roleId } });
      } else {
        await tx.userRole.create({
          data: { utilityId, userId: id, accountId: null, roleId },
        });
      }
    }
    return updated;
  });

  await invalidateUserRoleCache(id, utilityId);
  return toDto(utilityId, user);
}
