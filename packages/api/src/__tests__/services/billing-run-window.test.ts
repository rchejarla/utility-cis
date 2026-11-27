import { describe, it, expect } from "vitest";
import { windowContaining } from "../../services/billing-run/window.js";

/**
 * `windowContaining`, on the one day a month it can get wrong.
 *
 * It decides with `day <= closed.periodEnd`, and `periodEnd` is UTC
 * **midnight** on the bill day. So a `Date` carrying a time of day fails
 * that test on the bill day itself, falls through to the +31-day probe,
 * and returns the **next** window — the one that starts tomorrow.
 *
 * That is not hypothetical. Until 2026-11-18 `getReadingProgress` passed
 * `new Date()` straight in for a reading-week question, so on every bill
 * day the route detail page printed next month's window and counted the
 * reads taken that morning as unread. Four other callers were correct
 * only because their input happened to be a parsed `YYYY-MM-DD` or had
 * already been through `utcDay`.
 *
 * The parameter is named `day`, so the function normalises to UTC
 * midnight itself rather than trusting five call sites to remember. The
 * cases below are the ones that distinguish a normalising
 * implementation from a trusting one: a date-only argument passes either
 * way, which is why every test in the tree missed this.
 */

const MONTHLY = { billDayOfMonth: 10, frequency: "MONTHLY" };
const day = (d: Date) => d.toISOString().slice(0, 10);

describe("windowContaining — a day with a time of day on it", () => {
  /** The window ending on the bill day, which is the window the bill day is in. */
  const ON_BILL_DAY = { start: "2026-11-11", end: "2026-12-10" };

  it("puts UTC midnight on the bill day in the window ending that day", () => {
    const w = windowContaining(MONTHLY, new Date("2026-12-10T00:00:00.000Z"));
    expect({ start: day(w.periodStart), end: day(w.periodEnd) }).toEqual(ON_BILL_DAY);
  });

  it.each(["01:00:00.000Z", "12:00:00.000Z", "15:30:00.000Z", "23:59:59.999Z"])(
    "puts %s on the bill day in that same window, not the next one",
    (time) => {
      const w = windowContaining(MONTHLY, new Date(`2026-12-10T${time}`));
      expect({ start: day(w.periodStart), end: day(w.periodEnd) }).toEqual(ON_BILL_DAY);
    },
  );

  it("still puts the day after the bill day in the next window", () => {
    const w = windowContaining(MONTHLY, new Date("2026-12-11T15:00:00.000Z"));
    expect({ start: day(w.periodStart), end: day(w.periodEnd) }).toEqual({
      start: "2026-12-11",
      end: "2027-01-10",
    });
  });

  it("still puts the day before the bill day in the window ending on it", () => {
    const w = windowContaining(MONTHLY, new Date("2026-12-09T15:00:00.000Z"));
    expect({ start: day(w.periodStart), end: day(w.periodEnd) }).toEqual(ON_BILL_DAY);
  });

  /*
   * The returned window has to *contain* the day it was asked about —
   * the function's whole contract — at every hour of every day, for
   * every bill day a month can have. A short month clamps the bill day,
   * so 29, 30 and 31 are the interesting ones.
   */
  it.each([1, 5, 10, 28, 29, 30, 31])(
    "returns a window containing the day, at any hour, for bill day %i",
    (billDayOfMonth) => {
      const cycle = { billDayOfMonth, frequency: "MONTHLY" };
      const wrong: string[] = [];
      for (let d = new Date(Date.UTC(2026, 0, 1)); d < new Date(Date.UTC(2027, 0, 1)); ) {
        for (const hour of [0, 1, 13, 23]) {
          const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour));
          const w = windowContaining(cycle, at);
          const midnight = new Date(
            Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
          );
          if (midnight < w.periodStart || midnight > w.periodEnd) {
            wrong.push(`${at.toISOString()} -> ${day(w.periodStart)}..${day(w.periodEnd)}`);
          }
        }
        d = new Date(d.getTime() + 86_400_000);
      }
      expect(wrong).toEqual([]);
    },
  );
});
