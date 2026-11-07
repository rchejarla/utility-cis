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
 *
 * `refusedInOverlay` says whether an **overlay** tenant is excluded
 * from the job (spec 28, OVL-T-2). It is declared here, beside
 * `defaultEnabled`, because `tenantsForScheduler` is the one place
 * every scheduled dispatcher selects tenants — so one flag per
 * scheduler, enforced once, covers the whole scheduled surface. Without
 * it the request-level refusal would be half a gate: an overlay tenant
 * with a cycle configured and a worker attached would still be billed
 * on its bill day by nobody pressing anything.
 *
 * The three that are refused are the ones OVL-T-2 names — billing runs,
 * delinquency actions and customer notifications. `suspension` and
 * `slaBreachSweep` stay on, and that is a judgement rather than an
 * omission: a service hold transitioning is a state change with no
 * outward effect and no money in it, and service requests are ours in
 * either mode (spec 28 §6 builds on them).
 */
export const SCHEDULER_DEFINITIONS = [
  {
    key: "suspension",
    refusedInOverlay: false,
    label: "Suspension transitions · hourly",
    description:
      "Automatically activates pending service holds at their start date and completes active holds at their end date.",
    hasRunHour: false,
    defaultEnabled: true,
  },
  {
    key: "notificationSend",
    refusedInOverlay: true,
    label: "Notification dispatch · every 10 seconds",
    description:
      "Drains the notification outbox to email/SMS providers. Disable only during maintenance — queued messages will not deliver.",
    hasRunHour: false,
    defaultEnabled: true,
  },
  {
    key: "slaBreachSweep",
    refusedInOverlay: false,
    label: "SLA breach sweep · every 5 minutes",
    description:
      "Marks open service requests as breached when their SLA due date has passed. Drives the breached filter on the request queue.",
    hasRunHour: false,
    defaultEnabled: true,
  },
  {
    key: "delinquency",
    refusedInOverlay: true,
    label: "Delinquency evaluation · daily",
    description:
      "Runs your tenant's delinquency rules at the configured local hour. Sends notices, creates delinquency actions.",
    hasRunHour: true,
    defaultEnabled: true,
  },
  {
    key: "billing",
    refusedInOverlay: true,
    label: "Billing runs · on each cycle's bill day",
    description:
      "Starts a billing run for every active cycle on its own bill day, at the configured local hour. It generates bills; it does not post them.",
    hasRunHour: true,
    defaultEnabled: false,
    offNote:
      "Off: nothing starts a billing run. Somebody has to open each cycle on its bill day and press Start.",
  },
  {
    key: "intervalCoverage",
    refusedInOverlay: false,
    label: "Interval coverage sweep · daily",
    description:
      "Checks that interval meters' data covers each day, and reports the days with holes. A gap found on bill day can only be held or estimated; found the day after it happened, the meter can be re-polled and the real data recovered.",
    hasRunHour: true,
    defaultEnabled: false,
    offNote:
      "Off: nothing checks interval coverage until a bill run reaches the meter, which refuses the month rather than telling anyone a week earlier.",
  },
] as const;

export type SchedulerKey = (typeof SCHEDULER_DEFINITIONS)[number]["key"];

/**
 * The interval-coverage sweep's own two knobs, in its
 * `scheduler_config.settings` jsonb (spec 18 — a value only one
 * scheduler needs costs no migration there).
 *
 * Both are per tenant because backfill speed is a property of the
 * head-end and the network, not of this software: a utility on a tight
 * cellular network wants two days of grace, one on a flaky mesh wants
 * seven, and a single fixed number would cry wolf for the first and be
 * useless for the second.
 *
 * `graceHours` defaults to 48 — the thinnest real case, since a cycle
 * reading on day 8 and billing on day 10 gives the period's last
 * intervals about that long to arrive. It is a default, not a
 * measurement: the number wants checking against a real head-end.
 */
export const intervalCoverageSettingsSchema = z
  .object({
    /** How long the head-end gets to backfill before a hole is real. */
    graceHours: z.number().int().min(0).max(336).default(48),
    /** How many complete days back to keep checking. */
    lookbackDays: z.number().int().min(1).max(60).default(7),
  })
  .strict();

export type IntervalCoverageSettings = z.infer<typeof intervalCoverageSettingsSchema>;

/**
 * Which schedulers have knobs of their own, and what shape they are.
 *
 * One statement, three readers: the patch path validates against it, the
 * Automation page's drift guard asserts that every key in it is
 * reachable on screen, and that same guard uses it to allow the page to
 * name these schedulers while still forbidding it to name the others —
 * a job's enable switch and run hour come from a loop over the
 * catalogue, and must keep doing so, but a knob only one job has cannot
 * be rendered by a loop without labelling it by its key name and
 * explaining nothing.
 *
 * It exists because the sweep's two knobs shipped with a schema,
 * defaults, validation and a column to live in, and **no control
 * anywhere** — the same orphan-field shape `settings-coverage.test.ts`
 * was written to catch one level up. A scheduler added here with no
 * block on the page now fails that test by name.
 */
export const SCHEDULER_SETTINGS_SCHEMAS = {
  intervalCoverage: intervalCoverageSettingsSchema,
} as const satisfies Partial<Record<SchedulerKey, z.ZodTypeAny>>;

export type SchedulerWithSettings = keyof typeof SCHEDULER_SETTINGS_SCHEMAS;

/**
 * The sweep's settings from a `scheduler_config` row's jsonb, with the
 * defaults applied. Unparseable settings fall back to the defaults
 * rather than throwing: a sweep that refuses to run because a knob is
 * malformed reports nothing at all, which is worse than reporting on
 * the defaults.
 */
export function intervalCoverageSettings(settings: unknown): IntervalCoverageSettings {
  const parsed = intervalCoverageSettingsSchema.safeParse(settings ?? {});
  return parsed.success ? parsed.data : intervalCoverageSettingsSchema.parse({});
}

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
