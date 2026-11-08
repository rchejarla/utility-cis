import { localMidnight } from "../lib/coverage-windows.js";
import { findCoverageProblems } from "../lib/interval-coverage.js";
import { prisma } from "../lib/prisma.js";

/**
 * One meter's interval data, as a series somebody can look at
 * (spec 26, TOU-INT-9).
 *
 * **Nothing could show one.** The importer landed on 2026-11-07 and
 * there was still no route returning an interval row: a month of AMI
 * data existed only as the three `meter_read` buckets the roll-up
 * derived from it. Two questions had no answer anywhere — *what did
 * this meter actually report*, which is what a customer disputing a
 * TOU bill is asking, and *where is the hole*, which the coverage
 * queue reports and nothing could display.
 *
 * **The gaps come from `findCoverageProblems`**, the same tiling the
 * roll-up refuses on and the sweep opens exceptions for. Not a second
 * implementation: a screen drawing holes a different way from the
 * thing that will not bill them would be worse than no screen.
 */

/** How many days may be asked for at once. */
const MAX_DAYS = 7;
const DAY_MS = 86_400_000;

export interface IntervalPoint {
  intervalStart: Date;
  lengthMinutes: number;
  /** A string, so a decimal survives the trip out of Postgres. */
  quantity: string;
  quality: string;
}

export interface IntervalGap {
  startsAt: Date;
  minutes: number;
}

export interface MeterIntervalSeries {
  meterId: string;
  meterNumber: string;
  uomCode: string | null;
  /** The range actually shown, which is a day when none was asked for. */
  from: Date;
  to: Date;
  /**
   * The zone the days are measured in and the series should be read
   * in — the tenant's own `utility_config.timezone`.
   *
   * **Not UTC**, which is what this returned for an afternoon until
   * somebody looked at the chart: a household's evening peak drew at
   * midnight, because a day was a UTC day and the hours were UTC
   * hours. A customer disputing a peak charge is asking about *their*
   * five o'clock, and the TOU calendar classifies by local time too —
   * so a view of a UTC day answers a question nobody asked and
   * straddles two of the days the sweep reports on.
   */
  timeZone: string;
  /**
   * Whether this meter has ever reported an interval at all.
   *
   * Separate from an empty range, because the two mean different
   * things to whoever is looking: a water meter has no intervals and
   * never will, while an AMI meter with none for a day has a problem.
   */
  reportsIntervals: boolean;
  intervals: IntervalPoint[];
  summary: {
    count: number;
    total: string;
    byQuality: Record<string, number>;
    minutesCovered: number;
    minutesInRange: number;
    gaps: IntervalGap[];
  };
}

export interface MeterIntervalSeriesQuery {
  /** Inclusive `YYYY-MM-DD` days. Both or neither. */
  from?: string;
  to?: string;
}

export async function getMeterIntervalSeries(
  utilityId: string,
  meterId: string,
  query: MeterIntervalSeriesQuery,
): Promise<MeterIntervalSeries> {
  /*
   * The same `localMidnight` the nightly sweep builds its windows
   * with, so a day here is the day an exception is opened for and a
   * hole drawn here is the hole that gets reported.
   */
  const config = await prisma.utilityConfig.findFirst({
    where: { utilityId },
    select: { timezone: true },
  });
  const timeZone = config?.timezone ?? "UTC";

  const meter = await prisma.meter.findFirst({
    where: { id: meterId, utilityId },
    select: { id: true, meterNumber: true, uom: { select: { code: true } } },
  });
  if (!meter) {
    throw Object.assign(new Error(`Meter ${meterId} not found`), {
      statusCode: 404,
      code: "METER_NOT_FOUND",
    });
  }

  /*
   * The newest day this meter reported, when no range was asked for.
   * Opening a tab should answer something; making somebody pick a date
   * before seeing anything is work before an answer, and they rarely
   * know which date to pick.
   */
  const newest = await prisma.meterReadInterval.findFirst({
    where: { utilityId, meterId },
    orderBy: { intervalStart: "desc" },
    select: { intervalStart: true },
  });
  const reportsIntervals = newest !== null;

  const fromDate = query.from ?? localDayOf(newest?.intervalStart ?? new Date(), timeZone);
  const toDate = query.to ?? fromDate;
  const fromDay = localMidnight(fromDate, timeZone);
  const toDay = localMidnight(toDate, timeZone);

  if (Number.isNaN(fromDay.getTime()) || Number.isNaN(toDay.getTime()) || toDay < fromDay) {
    throw Object.assign(new Error("from must be a date on or before to"), {
      statusCode: 400,
      code: "INVALID_RANGE",
    });
  }

  const days = Math.round((toDay.getTime() - fromDay.getTime()) / DAY_MS) + 1;
  if (days > MAX_DAYS) {
    /*
     * Stated rather than silently truncated. A month of 5-minute data
     * is 8,928 intervals — neither readable as a chart nor cheap — and
     * a view that quietly drops the end of a range is how somebody
     * concludes a meter stopped reporting.
     */
    throw Object.assign(
      new Error(
        `${days} days is more than this view draws at once. Ask for ${MAX_DAYS} days or fewer.`,
      ),
      { statusCode: 400, code: "RANGE_TOO_LONG" },
    );
  }

  /*
   * Half-open, and the end is the *next local midnight* rather than
   * 24 hours on: a spring-forward day is 23 hours long and an autumn
   * one 25, and adding a fixed day would cut an hour off one of them
   * and invent a gap in the other.
   */
  const rangeEnd = localMidnight(addDays(toDate, 1), timeZone);

  const rows = await prisma.meterReadInterval.findMany({
    where: { utilityId, meterId, intervalStart: { gte: fromDay, lt: rangeEnd } },
    orderBy: { intervalStart: "asc" },
    select: {
      intervalStart: true,
      lengthMinutes: true,
      quantity: true,
      quality: true,
    },
  });

  const intervals: IntervalPoint[] = rows.map((r) => ({
    intervalStart: r.intervalStart,
    lengthMinutes: r.lengthMinutes,
    quantity: r.quantity.toString(),
    quality: r.quality,
  }));

  const byQuality: Record<string, number> = {};
  let total = 0;
  let minutesCovered = 0;
  for (const i of intervals) {
    byQuality[i.quality] = (byQuality[i.quality] ?? 0) + 1;
    total += Number(i.quantity);
    minutesCovered += i.lengthMinutes;
  }

  /*
   * Only the gaps. The other three problem kinds — an overlap, an
   * overrun, a reading the meter had no value for — are real and
   * belong on the coverage queue, but this view draws *where there is
   * nothing*, and an overlap drawn as a hole would be a lie.
   */
  const gaps = findCoverageProblems(
    intervals.map((i) => ({ intervalStart: i.intervalStart, lengthMinutes: i.lengthMinutes })),
    { startDate: fromDay, endDate: rangeEnd },
  )
    .filter((p) => p.kind === "gap")
    .map((p) => ({ startsAt: p.startsAt, minutes: p.minutes }));

  return {
    meterId: meter.id,
    meterNumber: meter.meterNumber,
    uomCode: meter.uom?.code ?? null,
    from: fromDay,
    to: toDay,
    timeZone,
    reportsIntervals,
    intervals,
    summary: {
      count: intervals.length,
      // Summed as a number and printed to six places, the column's own
      // scale: these are quantities to look at, not a figure a bill is
      // computed from — that sum is the roll-up's, in Postgres.
      total: total.toFixed(6),
      byQuality,
      minutesCovered,
      minutesInRange: Math.round((rangeEnd.getTime() - fromDay.getTime()) / 60_000),
      gaps,
    },
  };
}

/** The local calendar day an instant falls on, as `YYYY-MM-DD`. */
function localDayOf(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return parts;
}

/** `YYYY-MM-DD` shifted by whole calendar days. */
function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00.000Z`);
  return new Date(at.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}
