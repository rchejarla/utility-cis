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
  resolveDayType,
  resolvePeak,
  validateCalendar,
  type CalendarValidation,
} from "../lib/rate-engine/tou-calendar.js";
import {
  resolveHolidays,
  type HolidayObservance,
  type HolidayRule,
  type IsoWeekday,
} from "../lib/rate-engine/holidays.js";
import {
  loadObservedHolidays,
  toTouCalendarDefinition,
} from "../lib/rate-engine-loaders/load-tou-calendar.js";

/**
 * The calendar editor's server side (spec 26, TOU-UI-1 and TOU-UI-2).
 *
 * Three rules shape every function here:
 *
 * 1. **A draft is editable; a published version is not.** Changing which
 *    hours are on-peak changes what a bill costs, so a change is a new
 *    version with its own effective date, never an edit to the one that
 *    billed. There is no `version` column: a version *is* a (name,
 *    effectiveDate) pair.
 *
 * 2. **The child collections are replaced whole.** Every invariant they
 *    carry belongs to the whole list — the spans of a (season, day type)
 *    must tile the day exactly once, the seven weekdays must be claimed
 *    exactly once — so row-at-a-time saving would make every
 *    intermediate state invalid and reduce validation to advice.
 *
 * 3. **What the editor says, rating must say.** The validation, the spot
 *    check and the day preview all run the engine's own functions over
 *    the definition produced by the rating loader's mapper. A screen
 *    with its own copy of the classification rules is a screen that
 *    blesses a calendar the engine reads differently.
 */

/*
 * One include, used by every read here. The engine needs codes; the
 * editor needs the ids, labels and sort orders as well, so this is a
 * superset of what `toTouCalendarDefinition` reads and satisfies its
 * structural type.
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
 * raising, so every peak shifts by hours and nothing says so. The IANA
 * database is the authority and it changes, which is why neither this
 * nor the CHECK constraint holds a list of names.
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

export async function listTouCalendars(utilityId: string, query: TouCalendarQuery) {
  const where: Record<string, unknown> = { utilityId };
  if (query.name) where.name = query.name;
  if (query.status === "draft") where.publishedAt = null;
  if (query.status === "published") where.publishedAt = { not: null };

  return paginatedTenantList(prisma.touCalendar, where, query, {
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
}

export async function getTouCalendar(id: string, utilityId: string) {
  const row = await loadEditorCalendar(utilityId, id);
  return toEditorPayload(row);
}

/**
 * What the editor screen renders from.
 *
 * The spans are grouped by (season, day type) because that is the unit
 * the screen edits and the unit the validator reports against. Flat
 * rows would make the page do the grouping, and the grouping is where
 * an empty (season, day type) — the most common mistake — would go
 * missing: a group with no spans is rendered, and a missing key is not.
 */
function toEditorPayload(row: EditorCalendar) {
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
    touHolidayListId: row.touHolidayListId,
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
      isHoliday: d.isHoliday,
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
    validation: validateCalendar(toTouCalendarDefinition(row), row.seasonSet.seasons),
  };
}

export async function createTouCalendar(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateTouCalendarInput,
) {
  assertKnownTimeZone(data.timeZone);

  const seasonSet = await prisma.seasonSet.findFirst({
    where: { id: data.seasonSetId, utilityId },
    select: { id: true, publishedAt: true, name: true },
  });
  if (!seasonSet) {
    throw badRequest("That season set does not exist.", "SEASON_SET_MISSING");
  }
  /*
   * A draft calendar may name a draft season set — the two are often
   * built together — but publishing requires the set to be published
   * too, and `publishTouCalendar` checks it there. Refusing here would
   * force an order of work the tenant has no reason to follow.
   */

  if (data.touHolidayListId) {
    const list = await prisma.touHolidayList.findFirst({
      where: { id: data.touHolidayListId, utilityId },
      select: { id: true },
    });
    if (!list) throw badRequest("That holiday list does not exist.", "HOLIDAY_LIST_MISSING");
  }

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
          touHolidayListId: data.touHolidayListId ?? null,
          timeZone: data.timeZone,
          clockBasis: data.clockBasis,
        },
      });
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
      touHolidayListId: true,
      timeZone: true,
      clockBasis: true,
    },
  });
  if (!existing) {
    throw notFound("There is no TOU calendar with that id.", "TOU_CALENDAR_NOT_FOUND");
  }
  assertDraft(existing);
  if (data.timeZone) assertKnownTimeZone(data.timeZone);

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouCalendar" },
    EVENT_TYPES.TOU_CALENDAR_UPDATED,
    existing,
    async (tx) =>
      tx.touCalendar.update({
        where: { id },
        data: {
          name: data.name,
          effectiveDate: data.effectiveDate ? utcDate(data.effectiveDate) : undefined,
          seasonSetId: data.seasonSetId,
          touHolidayListId: data.touHolidayListId,
          timeZone: data.timeZone,
          clockBasis: data.clockBasis,
        },
      }),
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
   * surface as a 500. Named here instead, because the operator needs to
   * know which schedule to change.
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
 * Validation runs here rather than at every save for the reason a draft
 * exists at all: a half-written calendar is a normal state of work, and
 * refusing each save would mean building it in an order nobody would
 * choose. Publishing is the commitment, so it is where the whole thing
 * has to hold together.
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
   * have the ground move under it — the set is editable, and an edited
   * code leaves every span referencing nothing.
   */
  if (!row.seasonSet.publishedAt) {
    throw conflict(
      `The season set "${row.seasonSet.name}" is still a draft. Publish it first — this calendar's hours are keyed on its season codes, and a draft set can still rename them.`,
      "SEASON_SET_NOT_PUBLISHED",
    );
  }

  const validation = validateCalendar(toTouCalendarDefinition(row), row.seasonSet.seasons);
  if (!validation.ok) {
    throw Object.assign(
      new Error(
        `"${row.name}" does not yet price every hour exactly once, so publishing it would leave usage either uncharged or charged twice:\n` +
          validation.problems.map((p) => `  • ${p}`).join("\n"),
      ),
      { statusCode: 409, code: "TOU_CALENDAR_INVALID", problems: validation.problems },
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
   * naming a constraint; this names the hours instead, which is what
   * the operator has to go and change.
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
       * The calendar is what the audit row is about: a span or a period
       * is not separately addressable to anyone asking "who moved the
       * peak hours", and `auditUpdate` needs an entity with an id. The
       * empty update is also what moves `updatedAt`, so the list can
       * show which calendar someone was last working on.
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

  const holidays = data.dayTypes.filter((d) => d.isHoliday);
  if (holidays.length > 1) {
    throw badRequest(
      `Only one day type can be the holiday one; ${holidays.map((d) => `"${d.label}"`).join(" and ")} are both marked.`,
      "MULTIPLE_HOLIDAY_DAY_TYPES",
    );
  }

  /*
   * Removing a day type deletes its hours, because
   * `tou_slot_day_type_id_fkey` cascades — which is right for deleting
   * a calendar and wrong for a typo in a code, where it would quietly
   * discard an afternoon's work. Refused instead, naming what would go.
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
      isHoliday: d.isHoliday,
      weekdays: d.weekdays.map((w) => w.isoWeekday),
    })),
    async (tx) => {
      if (removed.length > 0) {
        await tx.touDayType.deleteMany({ where: { id: { in: removed.map((d) => d.id) } } });
      }

      /*
       * Every weekday row for the calendar goes first, then they are
       * written again. `tou_day_type_weekday_once_per_calendar` makes
       * any weekday a single day type's property, so moving Saturday
       * from one day type to another is only legal with the old row
       * gone — and in one transaction the order inside it is all that
       * matters.
       */
      await tx.touDayTypeWeekday.deleteMany({ where: { utilityId, touCalendarId: id } });

      for (const [index, dayType] of data.dayTypes.entries()) {
        const existing = row.dayTypes.find((d) => d.dayTypeCode === dayType.dayTypeCode);
        const dayTypeId = existing
          ? (
              await tx.touDayType.update({
                where: { id: existing.id },
                data: { label: dayType.label, isHoliday: dayType.isHoliday, sortOrder: index },
              })
            ).id
          : (
              await tx.touDayType.create({
                data: {
                  utilityId,
                  touCalendarId: id,
                  dayTypeCode: dayType.dayTypeCode,
                  label: dayType.label,
                  isHoliday: dayType.isHoliday,
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
    throw badRequest(
      `This calendar has no day type "${data.dayTypeCode}".`,
      "TOU_DAY_TYPE_MISSING",
    );
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
      throw badRequest(
        `This calendar has no period "${span.peakCode}".`,
        "TOU_PERIOD_MISSING",
      );
    }
  }

  /*
   * Overlaps are caught here as well as by `tou_slot_no_overlap`,
   * because the exclusion constraint reports one pair and the editor
   * has to show the operator every clash at once — and because a 23503
   * from Postgres is not a sentence anybody can act on. Gaps are not
   * refused: a half-filled day is a normal state of a draft, and
   * `validateCalendar` names them on every read.
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

/** `17:15`, and `24:00` for the exclusive end of the day. */
function timeLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export async function validateTouCalendar(
  id: string,
  utilityId: string,
): Promise<CalendarValidation> {
  const row = await loadEditorCalendar(utilityId, id);
  return validateCalendar(toTouCalendarDefinition(row), row.seasonSet.seasons);
}

/** The rules of the calendar's holiday list, as the resolver wants them. */
async function holidayRulesFor(
  utilityId: string,
  touHolidayListId: string | null,
): Promise<HolidayRule[]> {
  if (!touHolidayListId) return [];
  const rules = await prisma.touHolidayRule.findMany({
    where: { utilityId, touHolidayListId },
    orderBy: [{ month: "asc" }, { code: "asc" }],
  });
  return rules.map((r) => ({
    code: r.code,
    label: r.label,
    kind: r.kind as HolidayRule["kind"],
    month: r.month,
    day: r.day ?? undefined,
    weekday: (r.weekday ?? undefined) as IsoWeekday | undefined,
    nth: r.nth ?? undefined,
    observance: r.observance as HolidayObservance,
  }));
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
 * The holiday interaction is the part people get wrong, so the holiday
 * case names the rule that produced the date rather than saying
 * "holiday" — a tenant checking 3 July wants to be told it is the
 * observed Independence Day, which is the fact they are unsure of.
 */
function explainDayType(
  date: Date,
  isoDate: string,
  reason: "OVERRIDE" | "HOLIDAY" | "WEEKDAY",
  dayTypeLabel: string,
  holidays: Array<{ label: string; observed: Date; actual: Date }>,
  override: { reason: string | null } | undefined,
): string {
  const weekday = WEEKDAY_NAMES[(date.getUTCDay() + 6) % 7];

  if (reason === "OVERRIDE") {
    const why = override?.reason ? ` (${override.reason})` : "";
    return `${isoDate} is overridden to "${dayTypeLabel}"${why}, which takes precedence over its weekday and the holiday list.`;
  }

  if (reason === "HOLIDAY") {
    const match = holidays.find((h) => h.observed.toISOString().slice(0, 10) === isoDate);
    if (!match) {
      return `${isoDate} is an observed holiday, so "${dayTypeLabel}" applies.`;
    }
    const actual = match.actual.toISOString().slice(0, 10);
    const shifted =
      actual === isoDate
        ? ""
        : ` — the holiday falls on ${actual} and is observed on this day instead`;
    return `${isoDate} is observed as ${match.label}${shifted}, so "${dayTypeLabel}" applies rather than its ${weekday} day type.`;
  }

  return `${isoDate} is a ${weekday}, and ${weekday} belongs to "${dayTypeLabel}".`;
}

/**
 * TOU-UI-1c — the spot check: one date and time, answered with the
 * period, the day type, the season and why.
 *
 * The single most valuable control on the screen, because it is how
 * somebody checks a calendar before publishing it, and it runs the
 * engine's own `resolvePeak` so that what it says is what a bill will
 * do.
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
  const observedHolidays = await loadObservedHolidays(prisma, utilityId, row.touHolidayListId, {
    startDate: date,
    endDate: date,
  });
  const rules = await holidayRulesFor(utilityId, row.touHolidayListId);
  const year = date.getUTCFullYear();
  const holidays = resolveHolidays(rules, year, year);

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
            holidays,
            row.overrides.find((o) => o.overrideDate.toISOString().slice(0, 10) === query.date),
          ),
        }
      : { ok: false as const, problem: lookup.problem }),
  };
}

/**
 * TOU-UI-1e — a whole day laid out: which day type and season resolve,
 * and the spans that apply. The same mechanism as the spot check, which
 * is the point: an observance rule is sanity-checked by looking at the
 * day it moves, not at one minute of it.
 */
export async function previewTouDay(id: string, utilityId: string, query: { date: string }) {
  const row = await loadEditorCalendar(utilityId, id);
  const date = utcDate(query.date);
  const definition = toTouCalendarDefinition(row);

  const observedHolidays = await loadObservedHolidays(prisma, utilityId, row.touHolidayListId, {
    startDate: date,
    endDate: date,
  });
  const rules = await holidayRulesFor(utilityId, row.touHolidayListId);
  const year = date.getUTCFullYear();
  const holidays = resolveHolidays(rules, year, year);

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
      holidays,
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
