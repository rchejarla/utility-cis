import { prisma } from "../lib/prisma.js";
import type {
  CreateRateComponentKindInput,
  UpdateRateComponentKindInput,
} from "@utility-cis/shared";

/**
 * Reference-table service for rate-component kind codes — the v2 rate
 * model's top-level discriminator on a RateComponent. Same global +
 * tenant-shadow pattern used by measure_type_def / premise_type_def /
 * account_type_def: utility_id NULL = system-defined global; utility_id
 * NOT NULL = per-tenant override that wins over the global with the
 * same code.
 *
 * Codebase-defined codes only — the rate engine (slice 3) dispatches
 * on these, so tenants cannot introduce new codes.
 */

interface ResolvedKind {
  id: string;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  isGlobal: boolean;
}

export async function listRateComponentKinds(utilityId: string): Promise<ResolvedKind[]> {
  // Fetch all globals + tenant overrides regardless of is_active.
  // The merge loop below requires visibility into INACTIVE overrides
  // because a tenant's isActive:false override is the documented way
  // to disable a global kind for that tenant — filtering at the SQL
  // layer would silently expose the global instead. The .filter(...)
  // at the end strips the resolved (post-override) inactive rows.
  const rows = await prisma.rateComponentKind.findMany({
    where: { OR: [{ utilityId: null }, { utilityId }] },
    orderBy: [{ code: "asc" }],
  });

  const byCode = new Map<string, ResolvedKind>();
  for (const r of rows) {
    const existing = byCode.get(r.code);
    const resolved: ResolvedKind = {
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
    .filter((k) => k.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function getRateComponentKind(id: string, utilityId: string) {
  // Tenant-only get: the where clause excludes globals (utility_id IS
  // NULL) so a tenant cannot fetch a global by id from this endpoint.
  return prisma.rateComponentKind.findUniqueOrThrow({
    where: { id, utilityId },
  });
}

export async function createRateComponentKind(
  utilityId: string,
  data: CreateRateComponentKindInput,
) {
  return prisma.rateComponentKind.create({
    data: { ...data, utilityId },
  });
}

export async function updateRateComponentKind(
  utilityId: string,
  id: string,
  data: UpdateRateComponentKindInput,
) {
  // Only tenant rows are updatable; globals (utility_id NULL) are
  // protected by the where clause requiring utility_id = current tenant.
  return prisma.rateComponentKind.update({
    where: { id, utilityId },
    data,
  });
}

export async function deleteRateComponentKind(utilityId: string, id: string) {
  return prisma.rateComponentKind.delete({
    where: { id, utilityId },
  });
}
