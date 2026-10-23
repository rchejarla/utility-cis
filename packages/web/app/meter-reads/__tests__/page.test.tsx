import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import MeterReadsPage from "../page";

/**
 * The read log.
 *
 * A reading and a consumption are quantities, and a quantity without
 * its unit is not a shorter truth — it is a different claim. The same
 * screen lists water in gallons and electricity in kilowatt hours, and
 * a column of bare numbers cannot be read across those rows at all. It
 * matters more since rating began converting: the tariff bills water in
 * HCF while the meter counts gallons, so "4958" here and "6.63" on the
 * bill are the same month, and only the units say so.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function read(over: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    readDate: "2026-09-15",
    readDatetime: "2026-09-15T00:00:00.000Z",
    reading: "56572.0000",
    priorReading: "51614.0000",
    consumption: "4958.0000",
    readType: "ACTUAL",
    readSource: "AMR",
    exceptionCode: null,
    isFrozen: false,
    meter: { meterNumber: "WM-001", commodityId: "c-water" },
    uom: { code: "GAL", name: "Gallons" },
    serviceAgreement: { agreementNumber: "SA-0001" },
    ...over,
  };
}

function payload(rows: unknown[]) {
  return { data: rows, meta: { total: rows.length, page: 1, limit: 25, pages: 1 } };
}

function renderPage() {
  return render(
    <ToastProvider>
      <MeterReadsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Meter reads — units", () => {
  it("names the unit the reading and consumption are counted in", async () => {
    get.mockResolvedValue(payload([read()]));
    renderPage();

    expect(await screen.findByText("WM-001")).toBeInTheDocument();
    expect(screen.getByText("GAL")).toBeInTheDocument();
  });

  it("shows each row's own unit, since one log carries several commodities", async () => {
    get.mockResolvedValue(
      payload([
        read(),
        read({
          id: "r-2",
          meter: { meterNumber: "EM-002", commodityId: "c-electric" },
          uom: { code: "KWH", name: "Kilowatt Hours" },
          consumption: "936.0000",
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByText("GAL")).toBeInTheDocument();
    expect(screen.getByText("KWH")).toBeInTheDocument();
  });

  /*
   * A read whose unit the API did not send must not print "undefined"
   * into a column an operator reads as fact.
   */
  it("shows a dash rather than nothing when the unit is absent", async () => {
    get.mockResolvedValue(payload([read({ uom: null })]));
    renderPage();

    await screen.findByText("WM-001");
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });
});
