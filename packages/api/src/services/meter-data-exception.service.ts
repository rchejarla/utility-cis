/**
 * Writing what a sweep found to the exception queue (spec 26,
 * TOU-GAP-1).
 *
 * One module owns the conversation with `meter_data_exception`. The
 * decision of what to open, update and resolve is not here — it is
 * `reconcileDataExceptions`, a pure function over two sets, so that the
 * rule can be read and tested without a database and this file is only
 * the three writes it asks for.
 *
 * **Not in a transaction, deliberately.** Every run derives its plan
 * from the data as it stands, so a run that dies half-applied leaves
 * rows the next run reaches the same conclusion about. The state is
 * indistinguishable from a sweep still in progress and self-heals, and
 * wrapping it would hold a connection for the whole of a tenant's
 * writes to buy nothing a reader could name.
 *
 * `now` is passed in rather than taken from the clock here, so
 * `detected_at` and `resolved_at` come from the same clock as the sweep
 * that decided them — and so a test can say when it ran.
 */
import {
  EVENT_TYPES,
  meterDataExceptionSortFields,
  type MeterDataExceptionQuery,
} from "@utility-cis/shared";
import { auditUpdate, type AuditContext } from "../lib/audit-wrap.js";
import { paginatedTenantList } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import {
  reconcileDataExceptions,
  type DataExceptionKind,
  type DataExceptionStatus,
  type FoundDataException,
} from "../lib/meter-data-exception.js";

export interface FlagResult {
  opened: number;
  updated: number;
  resolved: number;
}

export async function flagDataExceptions(input: {
  utilityId: string;
  /** The windows the sweep examined. Nothing outside them is resolved. */
  sweptWindowStarts: Date[];
  found: FoundDataException[];
  now: Date;
}): Promise<FlagResult> {
  if (input.sweptWindowStarts.length === 0) {
    return { opened: 0, updated: 0, resolved: 0 };
  }

  /*
   * Every *unresolved* exception for these days, not only the open
   * ones. An accepted or estimated row means somebody has decided what
   * to do about a problem that is still there, and the sweep finds it
   * again every night — so it has to see those rows to leave them
   * alone. The partial unique index would not catch the mistake: it
   * forbids a second open row, not an open row beside an accepted one.
   *
   * Resolved rows are excluded on purpose. A gap that was fixed in
   * March and returns in April is a new exception, which is what makes
   * a meter that fails every month visible.
   */
  const existing = await prisma.meterDataException.findMany({
    where: {
      utilityId: input.utilityId,
      status: { in: ["open", "accepted", "estimated"] },
      windowStart: { in: input.sweptWindowStarts },
    },
    select: {
      id: true,
      meterId: true,
      windowStart: true,
      kind: true,
      status: true,
      minutesAffected: true,
      detail: true,
    },
  });

  const plan = reconcileDataExceptions({
    sweptWindowStarts: input.sweptWindowStarts,
    found: input.found,
    // `kind` and `status` are VARCHARs with CHECKs rather than Postgres
    // enums, so the columns' types are wider than their vocabularies.
    // Narrowed here, at the one place rows enter the pure layer.
    existing: existing.map((row) => ({
      ...row,
      kind: row.kind as DataExceptionKind,
      status: row.status as DataExceptionStatus,
    })),
  });

  if (plan.toOpen.length > 0) {
    await prisma.meterDataException.createMany({
      data: plan.toOpen.map((f) => ({
        utilityId: input.utilityId,
        meterId: f.meterId,
        windowStart: f.windowStart,
        windowEnd: f.windowEnd,
        kind: f.kind,
        minutesAffected: f.minutesAffected,
        detail: f.detail,
        status: "open",
        detectedAt: input.now,
      })),
    });
  }

  for (const row of plan.toUpdate) {
    await prisma.meterDataException.update({
      where: { id: row.id },
      data: { minutesAffected: row.minutesAffected, detail: row.detail },
    });
  }

  if (plan.toResolveIds.length > 0) {
    await prisma.meterDataException.updateMany({
      where: { id: { in: plan.toResolveIds } },
      data: { status: "resolved", resolvedAt: input.now },
    });
  }

  return {
    opened: plan.toOpen.length,
    updated: plan.toUpdate.length,
    resolved: plan.toResolveIds.length,
  };
}

/*
 * ─── Working the queue ───────────────────────────────────────────────
 *
 * Above: what a sweep writes. Below: what a person decides about it.
 * The two halves share this module because they are the same table's
 * only writers, and the statuses one sets are exactly the ones the
 * other must leave alone.
 */

/** The meter, because its number is what a person recognises. */
const QUEUE_INCLUDE = { meter: { select: { id: true, meterNumber: true } } } as const;

/**
 * One row of the queue as the database hands it over.
 *
 * `kind` and `status` are narrowed here from the VARCHARs they are
 * stored as — the same narrowing `flagDataExceptions` does above, and
 * for the same reason: the CHECK constraints are the enforcement, so
 * this is the one place rows enter the typed world and the assertion
 * belongs here rather than at every reader.
 */
export interface QueuedDataException {
  id: string;
  utilityId: string;
  meterId: string;
  windowStart: Date;
  windowEnd: Date;
  kind: DataExceptionKind;
  minutesAffected: number;
  detail: string;
  status: DataExceptionStatus;
  detectedAt: Date;
  resolvedAt: Date | null;
  updatedAt: Date;
  meter: { id: string; meterNumber: string };
}

export async function listDataExceptions(utilityId: string, query: MeterDataExceptionQuery) {
  const where: Record<string, unknown> = { utilityId };
  if (query.status) where.status = query.status;
  if (query.kind) where.kind = query.kind;
  if (query.meterId) where.meterId = query.meterId;
  if (query.fromDate || query.toDate) {
    const range: Record<string, Date> = {};
    if (query.fromDate) range.gte = new Date(query.fromDate);
    // Exclusive, because a window is half-open and `toDate` names the
    // day somebody typed: `lte` on a timestamptz column would include
    // that day's midnight row and nothing else of it.
    if (query.toDate) range.lt = new Date(new Date(query.toDate).getTime() + 86_400_000);
    where.windowStart = range;
  }
  return paginatedTenantList<QueuedDataException>(prisma.meterDataException, where, query, {
    include: QUEUE_INCLUDE,
    allowedSorts: meterDataExceptionSortFields,
  });
}

async function requireException(id: string, utilityId: string) {
  const row = await prisma.meterDataException.findFirst({ where: { id, utilityId } });
  if (!row) {
    /*
     * 404 and not 403, for the reason the portal routes answer 404:
     * whether another tenant has a row with this id is not the
     * caller's to learn.
     */
    throw Object.assign(new Error(`Data exception ${id} not found`), {
      statusCode: 404,
      code: "DATA_EXCEPTION_NOT_FOUND",
    });
  }
  return row;
}

/**
 * "This hole is never going to be filled."
 *
 * `checkTouReadiness` **sums the accepted minutes** for a meter and
 * stops counting that many against the period, so an accepted month
 * clears the pre-run check.
 *
 * **It does not make the month billable, and the gap between those two
 * sentences is a known hole** (2026-11-07). `rollUpIntervals` refuses
 * any period its intervals do not cover and never consults this table,
 * so a run over an accepted month is allowed to start and then fails
 * that one account with `TOU_ROLLUP_FAILED`. Either the roll-up learns
 * to tolerate exactly the accepted minutes — which means billing a
 * month short on purpose, and a bill that says so — or acceptance is
 * only ever a route to the estimator. That is a decision about what a
 * customer is charged, so it is recorded in spec 26 rather than settled
 * here; the screen and this comment say what the action does today.
 *
 * Only from `open`, and a refusal rather than a no-op for the rest.
 * Accepting a `resolved` row would add minutes to that sum which are no
 * longer missing — forgiving a later, real shortfall by accident — and
 * an `estimated` row already shows up as coverage, so counting it here
 * would forgive it twice. Agreeing silently with a caller who named a
 * row in neither state hides which of those two things happened.
 */
export async function acceptDataException(id: string, ctx: AuditContext) {
  const before = await requireException(id, ctx.utilityId);
  if (before.status !== "open") {
    throw Object.assign(
      new Error(
        `This exception is ${before.status}, not open, so there is nothing to accept. ` +
          (before.status === "resolved"
            ? "Its data arrived, so the minutes are no longer missing."
            : "A decision has already been made about it."),
      ),
      { statusCode: 409, code: "DATA_EXCEPTION_NOT_OPEN" },
    );
  }
  /*
   * `resolved_at` is "when it stopped being open", not "when the data
   * arrived" — the CHECK ties it to `status` in both directions, so an
   * accepted row without one cannot be written. Here it is the moment
   * somebody took responsibility for billing the hole.
   */
  return auditUpdate(ctx, EVENT_TYPES.METER_DATA_EXCEPTION_ACCEPTED, before, (tx) =>
    tx.meterDataException.update({
      where: { id },
      data: { status: "accepted", resolvedAt: new Date() },
    }),
  );
}

/**
 * The undo for an acceptance.
 *
 * Only from `accepted`: `resolved` is the sweep's to set and to unset,
 * and a person reopening one would be asserting a hole the data says is
 * filled. The partial unique index allows this — the sweep leaves an
 * accepted row alone rather than opening a second one for the same
 * (meter, window, kind), so there is no open row here to collide with.
 */
export async function reopenDataException(id: string, ctx: AuditContext) {
  const before = await requireException(id, ctx.utilityId);
  if (before.status !== "accepted") {
    throw Object.assign(
      new Error(
        `This exception is ${before.status}, not accepted, so there is no acceptance to undo.`,
      ),
      { statusCode: 409, code: "DATA_EXCEPTION_NOT_ACCEPTED" },
    );
  }
  return auditUpdate(ctx, EVENT_TYPES.METER_DATA_EXCEPTION_REOPENED, before, (tx) =>
    tx.meterDataException.update({
      where: { id },
      data: { status: "open", resolvedAt: null },
    }),
  );
}
