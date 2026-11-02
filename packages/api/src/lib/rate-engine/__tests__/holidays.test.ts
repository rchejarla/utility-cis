import { describe, it, expect } from "vitest";
import { resolveHoliday, resolveHolidays, type HolidayRule } from "../holidays.js";

/**
 * Holiday rules and their observance (spec 26, TOU-CAL-4).
 *
 * A holiday is a day type, so it decides which hours are on-peak. Two
 * things make it the part people get wrong:
 *
 * **The rule.** "Fourth Thursday of November" and "last Monday of May"
 * are not dates; they resolve differently every year, and a count-based
 * rule can run off the end of the month ("fifth Monday" exists in some
 * years and not others).
 *
 * **Observance.** A holiday falling on a Saturday is commonly observed
 * the Friday before, and on a Sunday the Monday after. That *moves
 * which day is off-peak* — so getting it wrong misprices a whole day,
 * for every TOU customer, in a way that looks like an ordinary bill.
 * A tenant may also say it is not observed at all.
 *
 * Dates are UTC throughout, as everywhere in the engine: these are
 * calendar days, and reading them with local getters turns 1 January
 * into 31 December west of Greenwich.
 */

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);

const fixed = (over: Partial<HolidayRule> = {}): HolidayRule => ({
  code: "independence_day",
  label: "Independence Day",
  kind: "FIXED",
  month: 7,
  day: 4,
  observance: "NONE",
  ...over,
});

const nth = (over: Partial<HolidayRule> = {}): HolidayRule => ({
  code: "thanksgiving",
  label: "Thanksgiving",
  kind: "NTH_WEEKDAY",
  month: 11,
  weekday: 4, // Thursday, ISO
  nth: 4,
  observance: "NONE",
  ...over,
});

describe("fixed-date holidays", () => {
  it("resolves to its date", () => {
    expect(iso(resolveHoliday(fixed(), 2026)!.observed)).toBe("2026-07-04");
  });

  it("reports the actual date beside the observed one", () => {
    // The bill footnote names the holiday; the operator checking a
    // calendar needs to see that 3 July is off-peak *because* 4 July
    // fell on a Saturday.
    const r = resolveHoliday(fixed({ observance: "NEAREST_WEEKDAY" }), 2026)!;
    expect(iso(r.actual)).toBe("2026-07-04"); // a Saturday
    expect(iso(r.observed)).toBe("2026-07-03"); // observed Friday
  });
});

describe("nth-weekday holidays", () => {
  it("resolves the fourth Thursday of November", () => {
    expect(iso(resolveHoliday(nth(), 2026)!.observed)).toBe("2026-11-26");
    expect(iso(resolveHoliday(nth(), 2027)!.observed)).toBe("2027-11-25");
  });

  it("resolves a last-weekday rule", () => {
    // Memorial Day: last Monday of May. 2026 has five Mondays in May.
    const memorial = nth({
      code: "memorial_day",
      label: "Memorial Day",
      month: 5,
      weekday: 1,
      nth: -1,
    });
    expect(iso(resolveHoliday(memorial, 2026)!.observed)).toBe("2026-05-25");
  });

  it("resolves the first weekday of a month", () => {
    const labour = nth({ code: "labor_day", label: "Labor Day", month: 9, weekday: 1, nth: 1 });
    expect(iso(resolveHoliday(labour, 2026)!.observed)).toBe("2026-09-07");
  });

  it("returns null for an nth that the month does not have", () => {
    /*
     * May 2026 has four Mondays (4, 11, 18, 25); May 2027 has five
     * (3, 10, 17, 24, 31). So a "fifth Monday" rule resolves in 2027
     * and not in 2026 — null rather than silently falling back to the
     * fourth, since a calendar that quietly moved a holiday would
     * misprice a day and say nothing.
     *
     * The years here were the wrong way round when first written, and
     * the code caught it: worth the comment, because "which years have
     * five Mondays" is exactly the kind of thing to compute rather
     * than assume.
     */
    const fifth = nth({ month: 5, weekday: 1, nth: 5 });
    expect(resolveHoliday(fifth, 2026)).toBeNull();
    expect(resolveHoliday(fifth, 2027)).not.toBeNull();
  });
});

describe("observance", () => {
  const saturdayHoliday = fixed({ month: 7, day: 4 }); // Saturday in 2026
  const sundayHoliday = fixed({ code: "christmas", month: 11, day: 1 }); // Sunday in 2026

  it("leaves the date alone when not observed", () => {
    expect(iso(resolveHoliday({ ...saturdayHoliday, observance: "NONE" }, 2026)!.observed)).toBe(
      "2026-07-04",
    );
  });

  it("moves a Saturday holiday to the Friday before", () => {
    const r = resolveHoliday({ ...saturdayHoliday, observance: "NEAREST_WEEKDAY" }, 2026)!;
    expect(iso(r.observed)).toBe("2026-07-03");
  });

  it("moves a Sunday holiday to the Monday after", () => {
    const r = resolveHoliday({ ...sundayHoliday, observance: "NEAREST_WEEKDAY" }, 2026)!;
    expect(iso(r.actual)).toBe("2026-11-01"); // Sunday
    expect(iso(r.observed)).toBe("2026-11-02"); // Monday
  });

  it("leaves a weekday holiday where it is", () => {
    const r = resolveHoliday({ ...saturdayHoliday, observance: "NEAREST_WEEKDAY" }, 2027)!;
    expect(iso(r.actual)).toBe("2027-07-04"); // a Sunday
    expect(iso(r.observed)).toBe("2027-07-05");
    const weekday = resolveHoliday({ ...saturdayHoliday, observance: "NEAREST_WEEKDAY" }, 2025)!;
    expect(iso(weekday.actual)).toBe("2025-07-04"); // a Friday
    expect(iso(weekday.observed)).toBe("2025-07-04");
  });

  it("can observe a Saturday holiday on the following Monday instead", () => {
    // Some tenants observe forward in both cases rather than back.
    const r = resolveHoliday({ ...saturdayHoliday, observance: "FOLLOWING_MONDAY" }, 2026)!;
    expect(iso(r.observed)).toBe("2026-07-06");
  });
});

describe("resolveHolidays over a span of years", () => {
  it("returns the resolved dates the editor shows beside each rule", () => {
    // TOU-UI-2: a rule nobody can see the output of is a rule nobody
    // will trust, so the editor shows three years of resolved dates.
    const resolved = resolveHolidays([fixed(), nth()], 2026, 2028);
    const thanksgivings = resolved
      .filter((r) => r.code === "thanksgiving")
      .map((r) => iso(r.observed));
    expect(thanksgivings).toEqual(["2026-11-26", "2027-11-25", "2028-11-23"]);
  });

  it("drops a year a rule cannot resolve rather than shifting it", () => {
    // Five Mondays in May 2027 and 2028, four in 2026.
    const fifth = nth({ nth: 5, month: 5, weekday: 1 });
    const years = resolveHolidays([fifth], 2026, 2028).map((r) => r.year);
    expect(years).toEqual([2027, 2028]);
  });

  it("flags two rules that resolve to the same observed day", () => {
    /*
     * Not an error — a tenant may legitimately have two names for one
     * day — but the editor has to show it, because the day is one day
     * type and a reader counting holidays would otherwise be off by
     * one.
     */
    const a = fixed({ code: "a", month: 7, day: 4, observance: "NEAREST_WEEKDAY" });
    const b = fixed({ code: "b", month: 7, day: 3, observance: "NONE" });
    const resolved = resolveHolidays([a, b], 2026, 2026);
    const days = resolved.map((r) => iso(r.observed));
    expect(new Set(days).size).toBe(1);
    expect(resolved.every((r) => r.sharesObservedDate)).toBe(true);
  });
});
