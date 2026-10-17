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
  existingRun: { id: string; status: string } | null;
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
