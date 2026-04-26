import type {
  AutomationConfig,
  AutomationConfigPatch,
  SchedulerKey,
} from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { isValidIANA, localHour } from "../lib/iana-tz.js";

/**
 * Service layer for the per-tenant automation/scheduler config.
 *
 * The DB-side schema is on `TenantConfig`; this module is the
 * application-side surface that the routes, worker handlers, and
 * dispatchers all read through.
 *
 * What stays here vs in tenant-config.service.ts:
 *   - Anything specifically about scheduler behavior (timezone,
 *     enable flags, quiet hours, run hour) lives here.
 *   - General TenantConfig CRUD stays in tenant-config.service.ts.
 *   - This split keeps `tenant-config.service.ts` from growing into
 *     a kitchen-sink module as more automation knobs land.
 */

interface AutomationConfigRow {
  timezone: string;
  suspensionEnabled: boolean;
  notificationSendEnabled: boolean;
  slaBreachSweepEnabled: boolean;
  delinquencyEnabled: boolean;
  delinquencyRunHourLocal: number;
  delinquencyLastRunAt: Date | null;
  notificationQuietStart: string;
  notificationQuietEnd: string;
  schedulerAuditRetentionDays: number;
}

function toDto(row: AutomationConfigRow): AutomationConfig {
  return {
    timezone: row.timezone,
    suspensionEnabled: row.suspensionEnabled,
    notificationSendEnabled: row.notificationSendEnabled,
    slaBreachSweepEnabled: row.slaBreachSweepEnabled,
    delinquencyEnabled: row.delinquencyEnabled,
    delinquencyRunHourLocal: row.delinquencyRunHourLocal,
    delinquencyLastRunAt: row.delinquencyLastRunAt
      ? row.delinquencyLastRunAt.toISOString()
      : null,
    notificationQuietStart: row.notificationQuietStart,
    notificationQuietEnd: row.notificationQuietEnd,
    schedulerAuditRetentionDays: row.schedulerAuditRetentionDays,
  };
}

/**
 * Fetch the automation slice of a tenant's config. If the tenant has
 * no `tenant_config` row yet (legacy), one is upserted with defaults
 * so callers can rely on a stable shape. The defaults mirror the
 * column-level defaults in the migration so behavior is identical.
 */
export async function getAutomationConfig(utilityId: string): Promise<AutomationConfig> {
  const row = await prisma.tenantConfig.findUnique({
    where: { utilityId },
    select: {
      timezone: true,
      suspensionEnabled: true,
      notificationSendEnabled: true,
      slaBreachSweepEnabled: true,
      delinquencyEnabled: true,
      delinquencyRunHourLocal: true,
      delinquencyLastRunAt: true,
      notificationQuietStart: true,
      notificationQuietEnd: true,
      schedulerAuditRetentionDays: true,
    },
  });
  if (row) return toDto(row);

  // No row yet — create with defaults. UPSERT-on-read keeps the rest
  // of the system simple at the cost of one cheap write the first
  // time we see a fresh tenant.
  const created = await prisma.tenantConfig.upsert({
    where: { utilityId },
    create: { utilityId },
    update: {},
    select: {
      timezone: true,
      suspensionEnabled: true,
      notificationSendEnabled: true,
      slaBreachSweepEnabled: true,
      delinquencyEnabled: true,
      delinquencyRunHourLocal: true,
      delinquencyLastRunAt: true,
      notificationQuietStart: true,
      notificationQuietEnd: true,
      schedulerAuditRetentionDays: true,
    },
  });
  return toDto(created);
}

/**
 * Apply a partial patch. Validates IANA timezone if supplied — the
 * Zod schema only checks shape; this is the semantic gate. Returns
 * the post-patch full config.
 */
export async function patchAutomationConfig(
  utilityId: string,
  patch: AutomationConfigPatch,
): Promise<AutomationConfig> {
  if (patch.timezone !== undefined && !isValidIANA(patch.timezone)) {
    throw new Error(`Invalid IANA timezone: "${patch.timezone}"`);
  }
  // Quiet-hour values are validated by Zod regex at the route layer;
  // any HH:mm pair is acceptable here. Equal start/end (e.g.,
  // "00:00"/"00:00") effectively disables quiet hours — that's a
  // configurable choice, not a bug.

  const row = await prisma.tenantConfig.upsert({
    where: { utilityId },
    create: { utilityId, ...patch },
    update: patch,
    select: {
      timezone: true,
      suspensionEnabled: true,
      notificationSendEnabled: true,
      slaBreachSweepEnabled: true,
      delinquencyEnabled: true,
      delinquencyRunHourLocal: true,
      delinquencyLastRunAt: true,
      notificationQuietStart: true,
      notificationQuietEnd: true,
      schedulerAuditRetentionDays: true,
    },
  });
  logger.info(
    { component: "automation-config", utilityId, patchedKeys: Object.keys(patch) },
    "Automation config patched",
  );
  return toDto(row);
}

/**
 * Read a single scheduler's enable flag from a config object. Used by
 * worker handlers that have already loaded the config and want to
 * gate work by scheduler.
 */
export function isSchedulerEnabled(
  config: AutomationConfig,
  scheduler: SchedulerKey,
): boolean {
  switch (scheduler) {
    case "suspension":
      return config.suspensionEnabled;
    case "notificationSend":
      return config.notificationSendEnabled;
    case "slaBreachSweep":
      return config.slaBreachSweepEnabled;
    case "delinquency":
      return config.delinquencyEnabled;
  }
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
