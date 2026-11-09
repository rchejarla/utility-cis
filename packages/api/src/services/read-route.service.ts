import type {
  ReadRoute,
  ReadRouteInput,
  ReadRouteQuery,
  ReadRouteUpdate,
  ReadRouteSummary,
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
 * Stops are Task 3's business; this file owns the route row itself.
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
