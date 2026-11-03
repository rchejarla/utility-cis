/**
 * SMUD residential Time-of-Day (5–8 p.m.), as the golden TOU tariff.
 *
 * Sacramento Municipal Utility District is a publicly owned utility,
 * which is the market this system is built for, and it publishes the
 * whole calendar — seasons, windows, the holiday list and the
 * observance rule — on one page:
 * https://www.smud.org/Rate-Information/Residential-rates/Time-of-Day-5-8pm-Rate/Rate-details
 *
 * **Chosen because it exercises more of the model than a two-period
 * tariff would** (spec 26, open question 1, decided 2026-11-02 in the
 * absence of a prospect's schedule):
 *
 * - a season that **wraps the year end** — non-summer is 1 Oct – 31 May
 * - **three periods in summer, two in non-summer**, so the calendar's
 *   shape is not the same in every season
 * - a period appearing **twice in one day** — summer mid-peak runs
 *   noon–5 pm and again 8 pm–midnight, either side of the peak
 * - **eleven holidays**, mixing fixed dates with nth-weekday rules,
 *   including a last-Monday rule
 * - an explicit **observance rule**, and not the one a textbook assumes
 *
 * On that last point: SMUD states that a fixed-date holiday falling on
 * a weekend is *not* shifted to an observed weekday. So all eleven
 * rules are `observance: "NONE"` — a real utility using the default,
 * which is worth pinning, since `NEAREST_WEEKDAY` is the rule most
 * people would assume.
 *
 * **What this fixture deliberately leaves out.** SMUD's monthly System
 * Infrastructure Fixed Charge is not here: sources disagree on which
 * step is current, and a flat monthly charge exercises nothing the
 * Bozeman and NWE golden tests do not already cover. The prices below
 * are the energy charges, which are the part a TOU calendar decides.
 *
 * Replace or supplement this when a real prospect's tariff arrives; it
 * is a second file, not an edit to this one.
 */

import type { SeasonDefinition } from "../../seasons.js";
import type { HolidayRule } from "../../holidays.js";
import type { TouCalendarDefinition } from "../../tou-calendar.js";

/** Minutes from midnight, for spans written as clock times. */
const hhmm = (hour: number, minute = 0) => hour * 60 + minute;

export const SMUD_TIME_ZONE = "America/Los_Angeles";

/**
 * Summer is June through September; everything else is non-summer,
 * which wraps the year end as one season rather than two.
 */
export const SMUD_SEASONS: SeasonDefinition[] = [
  { seasonCode: "summer", startMonth: 6, startDay: 1, endMonth: 9, endDay: 30 },
  { seasonCode: "non_summer", startMonth: 10, startDay: 1, endMonth: 5, endDay: 31 },
];

/**
 * All eleven, all `NONE`: SMUD does not move a fixed-date holiday that
 * falls on a weekend to the adjacent weekday. The nth-weekday rules
 * always land on a Monday or Thursday, so observance never arises for
 * them.
 */
export const SMUD_HOLIDAY_RULES: HolidayRule[] = [
  { code: "new_years_day", label: "New Year's Day", kind: "FIXED", month: 1, day: 1, observance: "NONE" },
  { code: "mlk_day", label: "Martin Luther King Jr. Day", kind: "NTH_WEEKDAY", month: 1, weekday: 1, nth: 3, observance: "NONE" },
  { code: "presidents_day", label: "Presidents Day", kind: "NTH_WEEKDAY", month: 2, weekday: 1, nth: 3, observance: "NONE" },
  { code: "memorial_day", label: "Memorial Day", kind: "NTH_WEEKDAY", month: 5, weekday: 1, nth: -1, observance: "NONE" },
  { code: "juneteenth", label: "Juneteenth National Independence Day", kind: "FIXED", month: 6, day: 19, observance: "NONE" },
  { code: "independence_day", label: "Independence Day", kind: "FIXED", month: 7, day: 4, observance: "NONE" },
  { code: "labor_day", label: "Labor Day", kind: "NTH_WEEKDAY", month: 9, weekday: 1, nth: 1, observance: "NONE" },
  { code: "indigenous_peoples_day", label: "Indigenous Peoples' Day", kind: "NTH_WEEKDAY", month: 10, weekday: 1, nth: 2, observance: "NONE" },
  { code: "veterans_day", label: "Veterans Day", kind: "FIXED", month: 11, day: 11, observance: "NONE" },
  { code: "thanksgiving", label: "Thanksgiving Day", kind: "NTH_WEEKDAY", month: 11, weekday: 4, nth: 4, observance: "NONE" },
  { code: "christmas", label: "Christmas Day", kind: "FIXED", month: 12, day: 25, observance: "NONE" },
];

/**
 * Peak is weekdays 5–8 p.m. in both seasons. Weekends and holidays are
 * off-peak all day — SMUD says they are "always off-peak", so mid-peak
 * does not apply to them either.
 */
export const SMUD_CALENDAR: TouCalendarDefinition = {
  dayTypes: [
    { dayTypeCode: "weekday", weekdays: [1, 2, 3, 4, 5], isHoliday: false },
    { dayTypeCode: "weekend", weekdays: [6, 7], isHoliday: false },
    { dayTypeCode: "holiday", weekdays: [], isHoliday: true },
  ],
  peakCodes: ["off_peak", "mid_peak", "peak"],
  slots: [
    // Non-summer weekdays: off-peak until 5 pm, peak 5–8, off-peak after.
    { seasonCode: "non_summer", dayTypeCode: "weekday", startMinute: hhmm(0), endMinute: hhmm(17), peakCode: "off_peak" },
    { seasonCode: "non_summer", dayTypeCode: "weekday", startMinute: hhmm(17), endMinute: hhmm(20), peakCode: "peak" },
    { seasonCode: "non_summer", dayTypeCode: "weekday", startMinute: hhmm(20), endMinute: hhmm(24), peakCode: "off_peak" },
    { seasonCode: "non_summer", dayTypeCode: "weekend", startMinute: hhmm(0), endMinute: hhmm(24), peakCode: "off_peak" },
    { seasonCode: "non_summer", dayTypeCode: "holiday", startMinute: hhmm(0), endMinute: hhmm(24), peakCode: "off_peak" },

    // Summer weekdays: mid-peak brackets the peak on both sides.
    { seasonCode: "summer", dayTypeCode: "weekday", startMinute: hhmm(0), endMinute: hhmm(12), peakCode: "off_peak" },
    { seasonCode: "summer", dayTypeCode: "weekday", startMinute: hhmm(12), endMinute: hhmm(17), peakCode: "mid_peak" },
    { seasonCode: "summer", dayTypeCode: "weekday", startMinute: hhmm(17), endMinute: hhmm(20), peakCode: "peak" },
    { seasonCode: "summer", dayTypeCode: "weekday", startMinute: hhmm(20), endMinute: hhmm(24), peakCode: "mid_peak" },
    { seasonCode: "summer", dayTypeCode: "weekend", startMinute: hhmm(0), endMinute: hhmm(24), peakCode: "off_peak" },
    { seasonCode: "summer", dayTypeCode: "holiday", startMinute: hhmm(0), endMinute: hhmm(24), peakCode: "off_peak" },
  ],
};

/**
 * Energy charges, dollars per kWh, as the rate-details page states
 * them. `mid_peak` exists only in summer, which is why this is keyed by
 * season and period rather than being a flat table.
 */
export const SMUD_ENERGY_RATES: Record<string, Record<string, number>> = {
  non_summer: { off_peak: 0.1285, peak: 0.1776 },
  summer: { off_peak: 0.1550, mid_peak: 0.2139, peak: 0.3765 },
};
