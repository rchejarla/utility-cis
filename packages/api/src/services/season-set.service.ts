import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES, seasonSetSortFields } from "@utility-cis/shared";
import type {
  CreateSeasonSetInput,
  PutSeasonsInput,
  SeasonSetQuery,
  UpdateSeasonSetInput,
} from "@utility-cis/shared";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { paginatedTenantList } from "../lib/pagination.js";
import { ordinalDate, seasonCoverage, validateSeasons } from "../lib/rate-engine/seasons.js";

/**
 * Season sets (spec 26, §1 and TOU-SEA-*).
 *
 * A set says which months are summer. It is versioned and published
 * like a rate schedule because a season boundary decides which price
 * applies: moving summer's start from 1 May to 1 June changes what
 * April costs. A published set is immutable.
 *
 * The rule a set has to satisfy — **every day of the year covered
 * exactly once** — belongs to the whole set, so no CHECK constraint can
 * express it and the seasons are saved as one list.
 * `validateSeasons` is that rule, and it is the engine's own, so what
 * this screen accepts is what rating will resolve.
 */

const conflict = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 409, code });

const notFound = (message: string, code: string) =>
  Object.assign(new Error(message), { statusCode: 404, code });

const SEASON_ORDER = { sortOrder: "asc" as const };

function utcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

function assertDraft(row: { name: string; publishedAt: Date | null }): void {
  if (row.publishedAt) {
    throw conflict(
      `"${row.name}" is published, so its seasons cannot change. Create a new set with a later effective date instead — these season codes are what published TOU calendars and rate components are keyed on.`,
      "SEASON_SET_PUBLISHED",
    );
  }
}

async function loadSet(utilityId: string, id: string) {
  const row = await prisma.seasonSet.findFirst({
    where: { id, utilityId },
    include: { seasons: { orderBy: SEASON_ORDER } },
  });
  if (!row) throw notFound("There is no season set with that id.", "SEASON_SET_NOT_FOUND");
  return row;
}

/**
 * Published TOU calendars that name a **different** set.
 *
 * This is the thing a tenant cannot see and would not think to look
 * for. A TOU calendar names its season set explicitly and a published
 * one is immutable, so it keeps the seasons it was built against
 * forever. Non-TOU charges do not: `loadBase` takes whichever published
 * set is in force for the period. So the moment a new set is published,
 * a tenant's water bill follows the new boundaries while their TOU
 * electric bill keeps the old ones — both correct by their own rules,
 * and nothing anywhere says they disagree.
 *
 * Reported rather than refused, because it is a legitimate state: a
 * published calendar *must* keep its own seasons, which is the whole of
 * TOU-CAL-10. What is not legitimate is not knowing.
 */
async function calendarsOnOtherSets(utilityId: string, seasonSetId: string) {
  const calendars = await prisma.touCalendar.findMany({
    where: { utilityId, publishedAt: { not: null }, seasonSetId: { not: seasonSetId } },
    select: {
      id: true,
      name: true,
      effectiveDate: true,
      seasonSet: { select: { id: true, name: true } },
    },
    orderBy: [{ name: "asc" }, { effectiveDate: "desc" }],
  });
  return calendars.map((c) => ({
    id: c.id,
    name: c.name,
    effectiveDate: c.effectiveDate,
    seasonSetId: c.seasonSet.id,
    seasonSetName: c.seasonSet.name,
  }));
}

export async function listSeasonSets(utilityId: string, query: SeasonSetQuery) {
  const where: Record<string, unknown> = { utilityId };
  if (query.status === "draft") where.publishedAt = null;
  if (query.status === "published") where.publishedAt = { not: null };

  /*
   * Through the shared helper, not hand-rolled.
   *
   * This was its own `findMany` + `count` returning
   * `{ data, pagination: { … } }`, and the list shell reads `meta` — so
   * the page printed "0 total season sets" above two of them. The
   * envelope is a contract between every list service and one
   * component, so the service that states it itself is the one that
   * gets it wrong.
   */
  return paginatedTenantList(prisma.seasonSet, where, query, {
    include: { seasons: { orderBy: SEASON_ORDER }, _count: { select: { touCalendars: true } } },
    allowedSorts: seasonSetSortFields,
  });
}

export async function getSeasonSet(id: string, utilityId: string) {
  const row = await loadSet(utilityId, id);
  const definitions = row.seasons.map((s) => ({
    seasonCode: s.seasonCode,
    startMonth: s.startMonth,
    startDay: s.startDay,
    endMonth: s.endMonth,
    endDay: s.endDay,
  }));

  return {
    ...row,
    /*
     * The year bar, drawn from the engine's own coverage rather than
     * recomputed in the browser. 366 entries: the year enumerated is a
     * leap year on purpose, because a set that ends one season on 28
     * February and starts the next on 1 March tiles 365 days and loses
     * a day every fourth year.
     */
    coverage: seasonCoverage(definitions).map((claimedBy, ordinal) => ({
      ...ordinalDate(ordinal),
      claimedBy,
    })),
    /*
     * Both of these are on the GET and not only on the publish
     * response, so the screen can show them *before* the irreversible
     * step rather than reporting them after it.
     */
    validation: validateSeasons(definitions),
    calendarsOnOtherSets: await calendarsOnOtherSets(utilityId, id),
  };
}

export async function createSeasonSet(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateSeasonSetInput,
) {
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "SeasonSet" },
    EVENT_TYPES.SEASON_SET_CREATED,
    async (tx) =>
      tx.seasonSet.create({
        data: {
          utilityId,
          name: data.name,
          effectiveDate: utcDate(data.effectiveDate),
          spanRule: data.spanRule,
        },
      }),
  );
}

export async function updateSeasonSet(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateSeasonSetInput,
) {
  const existing = await prisma.seasonSet.findFirst({
    where: { id, utilityId },
    select: { id: true, name: true, publishedAt: true, effectiveDate: true, spanRule: true },
  });
  if (!existing) throw notFound("There is no season set with that id.", "SEASON_SET_NOT_FOUND");
  assertDraft(existing);

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "SeasonSet" },
    EVENT_TYPES.SEASON_SET_UPDATED,
    existing,
    async (tx) =>
      tx.seasonSet.update({
        where: { id },
        data: {
          name: data.name,
          effectiveDate: data.effectiveDate ? utcDate(data.effectiveDate) : undefined,
          spanRule: data.spanRule,
        },
      }),
  );
}

export async function deleteSeasonSet(
  id: string,
  user: { utilityId: string; actorId: string; actorName: string },
) {
  const existing = await prisma.seasonSet.findFirst({
    where: { id, utilityId: user.utilityId },
    select: { id: true, name: true, publishedAt: true },
  });
  if (!existing) throw notFound("There is no season set with that id.", "SEASON_SET_NOT_FOUND");
  assertDraft(existing);

  /*
   * `tou_calendar_season_set_id_fkey` is RESTRICT, so the database
   * would refuse this with a constraint name. Named here instead,
   * because the operator has to go and change those calendars.
   */
  const calendars = await prisma.touCalendar.findMany({
    where: { utilityId: user.utilityId, seasonSetId: id },
    select: { name: true, effectiveDate: true },
    take: 5,
  });
  if (calendars.length > 0) {
    throw conflict(
      `${calendars.map((c) => `"${c.name}"`).join(", ")} ${calendars.length === 1 ? "is keyed" : "are keyed"} on this set's season codes. Point ${calendars.length === 1 ? "it" : "them"} at another set before deleting it.`,
      "SEASON_SET_IN_USE",
    );
  }

  return auditUpdate(
    {
      utilityId: user.utilityId,
      actorId: user.actorId,
      actorName: user.actorName,
      entityType: "SeasonSet",
    },
    EVENT_TYPES.SEASON_SET_UPDATED,
    existing,
    async (tx) => tx.seasonSet.delete({ where: { id } }),
  );
}

export async function putSeasons(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: PutSeasonsInput,
) {
  const row = await loadSet(utilityId, id);
  assertDraft(row);

  const codes = data.seasons.map((s) => s.seasonCode);
  const duplicate = codes.find((c, i) => codes.indexOf(c) !== i);
  if (duplicate) {
    throw Object.assign(new Error(`"${duplicate}" is listed twice.`), {
      statusCode: 400,
      code: "DUPLICATE_SEASON_CODE",
    });
  }

  /*
   * A code a TOU calendar's hours are keyed on cannot be renamed away.
   * This set is a draft, so a calendar referencing it is a draft too —
   * but its spans name `season_code` as a string, with no foreign key
   * to catch it, so renaming would leave them pointing at nothing and
   * `resolvePeak` answering "no period covers 17:15" on every bill.
   */
  const removed = row.seasons.map((s) => s.seasonCode).filter((c) => !codes.includes(c));
  if (removed.length > 0) {
    const orphaned = await prisma.touSlot.findMany({
      where: { utilityId, seasonCode: { in: removed }, calendar: { seasonSetId: id } },
      select: { seasonCode: true, calendar: { select: { name: true } } },
      take: 20,
    });
    if (orphaned.length > 0) {
      const names = [...new Set(orphaned.map((o) => `"${o.calendar.name}"`))];
      throw conflict(
        `${removed.map((c) => `"${c}"`).join(", ")} ${removed.length === 1 ? "is" : "are"} used by hours in ${names.join(", ")}. A span names its season as a code with no key to protect it, so removing ${removed.length === 1 ? "it" : "them"} would leave those hours pricing nothing. Clear those hours first.`,
        "SEASON_CODE_IN_USE",
      );
    }
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "SeasonSet" },
    EVENT_TYPES.SEASON_SET_SEASONS_SET,
    row.seasons.map((s) => ({
      seasonCode: s.seasonCode,
      label: s.label,
      startMonth: s.startMonth,
      startDay: s.startDay,
      endMonth: s.endMonth,
      endDay: s.endDay,
    })),
    async (tx) => {
      await tx.season.deleteMany({ where: { utilityId, seasonSetId: id } });
      await tx.season.createMany({
        data: data.seasons.map((season, index) => ({
          utilityId,
          seasonSetId: id,
          seasonCode: season.seasonCode,
          label: season.label,
          startMonth: season.startMonth,
          startDay: season.startDay,
          endMonth: season.endMonth,
          endDay: season.endDay,
          sortOrder: index,
        })),
      });
      // The set is the entity the audit row is about; the empty update
      // also moves `updatedAt`.
      return tx.seasonSet.update({ where: { id }, data: {} });
    },
  );
}

/**
 * Publish, which freezes the boundaries.
 *
 * Validation runs here and not at every save, because a half-written
 * set is a normal state of work: a tenant adds summer before they add
 * winter, and a set with one season covers 120 days of the year.
 * Publishing is the commitment.
 *
 * The response carries `calendarsOnOtherSets` — the divergence a tenant
 * has no way to see. See the note on that function.
 */
export async function publishSeasonSet(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
) {
  const row = await loadSet(utilityId, id);

  if (row.publishedAt) {
    throw conflict(`"${row.name}" is already published.`, "ALREADY_PUBLISHED");
  }

  const validation = validateSeasons(
    row.seasons.map((s) => ({
      seasonCode: s.seasonCode,
      startMonth: s.startMonth,
      startDay: s.startDay,
      endMonth: s.endMonth,
      endDay: s.endDay,
    })),
  );
  if (!validation.ok) {
    throw Object.assign(
      new Error(
        `"${row.name}" does not yet cover every day of the year exactly once, so a bill could fall in no season or in two:\n` +
          validation.problems.map((p) => `  • ${p}`).join("\n"),
      ),
      { statusCode: 409, code: "SEASON_SET_INVALID", problems: validation.problems },
    );
  }

  const diverging = await calendarsOnOtherSets(utilityId, id);

  const published = await auditUpdate(
    { utilityId, actorId, actorName, entityType: "SeasonSet" },
    EVENT_TYPES.SEASON_SET_PUBLISHED,
    { publishedAt: null },
    async (tx) => tx.seasonSet.update({ where: { id }, data: { publishedAt: new Date() } }),
  );

  return { ...published, calendarsOnOtherSets: diverging };
}
