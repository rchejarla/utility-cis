import type { Prisma } from "@utility-cis/shared/src/generated/prisma";

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
