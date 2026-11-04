import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateTouHolidaySetInput,
  PutTouHolidaysInput,
  TouHolidaySetQuery,
  UpdateTouHolidaySetInput,
} from "@utility-cis/shared";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

/**
 * Holiday sets: which dates are holidays (spec 26, TOU-CAL-4).
 *
 * Three decisions carried here:
 *
 * 1. **Dates, not rules.** A rule is a computation nobody checked. A
 *    date is the fact, and the observance — "4 July 2026 falls on a
 *    Saturday so we take the Friday" — is applied by whoever knows it.
 *
 * 2. **Versioned and published like a season set.** A published
 *    calendar names a published version, so editing a set cannot change
 *    which days got holiday hours on bills already issued.
 *
 * 3. **Shared across calendars**, because holidays are a property of
 *    the utility and not of a tariff.
 *
 * The cost is that a set covers a horizon and runs out, which
 * `tou-calendar.service.ts` reports and refuses to publish past.
 */

const conflict = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 409, code });

const badRequest = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 400, code });

const notFound = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 404, code });

const HOLIDAY_ORDER = { holidayDate: "asc" as const };

function utcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

function assertDraft(row: { name: string; publishedAt: Date | null }): void {
  if (row.publishedAt) {
    throw conflict(
      `"${row.name}" is published, so its dates cannot change. Create a new set with a later effective date instead — calendars naming this one priced bills against exactly these days.`,
      "HOLIDAY_SET_PUBLISHED",
    );
  }
}

/**
 * The calendars naming a set.
 *
 * Read directly rather than through a relation: the key from a calendar
 * to its set is nullable and composite, which Prisma cannot express, so
 * it exists only in the migration.
 */
async function calendarsUsing(utilityId: string, touHolidaySetId: string) {
  return prisma.touCalendar.findMany({
    where: { utilityId, touHolidaySetId },
    select: { id: true, name: true, effectiveDate: true, publishedAt: true },
    orderBy: [{ name: "asc" }, { effectiveDate: "desc" }],
  });
}

export async function listTouHolidaySets(utilityId: string, query: TouHolidaySetQuery) {
  const where: Record<string, unknown> = { utilityId };
  if (query.status === "draft") where.publishedAt = null;
  if (query.status === "published") where.publishedAt = { not: null };

  const [rows, total] = await Promise.all([
    prisma.touHolidaySet.findMany({
      where,
      include: { _count: { select: { holidays: true } } },
      orderBy: { [query.sort]: query.order },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.touHolidaySet.count({ where }),
  ]);

  /*
   * How many calendars name each set, and the span of dates it covers.
   * Both are what somebody needs before opening one: the reach of a
   * change, and whether the set has run out.
   */
  const ids = rows.map((r) => r.id);
  const [usage, bounds] = await Promise.all([
    ids.length === 0
      ? []
      : prisma.touCalendar.groupBy({
          by: ["touHolidaySetId"],
          where: { utilityId, touHolidaySetId: { in: ids } },
          _count: { _all: true },
        }),
    ids.length === 0
      ? []
      : prisma.touHoliday.groupBy({
          by: ["touHolidaySetId"],
          where: { utilityId, touHolidaySetId: { in: ids } },
          _min: { holidayDate: true },
          _max: { holidayDate: true },
        }),
  ]);
  const usedBy = new Map(usage.map((u) => [u.touHolidaySetId, u._count._all]));
  const span = new Map(bounds.map((b) => [b.touHolidaySetId, b]));

  return {
    data: rows.map((row) => ({
      ...row,
      calendarCount: usedBy.get(row.id) ?? 0,
      firstDate: span.get(row.id)?._min.holidayDate ?? null,
      lastDate: span.get(row.id)?._max.holidayDate ?? null,
    })),
    // The standard envelope. A hand-rolled `pagination` key is what made
    // the season-set list read "0 total" above a visible row.
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.ceil(total / query.limit),
    },
  };
}

export async function getTouHolidaySet(id: string, utilityId: string) {
  const row = await prisma.touHolidaySet.findFirst({
    where: { id, utilityId },
    include: { holidays: { orderBy: HOLIDAY_ORDER } },
  });
  if (!row) throw notFound("There is no holiday set with that id.", "HOLIDAY_SET_NOT_FOUND");

  return {
    ...row,
    /*
     * Who this set reaches. A published set is immutable, so this is
     * not a warning about editing — it is what a new version has to be
     * carried into, calendar by calendar.
     */
    calendars: await calendarsUsing(utilityId, id),
  };
}

export async function createTouHolidaySet(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateTouHolidaySetInput,
) {
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "TouHolidaySet" },
    EVENT_TYPES.TOU_HOLIDAY_SET_CREATED,
    async (tx) =>
      tx.touHolidaySet.create({
        data: {
          utilityId,
          name: data.name,
          effectiveDate: utcDate(data.effectiveDate),
        },
      }),
  );
}

export async function updateTouHolidaySet(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateTouHolidaySetInput,
) {
  const existing = await prisma.touHolidaySet.findFirst({
    where: { id, utilityId },
    select: { id: true, name: true, publishedAt: true, effectiveDate: true },
  });
  if (!existing) throw notFound("There is no holiday set with that id.", "HOLIDAY_SET_NOT_FOUND");
  assertDraft(existing);

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouHolidaySet" },
    EVENT_TYPES.TOU_HOLIDAY_SET_UPDATED,
    existing,
    async (tx) =>
      tx.touHolidaySet.update({
        where: { id },
        data: {
          name: data.name,
          effectiveDate: data.effectiveDate ? utcDate(data.effectiveDate) : undefined,
        },
      }),
  );
}

export async function deleteTouHolidaySet(
  id: string,
  user: { utilityId: string; actorId: string; actorName: string },
) {
  const existing = await prisma.touHolidaySet.findFirst({
    where: { id, utilityId: user.utilityId },
    select: { id: true, name: true, publishedAt: true },
  });
  if (!existing) throw notFound("There is no holiday set with that id.", "HOLIDAY_SET_NOT_FOUND");
  assertDraft(existing);

  /*
   * `tou_calendar_holiday_set_id_fkey` is RESTRICT, so the database
   * would refuse this with a constraint name. Named here, because the
   * operator has to go and change those calendars — and a published one
   * cannot be changed at all, which is worth learning before trying.
   */
  const calendars = await calendarsUsing(user.utilityId, id);
  if (calendars.length > 0) {
    throw conflict(
      `${calendars.map((c) => `"${c.name}"`).join(", ")} ${calendars.length === 1 ? "names" : "name"} this set. Point ${calendars.length === 1 ? "it" : "them"} at another set, or at none, before deleting it.`,
      "HOLIDAY_SET_IN_USE",
    );
  }

  return auditUpdate(
    {
      utilityId: user.utilityId,
      actorId: user.actorId,
      actorName: user.actorName,
      entityType: "TouHolidaySet",
    },
    EVENT_TYPES.TOU_HOLIDAY_SET_UPDATED,
    existing,
    async (tx) => tx.touHolidaySet.delete({ where: { id } }),
  );
}

export async function putTouHolidays(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: PutTouHolidaysInput,
) {
  const existing = await prisma.touHolidaySet.findFirst({
    where: { id, utilityId },
    include: { holidays: { orderBy: HOLIDAY_ORDER } },
  });
  if (!existing) throw notFound("There is no holiday set with that id.", "HOLIDAY_SET_NOT_FOUND");
  assertDraft(existing);

  const dates = data.holidays.map((h) => h.date);
  const duplicate = dates.find((d, i) => dates.indexOf(d) !== i);
  if (duplicate) {
    throw badRequest(
      `${duplicate} is listed twice. One row per date — two names for one day would make "is this a holiday" ambiguous in the set that is supposed to answer it.`,
      "DUPLICATE_HOLIDAY_DATE",
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouHolidaySet" },
    EVENT_TYPES.TOU_HOLIDAYS_SET,
    existing.holidays.map((h) => ({
      date: h.holidayDate.toISOString().slice(0, 10),
      name: h.name,
    })),
    async (tx) => {
      await tx.touHoliday.deleteMany({ where: { utilityId, touHolidaySetId: id } });
      if (data.holidays.length > 0) {
        await tx.touHoliday.createMany({
          data: data.holidays.map((h) => ({
            utilityId,
            touHolidaySetId: id,
            holidayDate: utcDate(h.date),
            name: h.name,
          })),
        });
      }
      // The set is the entity the audit row is about; the empty update
      // also moves `updatedAt`.
      return tx.touHolidaySet.update({ where: { id }, data: {} });
    },
  );
}

/**
 * Publish, which freezes the dates.
 *
 * A set with no dates is refused: a calendar naming it would price
 * every day by its weekday while appearing to observe holidays, which
 * is the quiet kind of wrong this subsystem exists to refuse.
 */
export async function publishTouHolidaySet(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
) {
  const row = await prisma.touHolidaySet.findFirst({
    where: { id, utilityId },
    include: { _count: { select: { holidays: true } } },
  });
  if (!row) throw notFound("There is no holiday set with that id.", "HOLIDAY_SET_NOT_FOUND");

  if (row.publishedAt) {
    throw conflict(`"${row.name}" is already published.`, "ALREADY_PUBLISHED");
  }
  if (row._count.holidays === 0) {
    throw conflict(
      `"${row.name}" has no dates in it. A calendar naming it would price every day by its weekday while appearing to observe holidays.`,
      "HOLIDAY_SET_EMPTY",
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouHolidaySet" },
    EVENT_TYPES.TOU_HOLIDAY_SET_PUBLISHED,
    { publishedAt: null },
    async (tx) => tx.touHolidaySet.update({ where: { id }, data: { publishedAt: new Date() } }),
  );
}
