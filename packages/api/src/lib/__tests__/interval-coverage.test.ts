import { describe, it, expect } from "vitest";
import { findCoverageProblems, findMissingReadings } from "../interval-coverage.js";

/**
 * Do a meter's intervals tile the period?
 *
 * The roll-up classified whatever rows it was given and objected to
 * three things — a `missing` reading, an interval it could not place,
 * one straddling a period change. All three are properties of a row
 * that *exists*. Nothing looked at whether the rows covered the
 * period, so a meter that lost three hours to a comms outage produced
 * buckets short by three hours of usage and a bill undercharged with
 * nothing anywhere saying so.
 *
 * Arithmetic on UTC instants, deliberately, rather than an expected
 * count. `window minutes ÷ interval length` needs the meter's length,
 * needs to know when a meter changed length mid-period, and is wrong
 * twice a year in opposite directions — a phantom gap every spring, a
 * real one missed every autumn. Adding milliseconds to instants is
 * immune to all three, which the DST cases below pin.
 */

const HOUR = 3_600_000;

/** `count` hourly intervals running from `from`. */
function hourly(from: string, count: number, lengthMinutes = 60) {
  const start = new Date(from).getTime();
  return Array.from({ length: count }, (_, i) => ({
    intervalStart: new Date(start + i * lengthMinutes * 60_000),
    lengthMinutes,
  }));
}

describe("interval coverage", () => {
  const period = {
    startDate: new Date("2026-07-01T06:00:00.000Z"),
    endDate: new Date("2026-07-02T06:00:00.000Z"),
  };

  it("is satisfied by intervals that tile the period exactly", () => {
    expect(findCoverageProblems(hourly("2026-07-01T06:00:00.000Z", 24), period)).toEqual([]);
  });

  it("reports a gap in the middle, where it starts and how long it is", () => {
    const rows = [
      ...hourly("2026-07-01T06:00:00.000Z", 3),
      ...hourly("2026-07-01T12:00:00.000Z", 18),
    ];

    const problems = findCoverageProblems(rows, period);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/2026-07-01T09:00/);
    expect(problems[0]!.message).toMatch(/180 minutes/);
  });

  /*
   * The kind and the minutes are data, not only a sentence.
   *
   * `meter_data_exception` keys on the kind and sums the minutes, and
   * the sweep used to recover the number by running a regex over its
   * own English — which quietly returned 0 the day a message was
   * reworded.
   */
  it("names each problem's kind, start and minutes as fields", () => {
    const rows = [
      ...hourly("2026-07-01T06:00:00.000Z", 3),
      ...hourly("2026-07-01T12:00:00.000Z", 18),
    ];

    expect(findCoverageProblems(rows, period)).toEqual([
      {
        kind: "gap",
        startsAt: new Date("2026-07-01T09:00:00.000Z"),
        minutes: 180,
        message: expect.stringContaining("undercharge"),
      },
    ]);
  });

  it("calls an overlap an overlap and an overrun an overrun", () => {
    const overlapping = [
      ...hourly("2026-07-01T06:00:00.000Z", 2),
      { intervalStart: new Date("2026-07-01T07:30:00.000Z"), lengthMinutes: 30 },
      ...hourly("2026-07-01T08:00:00.000Z", 22),
    ];
    const overrunning = [
      ...hourly("2026-07-01T06:00:00.000Z", 23),
      { intervalStart: new Date("2026-07-02T05:00:00.000Z"), lengthMinutes: 120 },
    ];

    expect(findCoverageProblems(overlapping, period)[0]).toMatchObject({
      kind: "overlap",
      startsAt: new Date("2026-07-01T07:30:00.000Z"),
      minutes: 30,
    });
    expect(findCoverageProblems(overrunning, period)[0]).toMatchObject({
      kind: "overrun",
      startsAt: new Date("2026-07-02T06:00:00.000Z"),
      minutes: 60,
    });
  });

  it("reports a period that does not start where its data does", () => {
    const problems = findCoverageProblems(hourly("2026-07-01T08:00:00.000Z", 22), period);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/2026-07-01T06:00/);
    expect(problems[0]!.message).toMatch(/120 minutes/);
  });

  it("reports data that stops before the period does", () => {
    const problems = findCoverageProblems(hourly("2026-07-01T06:00:00.000Z", 20), period);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/240 minutes/);
  });

  it("reports an overlap as usage counted twice", () => {
    // Two rows covering 07:00–08:00. The unique indexes cannot catch
    // this: a 30-minute row under a 60-minute one is a distinct key.
    const rows = [
      ...hourly("2026-07-01T06:00:00.000Z", 2),
      { intervalStart: new Date("2026-07-01T07:30:00.000Z"), lengthMinutes: 30 },
      ...hourly("2026-07-01T08:00:00.000Z", 22),
    ];

    const problems = findCoverageProblems(rows, period);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/twice/i);
    expect(problems[0]!.message).toMatch(/30 minutes/);
  });

  it("reports an interval running past the end of the period", () => {
    // Billing it would charge this period for energy used in the next.
    const rows = [
      ...hourly("2026-07-01T06:00:00.000Z", 23),
      { intervalStart: new Date("2026-07-02T05:00:00.000Z"), lengthMinutes: 120 },
    ];

    const problems = findCoverageProblems(rows, period);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/past the end/i);
    expect(problems[0]!.message).toMatch(/60 minutes/);
  });

  it("accepts a meter that changed interval length mid-period", () => {
    // An expected-count check would need to know when the change
    // happened; tiling does not care.
    const rows = [
      ...hourly("2026-07-01T06:00:00.000Z", 12),
      ...hourly("2026-07-01T18:00:00.000Z", 48, 15),
    ];

    expect(findCoverageProblems(rows, period)).toEqual([]);
  });

  it("says the whole period is missing when there are no intervals", () => {
    const problems = findCoverageProblems([], period);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/1440 minutes/);
  });

  it("does not mind an interval that is not on an hour boundary", () => {
    // Coverage is about tiling, not about where the boundaries fall.
    // Whether a boundary is billable is the straddle check's business.
    const rows = [
      { intervalStart: new Date("2026-07-01T06:00:00.000Z"), lengthMinutes: 90 },
      { intervalStart: new Date("2026-07-01T07:30:00.000Z"), lengthMinutes: 30 },
      ...hourly("2026-07-01T08:00:00.000Z", 22),
    ];

    expect(findCoverageProblems(rows, period)).toEqual([]);
  });
});

/**
 * A reading the meter did not take (spec 26, TOU-GAP-1).
 *
 * The other half of missing data, and the half that is *not* a hole in
 * the series: the row is there and says `missing`, which the migration
 * called "a gap the utility knows about reads differently from one
 * nobody has noticed". Tiling cannot see it — the interval exists and
 * covers its minutes — so it is a separate question over the same rows.
 */
describe("missing readings", () => {
  const quality = (q: string) => ({ quality: q });

  function series(qualities: string[]) {
    return qualities.map((q, i) => ({
      intervalStart: new Date(new Date("2026-07-01T06:00:00.000Z").getTime() + i * HOUR),
      lengthMinutes: 60,
      ...quality(q),
    }));
  }

  it("says nothing when every interval has a value", () => {
    expect(findMissingReadings(series(["actual", "actual", "edited"]))).toEqual([]);
  });

  it("reports a run of missing readings once, with the minutes it covers", () => {
    const problems = findMissingReadings(
      series(["actual", "missing", "missing", "missing", "actual"]),
    );

    expect(problems).toEqual([
      {
        kind: "missing_reading",
        startsAt: new Date("2026-07-01T07:00:00.000Z"),
        minutes: 180,
        message: expect.stringContaining("no value"),
      },
    ]);
  });

  it("keeps two separate runs apart, so the detail says where each was", () => {
    const problems = findMissingReadings(
      series(["missing", "actual", "actual", "missing", "missing"]),
    );

    expect(problems.map((p) => [p.startsAt.toISOString(), p.minutes])).toEqual([
      ["2026-07-01T06:00:00.000Z", 60],
      ["2026-07-01T09:00:00.000Z", 120],
    ]);
  });
});

describe("interval coverage across a daylight-saving change", () => {
  /*
   * The whole reason this is instant arithmetic rather than a count.
   * America/Denver: the clocks go back on 1 November 2026 and forward
   * on 8 March 2026, so those local days are 25 and 23 hours long. A
   * check that divided the window by the interval length would invent
   * a gap on one and miss a real one on the other.
   */
  it("accepts the 25 hourly intervals of a day the clocks go back", () => {
    const period = {
      // Local midnight 1 Nov (MDT, UTC-6) to local midnight 2 Nov (MST, UTC-7).
      startDate: new Date("2026-11-01T06:00:00.000Z"),
      endDate: new Date("2026-11-02T07:00:00.000Z"),
    };
    expect(period.endDate.getTime() - period.startDate.getTime()).toBe(25 * HOUR);

    expect(findCoverageProblems(hourly("2026-11-01T06:00:00.000Z", 25), period)).toEqual([]);
  });

  it("accepts the 23 hourly intervals of a day the clocks go forward", () => {
    const period = {
      // Local midnight 8 Mar (MST, UTC-7) to local midnight 9 Mar (MDT, UTC-6).
      startDate: new Date("2026-03-08T07:00:00.000Z"),
      endDate: new Date("2026-03-09T06:00:00.000Z"),
    };
    expect(period.endDate.getTime() - period.startDate.getTime()).toBe(23 * HOUR);

    expect(findCoverageProblems(hourly("2026-03-08T07:00:00.000Z", 23), period)).toEqual([]);
  });

  it("still finds a real gap on a day the clocks change", () => {
    const period = {
      startDate: new Date("2026-11-01T06:00:00.000Z"),
      endDate: new Date("2026-11-02T07:00:00.000Z"),
    };
    const rows = [
      ...hourly("2026-11-01T06:00:00.000Z", 10),
      ...hourly("2026-11-01T17:00:00.000Z", 14),
    ];

    const problems = findCoverageProblems(rows, period);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/60 minutes/);
  });
});
