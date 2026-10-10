import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArTab } from "../ar-tab";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import * as permModule from "@/lib/use-permission";
import type { LedgerPage, LedgerRow } from "../ar-tab";

/**
 * The actions, and above all the permission matrix.
 *
 * `usePermission` is mocked to all-allowed in vitest.setup.ts, so every
 * case that cares about a gate MUST override it — otherwise the test
 * passes while asserting nothing, which is the trap the plan called out.
 */

const mockedGet = vi.mocked(apiClient.get);
const mockedPost = vi.mocked(apiClient.post);

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: "e1",
    type: "BILL_CHARGE",
    amount: "40.00",
    openAmount: "40.00",
    settled: false,
    effectiveDate: "2026-05-15",
    dueDate: "2026-06-14",
    postedAt: "2026-05-15T00:00:00.000Z",
    reasonCode: null,
    reasonLabel: null,
    billNumber: "BILL-202605-1",
    tender: null,
    memo: null,
    reversedByEntryId: null,
    reversesEntryId: null,
    ...over,
  };
}

const LEDGER: LedgerPage = { data: [row()], balance: "40.00", openCount: 1, depositHeld: "0.00" };

const UNPOSTED = {
  data: [
    {
      id: "b1",
      billNumber: "BILL-202610-1",
      periodStart: "2026-09-16T00:00:00.000Z",
      periodEnd: "2026-10-15T00:00:00.000Z",
      dueDate: "2026-11-14T00:00:00.000Z",
      total: "38.7500",
    },
  ],
};

/** Grant exactly these module permissions and nothing else. */
function grant(perms: Record<string, string[]>) {
  vi.spyOn(permModule, "usePermission").mockImplementation((module?: string) => {
    const p = (module && perms[module]) || [];
    return {
      canView: p.includes("VIEW"),
      canCreate: p.includes("CREATE"),
      canEdit: p.includes("EDIT"),
      canDelete: p.includes("DELETE"),
    };
  });
}

function routeGets(ledger: LedgerPage = LEDGER, unposted = UNPOSTED) {
  mockedGet.mockImplementation((path: string) => {
    if (path.includes("/ledger")) return Promise.resolve(ledger as never);
    if (path.includes("/unposted-bills")) return Promise.resolve(unposted as never);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/**
 * The tab calls useToast, which throws outside a provider. In the app it
 * always renders inside the ToastProvider from layout.tsx, so the tests
 * supply the real one — mocking useToast globally would change shared
 * setup for every other suite to suit this file.
 */
function renderTab(accountId = "a1") {
  return render(
    <ToastProvider>
      <ArTab accountId={accountId} />
    </ToastProvider>,
  );
}

describe("ArTab actions — permissions", () => {
  it("shows Record Payment to payments:CREATE and hides it otherwise", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW", "CREATE"] });
    routeGets();
    renderTab();
    expect(await screen.findByRole("button", { name: /record payment/i })).toBeInTheDocument();
  });

  it("hides Record Payment from a user with no payments permission", async () => {
    grant({ accounts: ["VIEW", "EDIT"] });
    routeGets();
    renderTab();
    // Wait for the load to settle before asserting an absence.
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /record payment/i })).not.toBeInTheDocument();
  });

  it("hides Reverse without payments:EDIT", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW", "CREATE"] });
    routeGets();
    renderTab();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^reverse$/i })).not.toBeInTheDocument();
  });

  it("shows Reverse with payments:EDIT", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW", "EDIT"] });
    routeGets();
    renderTab();
    expect(await screen.findByRole("button", { name: /^reverse$/i })).toBeInTheDocument();
  });

  it("shows the unposted note to a read-only user", async () => {
    // The endpoint is accounts:VIEW, and the note explains a balance that
    // looks lower than the customer expects — which is exactly what a
    // read-only CSR is looking at. The old accounts:EDIT gate here was
    // copied from the Post button and hid it from them.
    grant({ accounts: ["VIEW"] });
    routeGets();
    renderTab();
    expect(await screen.findByText(/not yet owed/i)).toBeInTheDocument();
    const paths = mockedGet.mock.calls.map((c) => c[0] as string);
    expect(paths.some((p) => p.includes("unposted-bills"))).toBe(true);
  });

  it("offers no Post action on this tab, at any permission", async () => {
    // Posting moved to the Bills screen. A tab that lists what is owed
    // cannot show an unposted bill among its rows, so the action did not
    // belong on the one screen that cannot display its subject.
    grant({ accounts: ["VIEW", "EDIT"] });
    routeGets();
    renderTab();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^post$/i })).not.toBeInTheDocument();
  });

  it("points at Bills, filtered to what is waiting", async () => {
    grant({ accounts: ["VIEW"] });
    routeGets();
    renderTab();
    const link = await screen.findByRole("link", { name: /review in bills/i });
    expect(link).toHaveAttribute("href", "/bills?posted=false");
  });

});

describe("ArTab actions — behaviour", () => {
  it("warns when a reversal leaves dependent fees standing", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW", "EDIT"] });
    routeGets();
    mockedPost.mockResolvedValue({ balance: "40.00", dependentFees: [{ id: "f1" }] } as never);
    renderTab();

    await userEvent.click(await screen.findByRole("button", { name: /^reverse$/i }));
    // The confirm names what happens, including that nothing is deleted.
    expect(screen.getByText(/nothing is deleted/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /reverse entry/i }));

    await waitFor(() =>
      expect(mockedPost).toHaveBeenCalledWith("/api/v1/ledger-entries/e1/reverse", {}),
    );
  });

  it("offers no Reverse on an entry that is already reversed", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW", "EDIT"] });
    routeGets({
      data: [row({ reversedByEntryId: "e2" }), row({ id: "e2", type: "REVERSAL", reversesEntryId: "e1" })],
      balance: "0.00",
      openCount: 0,
      depositHeld: "0.00",
    });
    renderTab();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    // Neither the reversed original nor the reversal itself can be reversed.
    expect(screen.queryByRole("button", { name: /^reverse$/i })).not.toBeInTheDocument();
  });

});

/**
 * Refunds — money leaving.
 *
 * The gate is `payments:CREATE`, the same authority as taking money.
 * The button appears only when there is something to give back, because
 * a Refund button on an account that owes money invites a click whose
 * only possible outcome is a 422.
 */
describe("ArTab — refunds", () => {
  const IN_CREDIT: LedgerPage = {
    data: [row({ type: "PAYMENT", amount: "-60.00", openAmount: "-60.00" })],
    balance: "-60.00",
    openCount: 1,
    depositHeld: "0.00",
  };
  const HOLDS_DEPOSIT: LedgerPage = {
    data: [row({ type: "DEPOSIT", amount: "-500.00", openAmount: "-500.00" })],
    balance: "0.00",
    openCount: 0,
    depositHeld: "500.00",
  };

  it("offers Refund when the account is in credit", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW", "CREATE"] });
    routeGets(IN_CREDIT);
    renderTab();
    expect(await screen.findByRole("button", { name: /^refund$/i })).toBeInTheDocument();
  });

  it("offers Refund when a deposit is held, even with nothing owed", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW", "CREATE"] });
    routeGets(HOLDS_DEPOSIT);
    renderTab();
    expect(await screen.findByRole("button", { name: /^refund$/i })).toBeInTheDocument();
  });

  it("offers no Refund when there is nothing to give back", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW", "CREATE"] });
    // Owes 40.00, holds no deposit.
    routeGets();
    renderTab();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^refund$/i })).not.toBeInTheDocument();
  });

  it("hides Refund from a subject without payments:CREATE", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW"] });
    routeGets(IN_CREDIT);
    renderTab();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^refund$/i })).not.toBeInTheDocument();
  });

  it("posts the pool it was told to draw from", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW", "CREATE"] });
    routeGets(IN_CREDIT);
    mockedPost.mockResolvedValue({
      entryId: "r1",
      amount: "60.00",
      source: "CREDIT",
      balance: "0.00",
      depositAmount: "0.00",
    } as never);
    renderTab();

    await userEvent.click(await screen.findByRole("button", { name: /^refund$/i }));
    await userEvent.click(screen.getByRole("button", { name: /issue refund/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    const [url, body] = mockedPost.mock.calls[0]!;
    expect(url).toBe("/api/v1/accounts/a1/refunds");
    expect(body).toMatchObject({ amount: "60.00", source: "CREDIT" });
  });

  it("draws from the deposit when that is the pool with money in it", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW", "CREATE"] });
    routeGets(HOLDS_DEPOSIT);
    mockedPost.mockResolvedValue({
      entryId: "r1",
      amount: "500.00",
      source: "DEPOSIT",
      balance: "0.00",
      depositAmount: "0.00",
    } as never);
    renderTab();

    await userEvent.click(await screen.findByRole("button", { name: /^refund$/i }));
    await userEvent.click(screen.getByRole("button", { name: /issue refund/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(mockedPost.mock.calls[0]![1]).toMatchObject({ amount: "500.00", source: "DEPOSIT" });
  });

  // The server is the authority on what is available, so its refusal has
  // to reach the operator rather than being swallowed by a closing dialog.
  it("keeps the dialog open and shows why, when the server refuses", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW", "CREATE"] });
    routeGets(IN_CREDIT);
    mockedPost.mockRejectedValue(
      new Error("Cannot refund 60.00: only 40.00 is available from the credit balance"),
    );
    renderTab();

    await userEvent.click(await screen.findByRole("button", { name: /^refund$/i }));
    await userEvent.click(screen.getByRole("button", { name: /issue refund/i }));

    expect(await screen.findByText(/only 40.00 is available/i)).toBeInTheDocument();
    // Still open, with what was typed intact.
    expect(screen.getByRole("button", { name: /issue refund/i })).toBeInTheDocument();
  });

  /**
   * The row is named for the ACT, the card for the standing figure —
   * "Deposit taken" happened on a date, "Deposit held" is what is there
   * now. Asserted inside the table so the card cannot satisfy it.
   */
  it("names a DEPOSIT row for the act, instead of printing the raw enum", async () => {
    grant({ accounts: ["VIEW"], payments: ["VIEW"] });
    routeGets(HOLDS_DEPOSIT);
    renderTab();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Deposit taken")).toBeInTheDocument();
    expect(within(table).queryByText("DEPOSIT")).not.toBeInTheDocument();
    // The standing figure is the card's job, and it is still there.
    expect(screen.getByText("Deposit held")).toBeInTheDocument();
  });
});
