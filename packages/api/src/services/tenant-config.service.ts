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
  const row = await prisma.utilityConfig.findUnique({ where: { utilityId } });
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

  const row = await prisma.utilityConfig.upsert({
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

/**
 * Replace one namespace inside `settings`, leaving the others alone.
 *
 * `updateTenantConfig` above takes the whole `settings` object, which
 * was safe while one screen owned it. Eight namespaces now live in
 * there — `issuer`, `billDocuments`, `billing`, `branding`,
 * `notifications`, `numberFormats`, `retention` and `paymentPlans` —
 * each edited on its own screen. Whole-object writes between them lose
 * data: two admins saving two screens in the same minute means the
 * second one's read-modify-write silently reverts the first, and the
 * symptom is a bill issuer that goes back to blank for no reason anyone
 * can trace.
 *
 * One statement, so there is no window to lose a write in. `jsonb_set`
 * with `create_missing = true` adds the namespace when absent, and the
 * `ON CONFLICT` arm covers a tenant with no config row at all — which
 * is every tenant until something writes one.
 *
 * Runs under the caller's tenant scope: `utility_config` is policied, so
 * the insert and the update both see only this tenant's row.
 */
export async function patchSettingsNamespace(
  utilityId: string,
  namespace: string,
  value: unknown,
): Promise<void> {
  const json = JSON.stringify(value);
  await prisma.$executeRaw`
    INSERT INTO utility_config (id, utility_id, settings)
    VALUES (
      gen_random_uuid(),
      ${utilityId}::uuid,
      jsonb_build_object(${namespace}::text, ${json}::jsonb)
    )
    ON CONFLICT (utility_id) DO UPDATE
      SET settings = jsonb_set(
        COALESCE(utility_config.settings, '{}'::jsonb),
        ARRAY[${namespace}::text],
        ${json}::jsonb,
        true
      )
  `;
}
