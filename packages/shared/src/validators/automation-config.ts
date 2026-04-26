import { z } from "zod";

/**
 * Per-tenant automation/scheduler configuration. Schema mirrors the
 * 10 columns added to TenantConfig in migration
 * `20260425231524_tenant_automation_config`.
 *
 * Field-level rules:
 *   - timezone: any non-empty string is accepted at the schema level;
 *     true IANA validation lives in the api package's `iana-tz`
 *     helper (which checks against `@vvo/tzdb`). Two-step validation
 *     so the shared package doesn't need a tzdb dep.
 *   - notificationQuietStart / notificationQuietEnd: HH:mm form, 24h.
 *   - delinquencyRunHourLocal: 0-23.
 *   - schedulerAuditRetentionDays: 30-2555 (30 days to 7 years).
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const AutomationConfigSchema = z.object({
  timezone: z.string().min(1).max(64),
  suspensionEnabled: z.boolean(),
  notificationSendEnabled: z.boolean(),
  slaBreachSweepEnabled: z.boolean(),
  delinquencyEnabled: z.boolean(),
  delinquencyRunHourLocal: z.number().int().min(0).max(23),
  delinquencyLastRunAt: z.string().datetime().nullable(),
  notificationQuietStart: z.string().regex(HHMM, "must be HH:mm 24-hour"),
  notificationQuietEnd: z.string().regex(HHMM, "must be HH:mm 24-hour"),
  schedulerAuditRetentionDays: z.number().int().min(30).max(2555),
});

/**
 * Patch shape for `PATCH /api/v1/settings/automation`. All fields
 * optional; only the supplied keys get updated. `delinquencyLastRunAt`
 * is intentionally omitted — it's set internally by the worker, never
 * by the user.
 */
export const AutomationConfigPatchSchema = AutomationConfigSchema
  .omit({ delinquencyLastRunAt: true })
  .partial()
  .refine(
    (data) => Object.keys(data).length > 0,
    { message: "patch must include at least one field" },
  );

export type AutomationConfig = z.infer<typeof AutomationConfigSchema>;
export type AutomationConfigPatch = z.infer<typeof AutomationConfigPatchSchema>;

export const SCHEDULER_KEYS = [
  "suspension",
  "notificationSend",
  "slaBreachSweep",
  "delinquency",
] as const;
export type SchedulerKey = (typeof SCHEDULER_KEYS)[number];
