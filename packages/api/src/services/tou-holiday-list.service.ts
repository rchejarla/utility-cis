import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateTouHolidayListInput,
  PutTouHolidayRulesInput,
  TouHolidayListQuery,
  UpdateTouHolidayListInput,
} from "@utility-cis/shared";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import {
  resolveHolidays,
  type HolidayObservance,
  type HolidayRule,
  type IsoWeekday,
} from "../lib/rate-engine/holidays.js";

/**
 * Holiday lists and their rules (spec 26, TOU-CAL-4 and TOU-UI-2).
 *
 * **A list is shared across a tenant's calendars** and is *not*
 * versioned, which makes it the one piece of TOU configuration that can
 * change under a published calendar. That is deliberate and it is also
 * the sharp edge: a calendar is frozen so the hours it priced cannot
 * move, but adding a holiday to the list it names changes which *days*
 * get the holiday hours — including days already billed.
 *
 * The alternative is worse. Holidays are per utility, not per tariff,
 * so versioning the list per calendar means adding Juneteenth to three
 * calendars separately and missing one, which is a bill that is wrong
 * for a reason nobody can see. The editor states the reach instead:
 * every calendar naming this list is affected.
 */

const RULE_ORDER = [{ month: "asc" as const }, { code: "asc" as const }];

const conflict = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 409, code });

const notFound = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 404, code });

const badRequest = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 400, code });

/** The calendars a change to this list would reach. */
async function calendarsUsing(utilityId: string, touHolidayListId: string) {
  return prisma.touCalendar.findMany({
    where: { utilityId, touHolidayListId },
    select: { id: true, name: true, effectiveDate: true, publishedAt: true },
    orderBy: [{ name: "asc" }, { effectiveDate: "desc" }],
  });
}

function toEngineRules(
  rows: Array<{
    code: string;
    label: string;
    kind: string;
    month: number;
    day: number | null;
    weekday: number | null;
    nth: number | null;
    observance: string;
  }>,
): HolidayRule[] {
  return rows.map((r) => ({
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

/**
 * Each rule with the dates it produces over three years.
 *
 * **The output is the point.** A rule nobody can see the result of is a
 * rule nobody will trust, and the observance rules are where the
 * surprises live: "4 July, nearest weekday" does not tell anybody that
 * 2026 lands on a Saturday and moves the holiday to the Friday — which
 * moves a peak weekday to off-peak.
 */
export function resolvedFor(
  rules: HolidayRule[],
  fromYear: number,
): Array<{
  code: string;
  label: string;
  year: number;
  actual: string;
  observed: string;
  moved: boolean;
  sharesObservedDate: boolean;
}> {
  return resolveHolidays(rules, fromYear, fromYear + 2).map((r) => {
    const actual = r.actual.toISOString().slice(0, 10);
    const observed = r.observed.toISOString().slice(0, 10);
    return {
      code: r.code,
      label: r.label,
      year: r.year,
      actual,
      observed,
      /** The flag that changes a bill: the day treated as the holiday
       *  is not the day the rule names. */
      moved: actual !== observed,
      sharesObservedDate: r.sharesObservedDate,
    };
  });
}

export async function listTouHolidayLists(utilityId: string, query: TouHolidayListQuery) {
  const where = { utilityId };
  const [rows, total] = await Promise.all([
    prisma.touHolidayList.findMany({
      where,
      include: { _count: { select: { rules: true } } },
      orderBy: { [query.sort]: query.order },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.touHolidayList.count({ where }),
  ]);
  /*
   * How many calendars name each list, counted directly rather than
   * through a relation: the key from a calendar to its list is
   * composite and nullable, which Prisma cannot express, so it exists
   * only in the migration and there is no `calendars` to include.
   */
  const usage = await prisma.touCalendar.groupBy({
    by: ["touHolidayListId"],
    where: { utilityId, touHolidayListId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const usedBy = new Map(usage.map((u) => [u.touHolidayListId, u._count._all]));

  return {
    data: rows.map((row) => ({ ...row, calendarCount: usedBy.get(row.id) ?? 0 })),
    // The standard envelope. A hand-rolled `pagination` key here is
    // what made the season-set list read "0 total" above a visible row.
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.ceil(total / query.limit),
    },
  };
}

export async function getTouHolidayList(
  id: string,
  utilityId: string,
  /** Defaults to this year. Named explicitly by anything that
   *  needs a window it can rely on — a test pinning a known
   *  observance, or a screen stepping forward a year. */
  fromYear?: number,
) {
  const row = await prisma.touHolidayList.findFirst({
    where: { id, utilityId },
    include: { rules: { orderBy: RULE_ORDER } },
  });
  if (!row) throw notFound("There is no holiday list with that id.", "HOLIDAY_LIST_NOT_FOUND");

  const from = fromYear ?? new Date().getUTCFullYear();
  return {
    ...row,
    fromYear: from,
    toYear: from + 2,
    resolved: resolvedFor(toEngineRules(row.rules), from),
    /*
     * Who this list reaches. Not decoration: the list is unversioned
     * and shared, so editing it changes every calendar naming it —
     * including published ones, whose own hours are frozen.
     */
    calendars: await calendarsUsing(utilityId, id),
  };
}

export async function createTouHolidayList(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateTouHolidayListInput,
) {
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "TouHolidayList" },
    EVENT_TYPES.TOU_HOLIDAY_LIST_CREATED,
    async (tx) => tx.touHolidayList.create({ data: { utilityId, name: data.name } }),
  );
}

export async function updateTouHolidayList(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateTouHolidayListInput,
) {
  const existing = await prisma.touHolidayList.findFirst({
    where: { id, utilityId },
    select: { id: true, name: true },
  });
  if (!existing) {
    throw notFound("There is no holiday list with that id.", "HOLIDAY_LIST_NOT_FOUND");
  }
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouHolidayList" },
    EVENT_TYPES.TOU_HOLIDAY_LIST_UPDATED,
    existing,
    async (tx) => tx.touHolidayList.update({ where: { id }, data: { name: data.name } }),
  );
}

export async function deleteTouHolidayList(
  id: string,
  user: { utilityId: string; actorId: string; actorName: string },
) {
  const existing = await prisma.touHolidayList.findFirst({
    where: { id, utilityId: user.utilityId },
    select: { id: true, name: true },
  });
  if (!existing) {
    throw notFound("There is no holiday list with that id.", "HOLIDAY_LIST_NOT_FOUND");
  }

  /*
   * `tou_calendar_holiday_list_id_fkey` is RESTRICT, so the database
   * would refuse this with a constraint name. Named here instead,
   * because the operator has to go and change those calendars — and a
   * published one cannot be changed at all, which is worth learning
   * before trying.
   */
  const calendars = await calendarsUsing(user.utilityId, id);
  if (calendars.length > 0) {
    throw conflict(
      `${calendars.map((c) => `"${c.name}"`).join(", ")} ${calendars.length === 1 ? "names" : "name"} this list. Point ${calendars.length === 1 ? "it" : "them"} at another list, or at none, before deleting it.`,
      "HOLIDAY_LIST_IN_USE",
    );
  }

  return auditUpdate(
    {
      utilityId: user.utilityId,
      actorId: user.actorId,
      actorName: user.actorName,
      entityType: "TouHolidayList",
    },
    EVENT_TYPES.TOU_HOLIDAY_LIST_UPDATED,
    existing,
    async (tx) => tx.touHolidayList.delete({ where: { id } }),
  );
}

export async function putTouHolidayRules(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: PutTouHolidayRulesInput,
) {
  const existing = await prisma.touHolidayList.findFirst({
    where: { id, utilityId },
    include: { rules: { orderBy: RULE_ORDER } },
  });
  if (!existing) {
    throw notFound("There is no holiday list with that id.", "HOLIDAY_LIST_NOT_FOUND");
  }

  const codes = data.rules.map((r) => r.code);
  const duplicate = codes.find((c, i) => codes.indexOf(c) !== i);
  if (duplicate) {
    throw badRequest(`"${duplicate}" is listed twice.`, "DUPLICATE_HOLIDAY_CODE");
  }

  /*
   * A fixed date that does not exist — 30 February, 31 September.
   *
   * `resolveHoliday` answers null for one rather than guessing a nearby
   * day, so the rule would save and then contribute no holiday at all:
   * the quiet kind of wrong this subsystem exists to refuse. Checked
   * against a leap year, so 29 February is allowed.
   */
  const unreal = data.rules.filter((rule) => {
    if (rule.kind !== "FIXED") return false;
    const daysInMonth = new Date(Date.UTC(2028, rule.month, 0)).getUTCDate();
    return rule.day > daysInMonth;
  });
  if (unreal.length > 0) {
    throw badRequest(
      `${unreal.map((r) => `"${r.label}"`).join(", ")} ${unreal.length === 1 ? "names a date that does not exist" : "name dates that do not exist"} — check the day against the month.`,
      "HOLIDAY_RULE_UNREAL",
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouHolidayList" },
    EVENT_TYPES.TOU_HOLIDAY_RULES_SET,
    existing.rules.map((r) => ({
      code: r.code,
      label: r.label,
      kind: r.kind,
      month: r.month,
      day: r.day,
      weekday: r.weekday,
      nth: r.nth,
      observance: r.observance,
    })),
    async (tx) => {
      await tx.touHolidayRule.deleteMany({ where: { utilityId, touHolidayListId: id } });
      if (data.rules.length > 0) {
        await tx.touHolidayRule.createMany({
          data: data.rules.map((rule) => ({
            utilityId,
            touHolidayListId: id,
            code: rule.code,
            label: rule.label,
            kind: rule.kind,
            month: rule.month,
            day: rule.kind === "FIXED" ? rule.day : null,
            weekday: rule.kind === "NTH_WEEKDAY" ? rule.weekday : null,
            nth: rule.kind === "NTH_WEEKDAY" ? rule.nth : null,
            observance: rule.observance,
          })),
        });
      }
      // The list is the entity the audit row is about; the empty update
      // also moves `updatedAt`.
      return tx.touHolidayList.update({ where: { id }, data: {} });
    },
  );
}
