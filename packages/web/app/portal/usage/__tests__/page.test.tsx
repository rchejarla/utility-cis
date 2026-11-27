import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import PortalUsagePage from "../page";

/**
 * The customer's usage page. It had no test, and for a TOU meter it showed
 * the month at about double: it summed every read, and a TOU meter's month
 * is a total read plus one row per TOU period that reconcile to it. The
 * monthly figures now come from the API, which applies the rating engine's
 * rule; the page's job is to draw them and to label the rows honestly.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

const DASHBOARD = {
  accounts: [
    {
      id: "a-1",
      accountNumber: "0001000-00",
      serviceAgreements: [
        {
          id: "sa-1",
          agreementNumber: "SA-0001",
          status: "ACTIVE",
          commodity: { name: "Electric" },
          servicePoints: [
            { premise: { id: "p-1", addressLine1: "742 Evergreen Ter", city: "Bozeman", state: "MT", zip: "59715" } },
          ],
        },
      ],
    },
  ],
};

const row = (over: Record<string, unknown>) => ({
  id: String(Math.random()),
  readDate: "2026-06-08T00:00:00.000Z",
  reading: null,
  consumption: "0",
  readType: "ACTUAL",
  peakCode: null,
  meter: { meterNumber: "TOU-REG-001" },
  uom: { code: "KWH", name: "Kilowatt-hour" },
  ...over,
});

function serve(
  usage: { data: unknown[]; monthly: { month: string; total: number }[] },
  billed: { periods?: unknown[]; periodUsage?: unknown } = {},
) {
  get.mockImplementation(async (url: string) => {
    if (url.includes("/portal/api/dashboard")) return DASHBOARD;
    if (url.endsWith("/billed-periods")) return { data: billed.periods ?? [] };
    if (url.includes("/billed-periods/")) return billed.periodUsage;
    return usage;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("portal usage", () => {
  it("draws the month from the API's total, not from adding every row", async () => {
    serve({
      data: [
        row({ reading: "5623", consumption: "623" }),
        row({ peakCode: "peak", consumption: "132" }),
        row({ peakCode: "off_peak", consumption: "491" }),
      ],
      monthly: [{ month: "2026-06", total: 623 }],
    });
    render(<PortalUsagePage />);

    // The bar's figure is the month's usage once.
    expect(await screen.findByTitle(/^623 KWH$/)).toBeInTheDocument();
    expect(screen.queryByText("1,246")).not.toBeInTheDocument();
  });

  it("labels each row with its TOU period and shows no dial reading for a bucket", async () => {
    serve({
      data: [
        row({ reading: "5623", consumption: "623" }),
        row({ peakCode: "off_peak", consumption: "491" }),
      ],
      monthly: [{ month: "2026-06", total: 623 }],
    });
    render(<PortalUsagePage />);

    const periods = await screen.findAllByTestId("usage-period");
    expect(periods.map((p) => p.textContent)).toEqual(["Total", "Off peak"]);
    // A bucket's reading cell is a dash, not the `0` it used to print.
    const bucketRow = periods[1]!.closest("tr")!;
    expect(within(bucketRow).getByText("—")).toBeInTheDocument();
  });

  /*
   * Hourly is the billed time-of-use breakdown (spec 26, TOU-BIL-3): the
   * bill's own period table, and usage by hour of day stacked by period.
   * It was a disabled "Phase 3" button.
   */
  const MONTH = { data: [row({ reading: "5623", consumption: "623" })], monthly: [{ month: "2026-07", total: 623 }] };
  const PERIODS = [
    { segmentId: "seg-1", periodStart: "2026-07-01", periodEnd: "2026-07-31", billNumber: "B-7", tou: true },
  ];
  const hours = (fill: (h: number) => Record<string, number>) =>
    Array.from({ length: 24 }, (_, hour) => ({ hour, byPeriod: fill(hour) }));

  it("keeps Hourly off for an agreement with no billed time-of-use period", async () => {
    serve(MONTH, { periods: [] });
    render(<PortalUsagePage />);

    await screen.findByTitle(/^623 KWH$/);
    expect(screen.getByRole("button", { name: "Hourly" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Daily" })).toBeDisabled();
  });

  it("shows a billed period's hours and the bill's period table", async () => {
    serve(MONTH, {
      periods: PERIODS,
      periodUsage: {
        byPeriod: {
          heading: "Electric — usage by time of day",
          rows: [
            { label: "Peak", usage: "93.00 kWh", share: "15%", amount: "22.32" },
            { label: "Off-peak", usage: "530.00 kWh", share: "85%", amount: "34.19" },
          ],
          footnote: ["Peak: 5–8 pm weekdays, excluding holidays.", "Off-peak: all other hours."],
        },
        hourly: {
          unit: "KWH",
          periods: [
            { code: "peak", label: "Peak" },
            { code: "off_peak", label: "Off-peak" },
          ],
          hours: hours((h): Record<string, number> => (h >= 17 && h < 20 ? { peak: 31 } : { off_peak: 25 })),
        },
      },
    });
    render(<PortalUsagePage />);

    const hourly = await screen.findByRole("button", { name: "Hourly" });
    await waitFor(() => expect(hourly).toBeEnabled());
    await userEvent.click(hourly);

    const view = await screen.findByTestId("tou-view");
    expect(await within(view).findByText("93.00 kWh")).toBeInTheDocument();
    expect(within(view).getByText("Peak: 5–8 pm weekdays, excluding holidays.")).toBeInTheDocument();
    expect(within(view).getByTestId("hour-17")).toHaveAttribute("title", "5p: 31");
    expect(within(view).getAllByTestId(/^hour-/)).toHaveLength(24);
  });

  it("says a meter with no interval data has no hourly view, and still shows the periods", async () => {
    serve(MONTH, {
      periods: PERIODS,
      periodUsage: {
        byPeriod: {
          heading: "Electric — usage by time of day",
          rows: [{ label: "Peak", usage: "93.00 kWh", share: "15%", amount: "22.32" }],
          footnote: [],
        },
        hourly: null,
      },
    });
    render(<PortalUsagePage />);

    const hourly = await screen.findByRole("button", { name: "Hourly" });
    await waitFor(() => expect(hourly).toBeEnabled());
    await userEvent.click(hourly);

    expect(await screen.findByText(/hourly data isn.t available for this meter/i)).toBeInTheDocument();
    expect(screen.getByText("93.00 kWh")).toBeInTheDocument();
  });

  it("shows no Period column for an ordinary meter", async () => {
    serve({
      data: [row({ reading: "1030", consumption: "30", meter: { meterNumber: "WM-001" } })],
      monthly: [{ month: "2026-06", total: 30 }],
    });
    render(<PortalUsagePage />);

    await screen.findByText("WM-001");
    expect(screen.queryByRole("columnheader", { name: /period/i })).toBeNull();
  });
});
