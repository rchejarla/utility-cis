import { prisma } from "../lib/prisma.js";
import type {
  CreateMeasureTypeDefInput,
  UpdateMeasureTypeDefInput,
  MeasureTypeDefDTO,
} from "@utility-cis/shared";

/**
 * Reference-table service for measurement types (USAGE, DEMAND, TOU_*,
 * REACTIVE, OTHER). Same global + tenant-shadow pattern as
 * suspension-type-def. Globals are seeded via the migration; tenants
 * can layer in their own codes (shadow resolution picks the tenant
 * row when codes collide).
 */

type Row = {
  id: string;
  utilityId: string | null;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
};

function toDto(row: Row): MeasureTypeDefDTO {
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

export async function listMeasureTypes(
  utilityId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<MeasureTypeDefDTO[]> {
  const rows = await prisma.measureTypeDef.findMany({
    where: {
      OR: [{ utilityId: null }, { utilityId }],
      ...(opts.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  });

  // Shadow resolution: if both a global and a tenant-specific row
  // share the same code, keep the tenant-specific one.
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

export async function createMeasureType(
  utilityId: string,
  data: CreateMeasureTypeDefInput,
): Promise<MeasureTypeDefDTO> {
  const row = await prisma.measureTypeDef.create({
    data: {
      utilityId,
      code: data.code,
      label: data.label,
      description: data.description ?? null,
      sortOrder: data.sortOrder ?? 100,
      isActive: data.isActive ?? true,
    },
  });
  return toDto(row);
}

export async function updateMeasureType(
  utilityId: string,
  id: string,
  data: UpdateMeasureTypeDefInput,
): Promise<MeasureTypeDefDTO> {
  // Only tenant-owned rows can be edited. Globals are read-only —
  // a tenant can shadow a global by creating a local row with the
  // same code, but can't mutate the seeded system catalog itself.
  const existing = await prisma.measureTypeDef.findFirst({
    where: { id, utilityId },
  });
  if (!existing) {
    throw Object.assign(
      new Error("Measure type not found or not owned by this tenant"),
      { statusCode: 404 },
    );
  }
  const row = await prisma.measureTypeDef.update({
    where: { id },
    data: {
      ...(data.code !== undefined ? { code: data.code } : {}),
      ...(data.label !== undefined ? { label: data.label } : {}),
      ...(data.description !== undefined
        ? { description: data.description ?? null }
        : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });
  return toDto(row);
}
