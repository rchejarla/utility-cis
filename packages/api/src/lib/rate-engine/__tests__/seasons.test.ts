import { describe, it, expect } from "vitest";
import { resolveSeason, validateSeasons, type SeasonDefinition } from "../seasons.js";

/**
 * Tenant-configured seasons (spec 26, TOU-SEA-1 – 3).
 *
 * Replaces `seasonOf()`, which hard-coded summer as May–October for
 * every tenant on earth. Two things it has to get right that a
 * hard-coded pair never had to:
 *
 * **Wrapping.** Winter is Nov 1 – Mar 31. A naive range check reads
 * that as "month ≥ 11 and month ≤ 3", which is never true, so winter
 * silently covers nothing and every December bill rates as whatever
 * comes last.
 *
 * **February 29.** A set ending one season on Feb 28 and starting the
 * next on Mar 1 tiles 365 days and leaves one day uncovered every four
 * years. That bill would fail to rate — or worse, rate against a
 * fallback — in a leap year only, which is the kind of fault that
 * ships and then waits.
 */

const summer = (over: Partial<SeasonDefinition> = {}): SeasonDefinition => ({
  code: "summer",
  startMonth: 5,
  startDay: 1,
  endMonth: 10,
  endDay: 31,
  ...over,
});

const winter = (over: Partial<SeasonDefinition> = {}): SeasonDefinition => ({
  code: "winter",
  startMonth: 11,
  startDay: 1,
  endMonth: 4,
  endDay: 30,
  ...over,
});

/** A UTC date, the way every date in the engine is read. */
const utc = (month: number, day: number) => new Date(Date.UTC(2026, month - 1, day));

describe("validateSeasons", () => {
  it("accepts a set that tiles the year, including the wrap", () => {
    expect(validateSeasons([summer(), winter()])).toEqual({ ok: true });
  });

  it("accepts one season covering the whole year", () => {
    expect(
      validateSeasons([
        { code: "all", startMonth: 1, startDay: 1, endMonth: 12, endDay: 31 },
      ]),
    ).toEqual({ ok: true });
  });

  it("names the days a gap leaves uncovered", () => {
    // Winter ends a day early, so April 30 belongs to nothing.
    const result = validateSeasons([summer(), winter({ endDay: 29 })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toMatch(/30 April/);
      expect(result.problems.join(" ")).toMatch(/no season/i);
    }
  });

  it("names the days two seasons both claim", () => {
    const result = validateSeasons([summer(), winter({ endDay: 1, endMonth: 5 })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toMatch(/1 May/);
      expect(result.problems.join(" ")).toMatch(/summer/);
      expect(result.problems.join(" ")).toMatch(/winter/);
    }
  });

  it("catches a set that forgets 29 February", () => {
    /*
     * Jan 1 – Feb 28 then Mar 1 – Dec 31 tiles 365 days exactly, and
     * loses one day every fourth year. Validating against a leap year
     * is what catches it, since any day that exists in some year has to
     * belong to a season.
     */
    const result = validateSeasons([
      { code: "early", startMonth: 1, startDay: 1, endMonth: 2, endDay: 28 },
      { code: "rest", startMonth: 3, startDay: 1, endMonth: 12, endDay: 31 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/29 February/);
  });

  it("refuses an empty set rather than reporting 366 gaps", () => {
    const result = validateSeasons([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatch(/at least one season/i);
    }
  });

  it("refuses a day that is not a day of its month", () => {
    const result = validateSeasons([
      { code: "nope", startMonth: 2, startDay: 30, endMonth: 12, endDay: 31 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/30 February/);
  });

  it("refuses two seasons with the same code", () => {
    // The code is what a tariff's `season` predicate compares against,
    // so two of them makes the comparison meaningless.
    const result = validateSeasons([summer(), summer({ startMonth: 11, endMonth: 4 })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/summer/);
  });
});

describe("resolveSeason", () => {
  const seasons = [summer(), winter()];

  it("reads a date inside a plain range", () => {
    expect(resolveSeason(utc(6, 15), seasons)).toBe("summer");
  });

  it("reads a date inside a range that wraps the year end", () => {
    expect(resolveSeason(utc(12, 15), seasons)).toBe("winter");
    expect(resolveSeason(utc(1, 15), seasons)).toBe("winter");
  });

  it("includes both ends of a range", () => {
    expect(resolveSeason(utc(5, 1), seasons)).toBe("summer");
    expect(resolveSeason(utc(10, 31), seasons)).toBe("summer");
    expect(resolveSeason(utc(11, 1), seasons)).toBe("winter");
    expect(resolveSeason(utc(4, 30), seasons)).toBe("winter");
  });

  it("reads 29 February when a season covers it", () => {
    expect(resolveSeason(new Date(Date.UTC(2028, 1, 29)), seasons)).toBe("winter");
  });

  it("returns null when no season claims the date", () => {
    // Only reachable through an unvalidated set; the caller decides
    // whether that is a rating failure or a fallback, and it must not
    // be silently guessed here.
    expect(resolveSeason(utc(6, 15), [winter()])).toBeNull();
  });

  it("reads the date in UTC, not local time", () => {
    /*
     * The one bug this file exists downstream of: a period's bounds are
     * `@db.Date` columns, which Prisma returns as UTC midnight. Read
     * with local getters, 1 January is 31 December anywhere west of
     * Greenwich — which once resolved a Montana agreement's quarter to
     * the wrong year.
     */
    expect(resolveSeason(new Date(Date.UTC(2026, 0, 1)), seasons)).toBe("winter");
    expect(resolveSeason(new Date(Date.UTC(2026, 4, 1)), seasons)).toBe("summer");
  });
});
