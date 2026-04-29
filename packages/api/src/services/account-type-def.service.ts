import { prisma } from "../lib/prisma.js";

/**
 * Reference-table service for account types. Same global+tenant-shadow
 * pattern as premise-type-def: globals seeded via the migration,
 * tenants can layer in their own codes.
 */

export interface AccountTypeDefDTO {
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

function toDto(row: Row): AccountTypeDefDTO {
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

export async function listAccountTypes(
  utilityId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<AccountTypeDefDTO[]> {
  const rows = await prisma.accountTypeDef.findMany({
    where: {
      OR: [{ utilityId: null }, { utilityId }],
      ...(opts.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  });
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

export interface CreateAccountTypeInput {
  code: string;
  label: string;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export async function createAccountType(
  utilityId: string,
  data: CreateAccountTypeInput,
): Promise<AccountTypeDefDTO> {
  const row = await prisma.accountTypeDef.create({
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

export interface UpdateAccountTypeInput {
  code?: string;
  label?: string;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export async function updateAccountType(
  utilityId: string,
  id: string,
  data: UpdateAccountTypeInput,
): Promise<AccountTypeDefDTO> {
  const existing = await prisma.accountTypeDef.findFirst({
    where: { id, utilityId },
  });
  if (!existing) {
    throw Object.assign(
      new Error("Account type not found or not owned by this tenant"),
      { statusCode: 404 },
    );
  }
  const row = await prisma.accountTypeDef.update({
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

export async function resolveAccountTypeCode(
  utilityId: string,
  code: string,
): Promise<AccountTypeDefDTO | null> {
  const all = await listAccountTypes(utilityId);
  return all.find((t) => t.code === code.trim().toUpperCase()) ?? null;
}
