import { prisma } from "../lib/prisma.js";

/**
 * Tenant-level configuration. One row per utility, created lazily the
 * first time any flag is changed. Absence of a row means "all defaults".
 * Currently just holds requireHoldApproval + a generic settings JSON
 * bucket for future small flags.
 */

export interface TenantConfigDTO {
  utilityId: string;
  requireHoldApproval: boolean;
  settings: Record<string, unknown>;
}

const DEFAULTS: Omit<TenantConfigDTO, "utilityId"> = {
  requireHoldApproval: false,
  settings: {},
};

export async function getTenantConfig(utilityId: string): Promise<TenantConfigDTO> {
  const row = await prisma.tenantConfig.findUnique({ where: { utilityId } });
  if (!row) {
    return { utilityId, ...DEFAULTS };
  }
  return {
    utilityId,
    requireHoldApproval: row.requireHoldApproval,
    settings: (row.settings as Record<string, unknown>) ?? {},
  };
}

export async function updateTenantConfig(
  utilityId: string,
  patch: Partial<Omit<TenantConfigDTO, "utilityId">>,
): Promise<TenantConfigDTO> {
  // Prisma's Json input type is stricter than Record<string, unknown>;
  // cast at the assignment site rather than teaching the caller about
  // Prisma.InputJsonValue.
  const data: Record<string, unknown> = {};
  if (patch.requireHoldApproval !== undefined) {
    data.requireHoldApproval = patch.requireHoldApproval;
  }
  if (patch.settings !== undefined) {
    data.settings = patch.settings as object;
  }

  const row = await prisma.tenantConfig.upsert({
    where: { utilityId },
    update: data,
    create: {
      utilityId,
      requireHoldApproval: patch.requireHoldApproval ?? false,
      settings: (patch.settings ?? {}) as object,
    },
  });

  return {
    utilityId,
    requireHoldApproval: row.requireHoldApproval,
    settings: (row.settings as Record<string, unknown>) ?? {},
  };
}
