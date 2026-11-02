/**
 * Holiday rules and their observance (spec 26, TOU-CAL-4).
 *
 * A holiday is a **day type**, so it decides which hours are on-peak.
 * That is why this is worth its own module and its own tests: getting a
 * rule or an observance wrong misprices a whole day, for every TOU
 * customer, in a way that looks like an ordinary bill.
 *
 * Pure, like the rest of the engine. The dates come out; nothing is
 * read from a database, and the calendar screen and the rating path use
 * the same function so the preview cannot disagree with the bill.
 *
 * All dates are UTC: these are calendar days, and local getters turn
 * 1 January into 31 December west of Greenwich.
 */

/** ISO weekday: Monday is 1, Sunday is 7. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type HolidayObservance =
  /** Observed on the day it falls, whatever day that is. */
  | "NONE"
  /** Saturday → the Friday before; Sunday → the Monday after. */
  | "NEAREST_WEEKDAY"
  /** Either weekend day → the following Monday. */
  | "FOLLOWING_MONDAY";

export interface HolidayRule {
  code: string;
  label: string;
  /** A fixed date, or the nth weekday of a month. */
  kind: "FIXED" | "NTH_WEEKDAY";
  month: number;
  /** `FIXED` only. */
  day?: number;
  /** `NTH_WEEKDAY` only. */
  weekday?: IsoWeekday;
  /** `NTH_WEEKDAY` only. 1–5, or -1 for the last in the month. */
  nth?: number;
  observance: HolidayObservance;
}

export interface ResolvedHoliday {
  code: string;
  label: string;
  year: number;
  /** The day the rule names. */
  actual: Date;
  /** The day the utility treats as the holiday. */
  observed: Date;
  /** Another rule resolved to the same observed day. */
  sharesObservedDate: boolean;
}

const DAY_MS = 86_400_000;

/** ISO weekday of a UTC date. */
function isoWeekday(d: Date): IsoWeekday {
  const js = d.getUTCDay(); // 0 = Sunday
  return (js === 0 ? 7 : js) as IsoWeekday;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function observe(actual: Date, observance: HolidayObservance): Date {
  const weekday = isoWeekday(actual);
  if (observance === "NONE") return actual;
  if (observance === "FOLLOWING_MONDAY") {
    if (weekday === 6) return addDays(actual, 2);
    if (weekday === 7) return addDays(actual, 1);
    return actual;
  }
  // NEAREST_WEEKDAY
  if (weekday === 6) return addDays(actual, -1);
  if (weekday === 7) return addDays(actual, 1);
  return actual;
}

/**
 * The date a rule names in a given year, or null when it names none.
 *
 * **Null rather than a fallback.** "Fifth Monday of May" exists in some
 * years and not others, and a calendar that quietly resolved it to the
 * fourth would move a holiday — mispricing a day and saying nothing.
 * The caller shows the year as unresolvable instead.
 */
export function resolveHoliday(rule: HolidayRule, year: number): ResolvedHoliday | null {
  let actual: Date | null = null;

  if (rule.kind === "FIXED") {
    if (rule.day === undefined) return null;
    const candidate = new Date(Date.UTC(year, rule.month - 1, rule.day));
    // Guards 29 February in a common year, and any other unreal date:
    // Date rolls over silently, so the month is checked back.
    if (candidate.getUTCMonth() !== rule.month - 1) return null;
    actual = candidate;
  } else {
    if (rule.weekday === undefined || rule.nth === undefined) return null;
    actual = nthWeekdayOf(year, rule.month, rule.weekday, rule.nth);
  }

  if (!actual) return null;

  return {
    code: rule.code,
    label: rule.label,
    year,
    actual,
    observed: observe(actual, rule.observance),
    sharesObservedDate: false,
  };
}

/** The nth (or last, for -1) given weekday of a month, or null. */
function nthWeekdayOf(
  year: number,
  month: number,
  weekday: IsoWeekday,
  nth: number,
): Date | null {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (nth === -1) {
    for (let day = daysInMonth; day >= 1; day--) {
      const d = new Date(Date.UTC(year, month - 1, day));
      if (isoWeekday(d) === weekday) return d;
    }
    return null;
  }

  if (nth < 1) return null;
  let seen = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (isoWeekday(d) === weekday) {
      seen++;
      if (seen === nth) return d;
    }
  }
  // Ran off the end of the month: this year has no such weekday.
  return null;
}

/**
 * Every rule resolved across a span of years.
 *
 * What the holiday editor renders beside each rule (TOU-UI-2): a rule
 * nobody can see the output of is a rule nobody will trust, and the
 * observance rules are where the surprises live.
 *
 * `sharesObservedDate` marks rules landing on one day. Not an error — a
 * tenant may have two names for one day — but the editor has to show
 * it, because the day is a single day type and a reader counting
 * holidays would otherwise be off by one.
 */
export function resolveHolidays(
  rules: HolidayRule[],
  fromYear: number,
  toYear: number,
): ResolvedHoliday[] {
  const out: ResolvedHoliday[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    for (const rule of rules) {
      const resolved = resolveHoliday(rule, year);
      if (resolved) out.push(resolved);
    }
  }

  const byDay = new Map<string, number>();
  for (const r of out) {
    const key = r.observed.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  for (const r of out) {
    const key = r.observed.toISOString().slice(0, 10);
    r.sharesObservedDate = (byDay.get(key) ?? 0) > 1;
  }

  return out.sort((a, b) => a.observed.getTime() - b.observed.getTime());
}

/** Fast lookup for classification: the observed days in a year. */
export function observedDays(rules: HolidayRule[], year: number): Set<string> {
  return new Set(
    resolveHolidays(rules, year, year).map((r) => r.observed.toISOString().slice(0, 10)),
  );
}
