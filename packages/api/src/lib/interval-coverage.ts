/**
 * Where a meter's intervals fail to cover a period (spec 26, TOU-GAP-1).
 *
 * The roll-up's other three checks are all properties of a row that
 * exists: a `missing` reading, an interval that cannot be placed, one
 * straddling a period change. None of them can see an interval that
 * was never delivered — so a meter that lost three hours to a comms
 * outage or a truncated import produced buckets short by three hours
 * of usage, and a bill undercharged with nothing anywhere saying so.
 * The migration said both cases should behave alike: a gap "reads
 * differently from one nobody has noticed, and TOU-GAP-1 refuses to
 * bill either as off-peak". Only the self-reported half was built.
 *
 * **Tiling, not counting.** The obvious check is
 * `window minutes ÷ interval length` against the number of rows, and
 * it is wrong three ways: it needs the meter's interval length, it
 * needs to know when a meter changed length mid-period, and a local
 * day is 23 or 25 hours long twice a year — so it would invent a gap
 * every spring and miss a real one every autumn, on exactly the days a
 * TOU calendar matters most. Asking whether each interval starts where
 * the last one ended is arithmetic on UTC instants, which neither skip
 * nor repeat, and needs to know none of those things.
 */

const MINUTE_MS = 60_000;

export interface CoveredInterval {
  intervalStart: Date;
  lengthMinutes: number;
}

/**
 * Why a window's intervals cannot be billed as they stand.
 *
 * The first three are failures to **tile**: the series does not cover
 * the window, or covers part of it twice. The fourth is a property of a
 * row that is there — the meter reported no value for it — which tiling
 * cannot see, because the interval exists and covers its minutes.
 *
 * The same vocabulary as `meter_data_exception.kind`, so a problem
 * becomes a row without translation.
 */
export type CoverageProblemKind = "gap" | "overlap" | "overrun" | "missing_reading";

/**
 * One problem, as fields rather than only as a sentence.
 *
 * The kind and the minutes are what `meter_data_exception` keys and
 * sums on. They were recoverable only by running a regex over the
 * message, which returns 0 rather than failing the day somebody
 * rewords it.
 */
export interface CoverageProblem {
  kind: CoverageProblemKind;
  /** Where the problem begins, as a UTC instant. */
  startsAt: Date;
  minutes: number;
  /** The same sentence as before, for a log line or an exception's detail. */
  message: string;
}

const minutes = (ms: number) => Math.round(ms / MINUTE_MS);
const at = (ms: number) => new Date(ms).toISOString();

/**
 * Every place the intervals do not tile `period`, in time order.
 *
 * `intervals` must be sorted by `intervalStart` — the roll-up's query
 * already orders them, and sorting here would hide a caller that had
 * not.
 *
 * Overlaps are reported as well as gaps: the same energy counted twice
 * is as wrong as energy counted never, and the table's partial unique
 * indexes cannot catch it, because a 30-minute row underneath a
 * 60-minute one is a distinct key.
 */
export function findCoverageProblems(
  intervals: CoveredInterval[],
  period: { startDate: Date; endDate: Date },
): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  const end = period.endDate.getTime();
  /** Where the next interval has to begin for the period to be covered. */
  let cursor = period.startDate.getTime();

  for (const row of intervals) {
    const start = row.intervalStart.getTime();

    if (start > cursor) {
      problems.push({
        kind: "gap",
        startsAt: new Date(cursor),
        minutes: minutes(start - cursor),
        message:
          `${at(cursor)}: no interval data for the ${minutes(start - cursor)} minutes from here. ` +
          "That usage cannot be split into TOU periods, and billing without it would undercharge.",
      });
    } else if (start < cursor) {
      problems.push({
        kind: "overlap",
        startsAt: new Date(start),
        minutes: minutes(cursor - start),
        message:
          `${at(start)}: this interval starts before the previous one ended, so ` +
          `${minutes(cursor - start)} minutes of usage would be counted twice.`,
      });
    }

    // From the later of the two, so one overlapping row does not make
    // every row after it look like a gap as well.
    cursor = Math.max(cursor, start + row.lengthMinutes * MINUTE_MS);
  }

  if (cursor < end) {
    problems.push({
      kind: "gap",
      startsAt: new Date(cursor),
      minutes: minutes(end - cursor),
      message:
        `${at(cursor)}: the period's last ${minutes(end - cursor)} minutes have no interval data. ` +
        "That usage cannot be split into TOU periods, and billing without it would undercharge.",
    });
  } else if (cursor > end) {
    problems.push({
      kind: "overrun",
      startsAt: new Date(end),
      minutes: minutes(cursor - end),
      message:
        `${at(end)}: the last interval runs ${minutes(cursor - end)} minutes past the end of the ` +
        "period, so this period would be charged for energy used in the next one.",
    });
  }

  return problems;
}

/** An interval with the quality the meter or an import gave it. */
export interface QualifiedInterval extends CoveredInterval {
  quality: string;
}

/**
 * Every run of intervals the meter reported no value for.
 *
 * A **separate question over the same rows**, not part of tiling: a
 * `missing` row covers its minutes, so `findCoverageProblems` is
 * satisfied by it and should be — the two failures have different
 * answers. A hole means chase the data that never arrived; a `missing`
 * reading means the meter itself said it had none, which an estimate
 * may be the only honest way out of.
 *
 * Consecutive missing intervals coalesce into one problem, for the same
 * reason a gap is one problem rather than one per absent interval: a
 * day of 15-minute data gone is 96 rows and one fact.
 *
 * `intervals` must be sorted by `intervalStart`, as above.
 */
export function findMissingReadings(intervals: QualifiedInterval[]): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  let run: { startsAt: Date; minutes: number } | null = null;

  const close = () => {
    if (!run) return;
    problems.push({
      kind: "missing_reading",
      startsAt: run.startsAt,
      minutes: run.minutes,
      message:
        `${at(run.startsAt.getTime())}: the meter reported no value for the ` +
        `${run.minutes} minutes from here. Billing them as zero would undercharge, ` +
        "and an estimate is a decision somebody has to make.",
    });
    run = null;
  };

  for (const row of intervals) {
    if (row.quality !== "missing") {
      close();
      continue;
    }
    if (run) {
      run.minutes += row.lengthMinutes;
    } else {
      run = { startsAt: row.intervalStart, minutes: row.lengthMinutes };
    }
  }
  close();

  return problems;
}
