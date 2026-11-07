import { describe, it, expect } from "vitest";
import { parseIntervalRow } from "../../imports/handlers/meter-read-interval.js";

/**
 * Reading an interval file row by row (spec 26, TOU-INT-2).
 *
 * Until this handler, **nothing in production could put an interval in
 * the database.** Everything downstream of `meter_read_interval` was
 * built and tested — tiling, classification, the roll-up into TOU
 * buckets, the gap queue, the pre-run blocker — and its only writer was
 * `seed/tou-service.js`. A utility with an AMI head-end had no way to
 * deliver a day of data.
 *
 * `parseRow` is where a file's wording becomes a row, and it is pure, so
 * it is tested without a database. Three things decide whether an
 * interval file is read correctly, and all three are easy to get
 * silently wrong:
 *
 * - **The length.** `meter_read_interval_length_known` allows 5, 15, 30
 *   and 60 only. A file claiming 10 must be refused here, naming the
 *   value, rather than failing on an insert whose message is a
 *   constraint name.
 * - **The quality.** Four words, and `missing` is a row rather than an
 *   absence — a gap the utility knows about reads differently from one
 *   nobody has noticed, which is the whole premise of the coverage
 *   queue.
 * - **The timestamp.** A head-end file often carries local times with
 *   no zone, and an interval's start is an instant. Reading
 *   `2026-03-08T02:30:00` as UTC when the meter meant Denver puts the
 *   row seven hours out, and nothing downstream can tell: it tiles
 *   perfectly, classifies into the wrong TOU period, and bills.
 */

const base = {
  meterNumber: "TOU-AMI-001",
  intervalStart: "2026-02-08T01:00:00Z",
  lengthMinutes: "60",
  quantity: "1.25",
};

const parse = (over: Record<string, string> = {}) =>
  parseIntervalRow({ ...base, ...over });

describe("an interval row", () => {
  it("reads the four fields a series needs", () => {
    const res = parse();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row).toMatchObject({
      meterNumber: "TOU-AMI-001",
      lengthMinutes: 60,
      quantity: "1.25",
      quality: "actual",
    });
    expect(res.row.intervalStart.toISOString()).toBe("2026-02-08T01:00:00.000Z");
  });

  it("defaults quality to actual, which is what a head-end sending nothing means", () => {
    const res = parse({ quality: "" });
    expect(res.ok && res.row.quality).toBe("actual");
  });

  it("takes the four qualities the column allows, in any case", () => {
    for (const [given, expected] of [
      ["ACTUAL", "actual"],
      ["Estimated", "estimated"],
      ["missing", "missing"],
      ["EDITED", "edited"],
    ]) {
      const res = parse({ quality: given! });
      expect(res.ok && res.row.quality, given).toBe(expected);
    }
  });

  it("refuses a quality the column would reject", () => {
    const res = parse({ quality: "guessed" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("INVALID_QUALITY");
    // Names the value and the vocabulary: a constraint-name error from
    // the insert tells an operator nothing they can act on.
    expect(res.message).toContain("guessed");
    expect(res.message).toContain("actual");
  });

  it("refuses a length the hypertable's CHECK would reject", () => {
    const res = parse({ lengthMinutes: "10" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("INVALID_LENGTH");
    expect(res.message).toContain("5, 15, 30, 60");
  });

  it("keeps a negative quantity, which is a meter exporting", () => {
    // No CHECK on the sign, deliberately: a net-metered premise sends
    // power back, and refusing that here would make solar unimportable.
    const res = parse({ quantity: "-0.75" });
    expect(res.ok && res.row.quantity).toBe("-0.75");
  });

  it("refuses a quantity that is not a number", () => {
    const res = parse({ quantity: "n/a" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("INVALID_QUANTITY");
  });

  it("refuses a row with no meter", () => {
    expect(parse({ meterNumber: "  " }).ok).toBe(false);
  });
});

describe("the timestamp, which is where an interval file goes silently wrong", () => {
  it("honours an explicit Z", () => {
    const res = parse({ intervalStart: "2026-02-08T01:00:00Z" });
    expect(res.ok && res.row.intervalStart.toISOString()).toBe("2026-02-08T01:00:00.000Z");
    expect(res.ok && res.row.zoneAssumed).toBe(false);
  });

  it("honours an explicit offset", () => {
    const res = parse({ intervalStart: "2026-02-08T01:00:00-07:00" });
    expect(res.ok && res.row.intervalStart.toISOString()).toBe("2026-02-08T08:00:00.000Z");
    expect(res.ok && res.row.zoneAssumed).toBe(false);
  });

  /*
   * A local time with no zone is the common case in head-end exports,
   * and it cannot be resolved here: the handler records that a zone has
   * to be assumed, and `processRow` resolves it against the tenant's
   * own timezone. Deciding it here would mean the pure function
   * knowing a tenant.
   */
  it("marks a zoneless timestamp as needing the tenant's zone", () => {
    const res = parse({ intervalStart: "2026-02-08T01:00:00" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.zoneAssumed).toBe(true);
    // Carried as the wall-clock fields, not as an instant: there is no
    // instant yet.
    expect(res.row.localWallClock).toBe("2026-02-08T01:00:00");
  });

  it("takes a space instead of the T, which spreadsheets produce", () => {
    const res = parse({ intervalStart: "2026-02-08 01:00:00" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.zoneAssumed).toBe(true);
    expect(res.row.localWallClock).toBe("2026-02-08T01:00:00");
  });

  it("refuses a timestamp it cannot read at all", () => {
    const res = parse({ intervalStart: "08/02/2026 1am" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("INVALID_INTERVAL_START");
  });

  it("refuses a date with no time, which is not an interval start", () => {
    // A day is not an instant, and silently reading it as midnight
    // would put 96 rows of a file onto one timestamp.
    const res = parse({ intervalStart: "2026-02-08" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("INVALID_INTERVAL_START");
  });
});
