import { prisma } from "../lib/prisma.js";
import { loadTouCalendarById } from "../lib/rate-engine-loaders/load-tou-calendar.js";
import { findCoverageProblems } from "../lib/interval-coverage.js";
import { peakCodesUsedBy, resolvePeak } from "../lib/rate-engine/tou-calendar.js";
import { toLocalMoment } from "../lib/rate-engine/tou-clock.js";

/**
 * Turning interval data into TOU buckets (spec 26, TOU-INT-4, TOU-GAP-1).
 *
 * An interval meter reports one quantity per interval and says nothing
 * about periods; the published calendar is what classifies them. The
 * result is written as `meter_read` rows carrying a `peak_code` —
 * exactly the shape a register meter's read event produces — so the
 * rate engine never learns which kind of meter it is pricing.
 *
 * **It refuses rather than under-reports.** A bucket is a sum, and a
 * sum missing a day looks like a quiet month: nothing raises, the bill
 * is produced, and the customer is charged for less energy than they
 * used. So an unclassifiable interval, an interval straddling a period
 * change, or one marked `missing` stops the roll-up and is named. That
 * is TOU-GAP-1's rule — missing energy is never silently priced as
 * off-peak — applied one step earlier than the billing run.
 *
 * The calendar comes from the **rate schedule**, by id. Not from the
 * meter: TOU-CAL-11 is explicit that what a meter is programmed with
 * never decides pricing, and an interval meter is programmed with
 * nothing anyway. By id and not by name, because a published schedule
 * names one exact version and re-rating must reach the same one.
 */

export interface IntervalBucket {
  peakCode: string;
  /** Summed interval quantities, as a decimal string. */
  quantity: string;
  intervals: number;
}

export type RollUpResult =
  | { ok: true; buckets: IntervalBucket[]; intervalsRead: number; readEventId: string }
  | { ok: false; problems: string[]; intervalsRead: number };

export interface RollUpArgs {
  utilityId: string;
  meterId: string;
  serviceAgreementId: string;
  /** The TOU calendar version the rate schedule names. */
  touCalendarId: string;
  /** Half-open: intervals starting at or after `startDate`, before `endDate`. */
  period: { startDate: Date; endDate: Date };
  uomId: string;
}

const MINUTE_MS = 60_000;
/** How many problems are worth printing before the list itself is noise. */
const MAX_PROBLEMS = 10;

export async function rollUpIntervals(args: RollUpArgs): Promise<RollUpResult> {
  const { utilityId, meterId, serviceAgreementId, touCalendarId, period, uomId } = args;

  const load = await loadTouCalendarById(prisma, { utilityId, id: touCalendarId, period });
  if (!load.ok) return { ok: false, problems: [load.problem], intervalsRead: 0 };
  const { calendar } = load;

  const intervals = await prisma.meterReadInterval.findMany({
    where: {
      utilityId,
      meterId,
      intervalStart: { gte: period.startDate, lt: period.endDate },
    },
    orderBy: { intervalStart: "asc" },
    select: {
      intervalStart: true,
      lengthMinutes: true,
      quantity: true,
      quality: true,
    },
  });

  if (intervals.length === 0) {
    return {
      ok: false,
      problems: ["No interval data for this meter in this period."],
      intervalsRead: 0,
    };
  }

  const problems: string[] = [];
  /** peakCode → [sum, count]. A Map keeps the calendar's own codes. */
  const totals = new Map<string, { sum: number; intervals: number }>();

  /*
   * Every period the calendar uses starts at zero, including ones this
   * month never reaches.
   *
   * The same contract the register importer has — a row per TOU
   * register on every read event, zero consumption included — and for
   * the same reason. A missing bucket is not a zero: the loader leaves
   * the key unset and the `tou_period` quantity source *raises*, by
   * design, because on a register meter an absent period means usage
   * the meter rolled into another dial. An interval meter has no such
   * ambiguity: the calendar says which periods exist, and a month with
   * no mid-peak hours in it used no mid-peak energy. Without this, a
   * three-period tariff could not bill a month whose season has two —
   * which is every winter month of the seeded calendar.
   */
  for (const code of peakCodesUsedBy(calendar.definition)) {
    totals.set(code, { sum: 0, intervals: 0 });
  }

  /*
   * Does the data cover the period at all?
   *
   * First, because every check below is a property of a row that
   * exists and none of them can see an interval that was never
   * delivered. Without this the loop classified the 741 rows it was
   * given, objected to nothing, and produced buckets three hours
   * short — a bill undercharged with nothing saying so.
   */
  problems.push(...findCoverageProblems(intervals, period));

  for (const row of intervals) {
    const at = row.intervalStart.toISOString();

    if (row.quality === "missing") {
      problems.push(`${at}: the meter reported no value for this interval.`);
      continue;
    }

    const start = toLocalMoment(row.intervalStart, calendar.timeZone, calendar.clockBasis);
    const startPeak = resolvePeak({
      date: start.date,
      minuteOfDay: start.minuteOfDay,
      calendar: calendar.definition,
      seasons: calendar.seasons,
      observedHolidays: calendar.observedHolidays,
    });
    if (!startPeak.ok) {
      problems.push(`${at}: ${startPeak.problem}`);
      continue;
    }

    /*
     * TOU-INT-4, checked per interval rather than per import.
     *
     * 5- and 15-minute data divides the slot grid and can never
     * straddle; 30- and 60-minute data can, and an interval spanning
     * 16:30–17:30 against a 17:00 peak boundary has no honest single
     * answer. Classifying it by its start would price half an hour of
     * on-peak energy at the off-peak rate, every day, invisibly. The
     * last instant of the interval is the one that disagrees, so that
     * is what is classified.
     */
    const lastInstant = new Date(
      row.intervalStart.getTime() + row.lengthMinutes * MINUTE_MS - 1,
    );
    const end = toLocalMoment(lastInstant, calendar.timeZone, calendar.clockBasis);
    const endPeak = resolvePeak({
      date: end.date,
      minuteOfDay: end.minuteOfDay,
      calendar: calendar.definition,
      seasons: calendar.seasons,
      observedHolidays: calendar.observedHolidays,
    });
    if (endPeak.ok && endPeak.peakCode !== startPeak.peakCode) {
      problems.push(
        `${at}: this ${row.lengthMinutes}-minute interval starts in "${startPeak.peakCode}" and ends in "${endPeak.peakCode}". ` +
          "Shorter intervals, or a period boundary on the interval grid, would resolve it.",
      );
      continue;
    }

    const bucket = totals.get(startPeak.peakCode) ?? { sum: 0, intervals: 0 };
    bucket.sum += Number(row.quantity);
    bucket.intervals += 1;
    totals.set(startPeak.peakCode, bucket);
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_PROBLEMS);
    if (problems.length > shown.length) {
      shown.push(`…and ${problems.length - shown.length} more.`);
    }
    return { ok: false, problems: shown, intervalsRead: intervals.length };
  }

  const buckets: IntervalBucket[] = [...totals.entries()]
    .map(([peakCode, t]) => ({
      peakCode,
      quantity: t.sum.toFixed(4),
      intervals: t.intervals,
    }))
    .sort((a, b) => a.peakCode.localeCompare(b.peakCode));

  /*
   * Stamped at the end of the period, like a register meter's read: the
   * bucket describes consumption up to that moment, and the loader
   * selects reads by `readDatetime` within the billing period.
   */
  const readDatetime = new Date(period.endDate.getTime() - 1);
  const readDate = new Date(readDatetime.toISOString().slice(0, 10));

  const readEventId = await prisma.$transaction(async (tx) => {
    /*
     * Replace, so a re-run after a correction does not double the
     * month. Only this meter's interval-derived rows for this period
     * are removed — `reading: null` is what distinguishes them from a
     * register meter's buckets, which have dials behind them and are
     * not ours to delete.
     */
    await tx.meterRead.deleteMany({
      where: {
        utilityId,
        meterId,
        readDatetime: { gte: period.startDate, lt: period.endDate },
        peakCode: { not: null },
        reading: null,
        billedAt: null,
      },
    });

    const eventId = crypto.randomUUID();
    await tx.meterRead.createMany({
      data: buckets.map((b) => ({
        utilityId,
        meterId,
        serviceAgreementId,
        readEventId: eventId,
        uomId,
        readDate,
        readDatetime,
        // No dial. A sum over classified intervals has no cumulative
        // reading, and inventing one would put a number on the bill
        // that matches nothing on the device.
        reading: null,
        priorReading: null,
        consumption: b.quantity,
        peakCode: b.peakCode,
        readType: "AMI" as const,
        readSource: "AMI" as const,
      })),
    });
    return eventId;
  });

  return { ok: true, buckets, intervalsRead: intervals.length, readEventId };
}
