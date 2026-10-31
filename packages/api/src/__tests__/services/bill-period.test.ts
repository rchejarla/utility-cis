import { describe, it, expect } from "vitest";
import { computeBillPeriod } from "../../services/bill.service.js";

/**
 * The window a cycle bills, from its bill day and a date.
 *
 * Pure, exported, and until now covered only incidentally by three
 * integration suites — which is why the short-month case below went
 * unnoticed. It is about to acquire a scheduler, and a dispatcher that
 * fires on a day the window calculation disagrees about would bill the
 * wrong period or nothing at all.
 *
 * Everything is UTC here. The *decision* to dispatch is tenant-local
 * (27-job-scheduling SCH-BILL-2) and that belongs to the dispatcher;
 * the window a run covers belongs to the cycle's own calendar and is
 * the same window whoever starts it.
 */

/** A cycle, as `computeBillPeriod` wants it. */
function on(billDayOfMonth: number, asOf: string, frequency = "MONTHLY") {
  return computeBillPeriod(
    // Epoch creation date: the per-account clamp must not fire. A run's
    // window belongs to the cycle, not to any one account.
    { createdAt: new Date(0), billingCycle: { billDayOfMonth, frequency } },
    new Date(asOf),
  );
}

const day = (d: Date) => d.toISOString().slice(0, 10);

describe("the window for an ordinary bill day", () => {
  it("ends on this month's bill day once it has arrived", () => {
    const { periodStart, periodEnd } = on(15, "2026-10-20T00:00:00.000Z");

    expect(day(periodEnd)).toBe("2026-10-15");
    // The day after the previous period ended, so the two abut without
    // a gap and without an overlap.
    expect(day(periodStart)).toBe("2026-09-16");
  });

  it("ends on last month's bill day before this month's arrives", () => {
    const { periodStart, periodEnd } = on(15, "2026-10-14T23:59:59.000Z");

    expect(day(periodEnd)).toBe("2026-09-15");
    expect(day(periodStart)).toBe("2026-08-16");
  });

  it("includes the bill day itself", () => {
    expect(day(on(15, "2026-10-15T00:00:00.000Z").periodEnd)).toBe("2026-10-15");
  });

  it("crosses a year boundary", () => {
    const { periodStart, periodEnd } = on(15, "2026-01-10T00:00:00.000Z");

    expect(day(periodEnd)).toBe("2025-12-15");
    expect(day(periodStart)).toBe("2025-11-16");
  });
});

describe("a bill day later than the month is long", () => {
  it("bills a 31st cycle on the last day of February", () => {
    /*
     * `Date.UTC(2026, 1, 31)` is 3 March — the month rolls over. A
     * cycle set to the 31st therefore had a window ending in the
     * *following* month for every short month, and the manual path
     * produced it too. SCH-BILL-3: a month shorter than the configured
     * day bills on its last day.
     */
    const { periodStart, periodEnd } = on(31, "2026-02-28T00:00:00.000Z");

    expect(day(periodEnd)).toBe("2026-02-28");
    expect(day(periodStart)).toBe("2026-02-01");
  });

  it("bills a 31st cycle on 30 November", () => {
    expect(day(on(31, "2026-11-30T00:00:00.000Z").periodEnd)).toBe("2026-11-30");
  });

  it("gives March its own full window after a short February", () => {
    // The period after a clamped one starts the day after it ended, not
    // on a day arithmetic invented: 28 Feb + 1, never "31 Feb + 1".
    const { periodStart, periodEnd } = on(31, "2026-03-31T00:00:00.000Z");

    expect(day(periodEnd)).toBe("2026-03-31");
    expect(day(periodStart)).toBe("2026-03-01");
  });

  it("bills a 29th cycle on 28 February in a common year", () => {
    expect(day(on(29, "2026-02-28T00:00:00.000Z").periodEnd)).toBe("2026-02-28");
  });

  it("bills a 29th cycle on the 29th in a leap year", () => {
    expect(day(on(29, "2028-02-29T00:00:00.000Z").periodEnd)).toBe("2028-02-29");
  });

  it("does not bring a short month's window forward before its last day", () => {
    // 27 February, cycle on the 31st: the February window is not closed
    // yet, so the window is still January's.
    expect(day(on(31, "2026-02-27T00:00:00.000Z").periodEnd)).toBe("2026-01-31");
  });
});

describe("a frequency the engine cannot bill", () => {
  it("refuses a quarterly cycle rather than inventing a window", () => {
    // The rate engine ships MONTHLY only. A dispatcher must not create a
    // run whose every account would throw — it records this as a named
    // exception instead.
    expect(() => on(15, "2026-10-20T00:00:00.000Z", "QUARTERLY")).toThrow(
      /not yet supported/i,
    );
  });
});
