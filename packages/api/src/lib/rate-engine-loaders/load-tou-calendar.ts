/**
 * Database rows → the pure TOU calendar the engine classifies with
 * (spec 26, TOU-CAL-5 and TOU-CAL-8).
 *
 * The only place the calendar's tables are read for rating. Everything
 * downstream — the engine's TOU filter, the calendar screen's preview,
 * the bill's period footnote — takes the plain types this returns, so
 * none of them can disagree about which version was in force or what it
 * said.
 *
 * **Which version.** The newest *published* one whose effective date is
 * on or before the period's start. Chosen by the period's own dates and
 * never by today's, which is what makes a re-rate of an old period
 * reproducible: a calendar published since then has a later effective
 * date and is not reached.
 *
 * **Which seasons.** The set the calendar *names*, not the set in force.
 * A published calendar is immutable and its spans are keyed on its set's
 * codes; if a tenant published new seasons, reading those instead would
 * leave every span referencing a code that no longer exists and the
 * hours they price resolving to nothing.
 *
 * **It does not re-validate.** `validateCalendar` runs at save and
 * publishing freezes the result, so re-checking 96 cells per (season,
 * day type) on every bill would buy nothing. The safety net is already
 * there and better placed: a calendar with a gap makes `resolvePeak`
 * answer "no period covers 17:15" at the first interval it cannot
 * classify, which stops the bill and names the hole.
 */

import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import type { SeasonDefinition } from "../rate-engine/seasons.js";
import type { IsoWeekday } from "../rate-engine/tou-calendar.js";
import type { TouCalendarDefinition } from "../rate-engine/tou-calendar.js";
import type { ClockBasis } from "../rate-engine/tou-clock.js";

export interface LoadedTouCalendar {
  id: string;
  name: string;
  effectiveDate: Date;
  /** IANA name, e.g. `America/Los_Angeles`. */
  timeZone: string;
  clockBasis: ClockBasis;
  /** The set this calendar names, in its own declared order. */
  seasons: SeasonDefinition[];
  definition: TouCalendarDefinition;
  /**
   * Observed holiday dates (`YYYY-MM-DD`) for every year the period
   * touches. Empty when the calendar names no holiday set.
   */
  observedHolidays: Set<string>;
}

export type TouCalendarLoad =
  | { ok: true; calendar: LoadedTouCalendar }
  | { ok: false; problem: string };

/**
 * One include for both loads.
 *
 * The rating path resolves a version from a name; the interval roll-up
 * asks for one by id. Two copies of this would be two chances for a
 * calendar to be read differently by the thing that classifies usage
 * and the thing that prices it.
 */
const CALENDAR_INCLUDE = {
  seasonSet: { include: { seasons: { orderBy: { sortOrder: "asc" } } } },
  dayTypes: {
    orderBy: { sortOrder: "asc" },
    include: { weekdays: { orderBy: { isoWeekday: "asc" } } },
  },
  /*
   * The slot carries its own peak code, so rating needs no join to the
   * tenant's period list at all — and a published calendar keeps
   * meaning what it meant even if that list is edited.
   */
  slots: {
    orderBy: { startMinute: "asc" },
    include: { dayType: { select: { dayTypeCode: true } } },
  },
  overrides: { include: { dayType: { select: { dayTypeCode: true } } } },
} as const;

/** What `CALENDAR_INCLUDE` produces, for the shared mapper below. */
type TouCalendarRow = TouCalendarDefinitionRows & {
  id: string;
  name: string;
  effectiveDate: Date;
  timeZone: string;
  clockBasis: string;
  touHolidaySetId: string | null;
  seasonSet: {
    seasons: Array<{
      seasonCode: string;
      startMonth: number;
      startDay: number;
      endMonth: number;
      endDay: number;
    }>;
  };
};

/**
 * The fields `toTouCalendarDefinition` reads.
 *
 * Declared structurally rather than taken from Prisma's generated
 * types, because this is the seam between the database and the pure
 * engine: any query whose include supplies these may use the mapper.
 * Two do — the rating load below, and the calendar editor's own query,
 * which additionally selects the ids, labels and sort orders the engine
 * has no use for.
 *
 * That shared mapper is the point. The editor's validation, spot check
 * and day preview have to answer exactly what rating would answer, and
 * two copies of twenty lines of mapping is how a screen ends up
 * confirming a calendar the engine reads differently.
 */
export interface TouCalendarDefinitionRows {
  dayTypes: Array<{
    dayTypeCode: string;
    weekdays: Array<{ isoWeekday: number }>;
  }>;
  /*
   * No `periods`. Peak codes belong to the tenant since 2026-11-04, and
   * a calendar's own periods are the distinct codes its slots carry —
   * so the slot is the only row the engine needs to be told about.
   */
  slots: Array<{
    seasonCode: string;
    startMinute: number;
    endMinute: number;
    dayType: { dayTypeCode: string };
    peakCode: string;
  }>;
  overrides: Array<{ overrideDate: Date; dayType: { dayTypeCode: string } }>;
}

/** Rows → the pure definition the engine classifies with. */
export function toTouCalendarDefinition(row: TouCalendarDefinitionRows): TouCalendarDefinition {
  return {
    dayTypes: row.dayTypes.map((d) => ({
      dayTypeCode: d.dayTypeCode,
      weekdays: d.weekdays.map((w) => w.isoWeekday as IsoWeekday),
    })),
    slots: row.slots.map((s) => ({
      seasonCode: s.seasonCode,
      dayTypeCode: s.dayType.dayTypeCode,
      startMinute: s.startMinute,
      endMinute: s.endMinute,
      peakCode: s.peakCode,
    })),
    overrides: row.overrides.map((o) => ({
      // `@db.Date` comes back as UTC midnight, so the ISO date is the
      // date — no local getters, which would shift it a day west of
      // Greenwich.
      date: o.overrideDate.toISOString().slice(0, 10),
      dayTypeCode: o.dayType.dayTypeCode,
    })),
  };
}

/**
 * Load the calendar in force for a period.
 *
 * A discriminated result rather than null or a throw, matching the rest
 * of this subsystem: the two ways this fails are two different
 * operator mistakes — "you never published it" and "the component names
 * a calendar you have not got" — and one message for both sends
 * somebody to the wrong screen.
 *
 * `utilityId` is passed as well as relied on through RLS, the way
 * `loadBase` does: the policy is the guarantee, the predicate is what
 * makes the query say what it means.
 */
export async function loadTouCalendar(
  prisma: PrismaClient,
  args: {
    utilityId: string;
    name: string;
    period: { startDate: Date; endDate: Date };
  },
): Promise<TouCalendarLoad> {
  const { utilityId, name, period } = args;

  const row = await prisma.touCalendar.findFirst({
    where: {
      utilityId,
      name,
      publishedAt: { not: null },
      effectiveDate: { lte: period.startDate },
    },
    orderBy: { effectiveDate: "desc" },
    include: CALENDAR_INCLUDE,
  });

  if (!row) {
    // Distinguish the two mistakes. A second query, and only on the
    // failure path, so the common case still costs one round trip.
    const anyVersion = await prisma.touCalendar.findFirst({
      where: { utilityId, name },
      select: { id: true },
    });
    return anyVersion
      ? {
          ok: false,
          problem: `TOU calendar "${name}" has no published version in force on ${period.startDate
            .toISOString()
            .slice(0, 10)}.`,
        }
      : { ok: false, problem: `There is no TOU calendar named "${name}".` };
  }

  return { ok: true, calendar: await toLoadedCalendar(prisma, utilityId, row, period) };
}

/**
 * The same calendar, named by id instead of by name and date.
 *
 * Rating resolves a version from a name and the period, because that is
 * what a tariff asks for. The interval roll-up does not: it classifies
 * usage for a schedule that already names one exact version, and
 * TOU-CAL-5 is the reason — a published schedule cannot follow a
 * calendar republished with different hours, so re-rating that period
 * must reach the same version it reached the first time.
 *
 * Published-only, and deliberately without an effective-date filter: a
 * schedule may be published against a calendar that takes effect later
 * in its life, and the schedule's own version is what decides when
 * those hours apply.
 */
export async function loadTouCalendarById(
  prisma: PrismaClient,
  args: { utilityId: string; id: string; period: { startDate: Date; endDate: Date } },
): Promise<TouCalendarLoad> {
  const { utilityId, id, period } = args;

  const row = await prisma.touCalendar.findFirst({
    where: { utilityId, id, publishedAt: { not: null } },
    include: CALENDAR_INCLUDE,
  });

  if (!row) {
    const draft = await prisma.touCalendar.findFirst({
      where: { utilityId, id },
      select: { name: true },
    });
    return draft
      ? {
          ok: false,
          problem: `TOU calendar "${draft.name}" is still a draft, so its hours can change. Usage cannot be classified against it.`,
        }
      : { ok: false, problem: "That TOU calendar does not exist." };
  }

  return { ok: true, calendar: await toLoadedCalendar(prisma, utilityId, row, period) };
}

/** Shared by both loads, so the two cannot read a calendar differently. */
async function toLoadedCalendar(
  prisma: PrismaClient,
  utilityId: string,
  row: TouCalendarRow,
  period: { startDate: Date; endDate: Date },
): Promise<LoadedTouCalendar> {
  return {
    id: row.id,
    name: row.name,
    effectiveDate: row.effectiveDate,
    timeZone: row.timeZone,
    clockBasis: row.clockBasis as ClockBasis,
    seasons: row.seasonSet.seasons.map((s) => ({
      seasonCode: s.seasonCode,
      startMonth: s.startMonth,
      startDay: s.startDay,
      endMonth: s.endMonth,
      endDay: s.endDay,
    })),
    definition: toTouCalendarDefinition(row),
    observedHolidays: await loadObservedHolidays(prisma, utilityId, row.touHolidaySetId, period),
  };
}

/**
 * The holiday dates a period touches.
 *
 * A read now, not a resolution. They were computed from rules — "4
 * July, nearest weekday" — which meant the dates a bill priced against
 * existed nowhere until something worked them out, and nobody could
 * check them without a preview built for the purpose. They are rows.
 *
 * Filtered to the period rather than loaded whole: a set covers a
 * horizon of years and a bill covers a month.
 *
 * The set is read by id rather than through a relation because the key
 * from a calendar to its set is nullable and composite, which Prisma
 * cannot express; the foreign key itself is in the migration.
 */
export async function loadObservedHolidays(
  prisma: PrismaClient,
  utilityId: string,
  touHolidaySetId: string | null,
  period: { startDate: Date; endDate: Date },
): Promise<Set<string>> {
  if (!touHolidaySetId) return new Set();

  const rows = await prisma.touHoliday.findMany({
    where: {
      utilityId,
      touHolidaySetId,
      holidayDate: { gte: period.startDate, lte: period.endDate },
    },
    select: { holidayDate: true },
  });

  // `@db.Date` comes back as UTC midnight, so the ISO date is the date
  // — no local getters, which would shift it a day west of Greenwich.
  return new Set(rows.map((r) => r.holidayDate.toISOString().slice(0, 10)));
}
