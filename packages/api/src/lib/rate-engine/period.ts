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
