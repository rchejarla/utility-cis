/**
 * Turn an interval meter's intervals into the reads a bill is made of
 * (spec 26, TOU-INT-4 / TOU-BIL-1).
 *
 * The engine prices `tou_period` off `meter_read` rows carrying a
 * `peak_code`. A register meter gets those at import, stamped from its
 * mapped registers. An interval meter has no registers: its buckets
 * only exist once the calendar has classified its intervals, and until
 * this ran inside the billing run, the only thing that did that was an
 * operator typing `scripts/roll-up-intervals.ts`.
 *
 * What that cost, precisely: `resolveServicePeriod` needs an unbilled
 * `meter_read` to find a period at all, so an interval meter with a
 * month of data and no roll-up was **skipped** — not billed wrongly,
 * not billed. The run reported the account as having no read, which is
 * what an operator would check first and find untrue.
 *
 * Deriving here rather than in `createBillSegmentForServiceAgreement`
 * keeps the mutation where someone asked for a run: rating stays a
 * function of the reads it finds, and the manual and API paths do not
 * silently rewrite reads underneath a caller who only asked to price a
 * period.
 */
import { prisma } from "../../lib/prisma.js";
import { rollUpIntervals } from "../interval-rollup.service.js";

export interface DerivedBuckets {
  meterNumber: string;
  intervalsRead: number;
  periods: number;
}

/**
 * Derive buckets for every TOU agreement among `serviceAgreementIds`
 * whose meters report intervals for this window.
 *
 * Throws when a meter has intervals that **cannot** be classified —
 * a gap, a `missing` reading, an interval straddling a period change.
 * That is a bill this run must not produce: the alternative is billing
 * whatever classified and silently dropping the rest. The throw carries
 * `TOU_ROLLUP_FAILED`, so the run marks that one account's item failed,
 * names the meter and the reason, and carries on with the others.
 *
 * Silent no-ops, by design: an agreement whose tariff prices no TOU
 * period, and a meter with no intervals in the window. The second is
 * the ordinary register meter, which already has its buckets — asking
 * it for intervals it was never going to have is not a fault.
 */
export async function deriveIntervalReads(args: {
  utilityId: string;
  serviceAgreementIds: string[];
  window: { startDate: Date; endDate: Date };
}): Promise<DerivedBuckets[]> {
  const { utilityId, serviceAgreementIds, window } = args;
  if (serviceAgreementIds.length === 0) return [];

  /*
   * The calendar comes from the schedule the agreement is assigned, not
   * from the meter's programmed one: the tariff decides how usage is
   * split for pricing (TOU-CAL-11), and a meter's own calendar is a
   * device fact that may disagree — which `CALENDAR_MISMATCH` reports
   * rather than acts on.
   */
  const assignments = await prisma.sAScheduleAssignment.findMany({
    where: {
      utilityId,
      serviceAgreementId: { in: serviceAgreementIds },
      effectiveDate: { lte: window.endDate },
    },
    orderBy: { effectiveDate: "desc" },
    select: {
      serviceAgreementId: true,
      rateSchedule: { select: { touCalendarId: true, publishedAt: true } },
    },
  });

  /** One calendar per agreement: the newest assignment that names one. */
  const calendarBySa = new Map<string, string>();
  for (const a of assignments) {
    if (calendarBySa.has(a.serviceAgreementId)) continue;
    if (!a.rateSchedule.publishedAt) continue;
    if (!a.rateSchedule.touCalendarId) continue;
    calendarBySa.set(a.serviceAgreementId, a.rateSchedule.touCalendarId);
  }
  if (calendarBySa.size === 0) return [];

  const links = await prisma.servicePointMeter.findMany({
    where: {
      utilityId,
      removedDate: null,
      servicePoint: { serviceAgreementId: { in: [...calendarBySa.keys()] } },
    },
    select: {
      meterId: true,
      meter: { select: { meterNumber: true, uomId: true } },
      servicePoint: { select: { serviceAgreementId: true } },
    },
  });
  if (links.length === 0) return [];

  /*
   * Which of those meters actually report intervals here. One grouped
   * query rather than a probe per meter: a cycle is thousands of
   * accounts and almost none of them are interval meters.
   */
  const withIntervals = await prisma.meterReadInterval.groupBy({
    by: ["meterId"],
    where: {
      utilityId,
      meterId: { in: links.map((l) => l.meterId) },
      intervalStart: { gte: window.startDate, lt: window.endDate },
    },
    _count: { meterId: true },
  });
  const intervalMeterIds = new Set(withIntervals.map((g) => g.meterId));
  if (intervalMeterIds.size === 0) return [];

  /*
   * Buckets already billed for this window are left alone. The roll-up
   * clears and rewrites only unbilled interval-derived rows, so a
   * re-run picks up late-arriving intervals; a window already billed is
   * closed, and rewriting it would move a figure a customer has been
   * told.
   */
  const billed = await prisma.meterRead.groupBy({
    by: ["meterId"],
    where: {
      utilityId,
      meterId: { in: [...intervalMeterIds] },
      peakCode: { not: null },
      billedAt: { not: null },
      readDate: { gte: window.startDate, lte: window.endDate },
    },
    _count: { meterId: true },
  });
  const billedMeterIds = new Set(billed.map((g) => g.meterId));

  const derived: DerivedBuckets[] = [];
  for (const link of links) {
    if (!intervalMeterIds.has(link.meterId)) continue;
    if (billedMeterIds.has(link.meterId)) continue;
    const saId = link.servicePoint?.serviceAgreementId;
    const touCalendarId = saId ? calendarBySa.get(saId) : undefined;
    if (!saId || !touCalendarId) continue;

    const result = await rollUpIntervals({
      utilityId,
      meterId: link.meterId,
      serviceAgreementId: saId,
      touCalendarId,
      period: window,
      uomId: link.meter.uomId,
    });

    if (!result.ok) {
      throw Object.assign(
        new Error(
          `Meter ${link.meter.meterNumber}: its interval data could not be split into TOU periods ` +
            `for ${window.startDate.toISOString().slice(0, 10)}..${window.endDate
              .toISOString()
              .slice(0, 10)}, so this account cannot be billed. ` +
            result.problems.join(" "),
        ),
        { statusCode: 400, code: "TOU_ROLLUP_FAILED" },
      );
    }

    derived.push({
      meterNumber: link.meter.meterNumber,
      intervalsRead: result.intervalsRead,
      periods: result.buckets.length,
    });
  }

  return derived;
}
