import { describe, it, expect } from "vitest";
import {
  resolveDayType,
  resolvePeak,
  validateCalendar,
  validateTouPricing,
  type TouCalendarDefinition,
  type TouDayTypeDefinition,
  type TouSlotDefinition,
} from "../tou-calendar.js";
import type { SeasonDefinition } from "../seasons.js";

/**
 * The TOU calendar: which hours cost what (spec 26, TOU-CAL-1 – 3, 8, 9).
 *
 * A calendar answers one question — "what does this local date-time
 * cost?" — and three things have to line up to answer it: which season
 * the date falls in, what kind of day it is, and which span of the day
 * the time lands in. Every one of them can go wrong quietly, which is
 * why the answer carries its reasoning and a failure says which of the
 * three failed.
 *
 * Wall-clock throughout. The conversion from a stored UTC instant to a
 * local date and minute-of-day is a separate concern (TOU-CAL-6/7),
 * because TOU-CAL-7 classifies the repeated fall-back hour twice "both
 * by the same wall-clock rule" — so the rule must not know about
 * offsets at all.
 */

const day = (code: string, weekdays: number[]): TouDayTypeDefinition => ({
  dayTypeCode: code,
  weekdays: weekdays as TouDayTypeDefinition["weekdays"],
});

/** A whole day of one peak, for the (season, day type) given. */
const allDay = (seasonCode: string, dayTypeCode: string, peakCode: string): TouSlotDefinition => ({
  seasonCode,
  dayTypeCode,
  startMinute: 0,
  endMinute: 1440,
  peakCode,
});

const span = (
  seasonCode: string,
  dayTypeCode: string,
  startMinute: number,
  endMinute: number,
  peakCode: string,
): TouSlotDefinition => ({ seasonCode, dayTypeCode, startMinute, endMinute, peakCode });

const SEASONS: SeasonDefinition[] = [
  { seasonCode: "summer", startMonth: 6, startDay: 1, endMonth: 9, endDay: 30 },
  { seasonCode: "winter", startMonth: 10, startDay: 1, endMonth: 5, endDay: 31 },
];

/**
 * The shape of a real residential TOU tariff, reduced to what the
 * resolver needs: weekdays have a 4–9 pm peak in summer, weekends and
 * holidays are off-peak all day, and winter is flat.
 */
const CALENDAR: TouCalendarDefinition = {
  dayTypes: [day("weekday", [1, 2, 3, 4, 5]), day("weekend", [6, 7]), day("holiday", [])],
  peakCodes: ["on_peak", "off_peak"],
  slots: [
    span("summer", "weekday", 0, 960, "off_peak"),
    span("summer", "weekday", 960, 1260, "on_peak"), // 16:00–21:00
    span("summer", "weekday", 1260, 1440, "off_peak"),
    allDay("summer", "weekend", "off_peak"),
    allDay("summer", "holiday", "off_peak"),
    allDay("winter", "weekday", "off_peak"),
    allDay("winter", "weekend", "off_peak"),
    allDay("winter", "holiday", "off_peak"),
  ],
};

/** A local calendar day, read as UTC midnight like every date in the engine. */
const localDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

const noHolidays = new Set<string>();

describe("validateCalendar", () => {
  it("accepts a calendar whose every (season, day type) is tiled", () => {
    expect(validateCalendar(CALENDAR, SEASONS)).toEqual({ ok: true });
  });

  it("names the time range a gap leaves unpriced", () => {
    // 21:00–24:00 dropped from summer weekdays.
    const slots = CALENDAR.slots.filter((s) => !(s.startMinute === 1260 && s.seasonCode === "summer"));
    const result = validateCalendar({ ...CALENDAR, slots }, SEASONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toMatch(/summer/);
      expect(result.problems.join(" ")).toMatch(/weekday/);
      expect(result.problems.join(" ")).toMatch(/21:00.*24:00/);
    }
  });

  it("names the time range two spans both claim", () => {
    const slots = [
      ...CALENDAR.slots,
      span("summer", "weekday", 1020, 1080, "off_peak"), // 17:00–18:00, already on-peak
    ];
    const result = validateCalendar({ ...CALENDAR, slots }, SEASONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toMatch(/17:00.*18:00/);
      expect(result.problems.join(" ")).toMatch(/on_peak/);
      expect(result.problems.join(" ")).toMatch(/off_peak/);
    }
  });

  it("requires every (season, day type) pair, not just the ones with spans", () => {
    // A tenant adding a season and forgetting to price it is the common
    // case: the pairs that exist are tiled, and a third of the year has
    // no price at all.
    const seasons: SeasonDefinition[] = [
      { seasonCode: "summer", startMonth: 6, startDay: 1, endMonth: 9, endDay: 30 },
      { seasonCode: "shoulder", startMonth: 10, startDay: 1, endMonth: 11, endDay: 30 },
      { seasonCode: "winter", startMonth: 12, startDay: 1, endMonth: 5, endDay: 31 },
    ];
    const result = validateCalendar(CALENDAR, seasons);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/shoulder/);
  });

  it("refuses a span that is not on a 15-minute boundary", () => {
    // TOU-CAL-1 fixes the granularity at 15 minutes. A 17:10 boundary
    // would tile arithmetically and be unreachable from any interval.
    const slots = [
      span("summer", "weekday", 0, 970, "off_peak"),
      span("summer", "weekday", 970, 1260, "on_peak"),
      ...CALENDAR.slots.slice(2),
    ];
    const result = validateCalendar({ ...CALENDAR, slots }, SEASONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/15 minutes/);
  });

  it("refuses a peak that is declared and never used", () => {
    // TOU-CAL-3. A declared-unused peak is normally a half-finished
    // edit, and a rate component priced against it would never bill.
    const result = validateCalendar(
      { ...CALENDAR, peakCodes: [...CALENDAR.peakCodes, "super_off_peak"] },
      SEASONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/super_off_peak/);
  });

  it("refuses a span naming a peak the calendar never declared", () => {
    const slots = CALENDAR.slots.map((s) =>
      s.peakCode === "on_peak" ? { ...s, peakCode: "mid_peak" } : s,
    );
    const result = validateCalendar({ ...CALENDAR, slots }, SEASONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/mid_peak/);
  });

  it("requires the seven weekdays to be claimed exactly once", () => {
    /*
     * The constraint that makes day-type resolution total. A weekday
     * claimed by nobody leaves every Saturday unpriced; a weekday
     * claimed twice makes the answer depend on row order, which is the
     * failure that looks like a working calendar.
     */
    const gap = validateCalendar(
      { ...CALENDAR, dayTypes: [day("weekday", [1, 2, 3, 4, 5]), day("holiday", [])] },
      SEASONS,
    );
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.problems.join(" ")).toMatch(/Saturday/);

    const overlap = validateCalendar(
      {
        ...CALENDAR,
        dayTypes: [day("weekday", [1, 2, 3, 4, 5, 6]), day("weekend", [6, 7]), day("holiday", [])],
      },
      SEASONS,
    );
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.problems.join(" ")).toMatch(/Saturday/);
  });

  /*
   * "refuses two day types flagged as the holiday day type" was here
   * and is deleted, not repaired. The flag it guarded is gone: `holiday`
   * is a reserved code now and `tou_day_type_code_per_calendar` already
   * makes a code unique within a calendar, so two of them cannot exist
   * for the validator to catch. Rewritten to pass, it would have
   * validated an ordinary calendar while claiming to refuse something.
   */

  it("refuses a day type that nothing can ever select", () => {
    // No weekdays and not the holiday day type: every slot under it is
    // dead, and the hours it appears to price are priced elsewhere.
    const result = validateCalendar(
      {
        ...CALENDAR,
        dayTypes: [...CALENDAR.dayTypes, day("event", [])],
        slots: [...CALENDAR.slots, allDay("summer", "event", "on_peak"), allDay("winter", "event", "on_peak")],
      },
      SEASONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/event/);
  });

  it("allows a day type with no weekdays when a dated override selects it", () => {
    // TOU-CAL-9: a critical-peak event day is exactly this shape — no
    // weekday covers it, a specific date does.
    const result = validateCalendar(
      {
        ...CALENDAR,
        dayTypes: [...CALENDAR.dayTypes, day("event", [])],
        slots: [...CALENDAR.slots, allDay("summer", "event", "on_peak"), allDay("winter", "event", "on_peak")],
        overrides: [{ date: "2026-07-15", dayTypeCode: "event" }],
      },
      SEASONS,
    );
    expect(result).toEqual({ ok: true });
  });

  it("refuses an override naming a day type the calendar does not define", () => {
    const result = validateCalendar(
      { ...CALENDAR, overrides: [{ date: "2026-07-15", dayTypeCode: "typo" }] },
      SEASONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/typo/);
  });
});

describe("resolveDayType", () => {
  it("reads a weekday from its ISO weekday", () => {
    // 1 July 2026 is a Wednesday.
    const r = resolveDayType(localDay(2026, 7, 1), CALENDAR, noHolidays);
    expect(r).toEqual({ dayTypeCode: "weekday", reason: "WEEKDAY" });
  });

  it("reads a weekend day", () => {
    // 4 July 2026 is a Saturday.
    expect(resolveDayType(localDay(2026, 7, 4), CALENDAR, noHolidays)?.dayTypeCode).toBe("weekend");
  });

  it("prefers the holiday day type over the weekday the date falls on", () => {
    // An observed holiday on a Wednesday is not a weekday for pricing —
    // which is the whole reason holidays are a day type.
    const r = resolveDayType(localDay(2026, 7, 1), CALENDAR, new Set(["2026-07-01"]));
    expect(r).toEqual({ dayTypeCode: "holiday", reason: "HOLIDAY" });
  });

  it("uses the observed date, not the date the holiday falls on", () => {
    // 4 July 2026 is a Saturday, commonly observed on Friday 3 July.
    // The set it receives already holds observed dates (`observedDays`),
    // so the Friday is the holiday and the Saturday is an ordinary
    // weekend day.
    const observed = new Set(["2026-07-03"]);
    expect(resolveDayType(localDay(2026, 7, 3), CALENDAR, observed)?.dayTypeCode).toBe("holiday");
    expect(resolveDayType(localDay(2026, 7, 4), CALENDAR, observed)?.dayTypeCode).toBe("weekend");
  });

  it("lets a dated override win over a holiday", () => {
    /*
     * TOU-CAL-9. The override is the narrowest statement a tenant can
     * make — one named date — so it outranks both the holiday set and
     * the weekday coverage. A critical peak event called on a holiday
     * is the case: the event is why the day is priced as it is.
     */
    const overrides = [{ date: "2026-07-01", dayTypeCode: "weekday" }];
    const r = resolveDayType(localDay(2026, 7, 1), CALENDAR, new Set(["2026-07-01"]), overrides);
    expect(r).toEqual({ dayTypeCode: "weekday", reason: "OVERRIDE" });
  });

  it("falls back to the weekday when a calendar has no holiday day type", () => {
    // A tenant whose tariff does not distinguish holidays. The date is
    // still a holiday to the holiday set; no day type claims it, so the
    // weekday coverage answers.
    const noHolidayType: TouCalendarDefinition = {
      ...CALENDAR,
      dayTypes: [day("weekday", [1, 2, 3, 4, 5]), day("weekend", [6, 7])],
    };
    const r = resolveDayType(localDay(2026, 7, 1), noHolidayType, new Set(["2026-07-01"]));
    expect(r).toEqual({ dayTypeCode: "weekday", reason: "WEEKDAY" });
  });

  it("returns null when no day type claims the date", () => {
    // Only reachable through an unvalidated calendar; guessing here
    // would price a day against a day type nobody chose.
    const partial: TouCalendarDefinition = {
      ...CALENDAR,
      dayTypes: [day("weekday", [1, 2, 3, 4, 5])],
    };
    expect(resolveDayType(localDay(2026, 7, 4), partial, noHolidays)).toBeNull();
  });

  it("reads the date in UTC, not local time", () => {
    // 1 January 2026 is a Thursday; read with local getters west of
    // Greenwich it is Wednesday 31 December — a different weekday, and
    // in a wrapping season a different season too.
    expect(resolveDayType(localDay(2026, 1, 1), CALENDAR, noHolidays)?.dayTypeCode).toBe("weekday");
  });
});

describe("resolvePeak", () => {
  const lookup = (date: Date, minuteOfDay: number, observedHolidays = noHolidays) =>
    resolvePeak({ date, minuteOfDay, calendar: CALENDAR, seasons: SEASONS, observedHolidays });

  it("answers with the peak and the reasoning behind it", () => {
    // TOU-CAL-8 / TOU-UI-1c: the answer is only checkable if it says
    // why. 1 July 2026 is a summer Wednesday; 17:15 is 1035 minutes.
    expect(lookup(localDay(2026, 7, 1), 1035)).toEqual({
      ok: true,
      peakCode: "on_peak",
      seasonCode: "summer",
      dayTypeCode: "weekday",
      dayTypeReason: "WEEKDAY",
    });
  });

  it("includes the start of a span and excludes its end", () => {
    // 16:00 is on-peak, 21:00 is not. A half-open span is what makes
    // two adjacent spans tile without the boundary minute being either
    // double-counted or lost.
    const d = localDay(2026, 7, 1);
    expect(lookup(d, 960)).toMatchObject({ peakCode: "on_peak" });
    expect(lookup(d, 959)).toMatchObject({ peakCode: "off_peak" });
    expect(lookup(d, 1260)).toMatchObject({ peakCode: "off_peak" });
    expect(lookup(d, 1259)).toMatchObject({ peakCode: "on_peak" });
  });

  it("prices a holiday afternoon off-peak", () => {
    const r = lookup(localDay(2026, 7, 1), 1035, new Set(["2026-07-01"]));
    expect(r).toMatchObject({ ok: true, peakCode: "off_peak", dayTypeReason: "HOLIDAY" });
  });

  it("prices the same hour differently in winter", () => {
    expect(lookup(localDay(2026, 1, 7), 1035)).toMatchObject({
      peakCode: "off_peak",
      seasonCode: "winter",
    });
  });

  it("says which of the three resolutions failed", () => {
    /*
     * A bare null would send whoever is checking a tariff to read the
     * whole calendar. Each failure names its own cause: no season
     * claims the date, no day type claims it, or no span covers the
     * time.
     */
    const noSeason = resolvePeak({
      date: localDay(2026, 7, 1),
      minuteOfDay: 600,
      calendar: CALENDAR,
      seasons: [SEASONS[1]],
      observedHolidays: noHolidays,
    });
    expect(noSeason.ok).toBe(false);
    if (!noSeason.ok) expect(noSeason.problem).toMatch(/season/i);

    const noSpan = resolvePeak({
      date: localDay(2026, 7, 1),
      minuteOfDay: 600,
      calendar: { ...CALENDAR, slots: CALENDAR.slots.filter((s) => s.startMinute !== 0) },
      seasons: SEASONS,
      observedHolidays: noHolidays,
    });
    expect(noSpan.ok).toBe(false);
    if (!noSpan.ok) expect(noSpan.problem).toMatch(/10:00/);
  });

  it("refuses a minute outside the day", () => {
    // 1440 is midnight tomorrow. Reaching here means the caller's
    // UTC-to-local conversion is wrong, and classifying it against the
    // last span of today would hide that.
    const r = lookup(localDay(2026, 7, 1), 1440);
    expect(r.ok).toBe(false);
  });
});


describe("validateTouPricing (spec 26, TOU-UI-3)", () => {
  /**
   * Do a schedule's TOU components and its calendar line up?
   *
   * Both directions matter and they fail differently:
   *
   * - a component pricing a period the calendar has not got **never
   *   bills**, because no meter reports that period and the quantity
   *   source finds no bucket;
   * - a calendar period **no component prices** is energy the customer
   *   uses and is never charged for. Nothing raises: the bucket is
   *   simply never asked about, and the bill looks complete.
   *
   * The second is the expensive one, which is why it is an error here
   * rather than a warning.
   */

  it("accepts a schedule that prices every period exactly once", () => {
    expect(validateTouPricing(["peak", "off_peak"], ["peak", "off_peak"])).toEqual({ ok: true });
  });

  it("accepts a period priced by more than one component", () => {
    // One component per season is the normal shape: summer on-peak and
    // non-summer on-peak both price `peak`.
    expect(validateTouPricing(["peak", "peak", "off_peak"], ["peak", "off_peak"])).toEqual({
      ok: true,
    });
  });

  it("refuses a component pricing a period the calendar has not got", () => {
    // Usually a typo in the peak code. It would never bill: no meter
    // reports `pekk`, so the quantity source finds no bucket.
    const result = validateTouPricing(["peak", "pekk"], ["peak", "off_peak"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toMatch(/pekk/);
      expect(result.problems.join(" ")).toMatch(/does not define/i);
    }
  });

  it("refuses a calendar period no component prices", () => {
    /*
     * The costly direction. The calendar routes usage into mid-peak,
     * the meter reports it, and no component charges for it - so the
     * customer gets that energy free and the bill looks complete.
     */
    const result = validateTouPricing(["peak", "off_peak"], ["peak", "mid_peak", "off_peak"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toMatch(/mid_peak/);
      expect(result.problems.join(" ")).toMatch(/no component prices/i);
      // The message has to say what happens, not just that it is wrong:
      // whoever reads it is about to decide whether to publish anyway.
      expect(result.problems.join(" ")).toMatch(/never charged/i);
    }
  });

  it("names every unpriced period, not just the first", () => {
    const result = validateTouPricing(["peak"], ["peak", "mid_peak", "off_peak", "super_off_peak"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const all = result.problems.join(" ");
      expect(all).toMatch(/mid_peak/);
      expect(all).toMatch(/off_peak/);
      expect(all).toMatch(/super_off_peak/);
    }
  });

  it("reports both directions at once", () => {
    const result = validateTouPricing(["peak", "typo"], ["peak", "mid_peak"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(2);
  });

  it("refuses a schedule that prices nothing against a TOU calendar", () => {
    // A calendar referenced by a schedule with no TOU components means
    // every period is unpriced, which is the same costly failure.
    const result = validateTouPricing([], ["peak", "off_peak"]);
    expect(result.ok).toBe(false);
  });

  it("accepts a schedule with no TOU components and no calendar", () => {
    // The ordinary non-TOU tariff. Nothing to line up.
    expect(validateTouPricing([], [])).toEqual({ ok: true });
  });
});
