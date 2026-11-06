/**
 * Writing what a sweep found to the exception queue (spec 26,
 * TOU-GAP-1).
 *
 * One module owns the conversation with `meter_data_exception`. The
 * decision of what to open, update and resolve is not here — it is
 * `reconcileDataExceptions`, a pure function over two sets, so that the
 * rule can be read and tested without a database and this file is only
 * the three writes it asks for.
 *
 * **Not in a transaction, deliberately.** Every run derives its plan
 * from the data as it stands, so a run that dies half-applied leaves
 * rows the next run reaches the same conclusion about. The state is
 * indistinguishable from a sweep still in progress and self-heals, and
 * wrapping it would hold a connection for the whole of a tenant's
 * writes to buy nothing a reader could name.
 *
 * `now` is passed in rather than taken from the clock here, so
 * `detected_at` and `resolved_at` come from the same clock as the sweep
 * that decided them — and so a test can say when it ran.
 */
import { prisma } from "../lib/prisma.js";
import {
  reconcileDataExceptions,
  type DataExceptionKind,
  type DataExceptionStatus,
  type FoundDataException,
} from "../lib/meter-data-exception.js";

export interface FlagResult {
  opened: number;
  updated: number;
  resolved: number;
}

export async function flagDataExceptions(input: {
  utilityId: string;
  /** The windows the sweep examined. Nothing outside them is resolved. */
  sweptWindowStarts: Date[];
  found: FoundDataException[];
  now: Date;
}): Promise<FlagResult> {
  if (input.sweptWindowStarts.length === 0) {
    return { opened: 0, updated: 0, resolved: 0 };
  }

  /*
   * Every *unresolved* exception for these days, not only the open
   * ones. An accepted or estimated row means somebody has decided what
   * to do about a problem that is still there, and the sweep finds it
   * again every night — so it has to see those rows to leave them
   * alone. The partial unique index would not catch the mistake: it
   * forbids a second open row, not an open row beside an accepted one.
   *
   * Resolved rows are excluded on purpose. A gap that was fixed in
   * March and returns in April is a new exception, which is what makes
   * a meter that fails every month visible.
   */
  const existing = await prisma.meterDataException.findMany({
    where: {
      utilityId: input.utilityId,
      status: { in: ["open", "accepted", "estimated"] },
      windowStart: { in: input.sweptWindowStarts },
    },
    select: {
      id: true,
      meterId: true,
      windowStart: true,
      kind: true,
      status: true,
      minutesAffected: true,
      detail: true,
    },
  });

  const plan = reconcileDataExceptions({
    sweptWindowStarts: input.sweptWindowStarts,
    found: input.found,
    // `kind` and `status` are VARCHARs with CHECKs rather than Postgres
    // enums, so the columns' types are wider than their vocabularies.
    // Narrowed here, at the one place rows enter the pure layer.
    existing: existing.map((row) => ({
      ...row,
      kind: row.kind as DataExceptionKind,
      status: row.status as DataExceptionStatus,
    })),
  });

  if (plan.toOpen.length > 0) {
    await prisma.meterDataException.createMany({
      data: plan.toOpen.map((f) => ({
        utilityId: input.utilityId,
        meterId: f.meterId,
        windowStart: f.windowStart,
        windowEnd: f.windowEnd,
        kind: f.kind,
        minutesAffected: f.minutesAffected,
        detail: f.detail,
        status: "open",
        detectedAt: input.now,
      })),
    });
  }

  for (const row of plan.toUpdate) {
    await prisma.meterDataException.update({
      where: { id: row.id },
      data: { minutesAffected: row.minutesAffected, detail: row.detail },
    });
  }

  if (plan.toResolveIds.length > 0) {
    await prisma.meterDataException.updateMany({
      where: { id: { in: plan.toResolveIds } },
      data: { status: "resolved", resolvedAt: input.now },
    });
  }

  return {
    opened: plan.toOpen.length,
    updated: plan.toUpdate.length,
    resolved: plan.toResolveIds.length,
  };
}
