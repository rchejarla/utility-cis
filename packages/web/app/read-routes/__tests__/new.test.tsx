import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { selectLoadedOption } from "@/test-support/select-loaded-option";
import NewReadRoutePage from "../new/page";

/**
 * /read-routes/new — naming a route so it can be walked.
 *
 * **This page was missing, and its absence was worse than a gap.** The
 * list shipped an "Add Read Route" action and an empty-state call to
 * action, both pointing here, and both 404'd — so a tenant with no routes
 * met a dead end as the only thing the screen offered them, and
 * `POST /api/v1/read-routes` had no caller at all. Found by the e2e
 * stream writing a browser spec that had to create its fixture route
 * through the API because it could not be created by hand.
 *
 * **`origin` is not a field, and that is the design.** A route named here
 * is `LOCAL` by definition — somebody is about to build its walk. An
 * `EXTERNAL` route is created by the importer the first time a vendor's
 * read names a code nobody has seen (§5.4), and offering the choice here
 * would invite somebody to hand-make a row claiming a vendor owns an
 * itinerary that nobody is sending reads for. The validator defaults it,
 * so the body simply omits it.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/read-routes/new",
  useSearchParams: () => new URLSearchParams(),
}));

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

const CYCLES = [
  { id: "cyc-1", cycleCode: "R01", name: "Monthly — North" },
  { id: "cyc-2", cycleCode: "R02", name: "Monthly — South" },
];

function renderPage() {
  return render(
    <ToastProvider>
      <NewReadRoutePage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ data: CYCLES });
});

describe("Read routes — naming a new one", () => {
  it("asks for a code, a name and the cycle its reads are due in", async () => {
    renderPage();

    expect(await screen.findByLabelText(/code/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cycle/i)).toBeInTheDocument();
  });

  /*
   * A route with no cycle has no day its reads are due (§5.1), which is
   * why the column is NOT NULL — so the cycles have to be the tenant's
   * own, fetched, not typed.
   */
  /*
   * `selectLoadedOption` rather than `findByLabelText` then
   * `selectOptions`: the control renders before its list arrives, so
   * waiting for the control waits for the wrong thing. That race is this
   * repo's three unreproducible CI failures of 2026-11-07.
   */
  it("offers the cycles the tenant actually has", async () => {
    renderPage();

    const select = await selectLoadedOption(/billing cycle/i, "cyc-1");

    expect(within(select).getByRole("option", { name: /R01/ })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: /R02/ })).toBeInTheDocument();
  });

  it("does not offer to make a route a vendor owns", async () => {
    renderPage();

    await screen.findByLabelText(/code/i);
    expect(screen.queryByLabelText(/owner|origin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/EXTERNAL/)).not.toBeInTheDocument();
  });

  it("posts the code, the name and the cycle, and nothing else", async () => {
    post.mockResolvedValue({ id: "rt-new", code: "W-05", name: "South Willson" });
    renderPage();

    await userEvent.type(await screen.findByLabelText(/code/i), "W-05");
    await userEvent.type(screen.getByLabelText(/^name/i), "South Willson");
    await selectLoadedOption(/billing cycle/i, "cyc-1");
    await userEvent.click(screen.getByRole("button", { name: /create read route/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/read-routes", {
        code: "W-05",
        name: "South Willson",
        billingCycleId: "cyc-1",
      }),
    );
  });

  /*
   * The code is unique per tenant and the server refuses a duplicate with
   * 409 `ROUTE_CODE_TAKEN`. The operator has to see which field is at
   * fault — a route code is the thing people say out loud, so a collision
   * is the likely mistake here.
   */
  it("shows the refusal when the code is already taken", async () => {
    post.mockRejectedValue(new Error("API error 409: A route with code W-04 already exists"));
    renderPage();

    await userEvent.type(await screen.findByLabelText(/code/i), "W-04");
    await userEvent.type(screen.getByLabelText(/^name/i), "Duplicate");
    await selectLoadedOption(/billing cycle/i, "cyc-1");
    await userEvent.click(screen.getByRole("button", { name: /create read route/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });
});
