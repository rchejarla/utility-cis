import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import ReadRoutesPage from "../page";

/**
 * /read-routes — the named walks a meter reader makes (spec 30, §5.1).
 *
 * Two things the list has to say that a row of text does not say by
 * itself: how many stops are on a route, because a route with none is
 * half-built and looks finished; and **who owns the itinerary**. An
 * EXTERNAL route is a row that exists so a vendor's reads can point at
 * something — it has no stops, no sheet to print and nothing to type in,
 * and a list that renders it identically to a route somebody walks
 * invites all three.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function route(over: Record<string, unknown> = {}) {
  return {
    id: "rt-1",
    code: "W-04",
    name: "North Willson",
    billingCycleId: "cyc-1",
    origin: "LOCAL",
    active: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    stopCount: 48,
    cycleCode: "C-01",
    ...over,
  };
}

function payload(rows: unknown[]) {
  return { data: rows, meta: { total: rows.length, page: 1, limit: 25, pages: 1 } };
}

/** Routes from the list endpoint, cycles from the filter's own fetch. */
function serve(rows: unknown[]) {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/billing-cycles")) {
      return { data: [{ id: "cyc-1", cycleCode: "C-01", name: "Monthly" }] };
    }
    return payload(rows);
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <ReadRoutesPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Read routes — the list", () => {
  it("lists routes with their cycle and stop count", async () => {
    serve([route()]);
    renderPage();

    expect(await screen.findByText("W-04")).toBeInTheDocument();
    expect(screen.getByText("North Willson")).toBeInTheDocument();
    expect(screen.getByText("C-01")).toBeInTheDocument();
    expect(screen.getByText("48")).toBeInTheDocument();
  });

  /*
   * A route with no stops cannot produce a sheet, and nothing else on
   * the row says so — "0" in a count column reads as data not loaded.
   */
  it("says a route has no stops yet rather than printing a bare zero", async () => {
    serve([route({ stopCount: 0 })]);
    renderPage();

    await screen.findByText("W-04");
    expect(screen.getByText(/No stops/i)).toBeInTheDocument();
  });

  it("marks an EXTERNAL route as vendor-owned and offers no sheet", async () => {
    serve([
      route(),
      route({ id: "rt-2", code: "VEN-7", name: "VEN-7", origin: "EXTERNAL", stopCount: 0 }),
    ]);
    renderPage();

    expect(await screen.findByText(/Vendor-owned/i)).toBeInTheDocument();
    // One sheet button, for the LOCAL route — not two.
    expect(screen.getAllByRole("button", { name: /sheet/i })).toHaveLength(1);
  });

  it("offers an inactive route's rows as retired rather than hiding them", async () => {
    serve([route({ active: false })]);
    renderPage();

    await screen.findByText("W-04");
    expect(screen.getByText(/Retired/i)).toBeInTheDocument();
  });

  it("narrows to the routes a vendor owns", async () => {
    serve([route()]);
    renderPage();
    await screen.findByText("W-04");

    await userEvent.click(screen.getByRole("button", { name: /Owner/i }));
    await userEvent.click(await screen.findByText(/Vendor's system/i));

    expect(get).toHaveBeenCalledWith(
      "/api/v1/read-routes",
      expect.objectContaining({ origin: "EXTERNAL" }),
    );
  });

  it("offers the cycles the tenant actually has", async () => {
    serve([route()]);
    renderPage();
    await screen.findByText("W-04");

    await userEvent.click(screen.getByRole("button", { name: /Cycle/i }));

    expect(await screen.findByText(/C-01 — Monthly/)).toBeInTheDocument();
  });

  it("teaches what a route is when the tenant has none", async () => {
    serve([]);
    renderPage();

    expect(await screen.findByText(/No read routes yet/i)).toBeInTheDocument();
  });
});
