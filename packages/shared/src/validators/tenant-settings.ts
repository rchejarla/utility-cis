import { z } from "zod";

/**
 * Typed validators for the nested namespaces stored inside
 * TenantConfig.settings. Each namespace is optional — a PATCH only has
 * to include the block it wants to change. Fields inside each block
 * are also optional so clients can send partial updates.
 *
 * The API route uses brandingSettingsSchema / notificationSettingsSchema /
 * etc. to validate patch bodies, and the web settings pages use the
 * inferred types to read current values out of the config response.
 *
 * Field choices:
 *  - Branding: URL-only for now (no upload path yet — that needs the
 *    attachment service). Login splash is optional.
 *  - Notifications: sender email + daily digest toggle. Provider creds
 *    and templates are deferred (Phase 3).
 *  - Retention: duration-in-days for the auto-purge jobs, plus
 *    attachment retention in years since that's how operators think
 *    about it. All values are bounded so a typo cannot shrink retention
 *    to 1 day or balloon it past what the DB can sustain.
 *  - Billing: points at the SaaSLogic instance CIS should talk to. API
 *    key storage is NOT in this schema — that needs encryption at rest
 *    and rotation, which is a separate entity.
 */

export const brandingSettingsSchema = z
  .object({
    logoUrl: z.string().url().max(500).optional().or(z.literal("")),
    loginSplashUrl: z.string().url().max(500).optional().or(z.literal("")),
  })
  .strict();
export type BrandingSettings = z.infer<typeof brandingSettingsSchema>;

export const notificationSettingsSchema = z
  .object({
    senderEmail: z
      .string()
      .email()
      .max(254)
      .optional()
      .or(z.literal("")),
    dailyDigestEnabled: z.boolean().optional(),
  })
  .strict();
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const retentionSettingsSchema = z
  .object({
    auditRetentionDays: z.number().int().min(365).max(3650).optional(),
    softDeletePurgeDays: z.number().int().min(7).max(3650).optional(),
    intervalReadRetentionDays: z.number().int().min(30).max(3650).optional(),
    attachmentRetentionYears: z.number().int().min(1).max(30).optional(),
  })
  .strict();
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;

export const billingIntegrationSettingsSchema = z
  .object({
    saaslogicBaseUrl: z
      .string()
      .url()
      .max(500)
      .optional()
      .or(z.literal("")),
    sandbox: z.boolean().optional(),
    pollMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .strict();
export type BillingIntegrationSettings = z.infer<typeof billingIntegrationSettingsSchema>;

/**
 * Umbrella schema used by the tenant-config PATCH route. Each namespace
 * is optional so a patch only has to include the block it's changing.
 * Unknown top-level keys are rejected so typos fail loudly.
 */
export const tenantSettingsNamespacesSchema = z
  .object({
    branding: brandingSettingsSchema.optional(),
    notifications: notificationSettingsSchema.optional(),
    retention: retentionSettingsSchema.optional(),
    billing: billingIntegrationSettingsSchema.optional(),
  })
  .strict();
export type TenantSettingsNamespaces = z.infer<typeof tenantSettingsNamespacesSchema>;

/**
 * Defaults applied when a tenant has no value set. The retention
 * defaults match the placeholder copy shipped in the Phase 1 stubs so
 * operators see the same numbers before and after persistence is
 * wired up.
 */
export const DEFAULT_RETENTION: Required<RetentionSettings> = {
  auditRetentionDays: 2555, // 7 years
  softDeletePurgeDays: 90,
  intervalReadRetentionDays: 1095, // 3 years
  attachmentRetentionYears: 10,
};

export const DEFAULT_BILLING_INTEGRATION: Required<
  Pick<BillingIntegrationSettings, "sandbox" | "pollMinutes">
> & { saaslogicBaseUrl: string } = {
  saaslogicBaseUrl: "https://api-sandbox.saaslogic.io/v1",
  sandbox: true,
  pollMinutes: 5,
};
