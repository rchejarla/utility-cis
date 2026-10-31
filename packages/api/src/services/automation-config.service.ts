import {
  type AutomationConfig,
  type AutomationConfigPatch,
  type SchedulerKey,
  type SchedulerSetting,
  DEFAULT_RUN_HOUR_LOCAL,
  SCHEDULER_DEFINITIONS,
  schedulerDefinition,
} from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { isValidIANA, localHour } from "../lib/iana-tz.js";

/**
 * The per-tenant automation config, assembled from two places.
 *
 * Tenant-wide values are columns on `utility_config`. Per-scheduler
 * values are one `scheduler_config` row per job — so adding a job is a
 * row rather than a migration, and onboarding a utility is rows rather
 * than schema.
 *
 * **A missing row means the catalogue default.** Rows are written when
 * somebody saves a setting, not when a tenant is created, which is what
 * lets a newly added scheduler appear for every existing tenant without
 * a backfill. It is also why `SCHEDULER_DEFINITIONS` requires anything
 * new to default to disabled: a missing row would otherwise start work
 * for every tenant the day it shipped.
 */

/** The tenant-wide columns this module reads, in one place. */
const TENANT_SELECT = {
  timezone: true,
  notificationQuietStart: true,
  notificationQuietEnd: true,
  schedulerAuditRetentionDays: true,
  autoPostBills: true,
} as const;

interface TenantRow {
  timezone: string;
  notificationQuietStart: string;
  notificationQuietEnd: string;
  schedulerAuditRetentionDays: number;
  autoPostBills: boolean;
}

interface SchedulerRow {
  schedulerKey: string;
  enabled: boolean;
  runHourLocal: number | null;
  lastRunAt: Date | null;
  settings: unknown;
}

/**
 * One entry per catalogue key, whether or not a row exists.
 *
 * Driven by the catalogue rather than by what the table happens to
 * hold, so a scheduler added in code appears immediately and a row left
 * behind by a removed one is ignored rather than rendered.
 */
function toSchedulers(rows: SchedulerRow[]): SchedulerSetting[] {
  return SCHEDULER_DEFINITIONS.map((def) => {
    const row = rows.find((r) => r.schedulerKey === def.key);
    return {
      key: def.key,
      enabled: row?.enabled ?? def.defaultEnabled,
      runHourLocal: def.hasRunHour ? (row?.runHourLocal ?? DEFAULT_RUN_HOUR_LOCAL) : null,
      lastRunAt: row?.lastRunAt ? row.lastRunAt.toISOString() : null,
      settings: (row?.settings as Record<string, unknown> | null) ?? {},
    };
  });
}

function toDto(tenant: TenantRow, rows: SchedulerRow[]): AutomationConfig {
  return {
    timezone: tenant.timezone,
    notificationQuietStart: tenant.notificationQuietStart,
    notificationQuietEnd: tenant.notificationQuietEnd,
    schedulerAuditRetentionDays: tenant.schedulerAuditRetentionDays,
    autoPostBills: tenant.autoPostBills,
    schedulers: toSchedulers(rows),
  };
}

/**
 * Fetch the automation config. A tenant with no `utility_config` row yet
 * gets one with defaults, so callers can rely on a stable shape; the
 * scheduler rows are not created here, because a missing row already
 * means the catalogue default.
 */
export async function getAutomationConfig(utilityId: string): Promise<AutomationConfig> {
  const [tenant, rows] = await Promise.all([
    prisma.utilityConfig.findUnique({ where: { utilityId }, select: TENANT_SELECT }),
    prisma.schedulerConfig.findMany({
      where: { utilityId },
      select: { schedulerKey: true, enabled: true, runHourLocal: true, lastRunAt: true, settings: true },
    }),
  ]);
  if (tenant) return toDto(tenant, rows);

  const created = await prisma.utilityConfig.upsert({
    where: { utilityId },
    create: { utilityId },
    update: {},
    select: TENANT_SELECT,
  });
  return toDto(created, rows);
}

/**
 * Apply a partial patch, at both levels.
 *
 * An absent `schedulers` leaves every job alone; a job listed without
 * `enabled` keeps the enabled it had. Each listed job is upserted, which
 * is what materialises a row the first time anybody changes a setting.
 */
export async function patchAutomationConfig(
  utilityId: string,
  patch: AutomationConfigPatch,
): Promise<AutomationConfig> {
  if (patch.timezone !== undefined && !isValidIANA(patch.timezone)) {
    throw new Error(`Invalid IANA timezone: "${patch.timezone}"`);
  }

  const { schedulers, ...tenantPatch } = patch;

  if (Object.keys(tenantPatch).length > 0) {
    await prisma.utilityConfig.upsert({
      where: { utilityId },
      create: { utilityId, ...tenantPatch },
      update: tenantPatch,
    });
  }

  for (const change of schedulers ?? []) {
    const def = schedulerDefinition(change.key);
    /*
     * An hour for a job that has none would be a value nothing reads,
     * and the next person to look would reasonably believe it mattered.
     */
    const runHourLocal = def.hasRunHour ? change.runHourLocal : null;
    await prisma.schedulerConfig.upsert({
      where: { utilityId_schedulerKey: { utilityId, schedulerKey: change.key } },
      create: {
        utilityId,
        schedulerKey: change.key,
        enabled: change.enabled ?? def.defaultEnabled,
        runHourLocal: runHourLocal ?? (def.hasRunHour ? DEFAULT_RUN_HOUR_LOCAL : null),
        settings: (change.settings ?? {}) as object,
      },
      update: {
        ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
        ...(change.runHourLocal !== undefined ? { runHourLocal } : {}),
        ...(change.settings !== undefined ? { settings: change.settings as object } : {}),
      },
    });
  }

  logger.info(
    {
      component: "automation-config",
      utilityId,
      patchedKeys: Object.keys(tenantPatch),
      patchedSchedulers: (schedulers ?? []).map((c) => c.key),
    },
    "Automation config patched",
  );
  return getAutomationConfig(utilityId);
}

/**
 * Read one scheduler's enable flag from a config object.
 *
 * A lookup now rather than a switch over columns. The switch had to
 * grow an arm per scheduler, which is the same tax the columns charged.
 */
export function isSchedulerEnabled(config: AutomationConfig, scheduler: SchedulerKey): boolean {
  const entry = config.schedulers.find((s) => s.key === scheduler);
  return entry?.enabled ?? schedulerDefinition(scheduler).defaultEnabled;
}

export interface SchedulerTenant {
  utilityId: string;
  /** The zone the dispatcher reads the clock in. */
  timezone: string;
  /** Null where the job has no time of day. */
  runHourLocal: number | null;
  lastRunAt: Date | null;
}

/**
 * Every tenant this scheduler is enabled for, with what a dispatcher
 * needs to decide: the zone and the hour.
 *
 * Two small queries and an in-memory join rather than one filter on
 * `scheduler_config`. **A tenant with no row takes the catalogue
 * default**, so filtering on rows alone would silently skip every
 * tenant who has never touched the setting — which for a job that
 * defaults to enabled, like delinquency, is every tenant. One row per
 * tenant and at most one row per tenant per scheduler, so both reads
 * are a few hundred rows at the scale this runs at.
 *
 * Cross-tenant: the caller supplies platform authority, which the
 * `all-tenants` queues do through `scopedJob`.
 */
export async function tenantsForScheduler(key: SchedulerKey): Promise<SchedulerTenant[]> {
  const def = schedulerDefinition(key);
  const [tenants, rows] = await Promise.all([
    prisma.utilityConfig.findMany({ select: { utilityId: true, timezone: true } }),
    prisma.schedulerConfig.findMany({
      where: { schedulerKey: key },
      select: { utilityId: true, enabled: true, runHourLocal: true, lastRunAt: true },
    }),
  ]);

  const out: SchedulerTenant[] = [];
  for (const tenant of tenants) {
    const row = rows.find((r) => r.utilityId === tenant.utilityId);
    if (!(row?.enabled ?? def.defaultEnabled)) continue;
    out.push({
      utilityId: tenant.utilityId,
      timezone: tenant.timezone,
      runHourLocal: def.hasRunHour ? (row?.runHourLocal ?? DEFAULT_RUN_HOUR_LOCAL) : null,
      lastRunAt: row?.lastRunAt ?? null,
    });
  }
  return out;
}

/**
 * Record that a dispatcher acted for one tenant.
 *
 * An upsert, because the row may not exist: a tenant inherits the
 * catalogue default until something writes one, and a dispatcher
 * running is the first thing that does for a job nobody configured.
 */
export async function markSchedulerRun(
  utilityId: string,
  key: SchedulerKey,
  at: Date = new Date(),
): Promise<void> {
  const def = schedulerDefinition(key);
  await prisma.schedulerConfig.upsert({
    where: { utilityId_schedulerKey: { utilityId, schedulerKey: key } },
    create: {
      utilityId,
      schedulerKey: key,
      enabled: def.defaultEnabled,
      runHourLocal: def.hasRunHour ? DEFAULT_RUN_HOUR_LOCAL : null,
      lastRunAt: at,
    },
    update: { lastRunAt: at },
  });
}

/**
 * Determine whether the given UTC instant falls inside the tenant's
 * SMS quiet-hours window. Email is always eligible (quiet hours apply
 * to SMS only, per spec §3.4).
 *
 * Wrap-around: the window typically spans midnight (e.g., 22:00 →
 * 07:00). When start > end we treat the window as inclusive of
 * everything outside [end, start). When start === end the window is
 * effectively empty (never quiet) — caller wants always-eligible.
 *
 * Equal start/end of "00:00" is the documented "disable quiet hours"
 * pattern.
 */
export function isInQuietHours(utcNow: Date, config: AutomationConfig): boolean {
  if (config.notificationQuietStart === config.notificationQuietEnd) return false;

  const startMin = parseHHMMToMinutes(config.notificationQuietStart);
  const endMin = parseHHMMToMinutes(config.notificationQuietEnd);
  const nowMin = localMinutes(utcNow, config.timezone);

  if (startMin < endMin) {
    // Same-day window: e.g., 13:00 → 17:00 (rare but legal).
    return nowMin >= startMin && nowMin < endMin;
  }
  // Wrap-around: e.g., 22:00 → 07:00. Quiet if past start OR before end.
  return nowMin >= startMin || nowMin < endMin;
}

function parseHHMMToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((s) => Number.parseInt(s, 10));
  return h * 60 + m;
}

function localMinutes(utcNow: Date, tz: string): number {
  // Use Intl.DateTimeFormat parts to extract local hour + minute.
  // Mirrors what `localHour` does but returns finer granularity.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(utcNow);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  let hour = parseInt(lookup.hour ?? "0", 10);
  if (hour === 24) hour = 0; // locale quirk
  const minute = parseInt(lookup.minute ?? "0", 10);
  return hour * 60 + minute;
}

/**
 * Expose the shared localHour helper through this service so worker
 * code that already imports `automation-config.service` doesn't have
 * to also import iana-tz directly. Convenience re-export.
 */
export { localHour };

/**
 * Priority bucket used by the delinquency dispatcher (pattern #2).
 * Smaller tenants get priority 1 (processed first); medium get 2;
 * large get 3. Backed by BullMQ's job priority — lower number =
 * sooner. Boundaries per spec §3.3.
 */
export function priorityForTenant(accountCount: number): 1 | 2 | 3 {
  if (accountCount < 1000) return 1;
  if (accountCount < 10_000) return 2;
  return 3;
}
