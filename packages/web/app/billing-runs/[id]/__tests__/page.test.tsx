import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import * as permModule from "@/lib/use-permission";
import BillingRunDetailPage from "../page";

/**
 * One billing run: the exception list and the posting gate.
 *
 * The gate is the point of the whole feature. A run calculates; until it
 * is posted no receivable exists and no customer owes any of it. Every
 * other screen in this app shows bills that are already owed, so a
 * finished-looking run that has moved no money has to say so out loud —
 * and the Post button has to state what it will raise before it raises
 * it, since posting cannot be undone.
 *
 * Failures open first because they are the only part of "what didn't
 * bill?" that is work. Skipped accounts have their own tab: "no read in
 * the window" is the ordinary state of a meter nobody has read yet, and
 * mixed into the failures it buries them.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

const params = Promise.resolve({ id: "run-1" });

function detail(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    billingCycleId: "cyc-1",
    billingCycleName: "Residential Monthly",
    billingCycleCode: "RES-M",
    windowStart: "2026-09-16",
    windowEnd: "2026-10-15",
    billDate: "2026-10-15",
    dueDate: "2026-11-14",
    status: "PARTIAL",
    accountCount: 120,
    billedCount: 118,
    failedCount: 1,
    skippedCount: 1,
    billedTotal: "9452.6100",
    postedAt: null,
    cancelRequested: false,
    lastProgressAt: "2026-10-15T10:00:00.000Z",
    createdAt: "2026-10-15T09:00:00.000Z",
    ...over,
  };
}

function item(over: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    accountId: "acc-1",
    accountNumber: "A-900",
    customerName: "Jane Smith",
    status: "FAILED",
    billId: null,
    servicePeriodStart: null,
    servicePeriodEnd: null,
    segmentCount: 0,
    total: null,
    errorCode: "SCHEDULE_NOT_PUBLISHED",
    errorMessage: "Rate schedule for agreement SA-1 is not published",
    processedAt: "2026-10-15T09:30:00.000Z",
    ...over,
  };
}

/** Route the run GET and the items GET, keyed on the status asked for. */
function routeGets(opts: {
  run?: Record<string, unknown>;
  byStatus?: Record<string, unknown[]>;
}) {
  get.mockImplementation((path: string, query?: Record<string, string>) => {
    if (path === "/api/v1/billing-runs/run-1") return Promise.resolve(opts.run ?? detail());
    if (path === "/api/v1/billing-runs/run-1/items") {
      return Promise.resolve(opts.byStatus?.[query?.status ?? ""] ?? []);
    }
    return Promise.resolve([]);
  });
}

/**
 * Render inside `act`, and await it.
 *
 * The route's params are a promise, so the component suspends on its
 * first render. Rendering outside an awaited `act` leaves that suspense
 * unflushed, and the very first case in the file then asserts against an
 * empty document while every later one passes — React has the resolved
 * promise cached by then. The asymmetry is the tell.
 */
async function renderPage() {
  await act(async () => {
    render(
      <ToastProvider>
        <BillingRunDetailPage params={params} />
      </ToastProvider>,
    );
  });
}

/**
 * Wait for the page to exist before asserting about it.
 *
 * The route's params are a promise, so the component suspends on first
 * render and the run then arrives from a second await. The default 1s
 * find window is close enough to that on a cold module that the first
 * case in the file fails on timing rather than on behaviour.
 */
function loaded() {
  return screen.findByText(/Residential Monthly/, {}, { timeout: 5000 });
}

/** The tab bar renders plain buttons — `Tabs` carries no tab roles. */
function tab(name: RegExp) {
  return screen.getByRole("button", { name });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Billing run detail — the posting gate", () => {
  it("says a finished run owes nothing until it is posted", async () => {
    routeGets({ byStatus: { FAILED: [item()] } });
    await renderPage();
    await loaded();

    expect(
      screen.getByText(/118 bills calculated, none posted — no customer owes any of it yet/),
    ).toBeInTheDocument();
  });

  it("names the amount and the count before posting, and warns what is left out", async () => {
    routeGets({ byStatus: { FAILED: [item()] } });
    await renderPage();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Post this run" }));

    // The figure, not just the count: this is the moment somebody is
    // deciding whether to put it on customers' accounts.
    expect(screen.getByText(/118 bills totalling \$9,452.61/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    // The failures are not in the total and will stay unbilled.
    expect(screen.getByText(/1 accounts failed and are not included/)).toBeInTheDocument();
  });

  it("posts only on confirmation, and reports what happened", async () => {
    routeGets({ byStatus: { FAILED: [] } });
    post.mockResolvedValue({ posted: 117, alreadyPosted: 1, failed: 0 });
    await renderPage();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Post this run" }));
    expect(post).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Post the run" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/billing-runs/run-1/post", {}),
    );
    // "Already posted" is not an error — somebody posting a bill by hand
    // in between agrees with us about the outcome.
    expect(await screen.findByText(/117 posted, 1 already posted\./)).toBeInTheDocument();
  });

  it("offers no Post button to a user who may only look", async () => {
    vi.spyOn(permModule, "usePermission").mockReturnValue({
      canView: true,
      canCreate: false,
      canEdit: false,
      canDelete: false,
    });
    routeGets({ byStatus: { FAILED: [] } });
    await renderPage();

    await loaded();
    expect(screen.queryByRole("button", { name: "Post this run" })).not.toBeInTheDocument();
  });

  it("offers no Post button while the run is still going", async () => {
    routeGets({ run: detail({ status: "RUNNING" }), byStatus: { FAILED: [] } });
    await renderPage();

    await loaded();
    expect(screen.queryByRole("button", { name: "Post this run" })).not.toBeInTheDocument();
    // Cancel is what is on offer instead; it stops after the current
    // account rather than undoing what billed.
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeInTheDocument();
  });

  it("says a posted run is already on the accounts, and offers no second posting", async () => {
    routeGets({
      run: detail({ status: "COMPLETE", postedAt: "2026-10-15" }),
      byStatus: { FAILED: [] },
    });
    await renderPage();

    await loaded();
    expect(
      screen.getByText(/Posted 10\/15\/2026 — these bills are now receivables/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post this run" })).not.toBeInTheDocument();
  });
});

describe("Billing run detail — exceptions", () => {
  it("opens on the failures, with the code an operator groups by", async () => {
    routeGets({ byStatus: { FAILED: [item()] } });
    await renderPage();
    await loaded();

    await screen.findByText("SCHEDULE_NOT_PUBLISHED");
    expect(get).toHaveBeenCalledWith("/api/v1/billing-runs/run-1/items", {
      status: "FAILED",
      limit: "500",
    });
    expect(screen.getByText("A-900")).toBeInTheDocument();
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
  });

  it("keeps skipped accounts out of the failures and in their own tab", async () => {
    routeGets({
      byStatus: {
        FAILED: [item()],
        SKIPPED: [
          item({
            id: "item-2",
            accountNumber: "A-901",
            status: "SKIPPED",
            errorCode: "NO_READ_IN_WINDOW",
            errorMessage: "No unbilled read on or before 2026-10-15",
          }),
        ],
      },
    });
    await renderPage();
    await loaded();

    await screen.findByText("SCHEDULE_NOT_PUBLISHED");
    expect(screen.queryByText("NO_READ_IN_WINDOW")).not.toBeInTheDocument();

    await userEvent.click(tab(/Skipped \(1\)/));

    await screen.findByText("NO_READ_IN_WINDOW");
    expect(screen.queryByText("SCHEDULE_NOT_PUBLISHED")).not.toBeInTheDocument();
  });

  it("reassures rather than puzzles when nothing failed", async () => {
    routeGets({ run: detail({ status: "COMPLETE", failedCount: 0 }), byStatus: { FAILED: [] } });
    await renderPage();

    await loaded();
    expect(
      screen.getByText(/Nothing failed\. Every account that was due/),
    ).toBeInTheDocument();
  });

  it("shows each billed account's own service period, read to read", async () => {
    routeGets({
      run: detail(),
      byStatus: {
        BILLED: [
          item({
            id: "item-3",
            status: "BILLED",
            billId: "bill-7",
            servicePeriodStart: "2026-09-14",
            servicePeriodEnd: "2026-10-13",
            segmentCount: 2,
            total: "64.2000",
            errorCode: null,
            errorMessage: null,
          }),
        ],
      },
    });
    await renderPage();

    await loaded();
    await userEvent.click(tab(/Billed \(118\)/));

    // The run's window is 09/16–10/15; this account's period is neither,
    // which is the read-to-read point and why the column exists.
    expect(await screen.findByText(/09\/14\/2026 – 10\/13\/2026 \(30d\)/)).toBeInTheDocument();
    expect(screen.getByText("$64.20")).toBeInTheDocument();
  });
});
