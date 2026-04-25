import { timeZonesNames } from "@vvo/tzdb";

/**
 * IANA timezone helpers used by the automation-config service and the
 * scheduler workers.
 *
 * Validation runs against `@vvo/tzdb`'s built-in IANA database — that
 * way we don't depend on whatever ICU data ships with the runtime
 * (Alpine images strip ICU). Validation happens at write time so a bad
 * timezone never reaches the scheduler.
 *
 * `localHour` and `formatInTimeZone` are tiny wrappers around
 * `Intl.DateTimeFormat` with `timeZone` option. They assume the
 * runtime image has full ICU — guaranteed by `node:22-bookworm-slim`
 * (rejected: alpine).
 */

const validZones: ReadonlySet<string> = new Set(timeZonesNames);

export function isValidIANA(tz: string): boolean {
  if (tz === "UTC" || tz === "Etc/UTC") return true;
  return validZones.has(tz);
}

/**
 * Returns the local hour (0-23) for the given UTC instant in the
 * specified IANA timezone. Caller is responsible for supplying a
 * valid timezone — `isValidIANA` is the gate for input.
 */
export function localHour(utc: Date, tz: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });
  // `hour: "2-digit"` with `hour12: false` returns "00".."23". A few
  // locales return "24" for midnight — normalize.
  const hour = parseInt(formatter.format(utc), 10);
  return hour === 24 ? 0 : hour;
}

/**
 * Format a UTC instant in the specified timezone using a small
 * homegrown pattern language sufficient for idempotency keys:
 *   yyyy → 4-digit year
 *   MM   → 2-digit month
 *   dd   → 2-digit day of month
 *   HH   → 2-digit hour, 24h
 *   mm   → 2-digit minute
 *   ss   → 2-digit second
 *
 * Not a full date-fns replacement — purpose-built for things like
 * `formatInTimeZone(now, "UTC", "yyyyMMddHH")` to build deterministic
 * job IDs.
 */
export function formatInTimeZone(date: Date, tz: string, pattern: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;

  // Some locales return hour as "24" at midnight; normalize.
  if (lookup.hour === "24") lookup.hour = "00";

  return pattern
    .replace(/yyyy/g, lookup.year ?? "")
    .replace(/MM/g, lookup.month ?? "")
    .replace(/dd/g, lookup.day ?? "")
    .replace(/HH/g, lookup.hour ?? "")
    .replace(/mm/g, lookup.minute ?? "")
    .replace(/ss/g, lookup.second ?? "");
}
