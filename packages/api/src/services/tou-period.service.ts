import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES, touPeriodSortFields } from "@utility-cis/shared";
import type {
  CreateTouPeriodInput,
  TouPeriodQuery,
  UpdateTouPeriodInput,
} from "@utility-cis/shared";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { paginatedTenantList } from "../lib/pagination.js";

/**
 * A tenant's TOU periods — the price tiers its tariffs charge at
 * (spec 26, TOU-CAL-1).
 *
 * Defined once per tenant since 2026-11-04. They were declared on each
 * calendar, which stored one fact twice: every `meter_register`,
 * `meter_read` and rate component already carried the code as a plain
 * string, and `tou_slot` was the only keyed reference in the system.
 *
 * **A calendar's hours hold the code, not a key to this row.** That is
 * what makes a tenant-level list safe beside immutable published
 * calendars: the hours literally say `peak`, so editing a label here
 * changes what a screen prints and never what a bill meant. See the
 * `tenant_peak_codes` migration.
 */

const conflict = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 409, code });

const notFound = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 404, code });

export async function listTouPeriods(utilityId: string, query: TouPeriodQuery) {
  const page = await paginatedTenantList<{
    id: string;
    peakCode: string;
    label: string;
    sortOrder: number;
  }>(prisma.touPeriod, { utilityId }, query, { allowedSorts: touPeriodSortFields });

  /*
   * How many calendars price hours at each code, and how many tariffs
   * name it. Both answer the question somebody has before touching
   * one: a period nothing uses can go, and one that several calendars
   * use cannot.
   */
  const usage = await prisma.touSlot.groupBy({
    by: ["peakCode"],
    where: { utilityId },
    _count: { _all: true },
  });
  const calendars = await prisma.touSlot.findMany({
    where: { utilityId },
    select: { peakCode: true, touCalendarId: true },
    distinct: ["peakCode", "touCalendarId"],
  });

  const spans = new Map(usage.map((u) => [u.peakCode, u._count._all]));
  const calendarCount = new Map<string, number>();
  for (const row of calendars) {
    calendarCount.set(row.peakCode, (calendarCount.get(row.peakCode) ?? 0) + 1);
  }

  return {
    ...page,
    data: page.data.map((row) => ({
      ...row,
      spanCount: spans.get(row.peakCode) ?? 0,
      calendarCount: calendarCount.get(row.peakCode) ?? 0,
    })),
  };
}

export async function getTouPeriod(id: string, utilityId: string) {
  const row = await prisma.touPeriod.findFirst({ where: { id, utilityId } });
  if (!row) throw notFound("There is no TOU period with that id.", "TOU_PERIOD_NOT_FOUND");
  return row;
}

export async function createTouPeriod(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateTouPeriodInput,
) {
  const existing = await prisma.touPeriod.findFirst({
    where: { utilityId, peakCode: data.peakCode },
    select: { label: true },
  });
  if (existing) {
    throw conflict(
      `"${data.peakCode}" is already a period of this utility, called "${existing.label}".`,
      "DUPLICATE_PEAK_CODE",
    );
  }

  /*
   * Appended, not inserted at zero: the order decides the legend and
   * the strip's colours, and a new tier is usually a cheaper one added
   * at the end. It is editable afterwards.
   */
  const last = await prisma.touPeriod.findFirst({
    where: { utilityId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "TouPeriod" },
    EVENT_TYPES.TOU_PERIOD_CREATED,
    async (tx) =>
      tx.touPeriod.create({
        data: {
          utilityId,
          peakCode: data.peakCode,
          label: data.label,
          sortOrder: data.sortOrder ?? (last ? last.sortOrder + 1 : 0),
        },
      }),
  );
}

/**
 * The label and the order. Not the code — see `updateTouPeriodSchema`:
 * it is the key every calendar's hours reference and it has been copied
 * into rate components and meter registers that know nothing about this
 * row.
 */
export async function updateTouPeriod(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateTouPeriodInput,
) {
  const existing = await prisma.touPeriod.findFirst({
    where: { id, utilityId },
    select: { id: true, peakCode: true, label: true, sortOrder: true },
  });
  if (!existing) throw notFound("There is no TOU period with that id.", "TOU_PERIOD_NOT_FOUND");

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "TouPeriod" },
    EVENT_TYPES.TOU_PERIOD_UPDATED,
    existing,
    async (tx) =>
      tx.touPeriod.update({
        where: { id },
        data: { label: data.label, sortOrder: data.sortOrder },
      }),
  );
}

export async function deleteTouPeriod(
  id: string,
  user: { utilityId: string; actorId: string; actorName: string },
) {
  const existing = await prisma.touPeriod.findFirst({
    where: { id, utilityId: user.utilityId },
    select: { id: true, peakCode: true, label: true, sortOrder: true },
  });
  if (!existing) throw notFound("There is no TOU period with that id.", "TOU_PERIOD_NOT_FOUND");

  /*
   * `tou_slot_peak_code_fkey` is RESTRICT, so the database would refuse
   * this with a constraint name. Named here instead, with the calendars
   * to go and look at — and *published* ones cannot be changed at all,
   * which is worth learning before trying.
   */
  const using = await prisma.touSlot.findMany({
    where: { utilityId: user.utilityId, peakCode: existing.peakCode },
    select: { calendar: { select: { name: true, publishedAt: true } } },
    distinct: ["touCalendarId"],
  });
  if (using.length > 0) {
    const names = [...new Set(using.map((s) => `"${s.calendar.name}"`))].join(", ");
    const anyPublished = using.some((s) => s.calendar.publishedAt !== null);
    throw conflict(
      `${names} ${using.length === 1 ? "prices hours" : "price hours"} at "${existing.label}". Reassign those hours first` +
        (anyPublished
          ? " — and a published calendar cannot be changed, so this code stays as long as it is in force."
          : "."),
      "TOU_PERIOD_IN_USE",
    );
  }

  return auditUpdate(
    {
      utilityId: user.utilityId,
      actorId: user.actorId,
      actorName: user.actorName,
      entityType: "TouPeriod",
    },
    EVENT_TYPES.TOU_PERIOD_DELETED,
    existing,
    async (tx) => tx.touPeriod.delete({ where: { id } }),
  );
}
