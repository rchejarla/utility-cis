import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import BillingRunsPage from "../page";

/**
 * The billing run list, and starting one.
 *
 * What these cases pin is the distinction the run's whole design rests
 * on: failed and skipped are different kinds, and the screen must never
 * add them into one "exceptions" figure. A clerk who sees 40 against a
 * run with nothing wrong goes and reads 40 rows for nothing; a clerk who
 * sees 0 failures against 40 skips knows there is no work.
 *
 * The start dialog's preview is the other thing worth pinning. The
 * window is the cycle's, not the operator's — asking for the 20th on a
 * cycle that bills on the 15th gives the window ending the 15th — so the
 * dialog has to state the resolved window before the button is pressed,
 * not after, because a run cannot be started twice.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

function run(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    billingCycleId: "cyc-1",
    billingCycleName: "Residential Monthly",
    billingCycleCode: "RES-M",
    windowStart: "2026-09-16",
    windowEnd: "2026-10-15",
    billDate: "2026-10-15",
    dueDate: "2026-11-14",
    status: "COMPLETE",
    accountCount: 120,
    billedCount: 118,
    failedCount: 0,
    skippedCount: 2,
    postedAt: null,
    cancelRequested: false,
    lastProgressAt: "2026-10-15T10:00:00.000Z",
    createdAt: "2026-10-15T09:00:00.000Z",
    ...over,
  };
}

function cycle(over: Record<string, unknown> = {}) {
  return {
    id: "cyc-1",
    name: "Residential Monthly",
    cycleCode: "RES-M",
    billDayOfMonth: 15,
    readDayOfMonth: 8,
    active: true,
    ...over,
  };
}

function preview(over: Record<string, unknown> = {}) {
  return {
    billingCycleId: "cyc-1",
    billingCycleName: "Residential Monthly",
    billingCycleCode: "RES-M",
    windowStart: "2026-09-16",
    windowEnd: "2026-10-15",
    billDate: "2026-10-15",
    dueDate: "2026-11-14",
    accountCount: 120,
    billableCount: 120,
    blockers: [],
    existingRun: null,
    ...over,
  };
}

/** A pre-flight finding: a cause, a count, and the thing to fix. */
function blocker(over: Record<string, unknown> = {}) {
  return {
    code: "SCHEDULE_NOT_PUBLISHED",
    accountCount: 4,
    detail: "BZN-WATER v1",
    sampleAccounts: ["0001000-00", "0001002-00"],
    ...over,
  };
}

function renderPage() {
  return render(
    <ToastProvider>
      <BillingRunsPage />
    </ToastProvider>,
  );
}

/** Route the page's two different GETs by path. */
function routeGets(opts: { runs?: unknown[]; cycles?: unknown[]; preview?: unknown }) {
  get.mockImplementation((path: string) => {
    if (path === "/api/v1/billing-runs") return Promise.resolve(opts.runs ?? []);
    if (path === "/api/v1/billing-cycles") return Promise.resolve(opts.cycles ?? [cycle()]);
    if (path === "/api/v1/billing-runs/preview")
      return Promise.resolve(opts.preview ?? preview());
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Billing runs list", () => {
  it("counts failed and skipped in separate columns", async () => {
    routeGets({ runs: [run({ failedCount: 3, skippedCount: 40 })] });
    renderPage();

    await screen.findByText("Residential Monthly");

    // Both headers exist, and neither says "exceptions" — the sum of the
    // two is the figure this screen must never show.
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
    expect(screen.queryByText(/exception/i)).not.toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
    // 43 would be the merged count.
    expect(screen.queryByText("43")).not.toBeInTheDocument();
  });

  it("says a calculated run is not posted, because nobody owes it yet", async () => {
    routeGets({ runs: [run({ postedAt: null })] });
    renderPage();

    expect(await screen.findByText("Not posted")).toBeInTheDocument();
  });

  it("shows the cycle, never the run id", async () => {
    routeGets({ runs: [run()] });
    renderPage();

    await screen.findByText("Residential Monthly");
    expect(screen.getByText("RES-M")).toBeInTheDocument();
    expect(screen.queryByText(/run-1/)).not.toBeInTheDocument();
  });
});

describe("Starting a run", () => {
  it("states the resolved window, dates and account count before the button works", async () => {
    routeGets({ runs: [] });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start a run" }));

    // Nothing can be started until a cycle is chosen: there is no
    // default cycle, and guessing one would start the wrong run.
    const confirm = screen.getByRole("button", { name: "Start the run" });
    expect(confirm).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText("Billing cycle"), "cyc-1");

    await waitFor(() => expect(screen.getByText("120")).toBeInTheDocument());
    expect(screen.getByText(/09\/16\/2026 – 10\/15\/2026 \(30 days\)/)).toBeInTheDocument();
    expect(screen.getByText("11/14/2026")).toBeInTheDocument();
    expect(confirm).toBeEnabled();
  });

  it("explains that the window is the cycle's own, not the date asked for", async () => {
    routeGets({ runs: [], preview: preview() });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start a run" }));
    await userEvent.selectOptions(screen.getByLabelText("Billing cycle"), "cyc-1");
    await waitFor(() => expect(screen.getByText("120")).toBeInTheDocument());

    // Ask for the 20th against a cycle whose window ends on the 15th.
    await userEvent.click(screen.getByText(/leave blank to use the cycle/i));
    const windowEnd = screen.getByLabelText("Window ending");
    await userEvent.type(windowEnd, "2026-10-20");

    await waitFor(() =>
      expect(
        screen.getByText(/the window ends 10\/15\/2026 rather than 10\/20\/2026/i),
      ).toBeInTheDocument(),
    );
  });

  it("refuses a second run for a window that already has one, and offers to open it", async () => {
    routeGets({
      runs: [],
      preview: preview({ existingRun: { id: "run-9", status: "PARTIAL" } }),
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start a run" }));
    await userEvent.selectOptions(screen.getByLabelText("Billing cycle"), "cyc-1");

    await waitFor(() =>
      expect(screen.getByText(/already been run \(PARTIAL\)/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Open that run" })).toHaveAttribute(
      "href",
      "/billing-runs/run-9",
    );
    expect(screen.getByRole("button", { name: "Start the run" })).toBeDisabled();
  });

  it("will not start a run with nothing to bill", async () => {
    routeGets({ runs: [], preview: preview({ accountCount: 0 }) });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start a run" }));
    await userEvent.selectOptions(screen.getByLabelText("Billing cycle"), "cyc-1");

    await waitFor(() =>
      expect(screen.getByText(/nothing to bill/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Start the run" })).toBeDisabled();
  });

  /**
   * The pre-flight, stated before the button is pressed.
   *
   * Eligibility answers "is this account due", not "can it be billed",
   * so a draft schedule or a missing assignment used to be discovered
   * one account at a time *during* the run and reported afterwards as
   * failures. One publish usually clears the whole group, which is why
   * the cause is what gets shown rather than a list of accounts.
   */
  it("warns which accounts cannot be billed, and why, before starting", async () => {
    routeGets({
      runs: [],
      preview: preview({ billableCount: 116, blockers: [blocker()] }),
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start a run" }));
    await userEvent.selectOptions(screen.getByLabelText("Billing cycle"), "cyc-1");

    const warning = await screen.findByTestId("run-blockers");
    // Both numbers: "4 of 120" is a different instruction from either
    // figure alone.
    expect(warning).toHaveTextContent("4");
    expect(warning).toHaveTextContent("120");
    // The thing to go and fix, named.
    expect(warning).toHaveTextContent("BZN-WATER v1");
  });

  it("still allows the run, since the rest of the accounts can bill", async () => {
    routeGets({
      runs: [],
      preview: preview({ billableCount: 116, blockers: [blocker()] }),
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start a run" }));
    await userEvent.selectOptions(screen.getByLabelText("Billing cycle"), "cyc-1");

    // Billing 116 and fixing 4 is a normal month. Refusing the run would
    // make one misconfigured account hold up the cycle.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start the run" })).toBeEnabled(),
    );
  });

  it("will not start a run when nothing at all can be billed", async () => {
    routeGets({
      runs: [],
      preview: preview({ billableCount: 0, blockers: [blocker({ accountCount: 120 })] }),
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start a run" }));
    await userEvent.selectOptions(screen.getByLabelText("Billing cycle"), "cyc-1");

    // A run that can bill nothing produces a FAILED run that then owns
    // the window — and one run per window is a database constraint, so
    // the only way on is resume. Better not to start it.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start the run" })).toBeDisabled(),
    );
  });

  it("says nothing when every eligible account is configured", async () => {
    routeGets({ runs: [], preview: preview() });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start a run" }));
    await userEvent.selectOptions(screen.getByLabelText("Billing cycle"), "cyc-1");

    await waitFor(() => expect(screen.getByText(/Accounts due/i)).toBeInTheDocument());
    expect(screen.queryByTestId("run-blockers")).toBeNull();
  });

  it("offers only active cycles, since an inactive one is refused by the API", async () => {
    routeGets({
      runs: [],
      cycles: [cycle(), cycle({ id: "cyc-2", name: "Retired", cycleCode: "OLD", active: false })],
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start a run" }));

    const select = screen.getByLabelText("Billing cycle") as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("Residential Monthly"))).toBe(true);
    expect(labels.some((l) => l?.includes("Retired"))).toBe(false);
  });

  it("tells the operator the run owes nothing until it is posted", async () => {
    routeGets({ runs: [] });
    post.mockResolvedValue(run({ status: "PENDING", billedCount: 0 }));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start a run" }));
    await userEvent.selectOptions(screen.getByLabelText("Billing cycle"), "cyc-1");
    await waitFor(() => expect(screen.getByText("120")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Start the run" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/billing-runs", { billingCycleId: "cyc-1" }),
    );
    expect(await screen.findByText(/Nothing is owed until it is posted/i)).toBeInTheDocument();
  });
});
