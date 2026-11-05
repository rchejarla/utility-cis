import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { cacheDel } from "../lib/cache-redis.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateRateScheduleInput,
  RateScheduleQuery,
  ReviseRateScheduleInput,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { validateTouPricing } from "../lib/rate-engine/tou-calendar.js";

/**
 * Recursive deep-walk that rewrites every `component_id: <uuid>` key it
 * finds, using the supplied old→new id map. Used when copying components
 * to a new revision: a `pricing.percent_of.selector` (or nested
 * `and`/`or` selector) may reference a sibling component by id, and
 * those references need to point at the freshly-minted ids in the new
 * schedule. References that aren't in the map (e.g., to an expired
 * component that wasn't copied) are left untouched — the rate engine
 * will surface the dangling reference at evaluation time, which matches
 * what would happen anyway.
 */
function remapComponentIds(value: unknown, idMap: Map<string, string>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => remapComponentIds(v, idMap));
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === "component_id" && typeof val === "string") {
      result[key] = idMap.get(val) ?? val;
    } else {
      result[key] = remapComponentIds(val, idMap);
    }
  }
  return result;
}

const fullInclude = {
  commodity: true,
  /*
   * How many charges the schedule carries, for the list's Charges
   * column. `publishRateSchedule` requires no components, so a published
   * schedule with none is reachable and prices nothing — the count is
   * what makes that visible on the row instead of only after opening it.
   */
  _count: { select: { components: true } },
};

export async function listRateSchedules(utilityId: string, query: RateScheduleQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.commodityId) where.commodityId = query.commodityId;

  /*
   * The same three states the badge derives, in the same order:
   * supersession first, because a replaced version still carries its
   * `publishedAt` and would otherwise answer to "published". Mutually
   * exclusive, so the filter and the Status column cannot disagree about
   * a row.
   */
  if (query.status === "draft") {
    where.publishedAt = null;
    where.supersededById = null;
  } else if (query.status === "published") {
    where.publishedAt = { not: null };
    where.supersededById = null;
  } else if (query.status === "superseded") {
    where.supersededById = { not: null };
  }

  return paginatedTenantList(prisma.rateSchedule, where, query, { include: fullInclude });
}

export async function getRateSchedule(id: string, utilityId: string) {
  const schedule = await prisma.rateSchedule.findUniqueOrThrow({
    where: { id, utilityId },
    include: {
      commodity: true,
      supersedes: true,
      supersededBy: true,
    },
  });

  // Full version chain — every schedule that shares this (utilityId, code)
  // ordered by version asc. Lets the detail page render a single timeline
  // (v1 → v2 → … → vN) instead of only the immediate predecessor, so an
  // operator can jump to any prior version in one click rather than
  // walking the supersedes chain hop-by-hop.
  const chain = await prisma.rateSchedule.findMany({
    where: { utilityId, code: schedule.code },
    select: {
      id: true,
      version: true,
      effectiveDate: true,
      expirationDate: true,
      publishedAt: true,
      supersededById: true,
    },
    orderBy: { version: "asc" },
  });

  /*
   * The named calendar, fetched rather than included: `touCalendarId`
   * is a bare scalar column in `schema.prisma` with the key itself in
   * the `rate_schedule_tou_calendar` migration, because Prisma cannot
   * express an optional composite relation whose `utility_id` is not
   * optional. So there is no relation to include — and the detail page
   * needs the name, the effective date and whether it is published,
   * which are what the publish gate will judge it on.
   */
  const touCalendar = schedule.touCalendarId
    ? await prisma.touCalendar.findFirst({
        where: { id: schedule.touCalendarId, utilityId },
        select: { id: true, name: true, effectiveDate: true, publishedAt: true },
      })
    : null;

  return { ...schedule, chain, touCalendar };
}

/**
 * The calendar a schedule names has to be one of this tenant's.
 *
 * `rate_schedule_tou_calendar` is a tenant-scoped composite key, so
 * another tenant's id is refused by the database anyway — as a P2003
 * naming a constraint, which reaches the author as a 500. This is the
 * same refusal in words, and it also catches the calendar deleted
 * while the form was open.
 *
 * It does **not** require a published calendar. TOU-CAL-5 binds the
 * published *schedule*, and the two are usually authored together, so
 * that rule stays where it can be checked once and finally:
 * `publishRateSchedule`.
 */
async function assertCalendarAssignable(utilityId: string, touCalendarId: string) {
  const calendar = await prisma.touCalendar.findFirst({
    where: { id: touCalendarId, utilityId },
    select: { id: true },
  });
  if (!calendar) {
    throw Object.assign(
      new Error("That TOU calendar does not exist in this utility."),
      { statusCode: 400, code: "TOU_CALENDAR_UNKNOWN" },
    );
  }
}

export async function createRateSchedule(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateRateScheduleInput
) {
  if (data.touCalendarId) await assertCalendarAssignable(utilityId, data.touCalendarId);

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "RateSchedule" },
    EVENT_TYPES.RATE_SCHEDULE_CREATED,
    async (tx) => {
      const schedule = await tx.rateSchedule.create({
        data: {
          utilityId,
          name: data.name,
          code: data.code,
          commodityId: data.commodityId,
          effectiveDate: new Date(data.effectiveDate),
          expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
          description: data.description,
          regulatoryRef: data.regulatoryRef,
          touCalendarId: data.touCalendarId ?? null,
          version: 1,
        },
        include: fullInclude,
      });
      await cacheDel(`rate-schedule:${utilityId}:${data.code}`);
      return schedule;
    }
  );
}

export async function reviseRateSchedule(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: ReviseRateScheduleInput
) {
  const predecessor = await prisma.rateSchedule.findUniqueOrThrow({ where: { id, utilityId } });

  if (data.touCalendarId) await assertCalendarAssignable(utilityId, data.touCalendarId);

  const newEffectiveDate = new Date(data.effectiveDate);
  if (newEffectiveDate <= predecessor.effectiveDate) {
    throw Object.assign(
      new Error("Revision effective date must be after the predecessor's"),
      { statusCode: 400, code: "REVISE_DATE_NOT_AFTER_PREDECESSOR" },
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "RateSchedule" },
    EVENT_TYPES.RATE_SCHEDULE_REVISED,
    predecessor,
    async (tx) => {
      const newSchedule = await tx.rateSchedule.create({
        data: {
          utilityId,
          name: predecessor.name,
          code: predecessor.code,
          commodityId: predecessor.commodityId,
          effectiveDate: newEffectiveDate,
          expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
          description: data.description ?? predecessor.description,
          regulatoryRef: data.regulatoryRef ?? predecessor.regulatoryRef,
          /*
           * Carried forward, like everything else a revision does not
           * change — but `null` has to mean "clear it", so this reads
           * `undefined` rather than falsy. A revision that only
           * reprices keeps the hours it was approved against; one
           * that follows new hours names the new calendar version,
           * which is the usual reason a TOU tariff is revised.
           */
          touCalendarId:
            data.touCalendarId === undefined ? predecessor.touCalendarId : data.touCalendarId,
          version: predecessor.version + 1,
          supersedesId: id,
          // publishedAt left NULL — the new revision is a draft until
          // the operator explicitly publishes it. This is the whole
          // point of the publish/draft state: backdating workflows are
          // safe because the schedule is editable until publish.
        },
        include: fullInclude,
      });
      // Set the predecessor's expiration AND its supersededById so the
      // editability gate (publishedAt IS NULL AND supersededById IS NULL)
      // becomes a single column read instead of an inverse-relation count.
      await tx.rateSchedule.update({
        where: { id },
        data: {
          expirationDate: newEffectiveDate,
          supersededById: newSchedule.id,
        },
      });

      // Carry forward every still-active component (expirationDate IS
      // NULL) onto the new revision. Pre-generate ids so we can rewrite
      // intra-schedule `component_id` references in pricing selectors
      // (percent_of / floor / and / or) to point at the new ids before
      // insert. Components with an explicit expirationDate are treated
      // as "retired in the predecessor" and not carried forward.
      const activeComponents = await tx.rateComponent.findMany({
        where: { rateScheduleId: id, utilityId, expirationDate: null },
        orderBy: { sortOrder: "asc" },
      });
      if (activeComponents.length > 0) {
        const idMap = new Map<string, string>();
        for (const c of activeComponents) idMap.set(c.id, randomUUID());
        await tx.rateComponent.createMany({
          data: activeComponents.map((c) => ({
            id: idMap.get(c.id)!,
            utilityId,
            rateScheduleId: newSchedule.id,
            kindCode: c.kindCode,
            label: c.label,
            predicate: c.predicate as object,
            quantitySource: c.quantitySource as object,
            pricing: remapComponentIds(c.pricing, idMap) as object,
            sortOrder: c.sortOrder,
            effectiveDate: newEffectiveDate,
            expirationDate: null,
          })),
        });
      }

      await cacheDel(`rate-schedule:${utilityId}:${predecessor.code}`);
      return newSchedule;
    }
  );
}

/**
 * Name (or clear) the TOU calendar of a schedule that already exists
 * (spec 26, TOU-UI-3).
 *
 * Its own endpoint because a rate schedule has no PATCH: it is
 * immutable by design, and changes fork a new version through
 * `revise`. This one field is the exception while the schedule is
 * still a draft, so that an author can add the calendar after the
 * charges — the order `assertTouPricingComplete` explicitly allows.
 * Once published the hours are exactly what must not move, which is
 * the same editability rule the components obey.
 */
export async function assignTouCalendar(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  touCalendarId: string | null,
) {
  const before = await prisma.rateSchedule.findUniqueOrThrow({ where: { id, utilityId } });

  if (before.publishedAt !== null) {
    throw Object.assign(
      new Error(
        "This schedule is published — its TOU calendar is part of what was approved and cannot " +
          "change. Revise the schedule and point the new version at the calendar you want.",
      ),
      { statusCode: 409, code: "SCHEDULE_NOT_EDITABLE" },
    );
  }
  if (before.supersededById !== null) {
    throw Object.assign(
      new Error("This schedule has been superseded — change the newer version instead."),
      { statusCode: 409, code: "SCHEDULE_NOT_EDITABLE" },
    );
  }

  if (touCalendarId) await assertCalendarAssignable(utilityId, touCalendarId);

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "RateSchedule" },
    EVENT_TYPES.RATE_SCHEDULE_TOU_CALENDAR_SET,
    before,
    async (tx) => {
      const updated = await tx.rateSchedule.update({
        where: { id, utilityId },
        data: { touCalendarId },
        include: fullInclude,
      });
      await cacheDel(`rate-schedule:${utilityId}:${before.code}`);
      return updated;
    },
  );
}

export async function publishRateSchedule(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
) {
  const before = await prisma.rateSchedule.findUniqueOrThrow({
    where: { id, utilityId },
  });

  if (before.publishedAt !== null) {
    throw Object.assign(
      new Error("Schedule is already published"),
      { statusCode: 409, code: "ALREADY_PUBLISHED" },
    );
  }
  if (before.supersededById !== null) {
    throw Object.assign(
      new Error("Cannot publish a superseded schedule"),
      { statusCode: 409, code: "SUPERSEDED" },
    );
  }

  await assertTouPricingComplete(utilityId, before.id, before.touCalendarId);

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "RateSchedule" },
    EVENT_TYPES.RATE_SCHEDULE_PUBLISHED,
    before,
    async (tx) => {
      const updated = await tx.rateSchedule.update({
        where: { id, utilityId },
        data: { publishedAt: new Date() },
        include: fullInclude,
      });
      await cacheDel(`rate-schedule:${utilityId}:${before.code}`);
      return updated;
    },
  );
}

/**
 * Publishing a TOU schedule: its periods and its calendar's must agree
 * (spec 26, TOU-UI-3 and TOU-CAL-5).
 *
 * Checked at publish rather than at save, because a draft is allowed to
 * be half-written — the author adds the calendar, then the components,
 * in whichever order they like. Publishing is the commitment, and
 * TOU-CAL-5 is explicit that only a published calendar may be
 * referenced by a published schedule.
 *
 * The expensive failure this exists for is the quiet one: a calendar
 * period no component prices is energy the customer uses and is never
 * charged for, and nothing raises — the bucket is simply never asked
 * about and the bill looks complete.
 */
async function assertTouPricingComplete(
  utilityId: string,
  scheduleId: string,
  touCalendarId: string | null,
): Promise<void> {
  const components = await prisma.rateComponent.findMany({
    where: { rateScheduleId: scheduleId, utilityId },
    select: { quantitySource: true },
  });

  const pricedCodes = components.flatMap((c) => {
    const qs = c.quantitySource as Record<string, unknown> | null;
    if (!qs || typeof qs !== "object" || qs.base !== "tou_period") return [];
    return typeof qs.peak_code === "string" && qs.peak_code.length > 0 ? [qs.peak_code] : [];
  });

  if (pricedCodes.length === 0 && touCalendarId === null) return; // Not a TOU tariff.

  if (touCalendarId === null) {
    throw Object.assign(
      new Error(
        "This schedule prices TOU periods but names no TOU calendar, so there is nothing to " +
          "say which hours those periods cover. Choose a published calendar before publishing.",
      ),
      { statusCode: 409, code: "TOU_CALENDAR_REQUIRED" },
    );
  }

  /*
   * The codes the calendar's *hours* use, not a list it declares.
   * Peak codes are the tenant's since 2026-11-04, so a calendar's
   * periods are the distinct codes its slots carry — and that is the
   * right set to check a tariff against: a code the tenant has defined
   * but this calendar never assigns is not energy this schedule has to
   * price.
   */
  const calendar = await prisma.touCalendar.findFirst({
    where: { id: touCalendarId, utilityId },
    select: {
      name: true,
      publishedAt: true,
      slots: { select: { peakCode: true }, distinct: ["peakCode"] },
    },
  });
  if (!calendar) {
    throw Object.assign(new Error("The schedule's TOU calendar no longer exists."), {
      statusCode: 409,
      code: "TOU_CALENDAR_MISSING",
    });
  }

  // TOU-CAL-5: a published schedule cannot reference a draft calendar,
  // because a draft is still editable and the schedule would stop
  // meaning what it meant when it was approved.
  if (calendar.publishedAt === null) {
    throw Object.assign(
      new Error(
        `TOU calendar "${calendar.name}" is still a draft. Publish the calendar first — a ` +
          "published schedule cannot reference one whose hours can still change.",
      ),
      { statusCode: 409, code: "TOU_CALENDAR_NOT_PUBLISHED" },
    );
  }

  const result = validateTouPricing(
    pricedCodes,
    calendar.slots.map((s) => s.peakCode),
  );
  if (!result.ok) {
    throw Object.assign(new Error(result.problems.join(" ")), {
      statusCode: 409,
      code: "TOU_PRICING_INCOMPLETE",
      problems: result.problems,
    });
  }
}
