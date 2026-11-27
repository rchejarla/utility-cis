import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

function serve(usage: { data: unknown[]; monthly: { month: string; total: number }[] }) {
  get.mockImplementation(async (url: string) => {
    if (url.includes("/portal/api/dashboard")) return DASHBOARD;
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
