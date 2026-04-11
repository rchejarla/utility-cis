import { prisma } from "../lib/prisma.js";
import type {
  CreateSuspensionTypeDefInput,
  UpdateSuspensionTypeDefInput,
  SuspensionTypeDefDTO,
} from "@utility-cis/shared";

/**
 * Reference-table service for suspension (hold) types. Replaces the old
 * hard-coded SuspensionType enum. Rows with utilityId=NULL are global
 * (visible to every tenant) and seeded in seed.js. Rows with a specific
 * utilityId are tenant-local and can coexist with a global code of the
 * same name — the tenant row "shadows" the global one in listings.
 */

function toDto(row: {
  id: string;
  utilityId: string | null;
  code: string;
  label: string;
  description: string | null;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
  defaultBillingSuspended: boolean;
}): SuspensionTypeDefDTO {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    description: row.description,
    category: row.category,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    defaultBillingSuspended: row.defaultBillingSuspended,
    isGlobal: row.utilityId === null,
  };
}

export async function listSuspensionTypes(
  utilityId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<SuspensionTypeDefDTO[]> {
  const rows = await prisma.suspensionTypeDef.findMany({
    where: {
      OR: [{ utilityId: null }, { utilityId }],
      ...(opts.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  });

  // Shadow resolution: if both a global and a tenant-specific row share
  // the same code, keep the tenant-specific one.
  const byCode = new Map<string, typeof rows[number]>();
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

/**
 * Validate that a code exists and is active for this tenant (global or
 * tenant-specific). Thrown error uses the same shape the rest of the
 * services use so Fastify maps it to a clean 400.
 */
export async function assertSuspensionTypeCode(
  utilityId: string,
  code: string,
): Promise<void> {
  const found = await prisma.suspensionTypeDef.findFirst({
    where: {
      code,
      isActive: true,
      OR: [{ utilityId: null }, { utilityId }],
    },
    select: { id: true },
  });
  if (!found) {
    throw Object.assign(
      new Error(`Unknown suspension type code: ${code}`),
      { statusCode: 400, code: "SUSPENSION_TYPE_UNKNOWN" },
    );
  }
}

export async function createSuspensionType(
  utilityId: string,
  data: CreateSuspensionTypeDefInput,
): Promise<SuspensionTypeDefDTO> {
  const row = await prisma.suspensionTypeDef.create({
    data: {
      utilityId,
      code: data.code,
      label: data.label,
      description: data.description ?? null,
      category: data.category ?? null,
      sortOrder: data.sortOrder ?? 100,
      isActive: data.isActive ?? true,
      defaultBillingSuspended: data.defaultBillingSuspended ?? true,
    },
  });
  return toDto(row);
}

export async function updateSuspensionType(
  utilityId: string,
  id: string,
  data: UpdateSuspensionTypeDefInput,
): Promise<SuspensionTypeDefDTO> {
  // Only tenant-owned rows can be edited. Global rows are read-only to
  // prevent one tenant from mutating a seeded system code.
  const existing = await prisma.suspensionTypeDef.findFirst({
    where: { id, utilityId },
  });
  if (!existing) {
    throw Object.assign(
      new Error("Suspension type not found or not owned by this tenant"),
      { statusCode: 404 },
    );
  }
  const row = await prisma.suspensionTypeDef.update({
    where: { id },
    data: {
      ...(data.code !== undefined ? { code: data.code } : {}),
      ...(data.label !== undefined ? { label: data.label } : {}),
      ...(data.description !== undefined ? { description: data.description ?? null } : {}),
      ...(data.category !== undefined ? { category: data.category ?? null } : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      ...(data.defaultBillingSuspended !== undefined
        ? { defaultBillingSuspended: data.defaultBillingSuspended }
        : {}),
    },
  });
  return toDto(row);
}
