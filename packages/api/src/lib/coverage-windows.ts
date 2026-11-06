/**
 * Which days a coverage sweep may judge (spec 26, TOU-INT-4c).
 *
 * A gap found today is usually not a gap: an AMI head-end retries
 * missed reads and backfills for hours or days afterward, so a meter
 * that lost comms at 2am commonly delivers those intervals later the
 * same day. Judging the recent tail would report every meter whose
 * data is still arriving. `graceHours` is how long the head-end gets
 * before a hole counts as real, and `lookbackDays` how far back to
 * keep asking — both per tenant, because backfill speed is a property
 * of the head-end and the network, not of this software.
 *
 * **Whole local days, not a rolling window.** A rolling window ends at
 * an arbitrary instant that is not an interval boundary, so the
 * coverage check would report a spurious part-interval gap at both
 * edges every night. Local days also make a finding reportable to a
 * person — "the 3rd is missing three hours" is something a technician
 * can act on; "the window ending 04:17Z" is not.
 */
import { zoneOffsetMinutes } from "./rate-engine/tou-clock.js";
import { formatInTimeZone } from "./iana-tz.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Local midnight on `date` (YYYY-MM-DD) in `zone`, as a UTC instant.
 *
 * Two passes, because the offset depends on the instant being asked
 * about: guess with the offset at UTC midnight, then re-ask at the
 * guess. One iteration settles every zone except the hour daylight
 * saving skips, which has no local midnight to find.
 */
export function localMidnight(date: string, zone: string): Date {
  const utcMidnight = new Date(`${date}T00:00:00.000Z`);
  const guess = new Date(utcMidnight.getTime() - zoneOffsetMinutes(utcMidnight, zone) * MINUTE_MS);
  return new Date(utcMidnight.getTime() - zoneOffsetMinutes(guess, zone) * MINUTE_MS);
}

/** The local calendar date `instant` falls on, in `zone`. */
function localDate(instant: Date, zone: string): string {
  return formatInTimeZone(instant, zone, "yyyy-MM-dd");
}

/** `date` (YYYY-MM-DD) shifted by whole calendar days. */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface CoverageWindow {
  startDate: Date;
  endDate: Date;
}

/**
 * The last `lookbackDays` complete local days that ended at least
 * `graceHours` ago, oldest first.
 *
 * Each window runs local midnight to local midnight, so it is 23, 24
 * or 25 hours long as the zone requires and its boundaries land where
 * intervals actually tile. Consecutive windows share a boundary
 * exactly — no day judged twice, none skipped across a daylight-saving
 * change.
 */
export function windowsToCheck(args: {
  now: Date;
  timeZone: string;
  lookbackDays: number;
  graceHours: number;
}): CoverageWindow[] {
  const { now, timeZone, lookbackDays, graceHours } = args;
  if (lookbackDays <= 0) return [];

  /*
   * The newest day we are allowed to judge is the last one whose end —
   * its following local midnight — is already outside the grace period.
   * Taking the local date of the cutoff and stepping back one day gets
   * there: the cutoff's own day has not finished being backfilled.
   */
  const cutoff = new Date(now.getTime() - graceHours * HOUR_MS);
  const newestEndDate = localDate(cutoff, timeZone);

  const windows: CoverageWindow[] = [];
  for (let i = lookbackDays; i >= 1; i -= 1) {
    const start = shiftDate(newestEndDate, -i);
    windows.push({
      startDate: localMidnight(start, timeZone),
      endDate: localMidnight(shiftDate(start, 1), timeZone),
    });
  }
  return windows;
}
