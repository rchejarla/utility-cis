import { describe, it, expect } from "vitest";
import { groupCoverageFindings, reconcileDataExceptions } from "../meter-data-exception.js";

/**
 * What a sweep should do to the exceptions it already opened.
 *
 * The sweep re-examines the same week every night, so the same gap is
 * found again and again. Three things have to be true for that to be
 * useful rather than noisy: the second sighting must not open a second
 * row, a gap that has been backfilled must close itself, and a night
 * that found nothing new must write nothing at all.
 *
 * The fourth is the one that would be silently wrong: an exception for
 * a day **outside** the swept window must be left alone. A tenant that
 * narrows `lookbackDays` from 7 to 2 would otherwise have five days of
 * open exceptions resolved by a sweep that never looked at them — which
 * reads, in the queue, exactly like somebody having fixed them.
 */

const MONDAY = new Date("2026-10-05T06:00:00.000Z");
const TUESDAY = new Date("2026-10-06T06:00:00.000Z");
const WEDNESDAY = new Date("2026-10-07T06:00:00.000Z");

const METER = "11111111-1111-4111-8111-111111111111";

function foundGap(windowStart: Date, overrides: Record<string, unknown> = {}) {
  return {
    meterId: METER,
    windowStart,
    windowEnd: new Date(windowStart.getTime() + 24 * 3_600_000),
    kind: "gap" as const,
    minutesAffected: 180,
    detail: "three hours missing",
    ...overrides,
  };
}

function openGap(windowStart: Date, overrides: Record<string, unknown> = {}) {
  return {
    id: `open-${windowStart.toISOString()}`,
    meterId: METER,
    windowStart,
    kind: "gap" as const,
    status: "open" as const,
    minutesAffected: 180,
    detail: "three hours missing",
    ...overrides,
  };
}

describe("groupCoverageFindings", () => {
  const window = { startDate: MONDAY, endDate: new Date(MONDAY.getTime() + 24 * 3_600_000) };

  it("makes one exception per kind, summing the minutes and keeping every sentence", () => {
    const found = groupCoverageFindings([
      {
        meterId: METER,
        window,
        problems: [
          { kind: "gap", startsAt: MONDAY, minutes: 180, message: "three hours missing" },
          { kind: "gap", startsAt: MONDAY, minutes: 60, message: "one more hour missing" },
          { kind: "overrun", startsAt: MONDAY, minutes: 30, message: "runs over" },
        ],
      },
    ]);

    expect(found).toEqual([
      {
        meterId: METER,
        windowStart: MONDAY,
        windowEnd: window.endDate,
        kind: "gap",
        minutesAffected: 240,
        detail: "three hours missing\none more hour missing",
      },
      {
        meterId: METER,
        windowStart: MONDAY,
        windowEnd: window.endDate,
        kind: "overrun",
        minutesAffected: 30,
        detail: "runs over",
      },
    ]);
  });

  it("keeps two meters' findings for the same day apart", () => {
    const other = "22222222-2222-4222-8222-222222222222";

    const found = groupCoverageFindings([
      {
        meterId: METER,
        window,
        problems: [{ kind: "gap", startsAt: MONDAY, minutes: 60, message: "a" }],
      },
      {
        meterId: other,
        window,
        problems: [{ kind: "gap", startsAt: MONDAY, minutes: 60, message: "b" }],
      },
    ]);

    expect(found.map((f) => f.meterId)).toEqual([METER, other]);
  });
});

describe("reconcileDataExceptions", () => {
  it("opens an exception for a problem nothing is tracking", () => {
    const result = reconcileDataExceptions({
      sweptWindowStarts: [MONDAY],
      found: [foundGap(MONDAY)],
      existing:[],
    });

    expect(result.toOpen).toEqual([foundGap(MONDAY)]);
    expect(result.toUpdate).toEqual([]);
    expect(result.toResolveIds).toEqual([]);
  });

  it("resolves an open exception whose problem the sweep no longer finds", () => {
    const result = reconcileDataExceptions({
      sweptWindowStarts: [MONDAY],
      found: [],
      existing:[openGap(MONDAY)],
    });

    expect(result.toResolveIds).toEqual([openGap(MONDAY).id]);
    expect(result.toOpen).toEqual([]);
  });

  it("leaves an unchanged exception alone, so a quiet night writes nothing", () => {
    const result = reconcileDataExceptions({
      sweptWindowStarts: [MONDAY],
      found: [foundGap(MONDAY)],
      existing:[openGap(MONDAY)],
    });

    expect(result).toEqual({ toOpen: [], toUpdate: [], toResolveIds: [] });
  });

  it("updates the minutes when some of the gap has been backfilled", () => {
    const result = reconcileDataExceptions({
      sweptWindowStarts: [MONDAY],
      found: [foundGap(MONDAY, { minutesAffected: 60, detail: "one hour missing" })],
      existing:[openGap(MONDAY)],
    });

    expect(result.toUpdate).toEqual([
      { id: openGap(MONDAY).id, minutesAffected: 60, detail: "one hour missing" },
    ]);
    expect(result.toOpen).toEqual([]);
    expect(result.toResolveIds).toEqual([]);
  });

  /*
   * The minutes alone are not the problem's identity. Three hours
   * missing from the small hours and three hours missing from the
   * evening peak are the same number and very different bills, so a row
   * whose detail still describes yesterday's gap is misleading in the
   * one place somebody is working from it.
   */
  it("updates the detail when the gap has moved but not shrunk", () => {
    const result = reconcileDataExceptions({
      sweptWindowStarts: [MONDAY],
      found: [foundGap(MONDAY, { detail: "three hours missing, from 17:00" })],
      existing:[openGap(MONDAY)],
    });

    expect(result.toUpdate).toEqual([
      {
        id: openGap(MONDAY).id,
        minutesAffected: 180,
        detail: "three hours missing, from 17:00",
      },
    ]);
  });

  it("does not resolve an exception for a day it did not sweep", () => {
    const result = reconcileDataExceptions({
      sweptWindowStarts: [WEDNESDAY],
      found: [],
      existing:[openGap(MONDAY), openGap(TUESDAY)],
    });

    expect(result.toResolveIds).toEqual([]);
  });

  it("keys on the kind, so a gap and an overrun on one day are two exceptions", () => {
    const overrun = foundGap(MONDAY, { kind: "overrun", minutesAffected: 60, detail: "runs over" });

    const result = reconcileDataExceptions({
      sweptWindowStarts: [MONDAY],
      found: [foundGap(MONDAY), overrun],
      existing:[openGap(MONDAY)],
    });

    expect(result.toOpen).toEqual([overrun]);
    expect(result.toResolveIds).toEqual([]);
  });

  /*
   * The judgement cases. `accepted` means somebody decided to bill the
   * month as it stands and `estimated` means a value was supplied —
   * both are decisions about a problem that is still there, so the
   * sweep finds it again every night. Re-opening it would undo the
   * decision daily, and the partial unique index would not stop it:
   * that index only forbids a second *open* row.
   */
  it("does not re-open a problem somebody has accepted", () => {
    const result = reconcileDataExceptions({
      sweptWindowStarts: [MONDAY],
      found: [foundGap(MONDAY)],
      existing: [openGap(MONDAY, { status: "accepted", id: "accepted-1" })],
    });

    expect(result).toEqual({ toOpen: [], toUpdate: [], toResolveIds: [] });
  });

  it("does not resolve an accepted exception when the data turns up", () => {
    // The bill went out on the month as it stood. Closing the record of
    // that decision as though the data had always been there loses the
    // only evidence of why the bill looks like it does.
    const result = reconcileDataExceptions({
      sweptWindowStarts: [MONDAY],
      found: [],
      existing: [openGap(MONDAY, { status: "estimated", id: "estimated-1" })],
    });

    expect(result.toResolveIds).toEqual([]);
  });

  it("tells two meters' exceptions for the same day apart", () => {
    const otherMeter = "22222222-2222-4222-8222-222222222222";

    const result = reconcileDataExceptions({
      sweptWindowStarts: [MONDAY],
      found: [foundGap(MONDAY, { meterId: otherMeter })],
      existing:[openGap(MONDAY)],
    });

    expect(result.toOpen).toEqual([foundGap(MONDAY, { meterId: otherMeter })]);
    expect(result.toResolveIds).toEqual([openGap(MONDAY).id]);
  });
});
