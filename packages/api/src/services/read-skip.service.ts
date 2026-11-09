import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { EVENT_TYPES, type SkipReason } from "@utility-cis/shared";
import { writeAuditRow } from "../lib/audit-wrap.js";
import { computeBillPeriod } from "./bill.service.js";

/**
 * What a reader writes down when a stop produced no number, and the
 * healing of it when a number later arrives (read routes design §5.3).
 *
 * **A skip is its own row, not a read of zero.** `meter_read.consumption`
 * is NOT NULL and a zero is a statement billing already refuses to take
 * on faith; and it is not a `MeterEvent`, which records what a device
 * did — a locked gate is not a device fact. It keys on the meter, not
 * the premise, because the gate is locked in front of one meter while
 * the other at the same address reads fine.
 *
 * **Both functions take the caller's `tx` and nothing else's client.**
 * Every caller is already in a transaction, and a skip that outlives
 * the rollback of the read that should have healed it (or the reverse)
 * is the write-only column this exists to avoid.
 *
 * **The window is the cycle's, from `computeBillPeriod` with the epoch
 * as the creation date** — the call `getReadingProgress` makes, for the
 * same reason: a window belongs to the cycle, not to an account, and
 * passing a real account would clamp the start to its creation date and
 * give each account a different one. A skip and the progress screen
 * therefore agree about which window a day falls in. The cycle is the
 * one on the account the meter is assigned to on that day.
 */

type Tx = Prisma.TransactionClient;

function httpError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/** A DATE column comes back as UTC midnight; a caller's "today" may not be. */
function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

interface CycleWindow {
  windowStart: Date;
  windowEnd: Date;
}

/**
 * The window that *contains* `day`, which is not what `computeBillPeriod`
 * returns for `asOf = day`: that is the last period already closed on
 * that day, so a day between two bill days falls after its end. A read
 * on the 5th belongs to the window the run on the 10th will bill, and a
 * skip on the 3rd to the same one; asking for the closed period would
 * put both in last month's, and a date-range match on it would find
 * neither. The next period's end is 28 to 31 days on, so one more call
 * with `asOf` 31 days past the closed end lands on it and not the one
 * after.
 */
function windowContaining(
  cycle: { billDayOfMonth: number; frequency: string },
  day: Date,
): { periodStart: Date; periodEnd: Date } {
  const epoch = { createdAt: new Date(0), billingCycle: cycle };
  const closed = computeBillPeriod(epoch, day);
  if (day <= closed.periodEnd) return closed;
  return computeBillPeriod(epoch, new Date(closed.periodEnd.getTime() + 31 * 86_400_000));
}

/**
 * The windows `day` falls in for each meter, one per distinct cycle of
 * the meter's assignments open on that day (usually one; a handover day
 * can have two). Same open-on-a-date test as `readableRowsForPremises`.
 */
async function windowsByMeter(
  tx: Tx,
  utilityId: string,
  meterIds: string[],
  day: Date,
): Promise<Map<string, CycleWindow[]>> {
  const assignments = await tx.servicePointMeter.findMany({
    where: {
      utilityId,
      meterId: { in: meterIds },
      addedDate: { lte: day },
      OR: [{ removedDate: null }, { removedDate: { gte: day } }],
    },
    select: {
      meterId: true,
      servicePoint: {
        select: {
          serviceAgreement: {
            select: {
              account: {
                select: {
                  billingCycle: {
                    select: { id: true, billDayOfMonth: true, frequency: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const out = new Map<string, Map<string, CycleWindow>>();
  for (const a of assignments) {
    const cycle = a.servicePoint?.serviceAgreement?.account?.billingCycle;
    if (!cycle) continue;
    const { periodStart, periodEnd } = windowContaining(cycle, day);
    const perCycle = out.get(a.meterId) ?? new Map<string, CycleWindow>();
    perCycle.set(cycle.id, { windowStart: periodStart, windowEnd: periodEnd });
    out.set(a.meterId, perCycle);
  }
  return new Map([...out].map(([meterId, m]) => [meterId, [...m.values()]]));
}

/**
 * Record that these meters could not be read, one row each, one reason
 * for the lot (a reader skips a stop for a reason, and the stop's
 * meters share it). Returns how many rows were written.
 *
 * Refuses the whole call with 409 `METER_ALREADY_READ` if any meter
 * already has a read in the window `readDate` falls in: a skip says "no
 * number exists", which would be false. A meter already skipped open on
 * that day is left as it is, not duplicated and not reworded — the
 * partial unique index is the arbiter and the count excludes it, so a
 * sheet submitted twice writes once.
 */
export async function recordSkips(
  tx: Tx,
  utilityId: string,
  actor: { id: string; name: string },
  input: {
    routeId: string | null;
    readDate: Date;
    meterIds: string[];
    skipReason: SkipReason;
    notes?: string;
    readerId?: string;
  },
): Promise<number> {
  const day = utcDay(input.readDate);
  const meterIds = [...new Set(input.meterIds)];
  if (meterIds.length === 0) return 0;

  const known = await tx.meter.findMany({
    where: { utilityId, id: { in: meterIds } },
    select: { id: true },
  });
  const missing = meterIds.filter((id) => !known.some((m) => m.id === id));
  if (missing.length > 0) {
    throw httpError(404, "METER_NOT_FOUND", `Meter ${missing[0]} not found`);
  }

  const windows = await windowsByMeter(tx, utilityId, meterIds, day);
  for (const meterId of meterIds) {
    const ws = windows.get(meterId);
    if (!ws?.length) {
      throw httpError(
        400,
        "METER_NOT_ASSIGNED",
        `Meter ${meterId} is not assigned to an agreement on ${day.toISOString().slice(0, 10)}`,
      );
    }
    for (const w of ws) {
      const read = await tx.meterRead.findFirst({
        where: {
          utilityId,
          meterId,
          readDate: { gte: w.windowStart, lte: w.windowEnd },
        },
        select: { id: true },
      });
      if (read) {
        throw httpError(
          409,
          "METER_ALREADY_READ",
          `Meter ${meterId} already has a read in the window ending ${w.windowEnd.toISOString().slice(0, 10)}`,
        );
      }
    }
  }

  const created = await tx.readSkip.createManyAndReturn({
    data: meterIds.map((meterId) => ({
      utilityId,
      meterId,
      readRouteId: input.routeId,
      readDate: day,
      skipReason: input.skipReason,
      notes: input.notes ?? null,
      readerId: input.readerId ?? actor.id,
    })),
    skipDuplicates: true,
  });

  for (const row of created) {
    await writeAuditRow(
      tx,
      { utilityId, actorId: actor.id, actorName: actor.name, entityType: "ReadSkip" },
      EVENT_TYPES.READ_SKIP_CREATED,
      row.id,
      null,
      row,
    );
  }
  return created.length;
}

/**
 * A number has landed for this meter on `readDate`: close the open
 * skips for it that fall in the same cycle window. Returns how many.
 *
 * Per meter, not per premise — the other meter at the address still has
 * no number. Per window, not per meter — a skip from last month says
 * nothing about this read, and a later window's skip is not healed by
 * an earlier window's read. Called from every writer of a new
 * `meter_read` (single, multi-register event, import) and deliberately
 * not from `correctMeterRead`, which replaces a read that already
 * resolved whatever it was going to.
 */
export async function resolveSkipsForRead(
  tx: Tx,
  utilityId: string,
  meterId: string,
  readDate: Date,
): Promise<number> {
  const day = utcDay(readDate);
  const windows = (await windowsByMeter(tx, utilityId, [meterId], day)).get(meterId) ?? [];
  let resolved = 0;
  for (const w of windows) {
    const { count } = await tx.readSkip.updateMany({
      where: {
        utilityId,
        meterId,
        resolvedAt: null,
        readDate: { gte: w.windowStart, lte: w.windowEnd },
      },
      data: { resolvedAt: new Date() },
    });
    resolved += count;
  }
  return resolved;
}
