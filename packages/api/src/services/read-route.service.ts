import type {
  ReadRoute,
  ReadRouteInput,
  ReadRouteQuery,
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
  return (err as { code?: string }).code === "P2002";
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
            origin: input.origin ?? "LOCAL",
            active: input.active ?? true,
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
  input: Partial<ReadRouteInput>,
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
            ...(input.origin !== undefined ? { origin: input.origin } : {}),
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
 * later fails takes its route with it. `ON CONFLICT DO NOTHING` rather
 * than find-then-create: two rows naming the same new code in concurrent
 * batches would otherwise race to a unique violation, which in Postgres
 * poisons the whole transaction rather than just the statement.
 *
 * An existing route is returned as it is — whatever its origin or
 * cycle — because a later import must not rewrite what somebody has
 * since made of it. Only a creation is audited.
 */
export async function upsertExternalRoute(
  tx: ImportTx,
  utilityId: string,
  code: string,
  billingCycleId: string,
): Promise<string> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO read_route (utility_id, code, name, billing_cycle_id, origin)
    VALUES (${utilityId}::uuid, ${code}, ${code}, ${billingCycleId}::uuid, 'EXTERNAL')
    ON CONFLICT (utility_id, code) DO NOTHING
    RETURNING id`;
  if (inserted.length > 0) {
    const id = inserted[0]!.id;
    await writeAuditRow(
      tx,
      { utilityId, actorId: null, actorName: "Import", entityType: "ReadRoute" },
      EVENT_TYPES.READ_ROUTE_CREATED,
      id,
      null,
      { id, code, billingCycleId, origin: "EXTERNAL" },
    );
    return id;
  }
  const existing = await tx.readRoute.findFirstOrThrow({
    where: { utilityId, code },
    select: { id: true },
  });
  return existing.id;
}
