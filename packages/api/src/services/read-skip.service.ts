import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { EVENT_TYPES, type SkipReason } from "@utility-cis/shared";
import { writeAuditRowsCreated } from "../lib/audit-wrap.js";
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
 *
 * **That probe rests on `computeBillPeriod`'s `periodEnd` being
 * inclusive** (a bill day is the last day of the period ending on it,
 * `d >= thisMonth` there). The `day <= periodEnd` test is that equality
 * case: a read on the bill day itself is in the window that ends on it.
 * Were the end ever made exclusive, this would return the previous
 * window on every bill day; the integration test pins the day before,
 * the day of and the day after the bill day for that reason.
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
 *
 * A cycle `computeBillPeriod` cannot window (it ships MONTHLY only, and
 * `BillingFrequency` allows more) is reported in `unsupported` rather
 * than thrown, so each caller decides: the resolver treats it as "no
 * window", `recordSkips` refuses by name. Only that one code is caught;
 * anything else is a real fault and propagates.
 */
async function windowsByMeter(
  tx: Tx,
  utilityId: string,
  meterIds: string[],
  day: Date,
): Promise<{ windows: Map<string, CycleWindow[]>; unsupported: Set<string> }> {
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
  const unsupported = new Set<string>();
  for (const a of assignments) {
    const cycle = a.servicePoint?.serviceAgreement?.account?.billingCycle;
    if (!cycle) continue;
    let periodStart: Date;
    let periodEnd: Date;
    try {
      ({ periodStart, periodEnd } = windowContaining(cycle, day));
    } catch (err) {
      if ((err as { code?: string }).code === "UNSUPPORTED_FREQUENCY") {
        unsupported.add(a.meterId);
        continue;
      }
      throw err;
    }
    const perCycle = out.get(a.meterId) ?? new Map<string, CycleWindow>();
    perCycle.set(cycle.id, { windowStart: periodStart, windowEnd: periodEnd });
    out.set(a.meterId, perCycle);
  }
  return {
    windows: new Map([...out].map(([meterId, m]) => [meterId, [...m.values()]])),
    unsupported,
  };
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
 *
 * Refuses a meter on a cycle with no read window yet (a non-monthly
 * one) with 501 `READ_SKIP_CYCLE_UNSUPPORTED`: unlike healing a skip,
 * recording one cannot proceed without knowing the window, because the
 * already-read check is meaningless without it.
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
  const knownIds = new Set(known.map((m) => m.id));
  const missing = meterIds.find((id) => !knownIds.has(id));
  if (missing) throw httpError(404, "METER_NOT_FOUND", `Meter ${missing} not found`);

  const { windows, unsupported } = await windowsByMeter(tx, utilityId, meterIds, day);
  for (const meterId of meterIds) {
    if (unsupported.has(meterId)) {
      throw httpError(
        501,
        "READ_SKIP_CYCLE_UNSUPPORTED",
        `Meter ${meterId} is on a billing cycle whose frequency has no read window yet; its skips cannot be recorded`,
      );
    }
    if (!windows.get(meterId)?.length) {
      throw httpError(
        400,
        "METER_NOT_ASSIGNED",
        `Meter ${meterId} is not assigned to an agreement on ${day.toISOString().slice(0, 10)}`,
      );
    }
  }

  /*
   * One query for every meter. The span covers all their windows (one
   * shared window in the normal case); each hit is then checked against
   * its own meter's windows in memory, so a meter on another cycle is
   * never judged by this one's dates.
   */
  const all = [...windows.values()].flat();
  const reads = await tx.meterRead.findMany({
    where: {
      utilityId,
      meterId: { in: meterIds },
      readDate: {
        gte: new Date(Math.min(...all.map((w) => w.windowStart.getTime()))),
        lte: new Date(Math.max(...all.map((w) => w.windowEnd.getTime()))),
      },
    },
    select: { meterId: true, readDate: true },
  });
  for (const r of reads) {
    const hit = windows
      .get(r.meterId)!
      .find((w) => r.readDate >= w.windowStart && r.readDate <= w.windowEnd);
    if (hit) {
      throw httpError(
        409,
        "METER_ALREADY_READ",
        `Meter ${r.meterId} already has a read in the window ending ${hit.windowEnd.toISOString().slice(0, 10)}`,
      );
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

  await writeAuditRowsCreated(
    tx,
    { utilityId, actorId: actor.id, actorName: actor.name, entityType: "ReadSkip" },
    EVENT_TYPES.READ_SKIP_CREATED,
    created,
  );
  return created.length;
}

/**
 * A number has landed for this meter on `readDate`: close the open
 * skips for it that fall in the same cycle window. Returns how many.
 *
 * **This function must never throw.** It runs inside the read's own
 * transaction, which is right (a skip healed by a read that rolled back
 * would be a lie), but it means any throw here rolls the read back:
 * healing a skip is a convenience, never a precondition for recording a
 * number. A cycle with no window (`UNSUPPORTED_FREQUENCY`, any
 * non-monthly cycle) is therefore "no window" and returns 0. What can
 * still throw is the database failing, which fails the read's
 * transaction regardless. Anything added here that can reject on data (a
 * lookup that must find a row, a validation) belongs in the caller or
 * nowhere.
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
  const { windows: byMeter } = await windowsByMeter(tx, utilityId, [meterId], day);
  const windows = byMeter.get(meterId) ?? [];
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
