import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { computeBillPeriod } from "../bill.service.js";

/**
 * Billing windows, in one place: which service agreements belong to one
 * (`agreementInWindow`) and which window a given day falls in
 * (`windowContaining`). Each was once written twice and drifted, or would
 * have been; callers import these rather than restating either.
 */

/**
 * Which service agreements belong to a billing window.
 *
 * **There were two answers to this and they disagreed.** The planner
 * asked for an overlap — started on or before the window ends, had not
 * ended before it began. The executor asked for an agreement still open
 * at the window's *end*. So a service that stopped on the 20th of a
 * window ending on the 30th was put in the run by one and found not to
 * exist by the other: the account came back `SKIPPED` with
 * `NO_ACTIVE_ASSIGNMENTS`, a code `classify` files as noise an operator
 * scrolls past, and the days between the last bill and the final read
 * were billed by nothing — not by that run, not by the next one, which
 * excludes the agreement under either filter.
 *
 * The overlap is the right question, because a utility has to bill
 * service that was taken. `resolveServicePeriod` was always able to do
 * it: the period ends at the newest unbilled read, so a final read on
 * the 20th gives a period ending on the 20th with no proration logic
 * needed here. Only the gate in front of it was wrong.
 *
 * It cannot stretch past the stop date either. Closing an agreement
 * end-dates its service points and meter installations
 * (`closeServiceAgreement`), and a read resolves its agreement through
 * an open installation — so a read dated after the service ended cannot
 * be stamped on it in the first place.
 *
 * One function rather than two matching literals: the literals already
 * drifted once, silently, and the next edit would have to notice three
 * other call sites to keep them together.
 */
export function agreementInWindow(window: {
  periodStart: Date;
  periodEnd: Date;
}): Prisma.ServiceAgreementWhereInput {
  return {
    startDate: { lte: window.periodEnd },
    OR: [{ endDate: null }, { endDate: { gte: window.periodStart } }],
  };
}

/**
 * The window that *contains* `day`, which is not what `computeBillPeriod`
 * returns for `asOf = day`: that is the last period already closed on
 * that day, so a day between two bill days falls after its end. A read
 * on the 5th belongs to the window the run on the 10th will bill, and a
 * skip on the 3rd to the same one; asking for the closed period would
 * put both in last month's, and a date-range match on it would find
 * neither. The next period's end is 28 to 31 days on, so one more call
 * with `asOf` 31 days past the closed end lands on it and not the one
 * after.
 *
 * **That probe rests on `computeBillPeriod`'s `periodEnd` being
 * inclusive** (a bill day is the last day of the period ending on it,
 * `d >= thisMonth` there). The `day <= periodEnd` test is that equality
 * case: a read on the bill day itself is in the window that ends on it.
 * Were the end ever made exclusive, this would return the previous
 * window on every bill day; the integration test pins the day before,
 * the day of and the day after the bill day for that reason.
 *
 * **`day` is normalised to UTC midnight here, and that is load-bearing.**
 * `periodEnd` is UTC midnight on the bill day, so a `Date` carrying a
 * time of day fails `day <= periodEnd` on the bill day itself, takes the
 * probe below, and returns the window starting *tomorrow* — the one day
 * a month this function can be wrong, and silently. It was: until
 * 2026-11-18 `getReadingProgress` handed it `new Date()` for a
 * reading-week question, so every bill day the route page printed next
 * month's window and counted that morning's reads as unread.
 *
 * Normalised here rather than at the call sites because the parameter is
 * a *day* and four of the five callers were correct only by accident of
 * their input — a parsed `YYYY-MM-DD`, or something already through
 * `utcDay`. Those four are unaffected: midnight normalises to itself.
 * Nothing wants sub-day precision from a function whose answer is a
 * pair of dates.
 */
export function windowContaining(
  cycle: { billDayOfMonth: number; frequency: string },
  dayInput: Date,
): { periodStart: Date; periodEnd: Date } {
  const day = new Date(
    Date.UTC(dayInput.getUTCFullYear(), dayInput.getUTCMonth(), dayInput.getUTCDate()),
  );
  const epoch = { createdAt: new Date(0), billingCycle: cycle };
  const closed = computeBillPeriod(epoch, day);
  if (day <= closed.periodEnd) return closed;
  return computeBillPeriod(epoch, new Date(closed.periodEnd.getTime() + 31 * 86_400_000));
}
