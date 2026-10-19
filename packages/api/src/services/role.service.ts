import { prisma } from "../lib/prisma.js";
import { invalidateUserRoleCache } from "./rbac.service.js";
import { writeAuditRow } from "../lib/audit-wrap.js";
import { prisma as prismaClient } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
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

/**
 * Who changed a role, for the audit row.
 *
 * Required on every mutation, because a role change is a change to what
 * somebody may do and an unattributed one answers none of the questions
 * the log exists for. `source` is unset for a tenant's own admin — the
 * column's convention — and `platform:<actorId>` when the change came
 * from above the tenant.
 */
export interface RoleActor {
  actorId: string | null;
  actorName: string;
  source?: string;
}

const auditCtx = (utilityId: string, actor: RoleActor) => ({
  utilityId,
  actorId: actor.actorId,
  actorName: actor.actorName,
  entityType: "Role",
  source: actor.source,
});

export async function createRole(utilityId: string, data: CreateRoleInput, actor: RoleActor) {
  const role = await prismaClient.$transaction(async (tx) => {
    const created = await tx.role.create({
      data: { ...data, utilityId },
      include: { _count: { select: { userRoles: true } } },
    });
    await writeAuditRow(
      tx,
      auditCtx(utilityId, actor),
      EVENT_TYPES.ROLE_CREATED,
      created.id,
      null,
      { name: created.name, description: created.description, permissions: created.permissions },
    );
    return created;
  });
  return withLegacyUsersCount(role);
}

export async function updateRole(
  utilityId: string,
  id: string,
  data: UpdateRoleInput,
  actor: RoleActor,
) {
  const before = await prisma.role.findUnique({
    where: { id, utilityId },
    select: { name: true, description: true, permissions: true },
  });

  const role = await prismaClient.$transaction(async (tx) => {
    const updated = await tx.role.update({
      where: { id, utilityId },
      data,
      include: { _count: { select: { userRoles: true } } },
    });
    await writeAuditRow(
      tx,
      auditCtx(utilityId, actor),
      EVENT_TYPES.ROLE_UPDATED,
      id,
      before,
      { name: updated.name, description: updated.description, permissions: updated.permissions },
    );
    return updated;
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

export async function deleteRole(utilityId: string, id: string, actor: RoleActor) {
  /*
   * BR-RB-002 ("a system role cannot be deleted") was removed on
   * 2026-10-19, and deliberately not replaced.
   *
   * It protected nothing. BR-RB-003 below refuses any role that somebody
   * holds, so a deletable role is by definition one whose removal takes
   * no permission away from anyone — deletion cannot cause a lockout.
   * What the rule did instead was leave every utility permanently
   * carrying all six presets, Portal Customer on a utility with no
   * portal and Field Technician on one with no field staff, with no way
   * to shed either.
   *
   * The real lockout exposure is *editing* an assigned role down to
   * nothing, which neither rule addresses and which is recoverable from
   * the platform console.
   */
  const role = await prisma.role.findUnique({ where: { id, utilityId } });
  if (!role) {
    throw Object.assign(new Error("Role not found"), { statusCode: 404 });
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

  // The row records what was removed, since after the delete there is
  // nothing left to look up.
  return prismaClient.$transaction(async (tx) => {
    const result = await tx.role.deleteMany({ where: { id, utilityId } });
    if (result.count === 0) {
      throw Object.assign(new Error("Role not found"), { statusCode: 404 });
    }
    await writeAuditRow(
      tx,
      auditCtx(utilityId, actor),
      EVENT_TYPES.ROLE_DELETED,
      id,
      { name: role.name, description: role.description, permissions: role.permissions },
      null,
    );
    return result;
  });
}
