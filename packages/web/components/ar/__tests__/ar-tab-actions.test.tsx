import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

const LEDGER: LedgerPage = { data: [row()], balance: "40.00", openCount: 1 };

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
    });
    renderTab();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    // Neither the reversed original nor the reversal itself can be reversed.
    expect(screen.queryByRole("button", { name: /^reverse$/i })).not.toBeInTheDocument();
  });

});
