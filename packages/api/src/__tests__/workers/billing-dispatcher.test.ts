import { describe, it, expect } from "vitest";
/*
 * Imported statically, not per test. `billingDueAt` is pure and reads
 * no mocks, so a `beforeEach` that re-imported the module only paid for
 * the dispatcher's import graph — and paid 10s of it on the first test,
 * which timed out the hook while the other eleven passed off the module
 * cache.
 */
import { billingDueAt } from "../../workers/billing-dispatcher.js";

/**
 * Billing that happens on its own day.
 *
 * A cycle declares `bill_day_of_month` and, until this dispatcher,
 * nothing acted on it: somebody opened a screen on the bill day and
 * pressed a button, per cycle, every month, for every tenant. It is the
 * one job in the system with no clock behind it and the most
 * consequential one.
 *
 * The decision is tenant-local and the window is the cycle's own, which
 * is the pair most easily got wrong — a bill dated a day early because
 * the server is in UTC is a bill with the wrong period on it. So the
 * verdict is a pure function of the clock, and these are its cases.
 *
 * `docs/specs/27-job-scheduling.md` §3.
 */

/** A tenant and a cycle, as the verdict wants them. */
const tenant = (over: Record<string, unknown> = {}) => ({
  timezone: "America/Denver",
  runHourLocal: 3,
  ...over,
});
const cycle = (over: Record<string, unknown> = {}) => ({
  billDayOfMonth: 10,
  frequency: "MONTHLY",
  ...over,
});

const verdict = (iso: string, t = tenant(), c = cycle()) =>
  billingDueAt(new Date(iso), t, c);

describe("whether a cycle is due", () => {
  it("is due on its bill day once the local hour has come", () => {
    // 10:00 UTC is 03:00 in Denver on the 10th: the configured hour.
    expect(verdict("2026-10-10T10:00:00.000Z")).toMatchObject({ due: true, reason: "onSchedule" });
  });

  it("is not due on its bill day before the local hour", () => {
    // 06:00 UTC is 00:00 in Denver — the right day, three hours early.
    expect(verdict("2026-10-10T06:00:00.000Z")).toMatchObject({
      due: false,
      reason: "waitingForHour",
    });
  });

  it("is not due before its bill day", () => {
    expect(verdict("2026-10-09T10:00:00.000Z")).toMatchObject({
      due: false,
      reason: "windowOpen",
    });
  });

  it("judges the day in the tenant's zone, not the server's", () => {
    /*
     * 2026-10-10T04:00Z is still the 9th at 22:00 in Denver. A UTC
     * reading would call this the bill day and produce a bill dated a
     * day early — with the wrong period on it, which is the whole
     * reason the decision is local.
     */
    expect(verdict("2026-10-10T04:00:00.000Z")).toMatchObject({
      due: false,
      reason: "windowOpen",
    });
  });

  it("catches up after its bill day rather than skipping the month", () => {
    /*
     * SCH-BILL-7. BullMQ repeatables do not backfill: one overdue
     * occurrence fires on recovery, not one per interval missed. A
     * worker down at 03:00 on the bill day would otherwise skip the
     * month entirely, and the window stays dispatchable until the next
     * bill day closes it.
     */
    expect(verdict("2026-10-14T10:00:00.000Z")).toMatchObject({
      due: true,
      reason: "catchingUp",
    });
  });

  it("stops catching up once the next bill day arrives", () => {
    // On 10 November the window is November's, not October's. October
    // was missed and is gone — which is an exception, not a silent
    // skip, and the dispatcher says so by reporting the new window.
    expect(verdict("2026-11-10T10:00:00.000Z")).toMatchObject({ due: true, reason: "onSchedule" });
  });
});

describe("a bill day the month is too short to hold", () => {
  it("is due on the last day of February for a 31st cycle", () => {
    expect(verdict("2026-02-28T10:00:00.000Z", tenant(), cycle({ billDayOfMonth: 31 }))).toMatchObject({
      due: true,
      reason: "onSchedule",
    });
  });

  it("is not due on the 27th for a 31st cycle", () => {
    expect(verdict("2026-02-27T10:00:00.000Z", tenant(), cycle({ billDayOfMonth: 31 }))).toMatchObject({
      due: false,
      reason: "windowOpen",
    });
  });

  it("is due on the 29th in a leap year for a 29th cycle", () => {
    expect(verdict("2028-02-29T10:00:00.000Z", tenant(), cycle({ billDayOfMonth: 29 }))).toMatchObject({
      due: true,
    });
  });
});

describe("a frequency the engine cannot bill", () => {
  it("refuses a quarterly cycle by name rather than creating a doomed run", () => {
    // The rate engine ships MONTHLY only — `computeBillPeriod` throws
    // 501 for anything else, so every account in such a run would fail.
    // Naming it is the point: an active cycle that can never bill is
    // worth an operator's attention, and silence is what this spec
    // exists to remove.
    expect(verdict("2026-10-10T10:00:00.000Z", tenant(), cycle({ frequency: "QUARTERLY" }))).toMatchObject({
      due: false,
      reason: "unsupportedFrequency",
    });
  });
});

describe("the hour, across a daylight-saving change", () => {
  const firstOfMonth = cycle({ billDayOfMonth: 1 });

  it("is not due at the repeated hour on a day the clocks go back", () => {
    /*
     * Denver leaves DST on 2026-11-01, so local 01:00 happens twice —
     * once at 07:00Z as MDT and again at 08:00Z as MST. Neither
     * occurrence may make an hour-3 cycle due, or the run would carry a
     * bill dated before the hour its tenant asked for.
     */
    expect(verdict("2026-11-01T07:30:00.000Z", tenant(), firstOfMonth)).toMatchObject({
      due: false,
      reason: "waitingForHour",
    });
    expect(verdict("2026-11-01T08:30:00.000Z", tenant(), firstOfMonth)).toMatchObject({
      due: false,
      reason: "waitingForHour",
    });

    // 10:30Z is 03:30 MST — the hour has come, once.
    expect(verdict("2026-11-01T10:30:00.000Z", tenant(), firstOfMonth)).toMatchObject({
      due: true,
      reason: "onSchedule",
    });
  });

  it("does not strand a cycle whose configured hour the clocks skip", () => {
    /*
     * The case that decides the rule. Denver springs forward on
     * 2026-03-08: local 02:00 never happens, so an *equality* match on
     * the hour would never fire that day and the cycle would bill a day
     * late. "At or after the hour" cannot miss an hour that does not
     * exist.
     */
    const onHourTwo = tenant({ runHourLocal: 2 });
    const eighth = cycle({ billDayOfMonth: 8 });

    // 08:30Z is 01:30 MST — before the configured hour.
    expect(verdict("2026-03-08T08:30:00.000Z", onHourTwo, eighth)).toMatchObject({ due: false });
    // 09:30Z is 03:30 MDT: 02:00 was skipped entirely, and it is due.
    expect(verdict("2026-03-08T09:30:00.000Z", onHourTwo, eighth)).toMatchObject({
      due: true,
      reason: "onSchedule",
    });
  });
});
