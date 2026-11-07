/**
 * The TOU calendar: which hours cost what (spec 26, TOU-CAL-1 – 3, 8, 9).
 *
 * Three tenant vocabularies meet here — season, day type and peak — and
 * answering "what does this local date-time cost?" means resolving all
 * three. Each can go wrong without raising: a season that claims no
 * days, a weekday nothing covers, a span that leaves an hour unpriced.
 * So every answer carries its reasoning, and every failure says which
 * of the three failed rather than returning a bare null.
 *
 * **Wall-clock only.** Converting a stored UTC instant to a local date
 * and minute-of-day is a separate concern (TOU-CAL-6/7), because
 * TOU-CAL-7 classifies the repeated fall-back hour twice, "both by the
 * same wall-clock rule" — so the rule must not know about offsets at
 * all. This module never sees a time zone.
 *
 * Pure, like the rest of the engine: the calendar screen's preview and
 * the rating path call the same functions, so the preview cannot
 * disagree with the bill.
 */

import { resolveSeason, type SeasonDefinition } from "./seasons.js";

/** Minutes in a day; also the exclusive end of the last span. */
const DAY_MINUTES = 1440;

/** TOU-CAL-1 fixes the granularity. */
const SLOT_MINUTES = 15;

const WEEKDAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The one day-type code the system owns.
 *
 * Every other code is the tenant's own and the vocabulary stays open —
 * Saturday priced apart from Sunday is a real tariff. Reserving exactly
 * one lets a holiday date resolve to a day type by name, which is what
 * the `isHoliday` boolean used to do with a partial unique index and a
 * validator rule behind it.
 */
export const HOLIDAY_DAY_TYPE_CODE = "holiday";

/**
 * 1 = Monday … 7 = Sunday.
 *
 * Declared here now that the holiday rules are gone: a day type's
 * weekday coverage is the only thing left that uses it, and this is
 * where day types are defined.
 */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface TouDayTypeDefinition {
  /**
   * The tenant's own code, except for `holiday` — see
   * `HOLIDAY_DAY_TYPE_CODE`. The vocabulary stays open because Saturday
   * priced apart from Sunday is a real tariff.
   */
  dayTypeCode: string;
  /** Empty for the holiday day type, which no weekday claims. */
  weekdays: IsoWeekday[];
}

/**
 * A span of a day at one price, for one (season, day type).
 *
 * Half-open: `startMinute` is included and `endMinute` is not, which is
 * what lets two adjacent spans tile without the boundary minute being
 * either double-counted or lost. Stored as spans rather than 96 cells
 * because a span is what a tariff document says ("on-peak 4–9 pm") and
 * what a published diff has to read back (TOU-UI-1d).
 */
export interface TouSlotDefinition {
  seasonCode: string;
  dayTypeCode: string;
  /** Minutes from local midnight, inclusive. A multiple of 15. */
  startMinute: number;
  /** Minutes from local midnight, exclusive. 1440 is the end of the day. */
  endMinute: number;
  peakCode: string;
}

/**
 * One named date taking a different day type (TOU-CAL-9).
 *
 * The narrowest statement a tenant can make, so it outranks both the
 * holiday set and the weekday coverage. This is the shape a critical
 * peak event day will use, with no schema change.
 */
export interface TouDayOverride {
  /** ISO date, `YYYY-MM-DD`, in the calendar's own zone. */
  date: string;
  dayTypeCode: string;
}

export interface TouCalendarDefinition {
  dayTypes: TouDayTypeDefinition[];
  slots: TouSlotDefinition[];
  overrides?: TouDayOverride[];
}

/**
 * The price tiers a calendar actually uses, in the order its hours
 * first mention them.
 *
 * Derived rather than declared: peak codes belong to the tenant, and
 * what makes one a period *of this calendar* is that some span costs
 * it. A rate schedule has to price every one of these, which
 * `validateTouPricing` checks when the schedule is published.
 */
export function peakCodesUsedBy(calendar: TouCalendarDefinition): string[] {
  return [...new Set(calendar.slots.map((s) => s.peakCode))];
}

export type CalendarValidation = { ok: true } | { ok: false; problems: string[] };

/** Why a date resolved to the day type it did (TOU-UI-1c). */
export type DayTypeReason = "OVERRIDE" | "HOLIDAY" | "WEEKDAY";

export interface DayTypeResolution {
  dayTypeCode: string;
  reason: DayTypeReason;
}

export type TouPeakLookup =
  | {
      ok: true;
      peakCode: string;
      seasonCode: string;
      dayTypeCode: string;
      dayTypeReason: DayTypeReason;
    }
  | { ok: false; problem: string };

/** ISO weekday of a UTC date. */
function isoWeekday(d: Date): IsoWeekday {
  const js = d.getUTCDay(); // 0 = Sunday
  return (js === 0 ? 7 : js) as IsoWeekday;
}

/** `17:15`, and `24:00` for the exclusive end of the day. */
function timeLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function dateLabel(d: Date): string {
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Does this calendar price every minute of every day exactly once?
 *
 * Reports **every** problem rather than stopping at the first, for the
 * reason `validateSeasons` does: a calendar is edited as a whole and
 * fixing one boundary usually moves another, so one-at-a-time turns one
 * save into four. Problems are coalesced into time ranges — 96 cells
 * reported individually would bury the one span that is wrong.
 */
export function validateCalendar(
  calendar: TouCalendarDefinition,
  seasons: SeasonDefinition[],
): CalendarValidation {
  const problems: string[] = [];

  // Span shape first. A boundary off the 15-minute grid makes the
  // coverage arithmetic meaningless, so reporting gaps on top of it
  // would bury the cause.
  for (const s of calendar.slots) {
    const where = `${s.seasonCode} / ${s.dayTypeCode}`;
    if (!Number.isInteger(s.startMinute) || !Number.isInteger(s.endMinute)) {
      problems.push(`${where}: a span's bounds must be whole minutes.`);
      continue;
    }
    if (s.startMinute % SLOT_MINUTES !== 0 || s.endMinute % SLOT_MINUTES !== 0) {
      problems.push(
        `${where}: the span ${timeLabel(s.startMinute)}–${timeLabel(s.endMinute)} does not start and end on a multiple of 15 minutes.`,
      );
      continue;
    }
    if (s.startMinute < 0 || s.endMinute > DAY_MINUTES || s.startMinute >= s.endMinute) {
      problems.push(
        `${where}: the span ${timeLabel(s.startMinute)}–${timeLabel(s.endMinute)} is not a range inside one day.`,
      );
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const defined = new Set(calendar.dayTypes.map((d) => d.dayTypeCode));
  const overrides = calendar.overrides ?? [];

  // Day types.
  const seenDayType = new Set<string>();
  for (const d of calendar.dayTypes) {
    if (seenDayType.has(d.dayTypeCode)) {
      problems.push(`Two day types are both called "${d.dayTypeCode}".`);
    }
    seenDayType.add(d.dayTypeCode);

    for (const w of d.weekdays) {
      if (!Number.isInteger(w) || w < 1 || w > 7) {
        problems.push(`Day type "${d.dayTypeCode}" covers ${w}, which is not a weekday.`);
      }
    }

    // Reachable: a day type nothing can select prices hours that are
    // really priced elsewhere, and reads as a working part of the
    // calendar.
    const selectable =
      d.weekdays.length > 0 ||
      d.dayTypeCode === HOLIDAY_DAY_TYPE_CODE ||
      overrides.some((o) => o.dayTypeCode === d.dayTypeCode);
    if (!selectable) {
      problems.push(
        `Day type "${d.dayTypeCode}" covers no weekday, is not the holiday day type and no date selects it, so nothing can ever use it.`,
      );
    }
  }

  // The seven weekdays, claimed exactly once among the day types that
  // claim weekdays at all. This is what makes day-type resolution
  // total: an unclaimed weekday leaves every such date unpriced, and a
  // doubly-claimed one makes the answer depend on row order.
  const claimants: string[][] = Array.from({ length: 7 }, () => []);
  for (const d of calendar.dayTypes) {
    for (const w of d.weekdays) {
      if (w >= 1 && w <= 7) claimants[w - 1].push(d.dayTypeCode);
    }
  }
  for (let i = 0; i < 7; i++) {
    const who = claimants[i];
    if (who.length === 0) {
      problems.push(`${WEEKDAY_NAMES[i]} is covered by no day type.`);
    } else if (who.length > 1) {
      problems.push(`${WEEKDAY_NAMES[i]} is covered by more than one day type: ${who.join(", ")}.`);
    }
  }

  for (const o of overrides) {
    if (!defined.has(o.dayTypeCode)) {
      problems.push(`${o.date} is overridden to day type "${o.dayTypeCode}", which this calendar does not define.`);
    }
  }

  /*
   * TOU-CAL-3's two peak rules are gone, and neither is missed.
   *
   * They were "every period referenced is defined" and "every period
   * defined is used somewhere", and both existed only because a
   * calendar declared its periods as well as using them. Peak codes are
   * the tenant's now (2026-11-04), and a calendar's periods *are* the
   * distinct codes its hours use — so neither rule has two things left
   * to disagree.
   *
   * What each was protecting is still protected, better placed:
   *
   * - A span naming a code the tenant has not defined is refused by
   *   `tou_slot_peak_code_fkey` at the write, not reported at a save.
   * - A code nothing uses is no longer a fault. A four-code tenant with
   *   a two-period tariff is ordinary, and demanding every calendar use
   *   every code would have made it an error.
   * - A code the *tariff* does not price is still caught, by
   *   `validateTouPricing` when a rate schedule is published — which is
   *   where it matters, since that is the one that leaves energy
   *   uncharged.
   */

  // Coverage, over the full cross product. A pair with no spans at all
  // is the common half-finished edit — a season added and never priced
  // — and reports as one missing pair rather than 96 gaps.
  const cells = DAY_MINUTES / SLOT_MINUTES;
  for (const season of seasons) {
    for (const dayType of calendar.dayTypes) {
      const where = `${season.seasonCode} / ${dayType.dayTypeCode}`;
      const spans = calendar.slots.filter(
        (s) => s.seasonCode === season.seasonCode && s.dayTypeCode === dayType.dayTypeCode,
      );
      if (spans.length === 0) {
        problems.push(`${where} is not priced at all.`);
        continue;
      }

      const claimedBy: string[][] = Array.from({ length: cells }, () => []);
      for (const s of spans) {
        for (let c = s.startMinute / SLOT_MINUTES; c < s.endMinute / SLOT_MINUTES; c++) {
          claimedBy[c].push(s.peakCode);
        }
      }
      problems.push(...coverageProblems(where, claimedBy));
    }
  }

  // A span naming a season or day type the calendar does not have is
  // not caught above, since the loops walk what exists.
  const seasonCodes = new Set(seasons.map((s) => s.seasonCode));
  for (const s of calendar.slots) {
    if (!seasonCodes.has(s.seasonCode)) {
      problems.push(`A span names season "${s.seasonCode}", which this calendar's season set does not define.`);
    }
    if (!defined.has(s.dayTypeCode)) {
      problems.push(`A span names day type "${s.dayTypeCode}", which this calendar does not define.`);
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Gaps and overlaps as time ranges, one message per run of like cells.
 *
 * The run is what a person fixes: "21:00–24:00 has no period" points at
 * one span to extend, where 12 separate messages point at nothing.
 */
function coverageProblems(where: string, claimedBy: string[][]): string[] {
  const out: string[] = [];
  const signature = (claims: string[]) =>
    claims.length === 1 ? "" : claims.length === 0 ? "GAP" : [...claims].sort().join("+");

  let runStart = 0;
  let runSig = signature(claimedBy[0]);

  const flush = (endCell: number) => {
    if (runSig === "") return;
    const from = timeLabel(runStart * SLOT_MINUTES);
    const to = timeLabel(endCell * SLOT_MINUTES);
    if (runSig === "GAP") {
      out.push(`${where}: ${from}–${to} is not priced.`);
    } else {
      out.push(`${where}: ${from}–${to} is priced more than once, as ${runSig.split("+").join(" and ")}.`);
    }
  };

  for (let c = 1; c < claimedBy.length; c++) {
    const sig = signature(claimedBy[c]);
    if (sig !== runSig) {
      flush(c);
      runStart = c;
      runSig = sig;
    }
  }
  flush(claimedBy.length);

  return out;
}

/**
 * What kind of day this is, and why.
 *
 * Precedence is narrowest-first: a dated override names one day, the
 * holiday set names a set of days, and the weekday coverage names a
 * seventh of the year. Each outranks the next, so the more specific
 * statement a tenant made is the one that applies.
 *
 * `date` is a local calendar day read as UTC midnight, like every date
 * in the engine: local getters turn 1 January into 31 December west of
 * Greenwich, which is a different weekday and, in a wrapping season, a
 * different season.
 *
 * Null when nothing claims the date — only reachable through an
 * unvalidated calendar, and guessing would price a whole day against a
 * day type nobody chose.
 */
export function resolveDayType(
  date: Date,
  calendar: TouCalendarDefinition,
  observedHolidays: Set<string>,
  /**
   * Defaults to the calendar's own. Passed separately because overrides
   * are effective-dated and may be scoped to a service area
   * (TOU-CAL-13), so the caller may hold a filtered set.
   */
  overrides: TouDayOverride[] = calendar.overrides ?? [],
): DayTypeResolution | null {
  const iso = isoDate(date);

  const override = overrides.find((o) => o.date === iso);
  if (override && calendar.dayTypes.some((d) => d.dayTypeCode === override.dayTypeCode)) {
    return { dayTypeCode: override.dayTypeCode, reason: "OVERRIDE" };
  }

  if (observedHolidays.has(iso)) {
    const holiday = calendar.dayTypes.find((d) => d.dayTypeCode === HOLIDAY_DAY_TYPE_CODE);
    // A calendar with no holiday day type names no holiday set either,
    // so this cannot normally be reached — but a set can be detached
    // after the fact, and then the date is still a holiday to whoever
    // supplied the set while the weekday coverage answers.
    if (holiday) return { dayTypeCode: holiday.dayTypeCode, reason: "HOLIDAY" };
  }

  const weekday = isoWeekday(date);
  const byWeekday = calendar.dayTypes.find((d) => d.weekdays.includes(weekday));
  if (byWeekday) return { dayTypeCode: byWeekday.dayTypeCode, reason: "WEEKDAY" };

  return null;
}

/**
 * What period a local date-time falls in (TOU-CAL-8).
 *
 * The answer carries its reasoning, and a failure names which of the
 * three resolutions failed — season, day type or span. That is what
 * makes it checkable before publishing: TOU-UI-1c puts this in a field
 * above the calendar grid, and "no period" with no cause sends whoever
 * is checking a tariff to read the whole thing.
 */
export function resolvePeak(args: {
  /** The local calendar day, as UTC midnight. */
  date: Date;
  /** Minutes from local midnight, 0–1439. */
  minuteOfDay: number;
  calendar: TouCalendarDefinition;
  seasons: SeasonDefinition[];
  /** Observed holiday dates, from `observedDays()`. */
  observedHolidays: Set<string>;
  overrides?: TouDayOverride[];
}): TouPeakLookup {
  const { date, minuteOfDay, calendar, seasons, observedHolidays, overrides } = args;

  // Input shape first. 1440 is midnight tomorrow: reaching here means
  // the caller's conversion to local time is wrong, and classifying it
  // against the last span of today would hide that.
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= DAY_MINUTES) {
    return { ok: false, problem: `${minuteOfDay} is not a minute of a day.` };
  }

  const seasonCode = resolveSeason(date, seasons);
  if (seasonCode === null) {
    return { ok: false, problem: `No season claims ${dateLabel(date)}.` };
  }

  const dayType = resolveDayType(date, calendar, observedHolidays, overrides);
  if (dayType === null) {
    return {
      ok: false,
      problem: `No day type claims ${dateLabel(date)}, a ${WEEKDAY_NAMES[isoWeekday(date) - 1]}.`,
    };
  }

  const slot = calendar.slots.find(
    (s) =>
      s.seasonCode === seasonCode &&
      s.dayTypeCode === dayType.dayTypeCode &&
      minuteOfDay >= s.startMinute &&
      minuteOfDay < s.endMinute,
  );
  if (!slot) {
    return {
      ok: false,
      problem: `No period covers ${timeLabel(minuteOfDay)} on a ${seasonCode} ${dayType.dayTypeCode}.`,
    };
  }

  return {
    ok: true,
    peakCode: slot.peakCode,
    seasonCode,
    dayTypeCode: dayType.dayTypeCode,
    dayTypeReason: dayType.reason,
  };
}

/**
 * Do a schedule's TOU components and its calendar line up (TOU-UI-3)?
 *
 * Both directions are errors, and they fail differently:
 *
 * - a component pricing a period the calendar has not got **never
 *   bills** — no meter reports that period, so the quantity source
 *   finds no bucket and rating raises. Usually a typo.
 * - a calendar period **no component prices** is energy the customer
 *   uses and is never charged for. Nothing raises at all: the bucket is
 *   simply never asked about, and the bill looks complete.
 *
 * The second is the expensive one, and it is why this refuses rather
 * than warns. TOU-UI-3 allows "or says which are deliberately
 * unpriced"; no mechanism is built for that declaration, because the
 * escape hatch already exists and documents itself — a component priced
 * at zero, labelled for what it is. The engine suppresses zero-amount
 * lines, so it never reaches the bill, but it states the intent where a
 * reader of the tariff will find it.
 */
export function validateTouPricing(
  /** The peak codes this schedule's components price; duplicates are fine. */
  pricedCodes: readonly string[],
  /** The periods the referenced calendar defines. */
  calendarPeriods: readonly string[],
): CalendarValidation {
  const problems: string[] = [];
  const defined = new Set(calendarPeriods);
  const priced = new Set(pricedCodes);

  for (const code of [...priced].sort()) {
    if (!defined.has(code)) {
      problems.push(
        `A component prices period "${code}", which this schedule's TOU calendar does not define.`,
      );
    }
  }

  const unpriced = [...defined].filter((c) => !priced.has(c)).sort();
  if (unpriced.length > 0) {
    problems.push(
      `The calendar defines ${unpriced.length === 1 ? "a period" : "periods"} no component prices: ${unpriced.join(", ")}. ` +
        "Usage in an unpriced period is never charged, and nothing raises — " +
        "add a component for it, or one priced at zero if it is genuinely not charged separately.",
    );
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
