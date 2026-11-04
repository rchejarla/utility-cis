import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateTouCalendarInput,
  PutTouDayOverridesInput,
  PutTouDayTypesInput,
  PutTouPeriodsInput,
  PutTouSpansInput,
  TouCalendarQuery,
  UpdateTouCalendarInput,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import {
  HOLIDAY_DAY_TYPE_CODE,
  resolveDayType,
  resolvePeak,
  validateCalendar,
  type CalendarValidation,
} from "../lib/rate-engine/tou-calendar.js";
import {
  loadObservedHolidays,
  toTouCalendarDefinition,
} from "../lib/rate-engine-loaders/load-tou-calendar.js";

/**
 * The calendar editor's server side (spec 26, TOU-UI-1 and TOU-UI-2).
 *
 * Four rules shape every function here:
 *
 * 1. **A draft is editable; a published version is not.** Changing
 *    which hours are on-peak changes what a bill costs, so a change is
 *    a new version with its own effective date. There is no `version`
 *    column: a version *is* a (name, effectiveDate) pair.
 *
 * 2. **The child collections are replaced whole.** Every invariant they
 *    carry belongs to the whole list — the spans of a (season, day
 *    type) must tile the day exactly once, the seven weekdays must be
 *    claimed exactly once — so row-at-a-time saving would make every
 *    intermediate state invalid.
 *
 * 3. **What the editor says, rating must say.** Validation, the spot
 *    check and the day preview run the engine's own functions over the
 *    definition the *rating* loader's mapper produces.
 *
 * 4. **`holiday` is the system's day-type code.** The engine finds that
 *    day type by matching it — the one literal string comparison in the
 *    subsystem — so this service owns creating it and refuses a tenant
 *    taking, renaming or removing it. It replaced an `is_holiday`
 *    boolean that needed a partial unique index and a validator rule
 *    behind it, and that asked an operator to nominate "the holiday
 *    one" while giving them no way to say what their holidays were.
 */

/*
 * One include, used by every read here. The engine needs codes; the
 * editor needs ids, labels and sort orders too, so this is a superset
 * of what `toTouCalendarDefinition` reads and satisfies its structural
 * type.
 */
const EDITOR_INCLUDE = {
  seasonSet: {
    select: {
      id: true,
      name: true,
      publishedAt: true,
      seasons: {
        orderBy: { sortOrder: "asc" },
        select: {
          seasonCode: true,
          label: true,
          startMonth: true,
          startDay: true,
          endMonth: true,
          endDay: true,
        },
      },
    },
  },
  periods: { orderBy: { sortOrder: "asc" } },
  dayTypes: {
    orderBy: { sortOrder: "asc" },
    include: { weekdays: { orderBy: { isoWeekday: "asc" } } },
  },
  slots: {
    orderBy: { startMinute: "asc" },
    include: {
      dayType: { select: { id: true, dayTypeCode: true } },
      period: { select: { id: true, peakCode: true } },
    },
  },
  overrides: {
    orderBy: { overrideDate: "asc" },
    include: { dayType: { select: { dayTypeCode: true } } },
  },
} as const;

type EditorCalendar = Awaited<ReturnType<typeof loadEditorCalendar>>;

const conflict = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 409, code });

const badRequest = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 400, code });

const notFound = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 404, code });

async function loadEditorCalendar(utilityId: string, id: string) {
  const row = await prisma.touCalendar.findFirst({
    where: { id, utilityId },
    include: EDITOR_INCLUDE,
  });
  if (!row) throw notFound("There is no TOU calendar with that id.", "TOU_CALENDAR_NOT_FOUND");
  return row;
}

/** A published calendar is immutable, and that is the whole point of it. */
function assertDraft(row: { name: string; publishedAt: Date | null }): void {
  if (row.publishedAt) {
    throw conflict(
      `"${row.name}" is published, so its hours cannot change. Create a new version with a later effective date instead — a published calendar is what priced bills that have already gone out.`,
      "TOU_CALENDAR_PUBLISHED",
    );
  }
}

/**
 * Refuse a zone `Intl` does not know.
 *
 * Without this a typo falls back to the runtime's own zone rather than
 * raising, so every peak shifts by hours and nothing says so.
 */
function assertKnownTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw badRequest(
      `"${timeZone}" is not a time zone this system knows. Use an IANA name such as America/Denver.`,
      "UNKNOWN_TIME_ZONE",
    );
  }
}

/** UTC midnight, because the engine reads a date with UTC getters. */
function utcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/** `17:15`, and `24:00` for the exclusive end of the day. */
function timeLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/**
 * When a calendar stops applying, and what replaced it.
 *
 * **Derived, never stored.** `load-tou-calendar.ts` picks the newest
 * published version whose effective date is on or before the period's
 * start, so a version's last day *is* the day before the next published
 * version of the same name. A `superseded_by_id` column would be a
 * second answer to a question the loader settles by date.
 */
async function supersessionOf(
  utilityId: string,
  calendar: { id: string; name: string; effectiveDate: Date },
): Promise<{ supersededBy: { id: string; effectiveDate: Date } | null; inForceUntil: Date | null }> {
  const next = await prisma.touCalendar.findFirst({
    where: {
      utilityId,
      name: calendar.name,
      publishedAt: { not: null },
      effectiveDate: { gt: calendar.effectiveDate },
    },
    orderBy: { effectiveDate: "asc" },
    select: { id: true, effectiveDate: true },
  });
  if (!next) return { supersededBy: null, inForceUntil: null };
  return {
    supersededBy: next,
    inForceUntil: new Date(next.effectiveDate.getTime() - 86_400_000),
  };
}

/**
 * Has the holiday set run out?
 *
 * This is the cost of explicit dates instead of rules, and it is paid
 * here rather than by a tenant: a set covers a horizon and ends. A
 * calendar in force past the last date in its set prices every holiday
 * after that as an ordinary weekday — peak hours on a day the tariff
 * calls off-peak, with nothing raised. That is the quiet failure this
 * subsystem refuses everywhere else.
 *
 * Measured from the calendar's own effective date, since dates before
 * it belong to whichever version was in force then.
 */
async function holidayHorizonProblems(
  utilityId: string,
  row: { effectiveDate: Date; touHolidaySetId: string | null },
): Promise<string[]> {
  if (!row.touHolidaySetId) return [];

  const [last, ahead] = await Promise.all([
    prisma.touHoliday.findFirst({
      where: { utilityId, touHolidaySetId: row.touHolidaySetId },
      orderBy: { holidayDate: "desc" },
      select: { holidayDate: true },
    }),
    prisma.touHoliday.count({
      where: {
        utilityId,
        touHolidaySetId: row.touHolidaySetId,
        holidayDate: { gte: row.effectiveDate },
      },
    }),
  ]);

  if (!last) {
    return ["The holiday set this calendar names has no dates in it, so no day would be a holiday."];
  }
  if (ahead === 0) {
    return [
      `The holiday set's last date is ${last.holidayDate.toISOString().slice(0, 10)}, before this calendar takes effect, so no day it prices would be a holiday.`,
    ];
  }
  return [];
}

export async function listTouCalendars(utilityId: string, query: TouCalendarQuery) {
  const where: Record<string, unknown> = { utilityId };
  if (query.name) where.name = query.name;
  if (query.status === "draft") where.publishedAt = null;
  if (query.status === "published") where.publishedAt = { not: null };

  const page = await paginatedTenantList(prisma.touCalendar, where, query, {
    include: {
      seasonSet: { select: { id: true, name: true } },
      /*
       * The counts are what make a half-built calendar visible on the
       * row. A calendar with periods and no spans looks finished until
       * it is opened, and it is the one that cannot be published.
       */
      _count: { select: { periods: true, dayTypes: true, slots: true } },
    },
  });

  /*
   * Which rows have been replaced, in one query for the whole page
   * rather than one each. Without it a retired version shows as
   * "Published" with an open-ended start date.
   */
  const rows = page.data as Array<{
    id: string;
    name: string;
    effectiveDate: Date;
    publishedAt: Date | null;
    inForceUntil?: Date | null;
    supersededById?: string | null;
  }>;
  const names = [...new Set(rows.map((r) => r.name))];
  const published =
    names.length === 0
      ? []
      : await prisma.touCalendar.findMany({
          where: { utilityId, name: { in: names }, publishedAt: { not: null } },
          select: { id: true, name: true, effectiveDate: true },
          orderBy: { effectiveDate: "asc" },
        });

  for (const row of rows) {
    const next = published.find(
      (p) => p.name === row.name && p.effectiveDate.getTime() > row.effectiveDate.getTime(),
    );
    row.supersededById = next?.id ?? null;
    row.inForceUntil = next ? new Date(next.effectiveDate.getTime() - 86_400_000) : null;
  }

  return page;
}

export async function getTouCalendar(id: string, utilityId: string) {
  const row = await loadEditorCalendar(utilityId, id);
  const [supersession, horizon, holidaySet] = await Promise.all([
    supersessionOf(utilityId, row),
    holidayHorizonProblems(utilityId, row),
    row.touHolidaySetId
      ? prisma.touHolidaySet.findFirst({
          where: { id: row.touHolidaySetId, utilityId },
          select: {
            id: true,
            name: true,
            publishedAt: true,
            _count: { select: { holidays: true } },
          },
        })
      : Promise.resolve(null),
  ]);
  return { ...toEditorPayload(row, horizon), ...supersession, holidaySet };
}

/**
 * What the editor screen renders from.
 *
 * The spans are grouped by (season, day type) because that is the unit
 * the screen edits and the unit the validator reports against. A group
 * with no spans is rendered; a missing key is not, and an empty
 * (season, day type) is the most common mistake.
 */
function toEditorPayload(row: EditorCalendar, extraProblems: string[]) {
  const seasonCodes = row.seasonSet.seasons.map((s) => s.seasonCode);

  const groups = seasonCodes.flatMap((seasonCode) =>
    row.dayTypes.map((dayType) => ({
      seasonCode,
      dayTypeCode: dayType.dayTypeCode,
      spans: row.slots
        .filter((s) => s.seasonCode === seasonCode && s.dayType.dayTypeCode === dayType.dayTypeCode)
        .map((s) => ({
          id: s.id,
          startMinute: s.startMinute,
          endMinute: s.endMinute,
          peakCode: s.period.peakCode,
        })),
    })),
  );

  const engineValidation = validateCalendar(toTouCalendarDefinition(row), row.seasonSet.seasons);
  const problems = [
    ...(engineValidation.ok ? [] : engineValidation.problems),
    ...extraProblems,
  ];

  return {
    id: row.id,
    name: row.name,
    effectiveDate: row.effectiveDate,
    publishedAt: row.publishedAt,
    timeZone: row.timeZone,
    clockBasis: row.clockBasis,
    seasonSet: {
      id: row.seasonSet.id,
      name: row.seasonSet.name,
      publishedAt: row.seasonSet.publishedAt,
      seasons: row.seasonSet.seasons,
    },
    touHolidaySetId: row.touHolidaySetId,
    periods: row.periods.map((p) => ({
      id: p.id,
      peakCode: p.peakCode,
      label: p.label,
      sortOrder: p.sortOrder,
    })),
    dayTypes: row.dayTypes.map((d) => ({
      id: d.id,
      dayTypeCode: d.dayTypeCode,
      label: d.label,
      /** Not a stored flag any more — the reserved code is the fact. */
      isHolidayDayType: d.dayTypeCode === HOLIDAY_DAY_TYPE_CODE,
      sortOrder: d.sortOrder,
      weekdays: d.weekdays.map((w) => w.isoWeekday),
    })),
    spanGroups: groups,
    overrides: row.overrides.map((o) => ({
      id: o.id,
      date: o.overrideDate.toISOString().slice(0, 10),
      dayTypeCode: o.dayType.dayTypeCode,
      reason: o.reason,
    })),
    validation: (problems.length === 0
      ? { ok: true }
      : { ok: false, problems }) as CalendarValidation,
  };
}

/**
 * What a new calendar starts with.
 *
 * Starting from nothing made the first screen a blank form over a
 * vocabulary nobody has met. These are real rows — renameable,
 * re-codeable and deletable like any other — not placeholder text,
 * which is what made the empty rows look filled in.
 */
const DEFAULT_PERIODS = [
  { peakCode: "off_peak", label: "Off-peak" },
  { peakCode: "mid_peak", label: "Mid-peak" },
  { peakCode: "peak", label: "On-peak" },
];

const DEFAULT_DAY_TYPES = [
  { dayTypeCode: "weekday", label: "Weekday", weekdays: [1, 2, 3, 4, 5] },
  { dayTypeCode: "weekend", label: "Weekend", weekdays: [6, 7] },
];

/**
 * ...and the holiday one, when the calendar names a set.
 *
 * Created rather than asked for, because the alternative is the setup
 * step that made the old flag absurd: nominate a day type as "the
 * holiday one" before anything can tell you what the holidays are. A
 * calendar naming a set gets the day type; the operator gives it hours
 * like any other.
 */
const HOLIDAY_DAY_TYPE = {
  dayTypeCode: HOLIDAY_DAY_TYPE_CODE,
  label: "Holiday",
  weekdays: [] as number[],
};

export async function createTouCalendar(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateTouCalendarInput,
) {
  assertKnownTimeZone(data.timeZone);

  const seasonSet = await prisma.seasonSet.findFirst({
    where: { id: data.seasonSetId, utilityId },
    select: { id: true },
  });
  if (!seasonSet) {
    throw badRequest("That season set does not exist.", "SEASON_SET_MISSING");
  }

  if (data.touHolidaySetId) {
    const set = await prisma.touHolidaySet.findFirst({
      where: { id: data.touHolidaySetId, utilityId },
      select: { id: true },
    });
    if (!set) throw badRequest("That holiday set does not exist.", "HOLIDAY_SET_MISSING");
  }

  const dayTypes = data.touHolidaySetId
    ? [...DEFAULT_DAY_TYPES, HOLIDAY_DAY_TYPE]
    : DEFAULT_DAY_TYPES;

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "TouCalendar" },
    EVENT_TYPES.TOU_CALENDAR_CREATED,
    async (tx) => {
      const created = await tx.touCalendar.create({
        data: {
          utilityId,
          name: data.name,
          effectiveDate: utcDate(data.effectiveDate),
          seasonSetId: data.seasonSetId,
          touHolidaySetId: data.touHolidaySetId ?? null,
          timeZone: data.timeZone,
          clockBasis: data.clockBasis,
        },
      });

      await tx.touPeriod.createMany({
        data: DEFAULT_PERIODS.map((period, index) => ({
          utilityId,
          touCalendarId: created.id,
          peakCode: period.peakCode,
          label: period.label,
          sortOrder: index,
        })),
      });

      for (const [index, dayType] of dayTypes.entries()) {
        const dayTypeRow = await tx.touDayType.create({
          data: {
            utilityId,
            touCalendarId: created.id,
            dayTypeCode: dayType.dayTypeCode,
            label: dayType.label,
            sortOrder: index,
          },
        });
        if (dayType.weekdays.length > 0) {
          await tx.touDayTypeWeekday.createMany({
            data: dayType.weekdays.map((isoWeekday) => ({
              utilityId,
              touCalendarId: created.id,
              touDayTypeId: dayTypeRow.id,
              isoWeekday,
            })),
          });
        }
      }

      return created;
    },
  );
}

export async function updateTouCalendar(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateTouCalendarInput,
) {
  const existing = await prisma.touCalendar.findFirst({
    where: { id, utilityId },
    select: {
      id: true,
      name: true,
      publishedAt: true,
      effectiveDate: true,
      seasonSetId: true,
      touHolidaySetId: true,
      timeZone: true,
      clockBasis: true,
    },
  });
  if (!existing) {
    throw notFound("There is no TOU calendar with that id.", "TOU_CALENDAR_NOT_FOUND");
  }
  assertDraft(existing);
  if (data.timeZone) assertKnownTimeZone(data.timeZone);

  /*
   * Changing the season set while hours reference its codes.
   *
   * `tou_slot.season_code` is a string with no foreign key — it cannot
   * have one, because a season belongs to a set and a slot belongs to a
   * calendar — so moving the calendar to a set that lacks a code leaves
   * those hours pointing at nothing, and `resolvePeak` would answer "no
   * period covers 17:15" on every bill. Refused rather than cascaded:
   * deleting somebody's hours to make a dropdown change succeed is not
   * a trade a screen may make silently.
   */
  if (data.seasonSetId && data.seasonSetId !== existing.seasonSetId) {
    const target = await prisma.seasonSet.findFirst({
      where: { id: data.seasonSetId, utilityId },
      include: { seasons: { select: { seasonCode: true } } },
    });
    if (!target) {
      throw badRequest("That season set does not exist.", "SEASON_SET_MISSING");
    }

    const codes = new Set(target.seasons.map((season) => season.seasonCode));
    const orphaned = await prisma.touSlot.findMany({
      where: { utilityId, touCalendarId: id, seasonCode: { notIn: [...codes] } },
      select: { seasonCode: true },
      distinct: ["seasonCode"],
    });
    if (orphaned.length > 0) {
      const lost = orphaned.map((slot) => `"${slot.seasonCode}"`).join(", ");
      throw conflict(
        `This calendar has hours assigned to ${lost}, which "${target.name}" does not define. Clear those hours first, or pick a set that has ${orphaned.length === 1 ? "that season" : "those seasons"}.`,
        "SEASON_CODE_IN_USE",
      );
    }
  }

  /*
   * Attaching a holiday set brings the `holiday` day type with it, for
   * the same reason creating one does.
   */
  let createHolidayDayType = false;
  if (data.touHolidaySetId && data.touHolidaySetId !== existing.touHolidaySetId) {
    const set = await prisma.touHolidaySet.findFirst({
      where: { id: data.touHolidaySetId, utilityId },
      select: { id: true },
    });
    if (!set) throw badRequest("That holiday set does not exist.", "HOLIDAY_SET_MISSING");
    const already = await prisma.touDayType.findFirst({
      where: { utilityId, touCalendarId: id, dayTypeCode: HOLIDAY_DAY_TYPE_CODE },
      select: { id: true },
    });
    createHolidayDayType = !already;
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouCalendar" },
    EVENT_TYPES.TOU_CALENDAR_UPDATED,
    existing,
    async (tx) => {
      if (createHolidayDayType) {
        const count = await tx.touDayType.count({ where: { utilityId, touCalendarId: id } });
        await tx.touDayType.create({
          data: {
            utilityId,
            touCalendarId: id,
            dayTypeCode: HOLIDAY_DAY_TYPE_CODE,
            label: "Holiday",
            sortOrder: count,
          },
        });
      }
      return tx.touCalendar.update({
        where: { id },
        data: {
          name: data.name,
          effectiveDate: data.effectiveDate ? utcDate(data.effectiveDate) : undefined,
          seasonSetId: data.seasonSetId,
          touHolidaySetId: data.touHolidaySetId,
          timeZone: data.timeZone,
          clockBasis: data.clockBasis,
        },
      });
    },
  );
}

export async function deleteTouCalendar(
  id: string,
  user: { utilityId: string; actorId: string; actorName: string },
) {
  const existing = await prisma.touCalendar.findFirst({
    where: { id, utilityId: user.utilityId },
    select: { id: true, name: true, publishedAt: true },
  });
  if (!existing) {
    throw notFound("There is no TOU calendar with that id.", "TOU_CALENDAR_NOT_FOUND");
  }
  assertDraft(existing);

  /*
   * A rate schedule referencing it blocks the delete at the database
   * (`rate_schedule_tou_calendar_id_fkey` is RESTRICT), which would
   * surface as a 500. Named here, because the operator needs to know
   * which schedule to change.
   */
  const referencing = await prisma.rateSchedule.findMany({
    where: { utilityId: user.utilityId, touCalendarId: id },
    select: { name: true, code: true },
    take: 5,
  });
  if (referencing.length > 0) {
    throw conflict(
      `${referencing.map((r) => `${r.code} (${r.name})`).join(", ")} price against this calendar. Point them at another one before deleting it.`,
      "TOU_CALENDAR_IN_USE",
    );
  }

  return auditUpdate(
    {
      utilityId: user.utilityId,
      actorId: user.actorId,
      actorName: user.actorName,
      entityType: "TouCalendar",
    },
    EVENT_TYPES.TOU_CALENDAR_UPDATED,
    existing,
    async (tx) => tx.touCalendar.delete({ where: { id } }),
  );
}

/**
 * Publish, which freezes the hours.
 *
 * Validation runs here rather than at every save because a half-written
 * calendar is a normal state of work. Publishing is the commitment, so
 * it is where the whole thing has to hold together.
 */
export async function publishTouCalendar(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
) {
  const row = await loadEditorCalendar(utilityId, id);

  if (row.publishedAt) {
    throw conflict(`"${row.name}" is already published.`, "ALREADY_PUBLISHED");
  }

  /*
   * TOU-CAL-10: the calendar's spans are keyed on its season set's
   * codes, so a published calendar whose set is still a draft could
   * have the ground move under it.
   */
  if (!row.seasonSet.publishedAt) {
    throw conflict(
      `The season set "${row.seasonSet.name}" is still a draft. Publish it first — this calendar's hours are keyed on its season codes, and a draft set can still rename them.`,
      "SEASON_SET_NOT_PUBLISHED",
    );
  }

  /* The same argument for holidays: a draft set's dates can still move. */
  if (row.touHolidaySetId) {
    const set = await prisma.touHolidaySet.findFirst({
      where: { id: row.touHolidaySetId, utilityId },
      select: { name: true, publishedAt: true },
    });
    if (set && !set.publishedAt) {
      throw conflict(
        `The holiday set "${set.name}" is still a draft. Publish it first — a draft set's dates can still change, and these hours would then price different days than the ones you checked.`,
        "HOLIDAY_SET_NOT_PUBLISHED",
      );
    }
  }

  const engineValidation = validateCalendar(toTouCalendarDefinition(row), row.seasonSet.seasons);
  const problems = [
    ...(engineValidation.ok ? [] : engineValidation.problems),
    ...(await holidayHorizonProblems(utilityId, row)),
  ];
  if (problems.length > 0) {
    throw Object.assign(
      new Error(
        `"${row.name}" is not ready to publish, and publishing it would leave usage either uncharged or charged twice:\n` +
          problems.map((p) => `  • ${p}`).join("\n"),
      ),
      { statusCode: 409, code: "TOU_CALENDAR_INVALID", problems },
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouCalendar" },
    EVENT_TYPES.TOU_CALENDAR_PUBLISHED,
    { publishedAt: null },
    async (tx) => tx.touCalendar.update({ where: { id }, data: { publishedAt: new Date() } }),
  );
}

export async function putTouPeriods(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: PutTouPeriodsInput,
) {
  const row = await loadEditorCalendar(utilityId, id);
  assertDraft(row);

  const codes = data.periods.map((p) => p.peakCode);
  const duplicate = codes.find((c, i) => codes.indexOf(c) !== i);
  if (duplicate) {
    throw badRequest(`"${duplicate}" is listed twice.`, "DUPLICATE_PEAK_CODE");
  }

  /*
   * A period a span still references cannot go. The database would
   * refuse it (`tou_slot_period_id_fkey` is RESTRICT) with a message
   * naming a constraint; this names the hours instead.
   */
  const removed = row.periods.filter((p) => !codes.includes(p.peakCode));
  const stillUsed = removed.filter((p) => row.slots.some((s) => s.period.id === p.id));
  if (stillUsed.length > 0) {
    throw conflict(
      `${stillUsed.map((p) => `"${p.label}"`).join(", ")} ${stillUsed.length === 1 ? "is" : "are"} still assigned to hours in this calendar. Reassign those hours first.`,
      "TOU_PERIOD_IN_USE",
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouCalendar" },
    EVENT_TYPES.TOU_CALENDAR_PERIODS_SET,
    row.periods.map((p) => ({ peakCode: p.peakCode, label: p.label })),
    async (tx) => {
      if (removed.length > 0) {
        await tx.touPeriod.deleteMany({ where: { id: { in: removed.map((p) => p.id) } } });
      }
      for (const [index, period] of data.periods.entries()) {
        const existing = row.periods.find((p) => p.peakCode === period.peakCode);
        if (existing) {
          await tx.touPeriod.update({
            where: { id: existing.id },
            data: { label: period.label, sortOrder: index },
          });
        } else {
          await tx.touPeriod.create({
            data: {
              utilityId,
              touCalendarId: id,
              peakCode: period.peakCode,
              label: period.label,
              sortOrder: index,
            },
          });
        }
      }
      /*
       * The calendar is what the audit row is about: a period is not
       * separately addressable to anyone asking "who moved the peak
       * hours", and `auditUpdate` needs an entity with an id. The empty
       * update also moves `updatedAt`.
       */
      return tx.touCalendar.update({ where: { id }, data: {} });
    },
  );
}

export async function putTouDayTypes(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: PutTouDayTypesInput,
) {
  const row = await loadEditorCalendar(utilityId, id);
  assertDraft(row);

  const codes = data.dayTypes.map((d) => d.dayTypeCode);
  const duplicate = codes.find((c, i) => codes.indexOf(c) !== i);
  if (duplicate) {
    throw badRequest(`"${duplicate}" is listed twice.`, "DUPLICATE_DAY_TYPE_CODE");
  }

  /*
   * `holiday` is the system's code and the engine finds that day type
   * by matching it. Two refusals, because blocking only the first would
   * leave the second quiet: a renamed or removed holiday day type stops
   * being found, and then every holiday bills as an ordinary weekday
   * with nothing raised.
   */
  const existingHoliday = row.dayTypes.find((d) => d.dayTypeCode === HOLIDAY_DAY_TYPE_CODE);
  const submittedHoliday = data.dayTypes.find(
    (d) => d.dayTypeCode.trim().toLowerCase() === HOLIDAY_DAY_TYPE_CODE,
  );

  if (submittedHoliday && !existingHoliday) {
    throw badRequest(
      `"${HOLIDAY_DAY_TYPE_CODE}" is reserved. It is created for you when the calendar names a holiday set, and the hours you give it are what those dates cost.`,
      "RESERVED_DAY_TYPE_CODE",
    );
  }

  if (existingHoliday && !submittedHoliday && row.touHolidaySetId) {
    throw conflict(
      `The "${HOLIDAY_DAY_TYPE_CODE}" day type is what this calendar's holiday dates resolve to, so it cannot be renamed or removed while a holiday set is named. Detach the set first if the tariff does not price holidays separately.`,
      "RESERVED_DAY_TYPE_REQUIRED",
    );
  }

  /*
   * Removing a day type deletes its hours, because
   * `tou_slot_day_type_id_fkey` cascades — right for deleting a
   * calendar, wrong for a typo in a code.
   */
  const removed = row.dayTypes.filter((d) => !codes.includes(d.dayTypeCode));
  const withSpans = removed
    .map((d) => ({ d, count: row.slots.filter((s) => s.dayType.id === d.id).length }))
    .filter((x) => x.count > 0);
  if (withSpans.length > 0) {
    throw conflict(
      `${withSpans.map((x) => `"${x.d.label}" (${x.count} span${x.count === 1 ? "" : "s"})`).join(", ")} would lose assigned hours. Clear those hours first if you mean to remove it.`,
      "TOU_DAY_TYPE_HAS_SPANS",
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouCalendar" },
    EVENT_TYPES.TOU_CALENDAR_DAY_TYPES_SET,
    row.dayTypes.map((d) => ({
      dayTypeCode: d.dayTypeCode,
      label: d.label,
      weekdays: d.weekdays.map((w) => w.isoWeekday),
    })),
    async (tx) => {
      if (removed.length > 0) {
        await tx.touDayType.deleteMany({ where: { id: { in: removed.map((d) => d.id) } } });
      }

      /*
       * Every weekday row for the calendar goes first, then they are
       * written again. `tou_day_type_weekday_once_per_calendar` makes a
       * weekday one day type's property, so moving Saturday from one to
       * another is only legal with the old row gone.
       */
      await tx.touDayTypeWeekday.deleteMany({ where: { utilityId, touCalendarId: id } });

      for (const [index, dayType] of data.dayTypes.entries()) {
        const existing = row.dayTypes.find((d) => d.dayTypeCode === dayType.dayTypeCode);
        const dayTypeId = existing
          ? (
              await tx.touDayType.update({
                where: { id: existing.id },
                data: { label: dayType.label, sortOrder: index },
              })
            ).id
          : (
              await tx.touDayType.create({
                data: {
                  utilityId,
                  touCalendarId: id,
                  dayTypeCode: dayType.dayTypeCode,
                  label: dayType.label,
                  sortOrder: index,
                },
              })
            ).id;

        if (dayType.weekdays.length > 0) {
          await tx.touDayTypeWeekday.createMany({
            data: dayType.weekdays.map((isoWeekday) => ({
              utilityId,
              touCalendarId: id,
              touDayTypeId: dayTypeId,
              isoWeekday,
            })),
          });
        }
      }
      return tx.touCalendar.update({ where: { id }, data: {} });
    },
  );
}

export async function putTouSpans(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: PutTouSpansInput,
) {
  const row = await loadEditorCalendar(utilityId, id);
  assertDraft(row);

  const dayType = row.dayTypes.find((d) => d.dayTypeCode === data.dayTypeCode);
  if (!dayType) {
    throw badRequest(`This calendar has no day type "${data.dayTypeCode}".`, "TOU_DAY_TYPE_MISSING");
  }
  if (!row.seasonSet.seasons.some((s) => s.seasonCode === data.seasonCode)) {
    throw badRequest(
      `"${data.seasonCode}" is not a season in the set "${row.seasonSet.name}".`,
      "SEASON_MISSING",
    );
  }

  const periodByCode = new Map(row.periods.map((p) => [p.peakCode, p.id]));
  for (const span of data.spans) {
    if (!periodByCode.has(span.peakCode)) {
      throw badRequest(`This calendar has no period "${span.peakCode}".`, "TOU_PERIOD_MISSING");
    }
  }

  /*
   * Overlaps are caught here as well as by `tou_slot_no_overlap`,
   * because the exclusion constraint reports one pair and the editor
   * has to show every clash at once — and a 23503 from Postgres is not
   * a sentence anybody can act on. Gaps are not refused: a half-filled
   * day is a normal state of a draft, and `validateCalendar` names them.
   */
  const sorted = [...data.spans].sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMinute < sorted[i - 1].endMinute) {
      throw badRequest(
        `Two spans overlap: ${timeLabel(sorted[i - 1].startMinute)}–${timeLabel(sorted[i - 1].endMinute)} and ${timeLabel(sorted[i].startMinute)}–${timeLabel(sorted[i].endMinute)}.`,
        "TOU_SPANS_OVERLAP",
      );
    }
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouCalendar" },
    EVENT_TYPES.TOU_CALENDAR_SPANS_SET,
    {
      seasonCode: data.seasonCode,
      dayTypeCode: data.dayTypeCode,
      spans: row.slots
        .filter((s) => s.seasonCode === data.seasonCode && s.dayType.id === dayType.id)
        .map((s) => ({
          startMinute: s.startMinute,
          endMinute: s.endMinute,
          peakCode: s.period.peakCode,
        })),
    },
    async (tx) => {
      await tx.touSlot.deleteMany({
        where: {
          utilityId,
          touCalendarId: id,
          seasonCode: data.seasonCode,
          touDayTypeId: dayType.id,
        },
      });
      if (data.spans.length > 0) {
        await tx.touSlot.createMany({
          data: data.spans.map((span) => ({
            utilityId,
            touCalendarId: id,
            seasonCode: data.seasonCode,
            touDayTypeId: dayType.id,
            touPeriodId: periodByCode.get(span.peakCode) as string,
            startMinute: span.startMinute,
            endMinute: span.endMinute,
          })),
        });
      }
      return tx.touCalendar.update({ where: { id }, data: {} });
    },
  );
}

export async function putTouDayOverrides(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: PutTouDayOverridesInput,
) {
  const row = await loadEditorCalendar(utilityId, id);
  assertDraft(row);

  const dayTypeByCode = new Map(row.dayTypes.map((d) => [d.dayTypeCode, d.id]));
  for (const override of data.overrides) {
    if (!dayTypeByCode.has(override.dayTypeCode)) {
      throw badRequest(
        `This calendar has no day type "${override.dayTypeCode}".`,
        "TOU_DAY_TYPE_MISSING",
      );
    }
  }
  const dates = data.overrides.map((o) => o.date);
  const duplicate = dates.find((d, i) => dates.indexOf(d) !== i);
  if (duplicate) {
    throw badRequest(`${duplicate} is listed twice.`, "DUPLICATE_OVERRIDE_DATE");
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouCalendar" },
    EVENT_TYPES.TOU_CALENDAR_OVERRIDES_SET,
    row.overrides.map((o) => ({
      date: o.overrideDate.toISOString().slice(0, 10),
      dayTypeCode: o.dayType.dayTypeCode,
      reason: o.reason,
    })),
    async (tx) => {
      await tx.touDayOverride.deleteMany({ where: { utilityId, touCalendarId: id } });
      if (data.overrides.length > 0) {
        await tx.touDayOverride.createMany({
          data: data.overrides.map((o) => ({
            utilityId,
            touCalendarId: id,
            overrideDate: utcDate(o.date),
            touDayTypeId: dayTypeByCode.get(o.dayTypeCode) as string,
            reason: o.reason ?? null,
          })),
        });
      }
      return tx.touCalendar.update({ where: { id }, data: {} });
    },
  );
}

export async function validateTouCalendar(
  id: string,
  utilityId: string,
): Promise<CalendarValidation> {
  const row = await loadEditorCalendar(utilityId, id);
  const engineValidation = validateCalendar(toTouCalendarDefinition(row), row.seasonSet.seasons);
  const problems = [
    ...(engineValidation.ok ? [] : engineValidation.problems),
    ...(await holidayHorizonProblems(utilityId, row)),
  ];
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/**
 * Why this date got this day type, in a sentence (TOU-UI-1c).
 *
 * The holiday case names the holiday rather than saying "holiday",
 * because the name is the fact somebody is checking — and it is a row
 * now, not something a rule worked out.
 */
function explainDayType(
  date: Date,
  isoDate: string,
  reason: "OVERRIDE" | "HOLIDAY" | "WEEKDAY",
  dayTypeLabel: string,
  holidayName: string | null,
  override: { reason: string | null } | undefined,
): string {
  const weekday = WEEKDAY_NAMES[(date.getUTCDay() + 6) % 7];

  if (reason === "OVERRIDE") {
    const why = override?.reason ? ` (${override.reason})` : "";
    return `${isoDate} is overridden to "${dayTypeLabel}"${why}, which takes precedence over its weekday and the holiday set.`;
  }

  if (reason === "HOLIDAY") {
    const named = holidayName ? ` as ${holidayName}` : "";
    return `${isoDate} is in this calendar's holiday set${named}, so "${dayTypeLabel}" applies rather than its ${weekday} hours.`;
  }

  return `${isoDate} is a ${weekday}, and ${weekday} belongs to "${dayTypeLabel}".`;
}

/** The holiday row for one date, for the sentence above. */
async function holidayNameOn(
  utilityId: string,
  touHolidaySetId: string | null,
  date: Date,
): Promise<string | null> {
  if (!touHolidaySetId) return null;
  const row = await prisma.touHoliday.findFirst({
    where: { utilityId, touHolidaySetId, holidayDate: date },
    select: { name: true },
  });
  return row?.name ?? null;
}

/**
 * TOU-UI-1c — the spot check: one date and time, answered with the
 * period, the day type, the season and why.
 *
 * It runs the engine's own `resolvePeak`, so what it says is what a
 * bill will do.
 */
export async function spotCheckTouCalendar(
  id: string,
  utilityId: string,
  query: { date: string; time: string },
) {
  const row = await loadEditorCalendar(utilityId, id);
  const date = utcDate(query.date);
  const [hours, minutes] = query.time.split(":").map(Number);
  const minuteOfDay = hours * 60 + minutes;

  const definition = toTouCalendarDefinition(row);
  const [observedHolidays, holidayName] = await Promise.all([
    loadObservedHolidays(prisma, utilityId, row.touHolidaySetId, {
      startDate: date,
      endDate: date,
    }),
    holidayNameOn(utilityId, row.touHolidaySetId, date),
  ]);

  const lookup = resolvePeak({
    date,
    minuteOfDay,
    calendar: definition,
    seasons: row.seasonSet.seasons,
    observedHolidays,
  });

  const dayType = resolveDayType(date, definition, observedHolidays);
  const dayTypeRow = dayType
    ? row.dayTypes.find((d) => d.dayTypeCode === dayType.dayTypeCode)
    : undefined;

  return {
    date: query.date,
    time: query.time,
    ...(lookup.ok
      ? {
          ok: true as const,
          peakCode: lookup.peakCode,
          periodLabel:
            row.periods.find((p) => p.peakCode === lookup.peakCode)?.label ?? lookup.peakCode,
          seasonCode: lookup.seasonCode,
          seasonLabel:
            row.seasonSet.seasons.find((s) => s.seasonCode === lookup.seasonCode)?.label ??
            lookup.seasonCode,
          dayTypeCode: lookup.dayTypeCode,
          dayTypeLabel: dayTypeRow?.label ?? lookup.dayTypeCode,
          why: explainDayType(
            date,
            query.date,
            lookup.dayTypeReason,
            dayTypeRow?.label ?? lookup.dayTypeCode,
            holidayName,
            row.overrides.find((o) => o.overrideDate.toISOString().slice(0, 10) === query.date),
          ),
        }
      : { ok: false as const, problem: lookup.problem }),
  };
}

/**
 * TOU-UI-1e — a whole day laid out. The same mechanism as the spot
 * check, which is the point: a holiday is checked by looking at the day
 * it changes, not at one minute of it.
 */
export async function previewTouDay(id: string, utilityId: string, query: { date: string }) {
  const row = await loadEditorCalendar(utilityId, id);
  const date = utcDate(query.date);
  const definition = toTouCalendarDefinition(row);

  const [observedHolidays, holidayName] = await Promise.all([
    loadObservedHolidays(prisma, utilityId, row.touHolidaySetId, {
      startDate: date,
      endDate: date,
    }),
    holidayNameOn(utilityId, row.touHolidaySetId, date),
  ]);

  const dayType = resolveDayType(date, definition, observedHolidays);
  if (!dayType) {
    return {
      date: query.date,
      ok: false as const,
      problem: `No day type covers ${query.date}. Check that every weekday is claimed by a day type.`,
    };
  }
  const dayTypeRow = row.dayTypes.find((d) => d.dayTypeCode === dayType.dayTypeCode);

  /*
   * The season comes from `resolvePeak` at midnight rather than from a
   * second season resolver here, so the preview cannot disagree with
   * the spot check about which season a date is in.
   */
  const atMidnight = resolvePeak({
    date,
    minuteOfDay: 0,
    calendar: definition,
    seasons: row.seasonSet.seasons,
    observedHolidays,
  });
  const seasonCode = atMidnight.ok ? atMidnight.seasonCode : null;

  return {
    date: query.date,
    ok: true as const,
    dayTypeCode: dayType.dayTypeCode,
    dayTypeLabel: dayTypeRow?.label ?? dayType.dayTypeCode,
    why: explainDayType(
      date,
      query.date,
      dayType.reason,
      dayTypeRow?.label ?? dayType.dayTypeCode,
      holidayName,
      row.overrides.find((o) => o.overrideDate.toISOString().slice(0, 10) === query.date),
    ),
    seasonCode,
    seasonLabel: seasonCode
      ? (row.seasonSet.seasons.find((s) => s.seasonCode === seasonCode)?.label ?? seasonCode)
      : null,
    spans:
      seasonCode === null
        ? []
        : row.slots
            .filter(
              (s) => s.seasonCode === seasonCode && s.dayType.dayTypeCode === dayType.dayTypeCode,
            )
            .map((s) => ({
              startMinute: s.startMinute,
              endMinute: s.endMinute,
              peakCode: s.period.peakCode,
              periodLabel:
                row.periods.find((p) => p.peakCode === s.period.peakCode)?.label ??
                s.period.peakCode,
            })),
  };
}
