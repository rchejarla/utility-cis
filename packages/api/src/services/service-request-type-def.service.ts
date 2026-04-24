import { prisma } from "../lib/prisma.js";
import type { ServiceRequestTypeDefDTO } from "@utility-cis/shared";

/**
 * Reference-table service for service-request types. Mirrors the
 * suspension-type-def pattern: rows with utilityId=NULL are global
 * seeds visible to every tenant, tenant-owned rows with the same code
 * shadow the global one in listings.
 */

type Row = {
  id: string;
  utilityId: string | null;
  code: string;
  label: string;
  description: string | null;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
};

function toDto(row: Row): ServiceRequestTypeDefDTO {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    description: row.description,
    category: row.category,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    isGlobal: row.utilityId === null,
  };
}

export async function listServiceRequestTypes(
  utilityId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<ServiceRequestTypeDefDTO[]> {
  const rows = await prisma.serviceRequestTypeDef.findMany({
    where: {
      OR: [{ utilityId: null }, { utilityId }],
      ...(opts.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  });
  const byCode = new Map<string, Row>();
  for (const row of rows as Row[]) {
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
 * tenant-specific). Thrown error uses the same shape other services use
 * so Fastify maps it to a clean 400.
 */
export async function assertServiceRequestTypeCode(
  utilityId: string,
  code: string,
): Promise<void> {
  const found = await prisma.serviceRequestTypeDef.findFirst({
    where: {
      code,
      isActive: true,
      OR: [{ utilityId: null }, { utilityId }],
    },
    select: { id: true },
  });
  if (!found) {
    throw Object.assign(
      new Error(`Unknown service request type code: ${code}`),
      { statusCode: 400, code: "SERVICE_REQUEST_TYPE_UNKNOWN" },
    );
  }
}
