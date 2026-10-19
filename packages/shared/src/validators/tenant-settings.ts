import { z } from "zod";

/**
 * Typed validators for the nested namespaces stored inside
 * UtilityConfig.settings. Each namespace is optional — a PATCH only has
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
 * Who issued the bill and where payment goes. A namespace rather than
 * columns because nothing queries a remittance address: it is edited in
 * Settings and read by the bill presentation loader. `.strict()` is what
 * makes this safe as JSON — a misspelled key is rejected at the API
 * boundary instead of going quietly missing and surfacing later as an
 * unexplained "issuer incomplete" at render time.
 */
export const issuerSettingsSchema = z
  .object({
    utilityName: z.string().min(1).max(200).optional().or(z.literal("")),
    utilityLegalName: z.string().min(1).max(200).optional().or(z.literal("")),
    remittanceAddressLine1: z.string().min(1).max(200).optional().or(z.literal("")),
    remittanceAddressLine2: z.string().max(200).optional().or(z.literal("")),
    remittanceCity: z.string().min(1).max(100).optional().or(z.literal("")),
    remittanceState: z.string().min(1).max(50).optional().or(z.literal("")),
    remittancePostalCode: z.string().min(1).max(20).optional().or(z.literal("")),
    billingPhone: z.string().max(40).optional().or(z.literal("")),
    billingEmail: z.string().email().max(254).optional().or(z.literal("")),
    websiteUrl: z.string().url().max(500).optional().or(z.literal("")),
  })
  .strict();
export type IssuerSettings = z.infer<typeof issuerSettingsSchema>;

/**
 * The five without which a bill is not a valid document. Stated once
 * here so the presentation loader's 422 and the settings page's
 * "required" markers cannot drift apart.
 */
export const REQUIRED_ISSUER_FIELDS = [
  "utilityName",
  "remittanceAddressLine1",
  "remittanceCity",
  "remittanceState",
  "remittancePostalCode",
] as const;

export type RequiredIssuerField = (typeof REQUIRED_ISSUER_FIELDS)[number];

/**
 * Which of the five an issuer block is still missing.
 *
 * The predicate travels with the list, because the list alone does not
 * say what counts as set and that is where the answers would diverge:
 * the settings page writes `""` for a field the operator cleared, so
 * anything testing for the key's presence would call such a tenant
 * complete while its bills refuse to render. Both the presentation
 * loader's ISSUER_INCOMPLETE and the platform console's readiness panel
 * read this, so "ready" and "will render" cannot disagree.
 */
export function missingIssuerFields(
  issuer: IssuerSettings | null | undefined,
): RequiredIssuerField[] {
  return REQUIRED_ISSUER_FIELDS.filter((field) => {
    const value = issuer?.[field];
    return typeof value === "string" ? value.trim().length === 0 : value == null;
  });
}

/**
 * Which apptor-connect integration holds this tenant's bill PDFs. The
 * integration name selects S3, Azure Blob or GCS on their side; no
 * bucket name, region or credential belongs here.
 */
export const billDocumentSettingsSchema = z
  .object({
    storageIntegration: z.string().min(1).max(100).optional().or(z.literal("")),
    storageConnection: z.string().min(1).max(100).optional().or(z.literal("")),
  })
  .strict();
export type BillDocumentSettings = z.infer<typeof billDocumentSettingsSchema>;

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
    issuer: issuerSettingsSchema.optional(),
    billDocuments: billDocumentSettingsSchema.optional(),
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
