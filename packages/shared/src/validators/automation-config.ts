import { z } from "zod";

/**
 * Per-tenant automation configuration.
 *
 * Two parts, stored differently because they are different kinds of
 * thing:
 *
 * - **Tenant-wide settings** — timezone, quiet hours, audit retention,
 *   auto-post. Columns on `utility_config`, because every utility has a
 *   meaningful value for each.
 * - **Per-scheduler settings** — one `scheduler_config` row per
 *   background job a tenant may configure. Adding a job is a row, not a
 *   migration.
 *
 * The storage rule, which is worth keeping in mind before adding
 * anything here: **a value every utility has is a column; a value only
 * some have belongs in jsonb.** A knob only one scheduler needs goes in
 * that row's `settings` and costs no schema change at all.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The background jobs a tenant can configure, and what each one's
 * controls look like.
 *
 * This is the catalogue, and it is deliberately code rather than data:
 * each key names a handler that has to exist, so **keys are code and
 * values are configuration**. A `scheduler_config` row whose key is
 * absent from here is inert — nothing reads it.
 *
 * Adding a scheduler means one entry here plus a handler. The settings
 * page renders from this list, so the control appears without the page
 * being touched, and the row materialises the first time anyone sets it.
 *
 * `defaultEnabled` is `false` for anything added from now on, and that
 * is a rule rather than a coincidence: a tenant has no row until they
 * save one, so a missing row reads as the default — and a *new* job
 * defaulting to on would start doing work for every existing tenant the
 * moment it shipped. New schedulers are opt-in. The three that default
 * to `true` predate this table and have rows provisioned for them.
 */
export const SCHEDULER_DEFINITIONS = [
  {
    key: "suspension",
    label: "Suspension transitions · hourly",
    description:
      "Automatically activates pending service holds at their start date and completes active holds at their end date.",
    hasRunHour: false,
    defaultEnabled: true,
  },
  {
    key: "notificationSend",
    label: "Notification dispatch · every 10 seconds",
    description:
      "Drains the notification outbox to email/SMS providers. Disable only during maintenance — queued messages will not deliver.",
    hasRunHour: false,
    defaultEnabled: true,
  },
  {
    key: "slaBreachSweep",
    label: "SLA breach sweep · every 5 minutes",
    description:
      "Marks open service requests as breached when their SLA due date has passed. Drives the breached filter on the request queue.",
    hasRunHour: false,
    defaultEnabled: true,
  },
  {
    key: "delinquency",
    label: "Delinquency evaluation · daily",
    description:
      "Runs your tenant's delinquency rules at the configured local hour. Sends notices, creates delinquency actions.",
    hasRunHour: true,
    defaultEnabled: true,
  },
  {
    key: "billing",
    label: "Billing runs · on each cycle's bill day",
    description:
      "Starts a billing run for every active cycle on its own bill day, at the configured local hour. It generates bills; it does not post them.",
    hasRunHour: true,
    defaultEnabled: false,
    offNote:
      "Off: nothing starts a billing run. Somebody has to open each cycle on its bill day and press Start.",
  },
] as const;

export type SchedulerKey = (typeof SCHEDULER_DEFINITIONS)[number]["key"];

/** The keys alone, for a Zod enum and for iteration. */
export const SCHEDULER_KEYS = SCHEDULER_DEFINITIONS.map((d) => d.key) as unknown as [
  SchedulerKey,
  ...SchedulerKey[],
];

export function schedulerDefinition(key: SchedulerKey) {
  return SCHEDULER_DEFINITIONS.find((d) => d.key === key)!;
}

/** The default run hour for a job that has one. */
export const DEFAULT_RUN_HOUR_LOCAL = 3;

export const SchedulerSettingSchema = z.object({
  key: z.enum(SCHEDULER_KEYS),
  enabled: z.boolean(),
  /** Null for a job with no time of day — see `hasRunHour`. */
  runHourLocal: z.number().int().min(0).max(23).nullable(),
  /** Written by the dispatcher; see the patch schema. */
  lastRunAt: z.string().datetime().nullable(),
  /** Knobs only this job needs. No schema change to add one. */
  settings: z.record(z.unknown()),
});

export const AutomationConfigSchema = z.object({
  timezone: z.string().min(1).max(64),
  notificationQuietStart: z.string().regex(HHMM, "must be HH:mm 24-hour"),
  notificationQuietEnd: z.string().regex(HHMM, "must be HH:mm 24-hour"),
  schedulerAuditRetentionDays: z.number().int().min(30).max(2555),
  autoPostBills: z.boolean(),
  /** One entry per `SCHEDULER_DEFINITIONS` key, in catalogue order. */
  schedulers: z.array(SchedulerSettingSchema),
});

/**
 * Patch shape for `PATCH /api/v1/settings/automation`.
 *
 * Only the keys supplied are updated, at both levels: an absent
 * `schedulers` leaves every job alone, and a job listed without
 * `enabled` keeps the enabled it had.
 *
 * `lastRunAt` is absent by construction rather than omitted by name — a
 * dispatcher writes it, and a tenant who could rewrite it could break
 * the missed-tick recovery that reads it.
 */
export const SchedulerSettingPatchSchema = z.object({
  key: z.enum(SCHEDULER_KEYS),
  enabled: z.boolean().optional(),
  runHourLocal: z.number().int().min(0).max(23).nullable().optional(),
  settings: z.record(z.unknown()).optional(),
});

export const AutomationConfigPatchSchema = z
  .object({
    timezone: z.string().min(1).max(64).optional(),
    notificationQuietStart: z.string().regex(HHMM, "must be HH:mm 24-hour").optional(),
    notificationQuietEnd: z.string().regex(HHMM, "must be HH:mm 24-hour").optional(),
    schedulerAuditRetentionDays: z.number().int().min(30).max(2555).optional(),
    autoPostBills: z.boolean().optional(),
    schedulers: z.array(SchedulerSettingPatchSchema).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "patch must include at least one field",
  });

export type AutomationConfig = z.infer<typeof AutomationConfigSchema>;
export type AutomationConfigPatch = z.infer<typeof AutomationConfigPatchSchema>;
export type SchedulerSetting = z.infer<typeof SchedulerSettingSchema>;
export type SchedulerSettingPatch = z.infer<typeof SchedulerSettingPatchSchema>;
