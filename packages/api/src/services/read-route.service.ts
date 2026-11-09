import type {
  ReadRoute,
  ReadRouteInput,
  ReadRouteQuery,
  ReadRouteUpdate,
  ReadRouteSummary,
  ReadRouteStop,
  ReadRouteStopInput,
  UnsequencedPremiseQuery,
  PremiseSummary,
  PaginatedResponse,
} from "@utility-cis/shared";
import { EVENT_TYPES } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { auditCreate, auditUpdate, writeAuditRow } from "../lib/audit-wrap.js";
import { paginatedResponse } from "../lib/pagination.js";
import type { ImportTx } from "../imports/types.js";

/**
 * Read routes: the named walks a meter reader makes, and the rows that
 * let a vendor's route code on an imported read point at something.
 *
 * The route row is maintained first, then its stops (`addStop` and
 * below), which are premises in a walking order.
 *
 * **A vendor's code becomes a row, not free text** (`upsertExternalRoute`):
 * an imported read names a route in the vendor's own vocabulary, and
 * keeping that as a string on the read would leave nothing to count,
 * filter or later claim as local. The row is created with `origin =
 * EXTERNAL` and no stops, and is left alone on every later import.
 */

type RouteRow = {
  id: string;
  code: string;
  name: string;
  billingCycleId: string;
  origin: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toRoute(row: RouteRow): ReadRoute {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    billingCycleId: row.billingCycleId,
    origin: row.origin as ReadRoute["origin"],
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function httpError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/** The unique key on (utility_id, code) is the arbiter; this only names the refusal. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

async function requireCycle(utilityId: string, billingCycleId: string): Promise<void> {
  const cycle = await prisma.billingCycle.findFirst({
    where: { id: billingCycleId, utilityId },
    select: { id: true },
  });
  if (!cycle) {
    throw httpError(404, "CYCLE_NOT_FOUND", `Billing cycle ${billingCycleId} not found`);
  }
}

export async function createReadRoute(
  utilityId: string,
  actor: { id: string; name: string },
  input: ReadRouteInput,
): Promise<ReadRoute> {
  await requireCycle(utilityId, input.billingCycleId);
  try {
    const row = await auditCreate(
      { utilityId, actorId: actor.id, actorName: actor.name, entityType: "ReadRoute" },
      EVENT_TYPES.READ_ROUTE_CREATED,
      (tx) =>
        tx.readRoute.create({
          data: {
            utilityId,
            code: input.code,
            name: input.name,
            billingCycleId: input.billingCycleId,
            origin: input.origin,
            active: input.active,
          },
        }),
    );
    return toRoute(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw httpError(409, "ROUTE_CODE_TAKEN", `A route with code ${input.code} already exists`);
    }
    throw err;
  }
}

export async function listReadRoutes(
  utilityId: string,
  query: ReadRouteQuery,
): Promise<{ data: ReadRouteSummary[]; meta: PaginatedResponse<ReadRouteSummary>["meta"] }> {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const where = {
    utilityId,
    ...(query.billingCycleId ? { billingCycleId: query.billingCycleId } : {}),
    ...(query.origin ? { origin: query.origin } : {}),
    ...(query.active !== undefined ? { active: query.active } : {}),
    ...(query.search
      ? {
          OR: [
            { code: { contains: query.search, mode: "insensitive" as const } },
            { name: { contains: query.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.readRoute.findMany({
      where,
      orderBy: { code: "asc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        billingCycle: { select: { cycleCode: true } },
        _count: { select: { stops: true } },
      },
    }),
    prisma.readRoute.count({ where }),
  ]);
  const data = rows.map((r) => ({
    ...toRoute(r),
    stopCount: r._count.stops,
    cycleCode: r.billingCycle.cycleCode,
  }));
  return paginatedResponse(data, total, { page, limit, sort: "code", order: "asc" });
}

export async function updateReadRoute(
  utilityId: string,
  actor: { id: string; name: string },
  id: string,
  input: ReadRouteUpdate,
): Promise<ReadRoute> {
  const before = await prisma.readRoute.findFirst({ where: { id, utilityId } });
  if (!before) throw httpError(404, "ROUTE_NOT_FOUND", `Read route ${id} not found`);
  if (input.billingCycleId && input.billingCycleId !== before.billingCycleId) {
    await requireCycle(utilityId, input.billingCycleId);
  }
  try {
    const row = await auditUpdate(
      { utilityId, actorId: actor.id, actorName: actor.name, entityType: "ReadRoute" },
      EVENT_TYPES.READ_ROUTE_UPDATED,
      before,
      (tx) =>
        tx.readRoute.update({
          where: { id },
          data: {
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.billingCycleId !== undefined ? { billingCycleId: input.billingCycleId } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
        }),
    );
    return toRoute(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw httpError(409, "ROUTE_CODE_TAKEN", `A route with code ${input.code} already exists`);
    }
    throw err;
  }
}

/**
 * The route a vendor's code names, created as EXTERNAL if it is new.
 *
 * Runs inside the caller's transaction (an import row's), so a row that
 * later fails takes its route with it. Two things would otherwise
 * poison that transaction, and both are headed off here:
 *
 * - **A unique violation** from two rows naming the same new code. The
 *   insert is `ON CONFLICT ... DO UPDATE SET code = code`, a no-op write
 *   whose purpose is to make the statement wait for a concurrent
 *   uncommitted insert and return that row. `DO NOTHING` would return
 *   nothing, and a follow-up select could not see the other row either.
 * - **A foreign-key violation** from a cycle that is missing or another
 *   tenant's, so the cycle is looked up through `tx` first.
 *
 * **A LOCAL route is refused** (409 `ROUTE_IS_LOCAL`): a vendor's file
 * must not write reads onto an itinerary the utility maintains by hand.
 * Guarded here rather than only upstream so no caller can forget it.
 * An existing EXTERNAL route is returned as it is. Only a creation is
 * audited.
 */
export async function upsertExternalRoute(
  tx: ImportTx,
  utilityId: string,
  code: string,
  billingCycleId: string,
): Promise<string> {
  const cycle = await tx.billingCycle.findFirst({
    where: { id: billingCycleId, utilityId },
    select: { id: true },
  });
  if (!cycle) {
    throw httpError(404, "CYCLE_NOT_FOUND", `Billing cycle ${billingCycleId} not found`);
  }
  const rows = await tx.$queryRaw<{ id: string; origin: string; inserted: boolean }[]>`
    INSERT INTO read_route (utility_id, code, name, billing_cycle_id, origin)
    VALUES (${utilityId}::uuid, ${code}, ${code}, ${billingCycleId}::uuid, 'EXTERNAL')
    ON CONFLICT (utility_id, code) DO UPDATE SET code = "read_route"."code"
    RETURNING id, origin, (xmax = 0) AS inserted`;
  const row = rows[0]!;
  if (row.origin === "LOCAL") {
    throw httpError(409, "ROUTE_IS_LOCAL", `Route ${code} is maintained locally`);
  }
  if (row.inserted) {
    await writeAuditRow(
      tx,
      { utilityId, actorId: null, actorName: "Import", entityType: "ReadRoute" },
      EVENT_TYPES.READ_ROUTE_CREATED,
      row.id,
      null,
      { id: row.id, code, billingCycleId, origin: "EXTERNAL" },
    );
  }
  return row.id;
}

/**
 * Stops: a premise on a route, in walking order (design §5.1).
 *
 * **Sequences are gapped integers, step 100.** An append is `max + 100`;
 * an insert between `a` and `b` takes `floor((a + b) / 2)`, so placing a
 * stop writes one row and leaves every neighbour where it was. The
 * alternative, shifting everything after the insert up by one, rewrites
 * half a route to add one address. When no integer fits between two
 * neighbours the insert is refused (409 `SEQUENCE_FULL`) and the caller
 * resequences the route, which is a separate operation, not something an
 * insert does as a side effect.
 *
 * **A stop is a premise, not a meter**, and a route's stops are its
 * current state, not an effective-dated history: no sequence number
 * survives being edited, so there is nothing to version.
 *
 * Both writes lock the route row (`FOR UPDATE`) before reading the
 * sequences. Without it two concurrent appends both read the same max,
 * pick the same next sequence and one dies on the unique key with a
 * constraint error that says nothing a caller could act on. The lock
 * also makes the LOCAL check current for the length of the write.
 */
const SEQUENCE_STEP = 100;

type StopRow = {
  id: string;
  readRouteId: string;
  premiseId: string;
  sequence: number;
  createdAt: Date;
};

function toStop(row: StopRow): ReadRouteStop {
  return {
    id: row.id,
    readRouteId: row.readRouteId,
    premiseId: row.premiseId,
    sequence: row.sequence,
    createdAt: row.createdAt.toISOString(),
  };
}

type RouteTx = Pick<typeof prisma, "$queryRaw">;

function requireLocal(origin: string, routeId: string): void {
  if (origin !== "LOCAL") {
    throw httpError(
      400,
      "ROUTE_IS_EXTERNAL",
      `Route ${routeId} belongs to a vendor's reading system; its stops are not kept here`,
    );
  }
}

/** Lock the tenant's route and refuse it unless it is a LOCAL one. Returns nothing: the lock is the point. */
async function lockLocalRoute(tx: RouteTx, utilityId: string, routeId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ origin: string }[]>`
    SELECT origin FROM read_route
    WHERE id = ${routeId}::uuid AND utility_id = ${utilityId}::uuid
    FOR UPDATE`;
  if (rows.length === 0) {
    throw httpError(404, "ROUTE_NOT_FOUND", `Read route ${routeId} not found`);
  }
  requireLocal(rows[0]!.origin, routeId);
}

export async function addStop(
  utilityId: string,
  actor: { id: string; name: string },
  routeId: string,
  input: ReadRouteStopInput,
): Promise<ReadRouteStop> {
  try {
    const row = await auditCreate(
      { utilityId, actorId: actor.id, actorName: actor.name, entityType: "ReadRouteStop" },
      EVENT_TYPES.READ_ROUTE_STOP_CREATED,
      async (tx) => {
        await lockLocalRoute(tx, utilityId, routeId);

        const premise = await tx.premise.findFirst({
          where: { id: input.premiseId, utilityId },
          select: { id: true },
        });
        if (!premise) {
          throw httpError(404, "PREMISE_NOT_FOUND", `Premise ${input.premiseId} not found`);
        }
        const already = await tx.readRouteStop.findFirst({
          where: { utilityId, readRouteId: routeId, premiseId: input.premiseId },
          select: { id: true },
        });
        if (already) {
          throw httpError(409, "PREMISE_ALREADY_ON_ROUTE", "That premise is already a stop on this route");
        }

        let sequence: number;
        if (input.afterSequence === undefined) {
          const last = await tx.readRouteStop.aggregate({
            where: { utilityId, readRouteId: routeId },
            _max: { sequence: true },
          });
          sequence = (last._max.sequence ?? 0) + SEQUENCE_STEP;
        } else {
          const after = input.afterSequence;
          const next = await tx.readRouteStop.findFirst({
            where: { utilityId, readRouteId: routeId, sequence: { gt: after } },
            orderBy: { sequence: "asc" },
            select: { sequence: true },
          });
          if (!next) {
            sequence = after + SEQUENCE_STEP;
          } else {
            sequence = Math.floor((after + next.sequence) / 2);
            if (sequence <= after) {
              throw httpError(
                409,
                "SEQUENCE_FULL",
                `No room between sequence ${after} and ${next.sequence}; resequence the route`,
              );
            }
          }
        }

        return tx.readRouteStop.create({
          data: { utilityId, readRouteId: routeId, premiseId: input.premiseId, sequence },
        });
      },
    );
    return toStop(row);
  } catch (err) {
    // The route lock serialises writers, so this is a backstop for the
    // premise key only; the sequence key cannot collide under the lock.
    if (isUniqueViolation(err)) {
      throw httpError(409, "PREMISE_ALREADY_ON_ROUTE", "That premise is already a stop on this route");
    }
    throw err;
  }
}

export async function removeStop(
  utilityId: string,
  actor: { id: string; name: string },
  routeId: string,
  stopId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockLocalRoute(tx, utilityId, routeId);
    const stop = await tx.readRouteStop.findFirst({
      where: { id: stopId, readRouteId: routeId, utilityId },
    });
    if (!stop) throw httpError(404, "STOP_NOT_FOUND", `Stop ${stopId} is not on route ${routeId}`);
    await tx.readRouteStop.delete({ where: { id: stopId } });
    await writeAuditRow(
      tx,
      { utilityId, actorId: actor.id, actorName: actor.name, entityType: "ReadRouteStop" },
      EVENT_TYPES.READ_ROUTE_STOP_DELETED,
      stopId,
      stop,
      null,
    );
  });
}

export async function listStops(utilityId: string, routeId: string): Promise<ReadRouteStop[]> {
  const route = await prisma.readRoute.findFirst({
    where: { id: routeId, utilityId },
    select: { id: true },
  });
  if (!route) throw httpError(404, "ROUTE_NOT_FOUND", `Read route ${routeId} not found`);
  const rows = await prisma.readRouteStop.findMany({
    where: { utilityId, readRouteId: routeId },
    orderBy: { sequence: "asc" },
  });
  return rows.map(toStop);
}

/**
 * The tray: premises that are on **no route at all**.
 *
 * Not "premises missing from this route". A reader visits an address
 * once, so a premise belongs on exactly one route, and offering one that
 * is already on another route would invite the double visit that
 * ordering exists to prevent. `routeId` therefore does not filter the
 * list; it only proves the route exists and is LOCAL, because the tray
 * is meaningless for a route whose stops a vendor decides.
 */
export async function listUnsequencedPremises(
  utilityId: string,
  routeId: string,
  query: UnsequencedPremiseQuery,
): Promise<{ data: PremiseSummary[]; meta: PaginatedResponse<PremiseSummary>["meta"] }> {
  const route = await prisma.readRoute.findFirst({
    where: { id: routeId, utilityId },
    select: { origin: true },
  });
  if (!route) throw httpError(404, "ROUTE_NOT_FOUND", `Read route ${routeId} not found`);
  requireLocal(route.origin, routeId);

  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const where = {
    utilityId,
    readRouteStops: { none: {} },
    ...(query.search
      ? {
          OR: [
            { addressLine1: { contains: query.search, mode: "insensitive" as const } },
            { city: { contains: query.search, mode: "insensitive" as const } },
            { zip: { contains: query.search } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.premise.findMany({
      where,
      orderBy: [{ addressLine1: "asc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        zip: true,
        premiseType: true,
      },
    }),
    prisma.premise.count({ where }),
  ]);
  return paginatedResponse(rows, total, { page, limit, sort: "addressLine1", order: "asc" });
}
