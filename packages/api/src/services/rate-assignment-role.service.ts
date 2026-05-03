import { prisma } from "../lib/prisma.js";
import type {
  CreateRateAssignmentRoleInput,
  UpdateRateAssignmentRoleInput,
} from "@utility-cis/shared";

/**
 * Reference-table service for rate-assignment role codes — the v2 rate
 * model's top-level discriminator on a rate→service-agreement
 * assignment. Same global + tenant-shadow pattern as
 * rate_component_kind / measure_type_def: utility_id NULL = system
 * global, utility_id NOT NULL = per-tenant override that wins per code.
 *
 * Codebase-defined codes only — the rate engine (slice 3) dispatches
 * on these, so tenants cannot introduce new codes.
 */

interface ResolvedRole {
  id: string;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  isGlobal: boolean;
}

export async function listRateAssignmentRoles(utilityId: string): Promise<ResolvedRole[]> {
  const rows = await prisma.rateAssignmentRole.findMany({
    where: { OR: [{ utilityId: null }, { utilityId }] },
    orderBy: [{ code: "asc" }],
  });

  const byCode = new Map<string, ResolvedRole>();
  for (const r of rows) {
    const existing = byCode.get(r.code);
    const resolved: ResolvedRole = {
      id: r.id,
      code: r.code,
      label: r.label,
      description: r.description,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
      isGlobal: r.utilityId === null,
    };
    if (!existing || (existing.isGlobal && r.utilityId === utilityId)) {
      byCode.set(r.code, resolved);
    }
  }

  return [...byCode.values()]
    .filter((r) => r.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function getRateAssignmentRole(id: string, utilityId: string) {
  return prisma.rateAssignmentRole.findUniqueOrThrow({
    where: { id, utilityId },
  });
}

export async function createRateAssignmentRole(
  utilityId: string,
  data: CreateRateAssignmentRoleInput,
) {
  return prisma.rateAssignmentRole.create({
    data: { ...data, utilityId },
  });
}

export async function updateRateAssignmentRole(
  utilityId: string,
  id: string,
  data: UpdateRateAssignmentRoleInput,
) {
  return prisma.rateAssignmentRole.update({
    where: { id, utilityId },
    data,
  });
}

export async function deleteRateAssignmentRole(utilityId: string, id: string) {
  return prisma.rateAssignmentRole.delete({
    where: { id, utilityId },
  });
}
