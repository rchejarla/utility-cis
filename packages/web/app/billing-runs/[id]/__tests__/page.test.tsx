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
    // Always present on the wire, so the fixture carries it too rather
    // than letting the page defend against a field the API guarantees.
    sentCount: 0,
    // Also guaranteed on the wire. The default is an unposted run, so
    // everything billed is still waiting.
    postedCount: 0,
    awaitingPostCount: 118,
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
  /** The one bill the detail dialog fetches, when a case opens it. */
  bill?: Record<string, unknown>;
  /** The exceptions, counted by cause. */
  groups?: unknown[];
}) {
  get.mockImplementation((path: string, query?: Record<string, string>) => {
    if (path === "/api/v1/billing-runs/run-1/exception-summary") {
      return Promise.resolve(opts.groups ?? []);
    }
    if (path === "/api/v1/billing-runs/run-1") return Promise.resolve(opts.run ?? detail());
    if (path === "/api/v1/billing-runs/run-1/items") {
      return Promise.resolve(opts.byStatus?.[query?.status ?? ""] ?? []);
    }
    if (opts.bill && path === `/api/v1/bills/${opts.bill.id}`) {
      return Promise.resolve(opts.bill);
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
      run: detail({
        status: "COMPLETE",
        postedAt: "2026-10-15",
        postedCount: 118,
        awaitingPostCount: 0,
      }),
      byStatus: { FAILED: [] },
    });
    await renderPage();

    await loaded();
    expect(
      screen.getByText(/Posted 10\/15\/2026 — these bills are now receivables/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post this run" })).not.toBeInTheDocument();
  });

  /*
   * `postedAt` says a posting pass ran, not that nothing is left. It is
   * stamped unconditionally at the end of the loop, so a run where three
   * bills threw was marked posted — and gating the button on it hid the
   * only way to finish them, under a banner saying the bills were now
   * receivables on their accounts.
   */
  it("keeps Post on a posted run whose bills did not all post, and says how many are left", async () => {
    routeGets({
      run: detail({
        status: "COMPLETE",
        postedAt: "2026-10-15",
        postedCount: 115,
        awaitingPostCount: 3,
      }),
      byStatus: { FAILED: [] },
    });
    await renderPage();

    await loaded();
    expect(screen.getByRole("button", { name: "Post this run" })).toBeInTheDocument();
    expect(screen.getByText(/3 of 118 could not post/i)).toBeInTheDocument();
    // And it must not also claim they all landed.
    expect(screen.queryByText(/these bills are now receivables/)).not.toBeInTheDocument();
  });

  /*
   * The distinction the two figures exist for. 115 posted of 118 with
   * nothing awaiting means the other three are held — somebody's
   * decision, not work outstanding. Counting the difference would offer
   * a Post whose only possible outcome is to report them held again.
   */
  it("does not call a held bill a failure, or offer a Post that cannot help it", async () => {
    routeGets({
      run: detail({
        status: "COMPLETE",
        postedAt: "2026-10-15",
        postedCount: 115,
        awaitingPostCount: 0,
      }),
      byStatus: { FAILED: [] },
    });
    await renderPage();

    await loaded();
    expect(screen.queryByRole("button", { name: "Post this run" })).not.toBeInTheDocument();
    expect(screen.queryByText(/could not post/i)).not.toBeInTheDocument();
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

  /**
   * Reviewing a run means working down its accounts, so looking at one
   * bill must not cost the place in the list.
   *
   * View used to be a link to the bill list, which left the run
   * entirely: first to `?search=<bill id>`, which matched nothing and
   * read as "no such bill", then to `?bill=<id>`, which opened the
   * right bill but on another screen. The operator is reviewing a run;
   * the bill belongs on top of it.
   */
  it("opens a billed account's bill without leaving the run", async () => {
    routeGets({
      run: detail(),
      byStatus: {
        BILLED: [
          item({
            id: "item-3",
            status: "BILLED",
            billId: "bill-7",
            total: "64.2000",
            errorCode: null,
            errorMessage: null,
          }),
        ],
      },
      bill: {
        id: "bill-7",
        billNumber: "BILL-202610-0001000-00",
        periodStart: "2026-09-14",
        periodEnd: "2026-10-13",
        billDate: "2026-10-13",
        dueDate: "2026-11-12",
        postedAt: null,
        subtotal: "64.2000",
        taxes: "0.0000",
        credits: "0.0000",
        total: "64.2000",
        segments: [],
      },
    });
    await renderPage();

    await loaded();
    await userEvent.click(tab(/Billed \(118\)/));
    await userEvent.click(await screen.findByRole("button", { name: "View" }));

    // The dialog fetched the bill, and the run is still underneath it.
    expect(await screen.findByText("BILL-202610-0001000-00")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/v1/bills/bill-7");
    expect(screen.getByText(/Billed \(118\)/)).toBeInTheDocument();
  });
});

/**
 * Resume is the only way forward from a run that did not finish.
 *
 * One run per cycle window is a database constraint
 * (`@@unique([utilityId, billingCycleId, windowEnd])`), so the period
 * cannot be started again. Before this button existed, a FAILED run
 * closed its window permanently and the refusal told the operator to
 * "resume or cancel" — neither of which was possible.
 */
describe("resuming a run", () => {
  const resumable = ["FAILED", "PARTIAL", "CANCELLED"];

  for (const status of resumable) {
    it(`offers Resume on a ${status} run`, async () => {
      routeGets({ run: detail({ status, billedCount: status === "PARTIAL" ? 2 : 0 }) });
      await renderPage();

      expect(
        await screen.findByRole("button", { name: /resume/i }),
      ).toBeInTheDocument();
    });
  }

  it("offers no Resume on a run with nothing left to bill", async () => {
    routeGets({ run: detail({ status: "COMPLETE", billedCount: 120 }) });
    await renderPage();

    await loaded();
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
  });

  it("offers no Resume while the run is still going", async () => {
    routeGets({ run: detail({ status: "RUNNING", billedCount: 4 }) });
    await renderPage();

    // Two workers on one run would race over the same items.
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
  });

  it("offers no Resume to a user who may only look", async () => {
    vi.spyOn(permModule, "usePermission").mockReturnValue({
      canView: true,
      canCreate: false,
      canEdit: false,
      canDelete: false,
    });
    routeGets({ run: detail({ status: "FAILED" }) });
    await renderPage();

    await loaded();
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
  });

  it("queues the unbilled accounts and reloads", async () => {
    routeGets({ run: detail({ status: "FAILED" }) });
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /resume/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/billing-runs/run-1/resume", {}),
    );
  });
});

/**
 * What there is to fix, as against what happened to each account.
 *
 * A run of twelve thousand accounts that fails forty on one unpublished
 * schedule presents as forty rows, and an operator reads forty rows to
 * find one job. The counts above the list say how many accounts; this
 * says how many *things*, which is what the work is sized by. It is the
 * same grouping the pre-flight shows before the run, so a cause reads
 * the same either side of it.
 */
describe("Billing run detail — exceptions by cause", () => {
  function group(over: Record<string, unknown> = {}) {
    return {
      status: "FAILED",
      code: "SCHEDULE_NOT_PUBLISHED",
      accountCount: 40,
      sampleAccounts: ["0001000-00", "0001002-00", "0001003-00"],
      message: "Cannot bill against unpublished rate schedule(s): BZN-WATER v1. Publish them first.",
      ...over,
    };
  }

  it("states the cause, how many accounts it holds, and examples", async () => {
    routeGets({ run: detail({ failedCount: 40 }), groups: [group()] });
    await renderPage();

    await loaded();
    const panel = await screen.findByTestId("exception-causes");
    expect(panel).toHaveTextContent("40");
    expect(panel).toHaveTextContent("SCHEDULE_NOT_PUBLISHED");
    expect(panel).toHaveTextContent("0001000-00");
  });

  it("shows the causes for the tab being read, not all of them at once", async () => {
    // Failures and skips are separate tabs because only one is work;
    // merging their causes into one panel would undo that.
    routeGets({
      run: detail({ failedCount: 40, skippedCount: 7 }),
      groups: [
        group(),
        group({ status: "SKIPPED", code: "NO_READ_IN_WINDOW", accountCount: 7 }),
      ],
    });
    await renderPage();

    await loaded();
    const failures = await screen.findByTestId("exception-causes");
    expect(failures).toHaveTextContent("SCHEDULE_NOT_PUBLISHED");
    expect(failures).not.toHaveTextContent("NO_READ_IN_WINDOW");

    await userEvent.click(tab(/Skipped \(7\)/));
    const skips = await screen.findByTestId("exception-causes");
    expect(skips).toHaveTextContent("NO_READ_IN_WINDOW");
    expect(skips).not.toHaveTextContent("SCHEDULE_NOT_PUBLISHED");
  });

  it("says nothing when a run has nothing wrong", async () => {
    routeGets({ run: detail({ failedCount: 0 }), groups: [] });
    await renderPage();

    await loaded();
    expect(screen.queryByTestId("exception-causes")).toBeNull();
  });
});

/**
 * Sending a run's bills.
 *
 * Delivery existed one bill at a time, which is a feature for a utility
 * with twelve customers. The run is where it scales: it knows which
 * bills it made, and posting already precedes sending.
 *
 * Offered only once posted, because an unposted run is a calculation
 * nobody owes — and what comes back is reported by cause, since one
 * missing address usually stands for a group.
 */
describe("Billing run detail — sending", () => {
  it("says how many of its bills have actually gone out", async () => {
    routeGets({
      run: detail({ postedAt: "2026-10-16T09:00:00.000Z", billedCount: 118, sentCount: 116 }),
    });
    await renderPage();

    await loaded();
    // Derived on read, so it is still true days later — unlike the send
    // panel, which a reload loses.
    expect(await screen.findByText(/116 of 118/)).toBeInTheDocument();
  });

  it("does not offer Send until the run is posted", async () => {
    routeGets({ run: detail({ postedAt: null }) });
    await renderPage();

    await loaded();
    expect(screen.queryByRole("button", { name: /^send bills$/i })).toBeNull();
  });

  it("sends, and says how many went and what did not", async () => {
    routeGets({ run: detail({ postedAt: "2026-10-16T09:00:00.000Z" }) });
    post.mockResolvedValue({
      queued: 116,
      skipped: [
        {
          code: "NO_EMAIL_ADDRESS",
          accountCount: 4,
          sampleAccounts: ["0001000-00", "0001002-00"],
          message: "no email address",
        },
      ],
    });
    await renderPage();

    await loaded();
    await userEvent.click(screen.getByRole("button", { name: /^send bills$/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/billing-runs/run-1/send", {}),
    );
    // Both numbers: "116 sent" alone hides four customers who got
    // nothing, and the cause is what someone has to act on. Matched on
    // the panel's own wording — the toast says "116 bills queued" and
    // would otherwise make this ambiguous.
    expect(await screen.findByText(/116 queued for delivery/)).toBeInTheDocument();
    expect(screen.getByText(/NO_EMAIL_ADDRESS/)).toBeInTheDocument();
    expect(screen.getByText(/0001000-00/)).toBeInTheDocument();
  });
});
