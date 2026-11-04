import { describe, it, expect } from "vitest";
import { validateSeasons } from "../../seasons.js";
import { resolvePeak, validateCalendar, type TouPeakLookup } from "../../tou-calendar.js";
import { toLocalMoment } from "../../tou-clock.js";
import {
  SMUD_CALENDAR,
  SMUD_ENERGY_RATES,
  SMUD_HOLIDAYS_2026,
  SMUD_OBSERVED_2026,
  SMUD_SEASONS,
  SMUD_TIME_ZONE,
} from "./_smud-time-of-day-fixtures.js";

/**
 * The golden TOU calendar: SMUD residential Time-of-Day (5–8 p.m.).
 *
 * A conformance test, not a unit test. `tou-calendar.test.ts` proves the
 * rules in isolation against calendars written to provoke them; this
 * proves the model can hold a calendar nobody designed it for, and that
 * a real tariff's published answers come back out. Where the two
 * disagree, this one is right.
 *
 * It classifies **UTC instants**, the way rating will: the conversion
 * and the classification are separate modules, and the only thing that
 * matters is whether the pair of them prices 6 p.m. in Sacramento
 * correctly in both halves of the year.
 */

const utc = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi));

const holidays2026 = SMUD_OBSERVED_2026;

/** Local wall-clock time in Sacramento, then the period at it. */
function classifyLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): TouPeakLookup {
  return resolvePeak({
    date: new Date(Date.UTC(year, month - 1, day)),
    minuteOfDay: hour * 60 + minute,
    calendar: SMUD_CALENDAR,
    seasons: SMUD_SEASONS,
    observedHolidays: SMUD_OBSERVED_2026,
  });
}

/** What a stored interval timestamp costs: UTC in, period out. */
function classifyInstant(instant: Date): TouPeakLookup {
  const local = toLocalMoment(instant, SMUD_TIME_ZONE, "prevailing");
  return resolvePeak({
    date: local.date,
    minuteOfDay: local.minuteOfDay,
    calendar: SMUD_CALENDAR,
    seasons: SMUD_SEASONS,
    observedHolidays: SMUD_OBSERVED_2026,
  });
}

/** The price a classified interval is charged at. */
function priceOf(lookup: TouPeakLookup): number {
  if (!lookup.ok) throw new Error(`unclassified: ${lookup.problem}`);
  const price = SMUD_ENERGY_RATES[lookup.seasonCode]?.[lookup.peakCode];
  if (price === undefined) {
    throw new Error(`no published price for ${lookup.seasonCode} ${lookup.peakCode}`);
  }
  return price;
}

describe("the tariff as published is a calendar this model accepts", () => {
  it("tiles the year with a season that wraps it", () => {
    // Non-summer is 1 Oct – 31 May. A naive range check reads that as
    // "month >= 10 and month <= 5", which is never true, and every
    // December interval would price as whatever came last.
    expect(validateSeasons(SMUD_SEASONS)).toEqual({ ok: true });
  });

  it("prices every minute of every season and day type exactly once", () => {
    // Including the asymmetry: summer has three periods and non-summer
    // two, so six (season, day type) pairs are tiled by different
    // numbers of spans.
    expect(validateCalendar(SMUD_CALENDAR, SMUD_SEASONS)).toEqual({ ok: true });
  });

  it("observes eleven days a year, each on its own date", () => {
    // The set is the fact now, so this checks the fixture is a set and
    // not an accidental list with a day repeated — which would make
    // "is this a holiday" answerable twice.
    expect(SMUD_HOLIDAYS_2026).toHaveLength(11);
    expect(SMUD_OBSERVED_2026.size).toBe(11);
  });
});

describe("summer weekdays", () => {
  // 15 June 2026 is a Monday.
  it("is peak at 6 pm, at the top of the published rate", () => {
    const r = classifyLocal(2026, 6, 15, 18);
    expect(r).toMatchObject({ ok: true, seasonCode: "summer", peakCode: "peak" });
    expect(priceOf(r)).toBe(0.3765);
  });

  it("is mid-peak on both sides of the peak, which is one period in two spans", () => {
    expect(priceOf(classifyLocal(2026, 6, 15, 13))).toBe(0.2139); // noon–5 pm
    expect(priceOf(classifyLocal(2026, 6, 15, 21))).toBe(0.2139); // 8 pm–midnight
  });

  it("is off-peak overnight", () => {
    expect(priceOf(classifyLocal(2026, 6, 15, 3))).toBe(0.1550);
  });

  it("switches on the hour, not within it", () => {
    // 4:59 pm is mid-peak and 5:00 pm is peak — a factor of 1.76 across
    // one minute, which is why the span's start is inclusive and its
    // end is not.
    expect(classifyLocal(2026, 6, 15, 16, 59)).toMatchObject({ peakCode: "mid_peak" });
    expect(classifyLocal(2026, 6, 15, 17, 0)).toMatchObject({ peakCode: "peak" });
    expect(classifyLocal(2026, 6, 15, 19, 59)).toMatchObject({ peakCode: "peak" });
    expect(classifyLocal(2026, 6, 15, 20, 0)).toMatchObject({ peakCode: "mid_peak" });
  });
});

describe("non-summer weekdays", () => {
  it("has no mid-peak, so the same early afternoon is off-peak", () => {
    // 1 pm is mid-peak in summer and off-peak in non-summer: the
    // calendar's *shape* differs by season, not just its prices.
    expect(priceOf(classifyLocal(2026, 1, 15, 13))).toBe(0.1285);
    expect(classifyLocal(2026, 1, 15, 13)).toMatchObject({ peakCode: "off_peak" });
  });

  it("still has the 5–8 pm peak, at the lower published rate", () => {
    const r = classifyLocal(2026, 1, 15, 18);
    expect(r).toMatchObject({ seasonCode: "non_summer", peakCode: "peak" });
    expect(priceOf(r)).toBe(0.1776);
  });

  it("covers both sides of the year end", () => {
    // 31 December 2026 and 1 January 2026 are both non-summer, which is
    // the wrap doing its job.
    expect(classifyLocal(2026, 12, 31, 13)).toMatchObject({ seasonCode: "non_summer" });
    expect(classifyLocal(2026, 1, 1, 13)).toMatchObject({ seasonCode: "non_summer" });
  });
});

describe("weekends and holidays are always off-peak", () => {
  it("prices a summer Saturday evening off-peak, not peak", () => {
    // 4 July 2026 is a Saturday. 6 pm would be peak on a weekday.
    const r = classifyLocal(2026, 7, 4, 18);
    expect(r).toMatchObject({ peakCode: "off_peak" });
    expect(priceOf(r)).toBe(0.1550);
  });

  it("prices Thanksgiving evening off-peak although it is a Thursday", () => {
    /*
     * 26 November 2026, the fourth Thursday. This is the single most
     * valuable assertion in the file: it is the one case where getting
     * the holiday date wrong charges the peak rate on a day the tariff
     * says is off-peak, to every TOU customer, on a bill that looks
     * entirely ordinary.
     */
    const r = classifyLocal(2026, 11, 26, 18);
    expect(r).toMatchObject({ peakCode: "off_peak", dayTypeReason: "HOLIDAY" });
    expect(priceOf(r)).toBe(0.1285);

    // The Wednesday before is an ordinary weekday, at 38% more.
    expect(priceOf(classifyLocal(2026, 11, 25, 18))).toBe(0.1776);
  });

  it("prices Juneteenth off-peak, at the summer rate", () => {
    // 19 June 2026 is a Friday, and in summer — so the holiday saves
    // the customer the peak rate rather than the non-summer one.
    const r = classifyLocal(2026, 6, 19, 18);
    expect(r).toMatchObject({ peakCode: "off_peak", dayTypeReason: "HOLIDAY" });
    expect(priceOf(r)).toBe(0.1550);
  });

  it("prices Memorial Day off-peak while it is still non-summer", () => {
    // 25 May 2026 — before 1 June, so the holiday lands in the cheaper
    // season and the two rules interact.
    expect(holidays2026.has("2026-05-25")).toBe(true);
    const r = classifyLocal(2026, 5, 25, 18);
    expect(r).toMatchObject({ seasonCode: "non_summer", dayTypeReason: "HOLIDAY" });
  });

  it("leaves the Friday before a Saturday holiday at full peak", () => {
    /*
     * SMUD's actual practice, and not the one a textbook assumes: 4
     * July 2026 is a Saturday and they do **not** move the holiday to
     * the Friday. So 3 July is an ordinary summer weekday and 6 pm on
     * it is peak — the most expensive rate in the tariff, on the day
     * many utilities would have made the cheapest.
     *
     * This used to be `observance: "NONE"` on a rule, a field easy to
     * mis-set and invisible once set. As dates it is just the day
     * somebody typed: 4 July is in the set and 3 July is not.
     */
    expect(holidays2026.has("2026-07-03")).toBe(false);
    expect(priceOf(classifyLocal(2026, 7, 3, 18))).toBe(0.3765);
  });
});

describe("classifying a stored UTC instant", () => {
  it("prices 6 pm Sacramento as peak in both halves of the year", () => {
    // Sacramento is UTC-7 in June and UTC-8 in January, so the same
    // local 6 pm is a different UTC hour. Reading the stored timestamp
    // as if it were local would price one of these two wrong.
    expect(priceOf(classifyInstant(utc(2026, 6, 16, 1)))).toBe(0.3765); // 18:00 PDT, 15 June
    expect(priceOf(classifyInstant(utc(2026, 1, 16, 2)))).toBe(0.1776); // 18:00 PST, 15 January
  });

  it("gives the local calendar day, so a late-evening interval is not tomorrow's", () => {
    // 05:00 UTC on 16 June is 10 pm on the 15th in Sacramento — a
    // Monday mid-peak. Classified against the UTC date it would be a
    // Tuesday, and against the UTC hour it would be off-peak.
    const r = classifyInstant(utc(2026, 6, 16, 5));
    expect(r).toMatchObject({ peakCode: "mid_peak", dayTypeCode: "weekday" });
  });

  it("has no interval in the hour spring forward removes", () => {
    // 8 March 2026: 2 a.m. local becomes 3 a.m. Both of these are
    // off-peak, so this does not change a price — it pins that the
    // conversion does not invent a 2 a.m. the day did not have.
    const before = toLocalMoment(utc(2026, 3, 8, 9, 59), SMUD_TIME_ZONE, "prevailing");
    const after = toLocalMoment(utc(2026, 3, 8, 10, 0), SMUD_TIME_ZONE, "prevailing");
    expect(before.minuteOfDay).toBe(119); // 01:59
    expect(after.minuteOfDay).toBe(180); // 03:00
  });

  it("prices both occurrences of the repeated fall-back hour the same", () => {
    // 1 November 2026: 1–2 a.m. happens twice. Two distinct intervals,
    // one local time, one price — which is TOU-CAL-7's rule rather than
    // a case to special-case. 1 November 2026 is a Sunday, so both are
    // weekend off-peak.
    const first = classifyInstant(utc(2026, 11, 1, 8, 30)); // 01:30 PDT
    const second = classifyInstant(utc(2026, 11, 1, 9, 30)); // 01:30 PST
    expect(first).toMatchObject({ peakCode: "off_peak", dayTypeCode: "weekend" });
    expect(second).toEqual(first);
  });
});

describe("a day of intervals, as rating will consume one", () => {
  it("buckets 96 quarter-hours of a summer weekday into the published periods", () => {
    /*
     * The shape slice 2 will feed the engine: every interval of a day
     * classified, then summed per period. Counting the buckets is what
     * catches a span boundary that is off by one quarter-hour — which
     * no single lookup would show.
     */
    const counts = new Map<string, number>();
    for (let minute = 0; minute < 1440; minute += 15) {
      const r = classifyLocal(2026, 6, 15, Math.floor(minute / 60), minute % 60);
      if (!r.ok) throw new Error(r.problem);
      counts.set(r.peakCode, (counts.get(r.peakCode) ?? 0) + 1);
    }
    expect(counts.get("off_peak")).toBe(48); // midnight–noon
    expect(counts.get("mid_peak")).toBe(36); // noon–5 pm and 8 pm–midnight
    expect(counts.get("peak")).toBe(12); // 5–8 pm
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(96);
  });

  it("buckets a non-summer weekday into two periods", () => {
    const counts = new Map<string, number>();
    for (let minute = 0; minute < 1440; minute += 15) {
      const r = classifyLocal(2026, 1, 15, Math.floor(minute / 60), minute % 60);
      if (!r.ok) throw new Error(r.problem);
      counts.set(r.peakCode, (counts.get(r.peakCode) ?? 0) + 1);
    }
    expect(counts.get("off_peak")).toBe(84);
    expect(counts.get("peak")).toBe(12);
    expect(counts.has("mid_peak")).toBe(false);
  });
});
