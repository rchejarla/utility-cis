import { prisma } from "../../lib/prisma.js";

/**
 * Which rows a stop on a read route produces (design §5.12).
 *
 * **One definition, three callers.** The printed sheet, the entry screen
 * and the per-route progress count all call this and none re-derives it.
 * If they each asked the question themselves they would eventually
 * disagree, and the place that shows is in front of the person holding
 * the paper: the sheet has 41 lines and the screen says 40 to go.
 *
 * A row is one active **register** of a meter, not one meter. A meter
 * with no active register is still a row, with a null register: that is
 * the common case in real data, and nothing may drop it.
 */

export interface ReadableRow {
  premiseId: string;
  meterId: string;
  meterNumber: string;
  /** Null when the meter has no active register. */
  registerId: string | null;
  registerNumber: string | null;
  serviceAgreementId: string;
  accountNumber: string;
  /** The register's unit when there is one, else the meter's. */
  uomId: string;
}

/**
 * Meter types somebody physically visits. AMR is drive-by and belongs on
 * a route; AMI is not here because a sheet listing meters nobody visits
 * is how a reader learns to ignore the sheet.
 */
const VISITED_METER_TYPES = ["MANUAL", "AMR"] as const;

/**
 * `onDate` is a calendar day. The assignment columns are `@db.Date`, which
 * Prisma returns as UTC midnight, so it is normalised to UTC midnight here:
 * a caller passing `new Date()` for "today" would otherwise make
 * `removedDate >= onDate` false for an assignment removed today and drop a
 * row the sheet must print.
 */
export async function readableRowsForPremises(
  utilityId: string,
  premiseIds: string[],
  onDateInput: Date,
): Promise<ReadableRow[]> {
  if (premiseIds.length === 0) return [];
  const onDate = new Date(
    Date.UTC(onDateInput.getUTCFullYear(), onDateInput.getUTCMonth(), onDateInput.getUTCDate()),
  );
  const openAt = {
    addedDate: { lte: onDate },
    OR: [{ removedDate: null }, { removedDate: { gte: onDate } }],
  };

  /*
   * Reached through ServicePointMeter → ServicePoint, never through
   * `Meter.premiseId`. Both columns exist, but only the service-point path
   * guarantees an agreement resolves: a meter found by its own premise
   * column with no open assignment would print, and then fail at submit
   * with METER_NOT_ASSIGNED — and since a route posts as a whole, that one
   * row fails the sheet.
   *
   * Open at `onDate` is the same test `resolveServiceAgreementId` applies
   * (added on or before, removed on or after), and it is date-scoped rather
   * than `removedDate: null` because a sheet can be printed for a past date.
   *
   * One round trip however many premises: the callers pass a whole route.
   */
  const assignments = await prisma.servicePointMeter.findMany({
    where: {
      utilityId,
      ...openAt,
      servicePoint: { premiseId: { in: premiseIds } },
      meter: { meterType: { in: [...VISITED_METER_TYPES] }, status: "ACTIVE" },
    },
    select: {
      id: true,
      addedDate: true,
      servicePoint: {
        select: {
          premiseId: true,
          serviceAgreement: {
            select: { id: true, account: { select: { accountNumber: true } } },
          },
        },
      },
      meter: {
        select: {
          id: true,
          meterNumber: true,
          uomId: true,
          registers: {
            where: { isActive: true },
            orderBy: { registerNumber: "asc" },
            select: { id: true, registerNumber: true, uomId: true },
          },
        },
      },
    },
  });

  /*
   * A meter reassigned on the day it left its old service point is open
   * at both on that day (removal is inclusive, the next addition starts
   * the same date; the database's own range is half-open, so it permits
   * this). `resolveServiceAgreementId` settles that by taking the latest
   * `addedDate` across ALL of the meter's open assignments, with no
   * premise filter, so the winner is decided from the same candidate set
   * here: the batch query above is narrowed to `premiseIds`, and deciding
   * from it alone would make a stop's answer depend on what else was in
   * the call. Constant round trips: one more query for all meters.
   */
  const meterIds = [...new Set(assignments.map((a) => a.meter.id))];
  const allOpen = meterIds.length
    ? await prisma.servicePointMeter.findMany({
        where: { utilityId, meterId: { in: meterIds }, ...openAt },
        select: { id: true, meterId: true, addedDate: true },
      })
    : [];
  const winner = new Map<string, { id: string; addedDate: Date }>();
  for (const o of allOpen) {
    const held = winner.get(o.meterId);
    if (!held || o.addedDate > held.addedDate) winner.set(o.meterId, o);
  }
  const latest = assignments.filter((a) => winner.get(a.meter.id)?.id === a.id);

  const rows: ReadableRow[] = [];
  for (const a of latest) {
    const base = {
      premiseId: a.servicePoint.premiseId,
      meterId: a.meter.id,
      meterNumber: a.meter.meterNumber,
      serviceAgreementId: a.servicePoint.serviceAgreement.id,
      accountNumber: a.servicePoint.serviceAgreement.account.accountNumber,
    };
    if (a.meter.registers.length === 0) {
      rows.push({ ...base, registerId: null, registerNumber: null, uomId: a.meter.uomId });
    } else {
      for (const r of a.meter.registers) {
        rows.push({ ...base, registerId: r.id, registerNumber: String(r.registerNumber), uomId: r.uomId });
      }
    }
  }

  // Deterministic, so two calls for the same sheet cannot differ in order.
  return rows.sort(
    (x, y) =>
      x.premiseId.localeCompare(y.premiseId) ||
      x.meterNumber.localeCompare(y.meterNumber) ||
      Number(x.registerNumber ?? 0) - Number(y.registerNumber ?? 0),
  );
}
