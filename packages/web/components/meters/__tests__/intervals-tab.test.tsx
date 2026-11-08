import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { IntervalsTab } from "../intervals-tab";

/**
 * A meter's interval data, on the meter's own page.
 *
 * Nothing showed one until now: an AMI meter's month existed only as
 * the three `meter_read` buckets the roll-up derived from it. This is
 * what somebody opens when a customer disputes a time-of-use bill, and
 * the only way to *see* a hole the coverage queue is reporting.
 *
 * The chart is a bar per interval, so **a hole is a hole** — nothing is
 * drawn where nothing was reported. A line chart would interpolate
 * across it and draw a straight, confident line through data that does
 * not exist, which is the one thing this screen must not do.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function hours(count: number, startHour = 0, quality = "actual") {
  return Array.from({ length: count }, (_, i) => ({
    intervalStart: `2026-02-08T${String(startHour + i).padStart(2, "0")}:00:00.000Z`,
    lengthMinutes: 60,
    quantity: (0.5 + i * 0.1).toFixed(4),
    quality,
  }));
}

function series(over: Record<string, unknown> = {}) {
  const intervals = (over.intervals as unknown[]) ?? hours(24);
  return {
    meterId: "m-1",
    meterNumber: "TOU-AMI-001",
    uomCode: "KWH",
    timeZone: "America/Denver",
    from: "2026-02-08T00:00:00.000Z",
    to: "2026-02-08T00:00:00.000Z",
    reportsIntervals: true,
    intervals,
    summary: {
      count: intervals.length,
      total: "22.800000",
      byQuality: { actual: intervals.length },
      minutesCovered: intervals.length * 60,
      minutesInRange: 1440,
      gaps: [],
    },
    ...over,
  };
}

function renderTab() {
  return render(
    <ToastProvider>
      <IntervalsTab meterId="m-1" />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a meter's intervals", () => {
  it("asks for the meter's own series", async () => {
    get.mockResolvedValue(series());
    renderTab();

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(expect.stringContaining("/api/v1/meters/m-1/intervals")),
    );
  });

  /*
   * The chart drew UTC hours until somebody opened it: a household's
   * evening peak landed at midnight, and a TOU dispute is about the
   * customer's own five o'clock.
   */
  it("reads the clock the tenant's TOU periods are set by", async () => {
    get.mockResolvedValue(series());
    renderTab();

    expect(await screen.findByText(/America\/Denver/)).toBeInTheDocument();
  });

  it("says the day it is showing and what it adds up to", async () => {
    get.mockResolvedValue(series());
    renderTab();

    expect(await screen.findByText(/22\.8/)).toBeInTheDocument();
    // The unit, because a quantity without one is a different claim.
    expect(screen.getByText(/KWH/)).toBeInTheDocument();
    expect(screen.getByText(/24 intervals/i)).toBeInTheDocument();
  });

  it("names the hole, with when it starts and how long it is", async () => {
    get.mockResolvedValue(
      series({
        intervals: [...hours(9), ...hours(12, 12)],
        summary: {
          count: 21,
          total: "19.000000",
          byQuality: { actual: 21 },
          minutesCovered: 21 * 60,
          minutesInRange: 1440,
          gaps: [{ startsAt: "2026-02-08T09:00:00.000Z", minutes: 180 }],
        },
      }),
    );
    renderTab();

    expect(await screen.findByText(/3h/)).toBeInTheDocument();
    expect(screen.getByText(/missing/i)).toBeInTheDocument();
  });

  it("says a clean day is clean, rather than saying nothing", async () => {
    get.mockResolvedValue(series());
    renderTab();

    expect(await screen.findByText(/covers the whole/i)).toBeInTheDocument();
  });

  it("counts estimates apart, since an estimate is not a measurement", async () => {
    get.mockResolvedValue(
      series({
        intervals: [...hours(20), ...hours(4, 20, "estimated")],
        summary: {
          count: 24,
          total: "22.800000",
          byQuality: { actual: 20, estimated: 4 },
          minutesCovered: 1440,
          minutesInRange: 1440,
          gaps: [],
        },
      }),
    );
    renderTab();

    expect(await screen.findByText(/4 estimated/i)).toBeInTheDocument();
  });

  /*
   * A water meter has no intervals and never will; an AMI meter with
   * none for the day it is showing has a problem. Saying "no data"
   * for both would make the second invisible.
   */
  it("distinguishes a meter that reports none from a day that has none", async () => {
    get.mockResolvedValue(series({ intervals: [], reportsIntervals: false, summary: { count: 0, total: "0.000000", byQuality: {}, minutesCovered: 0, minutesInRange: 1440, gaps: [] } }));
    renderTab();

    expect(await screen.findByText(/does not report interval data/i)).toBeInTheDocument();
  });

  it("offers a date picker, since stepping to last month is absurd", async () => {
    get.mockResolvedValue(series());
    renderTab();
    await screen.findByText(/24 intervals/i);

    // The picker's trigger carries the day it is on, so the control
    // says where you are as well as letting you move.
    expect(screen.getByText(/2026-02-08|Feb 8, 2026|08\/02\/2026/)).toBeInTheDocument();
  });

  it("moves a day back when asked", async () => {
    get.mockResolvedValue(series());
    renderTab();
    await screen.findByText(/24 intervals/i);

    await userEvent.click(screen.getByRole("button", { name: /previous day/i }));

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(expect.stringContaining("from=2026-02-07")),
    );
  });
});

/**
 * Arriving from the coverage queue.
 *
 * That screen says "TOU-AMI-001 lost three hours on 9 October" and its
 * link used to land on the meter's Overview with no day chosen — so
 * the one question it had just raised took three more clicks and a
 * date picker to answer. The day travels in the URL now.
 */
describe("a meter's intervals, opened at a particular day", () => {
  it("asks for the day it was sent to", async () => {
    get.mockResolvedValue(series());
    render(
      <ToastProvider>
        <IntervalsTab meterId="m-1" initialDay="2026-10-09" />
      </ToastProvider>,
    );

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        expect.stringContaining("from=2026-10-09&to=2026-10-09"),
      ),
    );
  });
});
