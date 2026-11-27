import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import ReadRouteDetailPage from "../[id]/page";

/**
 * /read-routes/:id — the walk itself, in order (spec 30, §5.1).
 *
 * The page's whole job is the order. Three things make that hard to get
 * right from the data alone:
 *
 * - **The sequences are gapped integers**, step 100, so they are not 1,
 *   2, 3 and must never be shown as though they were — an operator
 *   reading "100, 200, 300" as a count would ask why 297 are missing.
 * - **A stop whose account bills on another cycle still belongs on the
 *   walk** (§5.1). It is a data-quality item, not an error: the route
 *   prints it, and the page says which cycle so somebody can decide.
 * - **The tray is premises on no route at all**, not premises missing
 *   from this one. A reader visits an address once.
 */

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "rt-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/read-routes/rt-1",
  useSearchParams: () => new URLSearchParams(),
}));

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;
const del = apiClient.delete as unknown as ReturnType<typeof vi.fn>;

const ROUTE = {
  id: "rt-1",
  code: "W-04",
  name: "North Willson",
  billingCycleId: "cyc-1",
  origin: "LOCAL",
  active: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  stopCount: 2,
  cycleCode: "C-01",
};

function premise(over: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    addressLine1: "412 N Willson Ave",
    addressLine2: null,
    city: "Bozeman",
    state: "MT",
    zip: "59715",
    premiseType: "RESIDENTIAL",
    ...over,
  };
}

function stop(over: Record<string, unknown> = {}) {
  return {
    id: "st-1",
    readRouteId: "rt-1",
    premiseId: "p-1",
    sequence: 100,
    createdAt: "2026-11-01T00:00:00.000Z",
    premise: premise(),
    accountCycles: [{ billingCycleId: "cyc-1", cycleCode: "C-01" }],
    ...over,
  };
}

const PROGRESS = {
  billingCycleId: "cyc-1",
  cycleCode: "C-01",
  windowStart: "2026-11-11T00:00:00.000Z",
  windowEnd: "2026-12-10T00:00:00.000Z",
  expected: 2,
  read: 1,
  outstanding: 1,
  data: [],
  meta: { total: 0, page: 1, limit: 50, pages: 0 },
};

interface Served {
  route?: Record<string, unknown>;
  stops?: unknown[];
  tray?: unknown[];
}

function serve({ route = ROUTE, stops = [stop()], tray = [] }: Served = {}) {
  get.mockImplementation(async (url: string) => {
    if (url.includes("/stops")) return { data: stops };
    if (url.includes("/unsequenced")) {
      return { data: tray, meta: { total: tray.length, page: 1, limit: 50, pages: 1 } };
    }
    if (url.includes("/progress")) return PROGRESS;
    return route;
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <ReadRouteDetailPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

/*
 * The addresses appear twice on the page — in the walk, and in the
 * "insert after" control, which has to name the position somehow. So
 * every address assertion is scoped to the table it is about rather
 * than asked of the whole screen.
 */
const walkRows = () => screen.findAllByTestId("stop-row");

describe("Read route detail — the walk", () => {
  it("names the route, its cycle and its stop count", async () => {
    serve();
    renderPage();

    expect(
      await screen.findByRole("heading", { name: /W-04 — North Willson/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Cycle C-01 · 2 stops/)).toBeInTheDocument();
  });

  it("shows stops in sequence order", async () => {
    serve({
      stops: [
        stop({ id: "st-1", premiseId: "p-1", sequence: 100, premise: premise({ id: "p-1", addressLine1: "1 First St" }) }),
        stop({ id: "st-2", premiseId: "p-2", sequence: 150, premise: premise({ id: "p-2", addressLine1: "2 Second St" }) }),
        stop({ id: "st-3", premiseId: "p-3", sequence: 200, premise: premise({ id: "p-3", addressLine1: "3 Third St" }) }),
      ],
    });
    renderPage();

    const rows = await walkRows();
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("1 First St"),
      expect.stringContaining("2 Second St"),
      expect.stringContaining("3 Third St"),
    ]);
  });

  /*
   * The gaps are an implementation detail of inserting without
   * renumbering the street. Printing them would invite somebody to read
   * 100 as "stop one hundred".
   */
  it("numbers the stops 1, 2, 3 rather than printing the gapped sequence", async () => {
    serve({
      stops: [
        stop({ id: "st-1", sequence: 100 }),
        stop({ id: "st-2", premiseId: "p-2", sequence: 250, premise: premise({ id: "p-2", addressLine1: "2 Second St" }) }),
      ],
    });
    renderPage();

    const rows = await walkRows();
    expect(within(rows[0]!).getByText("1")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("250")).not.toBeInTheDocument();
  });

  it("flags stops whose account is on a different cycle as a data-quality list", async () => {
    serve({
      stops: [
        stop(),
        stop({
          id: "st-2",
          premiseId: "p-2",
          sequence: 200,
          premise: premise({ id: "p-2", addressLine1: "99 Off Cycle Rd" }),
          accountCycles: [{ billingCycleId: "cyc-9", cycleCode: "C-09" }],
        }),
      ],
    });
    renderPage();

    const panel = await screen.findByTestId("off-cycle-stops");
    expect(within(panel).getByText(/99 Off Cycle Rd/)).toBeInTheDocument();
    expect(within(panel).getByText(/C-09/)).toBeInTheDocument();
    // The in-cycle stop is not in the list, and nothing here is an error.
    expect(within(panel).queryByText(/412 N Willson/)).not.toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says nothing about cycles when every stop bills on the route's own", async () => {
    serve();
    renderPage();

    await walkRows();
    expect(screen.queryByTestId("off-cycle-stops")).not.toBeInTheDocument();
  });

  it("offers premises that are on no route", async () => {
    serve({ tray: [premise({ id: "p-free", addressLine1: "7 Unsequenced Way" })] });
    renderPage();

    const tray = await screen.findByTestId("unsequenced-tray");
    expect(await within(tray).findByText(/7 Unsequenced Way/)).toBeInTheDocument();
  });

  it("adds a premise from the tray to the end of the walk", async () => {
    serve({ tray: [premise({ id: "p-free", addressLine1: "7 Unsequenced Way" })] });
    post.mockResolvedValue({ id: "st-new", readRouteId: "rt-1", premiseId: "p-free", sequence: 200 });
    renderPage();

    const tray = await screen.findByTestId("unsequenced-tray");
    await userEvent.click(await within(tray).findByRole("button", { name: /add/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/stops", {
        premiseId: "p-free",
      }),
    );
  });

  it("inserts a premise after a chosen stop, naming the position by its sequence", async () => {
    serve({
      stops: [stop({ sequence: 100 }), stop({ id: "st-2", premiseId: "p-2", sequence: 200 })],
      tray: [premise({ id: "p-free", addressLine1: "7 Unsequenced Way" })],
    });
    post.mockResolvedValue({ id: "st-new", readRouteId: "rt-1", premiseId: "p-free", sequence: 150 });
    renderPage();

    const tray = await screen.findByTestId("unsequenced-tray");
    const add = await within(tray).findByRole("button", { name: /add/i });
    // The position is named by the stop's own sequence, which is the
    // one place a gapped sequence is shown.
    await userEvent.selectOptions(screen.getByLabelText(/insert/i), "100");
    await userEvent.click(add);

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/stops", {
        premiseId: "p-free",
        afterSequence: 100,
      }),
    );
  });

  it("removes a stop from the walk", async () => {
    serve();
    del.mockResolvedValue(undefined);
    renderPage();

    const rows = await walkRows();
    await userEvent.click(within(rows[0]!).getByRole("button", { name: /remove/i }));

    await waitFor(() =>
      expect(del).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/stops/st-1"),
    );
  });

  it("reports the refusal when a stop cannot be placed where it was asked for", async () => {
    serve({ tray: [premise({ id: "p-free" })] });
    post.mockRejectedValue(
      Object.assign(new Error("No room between sequence 100 and 101; resequence the route"), {
        code: "SEQUENCE_FULL",
      }),
    );
    renderPage();

    const tray = await screen.findByTestId("unsequenced-tray");
    await userEvent.click(await within(tray).findByRole("button", { name: /add/i }));

    expect(await screen.findByText(/No room between sequence 100 and 101/)).toBeInTheDocument();
  });

  it("says how far along the route is", async () => {
    serve();
    renderPage();

    expect(await screen.findByText(/1 of 2/)).toBeInTheDocument();
  });

  it("offers the day's sheet and the entry screen", async () => {
    serve();
    renderPage();

    await walkRows();
    expect(screen.getByRole("button", { name: /sheet/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /enter readings/i })).toHaveAttribute(
      "href",
      `/read-routes/rt-1/entry?date=${new Date().toLocaleDateString("en-CA")}`,
    );
  });

  /*
   * The date picker decides which day's sheet prints, and the entry link
   * sits against it. Without the day, entry opens a batch for *today* on
   * mount and posts the numbers off a 1 June sheet with today's read
   * date — silently, because the only thing that would say so is the
   * header the typist is not looking at.
   */
  it("carries the chosen day into entry, so the sheet typed in is the sheet printed", async () => {
    serve();
    renderPage();

    await walkRows();
    fireEvent.change(screen.getByLabelText("For"), { target: { value: "2026-06-01" } });

    expect(screen.getByRole("link", { name: /enter readings/i })).toHaveAttribute(
      "href",
      "/read-routes/rt-1/entry?date=2026-06-01",
    );
  });
});

/**
 * An EXTERNAL route is a row so a vendor's reads can point at something
 * (§5.4). It has no stops here, no sheet and nothing to type in — and
 * `GET /unsequenced` **refuses** one (400 `ROUTE_IS_EXTERNAL`), so a
 * page that asked anyway would show an error for a route that is
 * working exactly as intended.
 */
describe("Read route detail — a route a vendor owns", () => {
  const vendor = { ...ROUTE, origin: "EXTERNAL", stopCount: 0, code: "VEN-7", name: "VEN-7" };

  const vendorNote = () => screen.findByText(/owns this\s+route/i);

  it("says the vendor owns the itinerary instead of offering an empty walk", async () => {
    serve({ route: vendor, stops: [] });
    renderPage();

    expect(await vendorNote()).toBeInTheDocument();
    expect(screen.queryByTestId("unsequenced-tray")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stop-row")).not.toBeInTheDocument();
  });

  it("does not ask for the tray, which that endpoint refuses", async () => {
    serve({ route: vendor, stops: [] });
    renderPage();

    await vendorNote();
    const asked = get.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(asked.some((url) => url.includes("/unsequenced"))).toBe(false);
  });

  it("offers neither a sheet nor entry", async () => {
    serve({ route: vendor, stops: [] });
    renderPage();

    await vendorNote();
    expect(screen.queryByRole("button", { name: /sheet/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /enter readings/i })).not.toBeInTheDocument();
  });

  /*
   * Progress still answers for an EXTERNAL route — membership is learned
   * from the reads its code carried (§5.4) — so it is the one thing the
   * page can still say about one.
   */
  it("still says how far along it is, which is learned from its reads", async () => {
    serve({ route: vendor, stops: [] });
    renderPage();

    expect(await screen.findByText(/1 of 2/)).toBeInTheDocument();
  });
});
