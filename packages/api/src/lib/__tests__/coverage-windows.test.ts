import { describe, it, expect } from "vitest";
import { localMidnight, windowsToCheck } from "../coverage-windows.js";

/**
 * Which days a coverage sweep is entitled to judge.
 *
 * Two numbers bound it, both per tenant: `graceHours` is how long the
 * head-end gets to backfill before a hole counts as real, and
 * `lookbackDays` is how far back to keep asking. A sweep that judged
 * the last few hours would report every meter still in flight.
 *
 * Whole **local** days, not a rolling window. A rolling one ends at an
 * arbitrary instant that is not an interval boundary, so the coverage
 * check would report a spurious part-interval gap at both edges every
 * night. Local days also make the finding reportable to a person: "the
 * 3rd is missing three hours" is actionable, "the window ending
 * 04:17Z" is not.
 */

const HOUR = 3_600_000;
const ZONE = "America/Denver";

const iso = (d: Date) => d.toISOString();

describe("localMidnight", () => {
  it("resolves to the right UTC instant on a standard-time date", () => {
    // MST is UTC-7, so local midnight is 07:00Z.
    expect(iso(localMidnight("2026-01-15", ZONE))).toBe("2026-01-15T07:00:00.000Z");
  });

  it("resolves to the right UTC instant on a summer-time date", () => {
    // MDT is UTC-6, so local midnight is 06:00Z.
    expect(iso(localMidnight("2026-07-15", ZONE))).toBe("2026-07-15T06:00:00.000Z");
  });

  it("is 25 hours between the midnights of a day the clocks go back", () => {
    const start = localMidnight("2026-11-01", ZONE);
    const end = localMidnight("2026-11-02", ZONE);
    expect(end.getTime() - start.getTime()).toBe(25 * HOUR);
  });

  it("is 23 hours between the midnights of a day the clocks go forward", () => {
    const start = localMidnight("2026-03-08", ZONE);
    const end = localMidnight("2026-03-09", ZONE);
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR);
  });
});

describe("windowsToCheck", () => {
  const base = { timeZone: ZONE, lookbackDays: 3, graceHours: 48 };

  it("returns whole local days, oldest first, each one midnight to midnight", () => {
    const windows = windowsToCheck({ now: new Date("2026-07-10T18:00:00.000Z"), ...base });

    expect(windows.map((w) => iso(w.startDate))).toEqual([
      "2026-07-05T06:00:00.000Z",
      "2026-07-06T06:00:00.000Z",
      "2026-07-07T06:00:00.000Z",
    ]);
    // Each window's end is the next window's start: no day judged twice,
    // none skipped.
    expect(iso(windows[0]!.endDate)).toBe(iso(windows[1]!.startDate));
    expect(iso(windows[2]!.endDate)).toBe("2026-07-08T06:00:00.000Z");
  });

  it("judges nothing inside the grace period", () => {
    const now = new Date("2026-07-10T18:00:00.000Z");
    const windows = windowsToCheck({ now, ...base });

    // 48h of grace from 10 July 18:00Z reaches back to 8 July 18:00Z, so
    // the last fully judgeable day is the 7th. Today and yesterday are
    // still in flight and must not be reported.
    const latest = windows[windows.length - 1]!;
    expect(latest.endDate.getTime()).toBeLessThanOrEqual(now.getTime() - 48 * HOUR);
  });

  it("asks for exactly lookbackDays windows", () => {
    expect(windowsToCheck({ now: new Date("2026-07-10T18:00:00.000Z"), ...base, lookbackDays: 7 }))
      .toHaveLength(7);
  });

  it("returns nothing when the lookback is zero", () => {
    expect(
      windowsToCheck({ now: new Date("2026-07-10T18:00:00.000Z"), ...base, lookbackDays: 0 }),
    ).toEqual([]);
  });

  it("spans a daylight-saving change without skipping or repeating a day", () => {
    // Sweeping on 5 November looks back over 1 November, the 25-hour day.
    const windows = windowsToCheck({
      now: new Date("2026-11-05T18:00:00.000Z"),
      timeZone: ZONE,
      lookbackDays: 4,
      graceHours: 48,
    });

    /*
     * The cutoff is 3 Nov 18:00Z, and the 3rd's own day does not end
     * until local midnight on the 4th — after the cutoff — so the 3rd
     * is still being backfilled and the newest judgeable day is the
     * 2nd.
     */
    const starts = windows.map((w) => iso(w.startDate));
    expect(starts).toEqual([
      "2026-10-30T06:00:00.000Z",
      "2026-10-31T06:00:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-02T07:00:00.000Z",
    ]);
    // 1 November is the 25-hour day, and its end is the next window's
    // start even though the offset changed inside it.
    expect(windows[2]!.endDate.getTime() - windows[2]!.startDate.getTime()).toBe(25 * HOUR);
    expect(iso(windows[2]!.endDate)).toBe(starts[3]!);
  });

  it("uses the tenant's zone, not the server's", () => {
    const denver = windowsToCheck({ now: new Date("2026-07-10T18:00:00.000Z"), ...base });
    const auckland = windowsToCheck({
      now: new Date("2026-07-10T18:00:00.000Z"),
      timeZone: "Pacific/Auckland",
      lookbackDays: 3,
      graceHours: 48,
    });

    expect(iso(denver[0]!.startDate)).not.toBe(iso(auckland[0]!.startDate));
  });
});
