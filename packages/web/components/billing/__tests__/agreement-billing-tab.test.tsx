import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { apiClient } from "@/lib/api-client";
import { AgreementBillingTab } from "../agreement-billing-tab";

/**
 * A service agreement's Billing tab shows its own `BillSegment`s.
 *
 * The noun matters. A `Bill` belongs to an Account and aggregates the
 * segments of every agreement on it, so an agreement has no bills of
 * its own to list — what it has is one segment per billed period, each
 * priced from one schedule version. Until 2026-10-22 this tab rendered
 * a mock "SaaSLogic Subscription" card instead, an entity dropped from
 * the design on 2026-10-09, beside an estimated charge nothing computes
 * and a fabricated event log.
 *
 * Two endpoints already existed to feed it, which is the whole fix:
 * `GET .../bill-segments` for what was billed and
 * `GET .../next-service-period` for what the next one would cover.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function segment(over: Record<string, unknown> = {}) {
  return {
    id: "seg-1",
    serviceAgreementId: "sa-1",
    segmentNumber: 7,
    periodStart: "2026-02-01T00:00:00.000Z",
    periodEnd: "2026-02-28T00:00:00.000Z",
    subtotal: "84.2000",
    taxes: "5.8000",
    credits: "0.0000",
    total: "90.0000",
    minimumFloorApplied: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    ...over,
  };
}

/** What the next segment would cover, when there is a read to bill. */
function nextPeriod(over: Record<string, unknown> = {}) {
  return {
    periodStart: "2026-03-01T00:00:00.000Z",
    periodEnd: "2026-03-30T00:00:00.000Z",
    readCount: 1,
    days: 30,
    ...over,
  };
}

/**
 * The API answers "nothing to bill" with a 200 and a reason, on purpose
 * — a page needs to say "no read since..." where it would otherwise
 * show an interval, and that is not an error by whoever opened it.
 */
function noReadYet() {
  return {
    periodStart: null,
    periodEnd: null,
    reason: "NO_READ_IN_WINDOW",
    message: "No unbilled read on or before 2026-03-31 for this agreement",
  };
}

function route(segments: unknown[], next: unknown) {
  get.mockImplementation((url: string) => {
    if (url.includes("/bill-segments")) return Promise.resolve(segments);
    if (url.includes("/next-service-period")) return Promise.resolve(next);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Agreement billing tab — what was billed", () => {
  it("lists the agreement's own bill segments", async () => {
    route([segment()], nextPeriod());

    render(<AgreementBillingTab agreementId="sa-1" />);

    // Scoped to the table: the same figure also appears in the summary
    // card above it, and this case is about the segment row.
    await waitFor(() => {
      expect(screen.getByRole("table")).toBeInTheDocument();
    });
    const table = screen.getByRole("table");
    await waitFor(() => {
      expect(within(table).getByText("2026-02-01 → 2026-02-28")).toBeInTheDocument();
    });
    expect(within(table).getByText("$90.00")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/v1/service-agreements/sa-1/bill-segments");
  });

  it("marks a segment charged at the tariff minimum rather than on usage", async () => {
    route([segment({ minimumFloorApplied: true })], nextPeriod());

    render(<AgreementBillingTab agreementId="sa-1" />);

    // Without this a CSR cannot answer "why is my bill the same every
    // month" from the screen: the figure is the floor, not the metered
    // amount, and nothing else on the row says so.
    await waitFor(() => {
      expect(screen.getByText(/minimum/i)).toBeInTheDocument();
    });
  });

  it("says so when nothing has been billed yet instead of inventing a row", async () => {
    route([], nextPeriod());

    render(<AgreementBillingTab agreementId="sa-1" />);

    await waitFor(() => {
      expect(screen.getByText(/no billed periods yet/i)).toBeInTheDocument();
    });
  });
});

describe("Agreement billing tab — what is next", () => {
  it("shows the interval the next segment would cover", async () => {
    route([segment()], nextPeriod());

    render(<AgreementBillingTab agreementId="sa-1" />);

    await waitFor(() => {
      expect(screen.getByText(/2026-03-01/)).toBeInTheDocument();
    });
    expect(screen.getByText(/2026-03-30/)).toBeInTheDocument();
  });

  it("explains a missing read rather than showing a blank period", async () => {
    route([segment()], noReadYet());

    render(<AgreementBillingTab agreementId="sa-1" />);

    await waitFor(() => {
      expect(
        screen.getByText(/no unbilled read on or before 2026-03-31/i),
      ).toBeInTheDocument();
    });
  });
});
