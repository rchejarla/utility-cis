/**
 * What a sweep should do to the exceptions it opened last night
 * (spec 26, TOU-GAP-1 and TOU-INT-4c).
 *
 * The sweep re-examines the same week every night, so it finds the same
 * gap repeatedly. Deciding what that means is arithmetic on two sets —
 * what is wrong now, and what we already say is wrong — so it is a pure
 * function here rather than a sequence of writes in the service, where
 * each case would be a branch nobody could see all of at once.
 *
 * **An exception is one row per (meter, window, kind).** The window is
 * the day the sweep examined, not the gap's own start: that is what
 * makes a second sighting find its own row instead of opening another,
 * and what the partial unique index enforces for the rows that are
 * open. Several gaps in one day are one exception whose minutes sum —
 * a person working the queue wants "this meter, this day", not one task
 * per hole.
 *
 * **Resolution is scoped to what was swept.** An open exception for a
 * day outside the window is left alone, because not looking is not the
 * same as finding nothing. Without that, a tenant narrowing
 * `lookbackDays` from 7 to 2 would have five days of open exceptions
 * closed by a sweep that never examined them — and a resolved
 * exception reads as one somebody fixed.
 */

import type { DataExceptionKind, DataExceptionStatus } from "@utility-cis/shared";
import type { CoverageProblem } from "./interval-coverage.js";

/*
 * `DataExceptionKind` and `DataExceptionStatus` were declared here as
 * unions until the queue got a screen, which needs the same two lists
 * for its filter pills. They now come from `@utility-cis/shared`, where
 * the vocabulary is written once beside the CHECK constraints it
 * mirrors — the table's columns are VARCHARs, so nothing generates
 * them and a third hand-kept copy was the likely next step.
 *
 * Re-exported because this module's own callers take these types from
 * it, and `reconcileDataExceptions` is where they are most often read.
 */
export type { DataExceptionKind, DataExceptionStatus };

export interface FoundDataException {
  meterId: string;
  windowStart: Date;
  windowEnd: Date;
  kind: DataExceptionKind;
  minutesAffected: number;
  detail: string;
}

/**
 * An exception that already exists for a key and has not been resolved.
 *
 * `status` is carried because the three unresolved statuses mean
 * different things to a sweep: an `open` row is the sweep's own and may
 * be updated or closed, while `accepted` (billed as it stands) and
 * `estimated` (a value was supplied) are decisions a person made about
 * a problem that is still there — so the sweep finds it again every
 * night and must leave it alone. Without this, the decision would be
 * undone daily, and the partial unique index would not stop it: that
 * index forbids only a second *open* row.
 */
export interface ExistingDataException {
  id: string;
  meterId: string;
  windowStart: Date;
  kind: DataExceptionKind;
  status: DataExceptionStatus;
  minutesAffected: number;
  detail: string;
}

export interface DataExceptionReconciliation {
  toOpen: FoundDataException[];
  toUpdate: Array<{ id: string; minutesAffected: number; detail: string }>;
  toResolveIds: string[];
}

/**
 * One sweep finding per (meter, window, kind), from the problems the
 * tiling check reported.
 *
 * Several holes in one day become one exception whose minutes sum and
 * whose detail keeps every sentence. A person working the queue wants
 * "this meter, this day, four hours missing" and the specifics to read;
 * one task per hole would turn a bad night at a head-end into fifty.
 */
export function groupCoverageFindings(
  findings: Array<{
    meterId: string;
    window: { startDate: Date; endDate: Date };
    problems: CoverageProblem[];
  }>,
): FoundDataException[] {
  const byKey = new Map<string, FoundDataException>();

  for (const finding of findings) {
    for (const problem of finding.problems) {
      const key = keyOf({
        meterId: finding.meterId,
        windowStart: finding.window.startDate,
        kind: problem.kind,
      });
      const existing = byKey.get(key);
      if (existing) {
        existing.minutesAffected += problem.minutes;
        existing.detail = `${existing.detail}\n${problem.message}`;
        continue;
      }
      byKey.set(key, {
        meterId: finding.meterId,
        windowStart: finding.window.startDate,
        windowEnd: finding.window.endDate,
        kind: problem.kind,
        minutesAffected: problem.minutes,
        detail: problem.message,
      });
    }
  }

  return [...byKey.values()];
}

/** The identity of a problem: a meter, a day, and what is wrong with it. */
const keyOf = (e: { meterId: string; windowStart: Date; kind: DataExceptionKind }) =>
  `${e.meterId}|${e.windowStart.getTime()}|${e.kind}`;

export function reconcileDataExceptions(input: {
  /** The windows this sweep actually examined. */
  sweptWindowStarts: Date[];
  found: FoundDataException[];
  /** Every unresolved exception for the swept windows, whatever its status. */
  existing: ExistingDataException[];
}): DataExceptionReconciliation {
  const swept = new Set(input.sweptWindowStarts.map((d) => d.getTime()));
  const foundKeys = new Set(input.found.map(keyOf));

  /*
   * One row per key, preferring an `open` one. Both can exist: the
   * partial unique index constrains open rows only, so a key may carry
   * an accepted row from last week and an open row from last night.
   * Where it does, the open row is the one this sweep owns.
   */
  const byKey = new Map<string, ExistingDataException>();
  for (const row of input.existing) {
    const key = keyOf(row);
    const held = byKey.get(key);
    if (!held || (held.status !== "open" && row.status === "open")) {
      byKey.set(key, row);
    }
  }

  const toOpen: FoundDataException[] = [];
  const toUpdate: DataExceptionReconciliation["toUpdate"] = [];

  for (const problem of input.found) {
    const held = byKey.get(keyOf(problem));
    if (!held) {
      toOpen.push(problem);
      continue;
    }
    // Somebody has already decided what to do about this one.
    if (held.status !== "open") continue;
    /*
     * Both fields, because the minutes are the measure and the detail
     * is where in the day it happened. Neither changing means the night
     * writes nothing, which is the ordinary case and should cost one
     * read.
     */
    if (held.minutesAffected !== problem.minutesAffected || held.detail !== problem.detail) {
      toUpdate.push({
        id: held.id,
        minutesAffected: problem.minutesAffected,
        detail: problem.detail,
      });
    }
  }

  const toResolveIds = input.existing
    .filter(
      (row) =>
        row.status === "open" &&
        swept.has(row.windowStart.getTime()) &&
        !foundKeys.has(keyOf(row)),
    )
    .map((row) => row.id);

  return { toOpen, toUpdate, toResolveIds };
}
