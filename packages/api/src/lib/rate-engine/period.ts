/**
 * Arithmetic on a service period that more than one evaluator does, and
 * that all of them have to agree about.
 *
 * Every reader of a date here is a UTC one. A period's bounds are
 * dates, not moments: they come from `@db.Date` columns — the
 * agreement's start, the day after the last billed read, the read that
 * closes the interval — and Prisma hands those back as UTC midnight.
 * Read with local getters, UTC midnight on 1 January is 31 December
 * anywhere west of Greenwich, so an agreement starting 2025-01-01
 * billed in Montana resolved to 2024-Q4: a quarter in the wrong year,
 * which no utility had published an index for.
 */

/**
 * How long a billing interval is, in days, counting both ends.
 *
 * Inclusive because a service period's bounds are both billed days: a
 * read-to-read interval from the 31st to the 30th of the next month is
 * 31 days, not 30. Two evaluators need this — quantity proration and
 * tier-threshold proration — and they must agree, since one scales the
 * usage and the other the allowance it is measured against.
 */
export function daysIn(period: { startDate: Date; endDate: Date }): number {
  const ms = period.endDate.getTime() - period.startDate.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24)) + 1;
}

/*
 * The three below name the index row an `indexed` component prices
 * from. The manifest decides which row to load and the pricing
 * evaluator decides which one to read, so the two must produce the
 * same string — they held separate copies of this arithmetic, both
 * wrong the same way, which is how the fault stayed invisible: the
 * loader fetched the key the evaluator then asked for, and neither
 * existed.
 */

/** `2025-Q1`. */
export function quarterOf(d: Date): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** `2025-01`. */
export function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `2025`. */
export function yearOf(d: Date): string {
  return String(d.getUTCFullYear());
}

/** Summer is May–October; a tariff's seasonal rates turn on this. */
export function seasonOf(d: Date): "summer" | "winter" {
  const month = d.getUTCMonth();
  return month >= 4 && month <= 9 ? "summer" : "winter";
}
