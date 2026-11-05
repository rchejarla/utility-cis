/**
 * SMUD residential Time-of-Day (5–8 p.m.), as the golden TOU tariff.
 *
 * Sacramento Municipal Utility District is a publicly owned utility,
 * which is the market this system is built for, and it publishes the
 * whole calendar — seasons, windows, the holiday set and the
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
 * SMUD's eleven holidays, as dates for 2026.
 *
 * Dates rather than rules, because a rule is a computation nobody
 * checked. The interesting one is what is **not** here: 4 July 2026
 * falls on a Saturday and SMUD does not move the holiday to the Friday,
 * so 3 July is an ordinary summer weekday at the most expensive rate in
 * the tariff. Under rules that was `observance: "NONE"` and easy to
 * mis-set; as dates it is simply the day somebody typed.
 */
export const SMUD_HOLIDAYS_2026: Array<{ date: string; name: string }> = [
  { date: "2026-01-01", name: "New Year's Day" },
  { date: "2026-01-19", name: "Martin Luther King Jr. Day" },
  { date: "2026-02-16", name: "Presidents Day" },
  { date: "2026-05-25", name: "Memorial Day" },
  { date: "2026-06-19", name: "Juneteenth National Independence Day" },
  { date: "2026-07-04", name: "Independence Day" },
  { date: "2026-09-07", name: "Labor Day" },
  { date: "2026-10-12", name: "Indigenous Peoples' Day" },
  { date: "2026-11-11", name: "Veterans Day" },
  { date: "2026-11-26", name: "Thanksgiving Day" },
  { date: "2026-12-25", name: "Christmas Day" },
];

/**
 * The next year, by the same policy: the actual date, never shifted.
 *
 * Here because a set covers a horizon — the loader fetches the dates
 * falling inside the billing period, and a December-to-January period
 * needs both years or New Year's Day prices as an ordinary weekday. One
 * year of dates cannot show that; it is also what a real tenant will
 * hit, two Decembers from now.
 */
export const SMUD_HOLIDAYS_2027: Array<{ date: string; name: string }> = [
  { date: "2027-01-01", name: "New Year's Day" },
  { date: "2027-01-18", name: "Martin Luther King Jr. Day" },
  { date: "2027-02-15", name: "Presidents Day" },
  { date: "2027-05-31", name: "Memorial Day" },
  { date: "2027-06-19", name: "Juneteenth National Independence Day" },
  { date: "2027-07-04", name: "Independence Day" },
  { date: "2027-09-06", name: "Labor Day" },
  { date: "2027-10-11", name: "Indigenous Peoples' Day" },
  { date: "2027-11-11", name: "Veterans Day" },
  { date: "2027-11-25", name: "Thanksgiving Day" },
  { date: "2027-12-25", name: "Christmas Day" },
];

/** Both years, which is what a holiday set holds. */
export const SMUD_HOLIDAYS = [...SMUD_HOLIDAYS_2026, ...SMUD_HOLIDAYS_2027];

/** The same, as the engine consumes them. */
export const SMUD_OBSERVED_2026 = new Set(SMUD_HOLIDAYS_2026.map((h) => h.date));

/**
 * Peak is weekdays 5–8 p.m. in both seasons. Weekends and holidays are
 * off-peak all day — SMUD says they are "always off-peak", so mid-peak
 * does not apply to them either.
 */
export const SMUD_CALENDAR: TouCalendarDefinition = {
  dayTypes: [
    { dayTypeCode: "weekday", weekdays: [1, 2, 3, 4, 5] },
    { dayTypeCode: "weekend", weekdays: [6, 7] },
    { dayTypeCode: "holiday", weekdays: [] },
  ],
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
