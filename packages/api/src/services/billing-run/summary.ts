/**
 * What every view of a billing run has in common.
 *
 * Here rather than beside any one reader because the list, the detail
 * and the planner all build the same shape, and a second mapper would
 * be a second thing to get wrong.
 */

export interface BillingRunSummary {
  id: string;
  billingCycleId: string;
  /**
   * The cycle's own name and code, carried on every summary.
   *
   * Not a convenience: a run's identity to an operator *is* its cycle and
   * window ("the October residential run"), and a list showing a cycle
   * UUID would be a list nobody can read. Required by the type rather
   * than nullable, so a query that forgets the relation fails to compile
   * instead of rendering a blank column.
   */
  billingCycleName: string;
  billingCycleCode: string;
  windowStart: Date;
  windowEnd: Date;
  billDate: Date;
  dueDate: Date;
  status: string;
  accountCount: number;
  billedCount: number;
  failedCount: number;
  skippedCount: number;
  /**
   * `failedCount + skippedCount`, derived rather than stored.
   *
   * Carried because one figure is sometimes what a caller wants — a log
   * line, a list column — but never stored, so it cannot drift from the
   * two numbers it is made of. Anything deciding whether somebody has
   * work to do should read `failedCount`.
   */
  exceptionCount: number;
  postedAt: Date | null;
  /**
   * When the current posting pass began, or null if none is running.
   *
   * On the summary rather than the detail because it is a lifecycle
   * fact, like `postedAt` beside it: a list wanting to mark a run as
   * busy needs it as much as the detail screen does. With `postedAt`
   * still null it means a pass is under way.
   */
  postingStartedAt: Date | null;
  cancelRequested: boolean;
  lastProgressAt: Date | null;
  /**
   * Nobody started this run; the schedule did.
   *
   * Derived from a null `created_by` rather than stored. The screens
   * need it because a run that appears with no explanation reads as a
   * defect — and before the dispatcher there was no such run, so
   * neither screen said who started anything at all. Which *person*
   * started a manual run is a separate question needing a `cis_user`
   * lookup that no relation supports (`created_by` has no foreign key);
   * this answers the one the dispatcher made urgent.
   */
  scheduled: boolean;
  createdAt: Date;
}

/** The columns and the one relation every summary is built from. */
export const RUN_CYCLE_SELECT = { select: { name: true, cycleCode: true } } as const;

export function toSummary(run: {
  id: string;
  billingCycleId: string;
  windowStart: Date;
  windowEnd: Date;
  billDate: Date;
  dueDate: Date;
  status: string;
  accountCount: number;
  billedCount: number;
  failedCount: number;
  skippedCount: number;
  postedAt: Date | null;
  postingStartedAt: Date | null;
  cancelRequested: boolean;
  lastProgressAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  cycle: { name: string; cycleCode: string };
}): BillingRunSummary {
  return {
    id: run.id,
    billingCycleId: run.billingCycleId,
    billingCycleName: run.cycle.name,
    billingCycleCode: run.cycle.cycleCode,
    windowStart: run.windowStart,
    windowEnd: run.windowEnd,
    billDate: run.billDate,
    dueDate: run.dueDate,
    status: run.status,
    accountCount: run.accountCount,
    billedCount: run.billedCount,
    failedCount: run.failedCount,
    skippedCount: run.skippedCount,
    exceptionCount: run.failedCount + run.skippedCount,
    postedAt: run.postedAt,
    postingStartedAt: run.postingStartedAt,
    cancelRequested: run.cancelRequested,
    lastProgressAt: run.lastProgressAt,
    scheduled: run.createdBy === null,
    createdAt: run.createdAt,
  };
}
