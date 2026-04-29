import { prisma } from "../lib/prisma.js";

/**
 * Reference-table service for premise types. Same global+tenant-shadow
 * pattern as measure-type-def: globals (utility_id NULL) are seeded
 * via the migration and visible to every tenant; tenants can layer in
 * their own codes (shadow resolution picks the tenant row when codes
 * collide).
 */

export interface PremiseTypeDefDTO {
  id: string;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  isGlobal: boolean;
}

type Row = {
  id: string;
  utilityId: string | null;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
};

function toDto(row: Row): PremiseTypeDefDTO {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    description: row.description,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    isGlobal: row.utilityId === null,
  };
}

export async function listPremiseTypes(
  utilityId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<PremiseTypeDefDTO[]> {
  const rows = await prisma.premiseTypeDef.findMany({
    where: {
      OR: [{ utilityId: null }, { utilityId }],
      ...(opts.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  });

  // Shadow resolution: tenant row wins over global when codes collide.
  const byCode = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = byCode.get(row.code);
    if (!existing || (existing.utilityId === null && row.utilityId !== null)) {
      byCode.set(row.code, row);
    }
  }
  return Array.from(byCode.values())
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
    .map(toDto);
}

export interface CreatePremiseTypeInput {
  code: string;
  label: string;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export async function createPremiseType(
  utilityId: string,
  data: CreatePremiseTypeInput,
): Promise<PremiseTypeDefDTO> {
  const row = await prisma.premiseTypeDef.create({
    data: {
      utilityId,
      code: data.code.trim().toUpperCase(),
      label: data.label.trim(),
      description: data.description?.trim() || null,
      sortOrder: data.sortOrder ?? 100,
      isActive: data.isActive ?? true,
    },
  });
  return toDto(row);
}

export interface UpdatePremiseTypeInput {
  code?: string;
  label?: string;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export async function updatePremiseType(
  utilityId: string,
  id: string,
  data: UpdatePremiseTypeInput,
): Promise<PremiseTypeDefDTO> {
  // Globals (utility_id NULL) are read-only.
  const existing = await prisma.premiseTypeDef.findFirst({
    where: { id, utilityId },
  });
  if (!existing) {
    throw Object.assign(
      new Error("Premise type not found or not owned by this tenant"),
      { statusCode: 404 },
    );
  }
  const row = await prisma.premiseTypeDef.update({
    where: { id },
    data: {
      ...(data.code !== undefined ? { code: data.code.trim().toUpperCase() } : {}),
      ...(data.label !== undefined ? { label: data.label.trim() } : {}),
      ...(data.description !== undefined
        ? { description: data.description?.trim() || null }
        : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });
  return toDto(row);
}

/**
 * Validate a premise-type code against the tenant's active reference
 * data (globals + tenant-specific). Returns the resolved DTO or null
 * if the code doesn't exist / isn't active. Used by writers (premise
 * service, premise import handler) to gate before insert.
 */
export async function resolvePremiseTypeCode(
  utilityId: string,
  code: string,
): Promise<PremiseTypeDefDTO | null> {
  const all = await listPremiseTypes(utilityId);
  return all.find((t) => t.code === code.trim().toUpperCase()) ?? null;
}
