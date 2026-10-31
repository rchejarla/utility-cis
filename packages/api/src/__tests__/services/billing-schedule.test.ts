import { describe, it, expect } from "vitest";
import { nextBillingDispatchAt } from "../../services/billing-schedule.service.js";

/**
 * "Is it going to happen?", answerable before the day (SCH-BILL-12).
 *
 * The dispatcher decides due-ness one hourly tick at a time and reports
 * it afterwards. Nothing could answer the question in advance, which is
 * the question an operator actually has on the 8th: a cycle that will
 * not fire on the 10th is worth knowing about on the 8th, not on the
 * 11th.
 *
 * Projected by running `billingDueAt` forward over the UTC hour
 * boundaries the cron actually fires on, rather than by converting a
 * tenant-local wall time to UTC. That is deliberate: a second
 * calculation of "when is the 10th at 03:00 in Denver" is a second
 * chance to disagree with the dispatcher, and the screen disagreeing
 * with the schedule is worse than no screen.
 */

const DENVER = { timezone: "America/Denver", runHourLocal: 3 };
const UTC = { timezone: "UTC", runHourLocal: 3 };
const MONTHLY = { billDayOfMonth: 10, frequency: "MONTHLY" };

describe("when a cycle will next be dispatched", () => {
  it("names the tenant's own hour on the bill day, not a UTC one", () => {
    // 03:00 in Denver on 2026-11-10 is 10:00 UTC — MST, UTC-7.
    const result = nextBillingDispatchAt(
      new Date("2026-11-08T12:00:00.000Z"),
      DENVER,
      MONTHLY,
      { currentWindowRun: false },
    );

    expect(result.reason).toBe("scheduled");
    expect(result.at?.toISOString()).toBe("2026-11-10T10:00:00.000Z");
  });

  it("answers for a UTC tenant on the hour itself", () => {
    const result = nextBillingDispatchAt(new Date("2026-11-08T12:00:00.000Z"), UTC, MONTHLY, {
      currentWindowRun: false,
    });

    expect(result.at?.toISOString()).toBe("2026-11-10T03:00:00.000Z");
  });

  it("says it is overdue rather than scheduled when its day has passed unbilled", () => {
    /*
     * The dispatcher catches up (SCH-BILL-7), so this is not a missed
     * month — but "overdue" and "scheduled for the 10th" are different
     * answers, and on the 12th only one of them is true.
     */
    const result = nextBillingDispatchAt(new Date("2026-11-12T12:00:00.000Z"), UTC, MONTHLY, {
      currentWindowRun: false,
    });

    expect(result.reason).toBe("overdue");
    // The next hourly tick, which is when the dispatcher will take it.
    expect(result.at?.toISOString()).toBe("2026-11-12T13:00:00.000Z");
  });

  it("looks to next month once this window has been run", () => {
    // The question after a successful run is about the next one, not
    // about the window that is already closed.
    const result = nextBillingDispatchAt(new Date("2026-11-12T12:00:00.000Z"), UTC, MONTHLY, {
      currentWindowRun: true,
    });

    expect(result.reason).toBe("scheduled");
    expect(result.at?.toISOString()).toBe("2026-12-10T03:00:00.000Z");
  });

  it("waits for the hour on the bill day itself", () => {
    const result = nextBillingDispatchAt(new Date("2026-11-10T01:00:00.000Z"), UTC, MONTHLY, {
      currentWindowRun: false,
    });

    expect(result.reason).toBe("scheduled");
    expect(result.at?.toISOString()).toBe("2026-11-10T03:00:00.000Z");
  });

  it("clamps a bill day past the end of a short month", () => {
    /*
     * The same clamp the window calculation uses. A cycle billing on
     * the 31st bills on the 30th in November, and a screen that
     * promised the 31st would be promising a date that does not exist.
     */
    const result = nextBillingDispatchAt(
      new Date("2026-11-20T12:00:00.000Z"),
      UTC,
      { billDayOfMonth: 31, frequency: "MONTHLY" },
      { currentWindowRun: true },
    );

    expect(result.at?.toISOString()).toBe("2026-11-30T03:00:00.000Z");
  });

  it("refuses to promise a date for a frequency that cannot be billed", () => {
    // `computeBillPeriod` throws 501 for anything but MONTHLY, so a
    // date here would be a promise the rate engine cannot keep.
    const result = nextBillingDispatchAt(
      new Date("2026-11-08T12:00:00.000Z"),
      UTC,
      { billDayOfMonth: 10, frequency: "QUARTERLY" },
      { currentWindowRun: false },
    );

    expect(result).toEqual({ at: null, reason: "unsupportedFrequency" });
  });

  it("holds to the tenant's local hour across a DST change", () => {
    /*
     * 2027-03-14 is when the US clocks go forward. A cycle billing on
     * the 20th at 03:00 local is 09:00 UTC after the change and 10:00
     * before it — so a projection made in February for a March bill day
     * has to use the offset in force *then*, which is what stepping
     * real instants gives for free and what an offset read from `now`
     * would get wrong by an hour.
     */
    const result = nextBillingDispatchAt(
      new Date("2027-02-20T12:00:00.000Z"),
      DENVER,
      { billDayOfMonth: 20, frequency: "MONTHLY" },
      { currentWindowRun: true },
    );

    expect(result.at?.toISOString()).toBe("2027-03-20T09:00:00.000Z");
  });

  it("stands in the default hour for a tenant that has never set one", () => {
    const result = nextBillingDispatchAt(
      new Date("2026-11-08T12:00:00.000Z"),
      { timezone: "UTC", runHourLocal: null },
      MONTHLY,
      { currentWindowRun: false },
    );

    // DEFAULT_RUN_HOUR_LOCAL is 3, the same default the dispatcher uses.
    expect(result.at?.toISOString()).toBe("2026-11-10T03:00:00.000Z");
  });
});
