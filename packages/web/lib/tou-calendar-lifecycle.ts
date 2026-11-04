export type TouCalendarLifecycle = "Draft" | "Published" | "Superseded";

/**
 * Which state a TOU calendar version is in.
 *
 * Defined once because the list and the editor must agree about the row
 * you are looking at — the same reason `rate-schedule-lifecycle.ts`
 * exists, and the same failure if they do not.
 *
 * **Supersession wins over publication.** A replaced version is still
 * published — `publishTouCalendar` set that timestamp and nothing
 * clears it — so reading `publishedAt` first shows a retired version as
 * current, which is what sends somebody to read the wrong hours. That
 * was the bug: the badge looked only at `publishedAt`.
 */
export function touCalendarLifecycle(calendar: {
  publishedAt?: string | null;
  supersededById?: string | null;
}): TouCalendarLifecycle {
  if (calendar.supersededById) return "Superseded";
  if (calendar.publishedAt) return "Published";
  return "Draft";
}

/**
 * The period a version applies for, in the words a person would use.
 *
 * A calendar has no end date of its own and should not have one: its
 * last day is the day before the next published version of the same
 * name takes over, which the server derives. An unreplaced version is
 * open-ended, and saying so is the honest answer rather than a blank.
 */
export function touCalendarPeriod(calendar: {
  publishedAt?: string | null;
  effectiveDate: string;
  inForceUntil?: string | null;
}): string {
  const from = calendar.effectiveDate.slice(0, 10);
  if (!calendar.publishedAt) return `Would take effect ${from}`;
  if (calendar.inForceUntil) return `${from} to ${calendar.inForceUntil.slice(0, 10)}`;
  return `${from} onwards`;
}
