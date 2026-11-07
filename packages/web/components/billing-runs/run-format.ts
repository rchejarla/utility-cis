/*
 * `RunBlocker` and `RunWarning` come from `shared`. They were
 * declared here as well until 2026-11-03 — two hand-maintained
 * copies of a union of codes, where adding a code on one side only
 * type-checks on both and shows the operator an empty row.
 *
 * The wording stays here. That is this file's job.
 */
import type { RunBlocker, RunWarning } from "@utility-cis/shared";

export type { RunBlocker, RunWarning };

/**
 * What a billing run looks like to this app, and how its dates are read.
 *
 * The types are here rather than on a page because the list and the
 * detail show the same run and must agree about it; the formatter is
 * here because both print date-only columns and getting that wrong
 * shifts a bill date by a day.
 */

export interface BillingRunRow {
  id: string;
  billingCycleId: string;
  billingCycleName: string;
  billingCycleCode: string;
  windowStart: string;
  windowEnd: string;
  billDate: string;
  dueDate: string;
  status: string;
  accountCount: number;
  billedCount: number;
  /** The work. Separate from skipped, deliberately — see the pages. */
  failedCount: number;
  /** Nothing to bill. Ordinary, and not work. */
  skippedCount: number;
  postedAt: string | null;
  cancelRequested: boolean;
  lastProgressAt: string | null;
  /**
   * Nobody started this run; the schedule did.
   *
   * Rendered on both screens, because a run appearing with no
   * explanation reads as a defect. Before the billing dispatcher every
   * run had a person behind it, so neither screen said who started
   * anything — which is why carrying this from the API was not enough on
   * its own (27-job-scheduling SCH-BILL-10).
   */
  scheduled: boolean;
  createdAt: string;
}

export interface BillingRunItemRow {
  id: string;
  accountId: string;
  accountNumber: string;
  customerName: string | null;
  status: string;
  billId: string | null;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  segmentCount: number;
  total: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  processedAt: string | null;
}

/** What the run would be if it were started now. */
export interface BillingRunPreview {
  billingCycleId: string;
  billingCycleName: string;
  billingCycleCode: string;
  windowStart: string;
  windowEnd: string;
  billDate: string;
  dueDate: string;
  accountCount: number;
  /** Of those, how many can actually be billed as configured. */
  billableCount: number;
  /**
   * Why the rest cannot, by cause rather than by account — one publish
   * or one assignment usually clears a whole group.
   */
  blockers: RunBlocker[];
  /**
   * Accounts that **will** bill, and bill wrongly — a separate list
   * because the instruction is different. Putting these among the
   * blockers would make "N of M cannot be billed yet" overstate itself
   * and hold a run that should go ahead.
   */
  warnings?: RunWarning[];
  existingRun: { id: string; status: string } | null;
}


const plural = (n: number) => `${n.toLocaleString()} account${n === 1 ? "" : "s"}`;

/** What to do about a blocker, in the operator's terms. */
export function describeBlocker(b: RunBlocker): string {
  const accounts = plural(b.accountCount);
  switch (b.code) {
    case "SCHEDULE_NOT_PUBLISHED":
      return `${accounts}: rate schedule not published — ${b.detail}. Publish it and these will bill.`;
    case "NO_ACTIVE_ASSIGNMENTS":
      return `${accounts}: no rate schedule assigned — ${b.detail}. Assign one on the agreement.`;
    /*
     * The TOU details already arrive as whole sentences from the
     * readiness service, so these do not re-explain them — one place
     * writes the wording, and the agreement's own page says the same.
     */
    case "TOU_PERIOD_NOT_REPORTED":
      return `${accounts}: a TOU period the tariff prices was never reported — ${b.detail}`;
    case "TOU_NO_READS":
      return `${accounts}: no TOU usage for this period — ${b.detail}`;
    case "TOU_INTERVALS_INCOMPLETE":
      return `${accounts}: interval data does not cover the period — ${b.detail}`;
  }
}

/**
 * What a warning means, in the operator's terms.
 *
 * Each says the bill *will* be produced, because that is the decision
 * in front of them: these do not stop a run, and running anyway is
 * sometimes the right call mid-migration.
 */
export function describeWarning(w: RunWarning): string {
  const accounts = plural(w.accountCount);
  switch (w.code) {
    case "TOU_CALENDAR_MISMATCH":
      return `${accounts}: will bill against hours the meter was not counting by — ${w.detail}`;
    case "TOU_CALENDAR_UNKNOWN":
      return `${accounts}: the meter's TOU programming is not recorded, so a mismatch cannot be ruled out — ${w.detail}`;
    case "TOU_REGISTERS_UNRECONCILED":
      return `${accounts}: the TOU registers do not sum to the total register — ${w.detail}`;
  }
}

/**
 * Render a date-only value without letting the local timezone shift it.
 *
 * `new Date("2026-06-30")` is UTC midnight, which is the 29th west of
 * Greenwich — a bill date would appear a day early, and a bill date is
 * the one on the paper a customer holds.
 */
export function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}

/** Inclusive day count across a date-only interval. */
export function daysInclusive(startIso: string, endIso: string): number {
  const start = Date.parse(`${startIso.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${endIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
}

/** `$1,234.56`, or a dash where there is no figure at all. */
export function fmtMoney(amount: string | null): string {
  if (amount === null) return "—";
  const n = Number(amount);
  if (Number.isNaN(n)) return "—";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
