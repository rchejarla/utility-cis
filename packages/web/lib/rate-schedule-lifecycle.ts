export type RateScheduleLifecycle = "Draft" | "Published" | "Superseded";

/**
 * Which of the three states a rate schedule is in.
 *
 * Derived from the two columns that decide it rather than stored, and
 * defined once because the list and the detail page must agree: the
 * detail page has shown this badge all along while the list showed
 * nothing, and two copies of the rule would have been two chances to
 * disagree about the row you are looking at.
 *
 * Supersession wins over publication. A replaced version is still
 * published — `publishRateSchedule` set that timestamp and nothing
 * clears it — so reading `publishedAt` first would show a retired
 * version as current, which is exactly what sends someone to edit the
 * wrong one.
 */
export function rateScheduleLifecycle(schedule: {
  publishedAt?: string | null;
  supersededById?: string | null;
}): RateScheduleLifecycle {
  if (schedule.supersededById) return "Superseded";
  if (schedule.publishedAt) return "Published";
  return "Draft";
}
