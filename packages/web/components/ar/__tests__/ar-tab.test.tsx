import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ArTab } from "../ar-tab";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type { LedgerPage, LedgerRow } from "../ar-tab";

/**
 * The cases a table of rows gets wrong.
 *
 * These are deliberately about what a reader concludes, not about which
 * elements exist: an empty grid, "amount due -$20.00", and a reversed
 * pair that looks like a double charge are all renderable and all wrong.
 */

const mockedGet = vi.mocked(apiClient.get);

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

function page(over: Partial<LedgerPage> = {}): LedgerPage {
  return { data: [], balance: "0.00", openCount: 0, depositHeld: "0.00", ...over };
}

/**
 * The tab fetches two things: the ledger, and (when the user may post)
 * the unposted bills. Stubbing both with one value would hand ledger rows
 * to the bills strip, so route by path and default the bills to empty —
 * these cases are about rendering the ledger.
 */
function routeGets(p: LedgerPage, unposted: unknown[] = []) {
  mockedGet.mockImplementation((path: string) => {
    if (path.includes("/unposted-bills")) return Promise.resolve({ data: unposted } as never);
    return Promise.resolve(p as never);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe("ArTab", () => {
  // Review Focus: the common case for a new account.
  it("says nothing is owed when the ledger is empty, without drawing a table", async () => {
    routeGets(page());
    renderTab();

    expect(await screen.findByText(/no ledger activity yet/i)).toBeInTheDocument();
    // The balance card says "Nothing owed"; the body must not draw an
    // empty grid of headers under it.
    expect(screen.getByText(/nothing owed/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/still owed/i)).not.toBeInTheDocument();
  });

  // Review Focus: "Amount due -$20.00" is not English.
  it("says the customer is in credit rather than showing a negative amount due", async () => {
    routeGets(page({
        balance: "-20.00",
        openCount: 1,
        data: [
          row({ type: "PAYMENT", amount: "-20.00", openAmount: "-20.00", dueDate: null }),
        ],
      }),
    );
    renderTab();

    expect(await screen.findByText(/in credit/i)).toBeInTheDocument();
    expect(screen.queryByText(/amount due/i)).not.toBeInTheDocument();
    // The figure itself is unsigned; the words carry the direction.
    expect(screen.queryByText("-$20.00")).not.toBeInTheDocument();
  });

  it("says amount due when the balance is positive", async () => {
    routeGets(page({ balance: "40.00", openCount: 1, data: [row()] }));
    renderTab();

    expect(await screen.findByText(/amount due/i)).toBeInTheDocument();
    expect(screen.queryByText(/in credit/i)).not.toBeInTheDocument();
  });

  // Review Focus: charged and still owed are different facts.
  it("shows what was charged separately from what is still owed", async () => {
    routeGets(page({
        balance: "15.00",
        openCount: 1,
        data: [row({ amount: "40.00", openAmount: "15.00" })],
      }),
    );
    renderTab();

    // The balance card legitimately shows 15.00 too, so scope to the row.
    const table = await screen.findByRole("table");
    expect(within(table).getByText("$40.00")).toBeInTheDocument();
    expect(within(table).getByText("$15.00")).toBeInTheDocument();
  });

  it("shows a dash rather than zero for a settled entry", async () => {
    routeGets(page({
        balance: "0.00",
        openCount: 0,
        data: [row({ amount: "40.00", openAmount: "0.00", settled: true })],
      }),
    );
    renderTab();

    expect(await screen.findByText("$40.00")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("$0.00", { selector: "td" })).not.toBeInTheDocument();
  });

  // Review Focus: a reversed pair must not read as a double charge.
  it("marks both sides of a reversal", async () => {
    routeGets(page({
        balance: "0.00",
        openCount: 0,
        data: [
          row({ id: "e2", type: "REVERSAL", amount: "-50.00", openAmount: "0.00", settled: true, reversesEntryId: "e1" }),
          row({ id: "e1", amount: "50.00", openAmount: "0.00", settled: true, reversedByEntryId: "e2" }),
        ],
      }),
    );
    renderTab();

    expect(await screen.findByText(/^reversed$/i)).toBeInTheDocument();
    expect(screen.getByText(/reverses an earlier entry/i)).toBeInTheDocument();
  });

  it("shows a credit in brackets, the accounting convention", async () => {
    routeGets(page({
        balance: "-25.00",
        openCount: 1,
        data: [row({ type: "PAYMENT", amount: "-25.00", openAmount: "-25.00", tender: "CHECK" })],
      }),
    );
    renderTab();

    expect(await screen.findByText("($25.00)")).toBeInTheDocument();
  });

  it("prefers the reason's own label over the type name", async () => {
    routeGets(page({
        balance: "25.00",
        openCount: 1,
        data: [
          row({
            type: "FEE",
            amount: "25.00",
            openAmount: "25.00",
            reasonCode: "LATE_FEE",
            reasonLabel: "Late payment fee",
          }),
        ],
      }),
    );
    renderTab();

    expect(await screen.findByText("Late payment fee")).toBeInTheDocument();
    expect(screen.queryByText("Fee")).not.toBeInTheDocument();
  });

  it("pluralises the open-item count", async () => {
    routeGets(page({ balance: "40.00", openCount: 1, data: [row()] }));
    renderTab();
    expect(await screen.findByText("Open item")).toBeInTheDocument();
  });

  it("surfaces a load failure instead of rendering an empty ledger", async () => {
    mockedGet.mockRejectedValue(new Error("Service unavailable"));
    renderTab();

    expect(await screen.findByText("Service unavailable")).toBeInTheDocument();
    // Crucially NOT the empty state, which would read as "nothing owed".
    expect(screen.queryByText(/nothing owed/i)).not.toBeInTheDocument();
  });
});

describe("ArTab — a deposit is shown beside what is owed, not inside it", () => {
  it("shows the deposit held as its own figure", async () => {
    routeGets(page({ balance: "169.25", openCount: 1, depositHeld: "500.00", data: [row()] }));
    renderTab();

    // Both are true at once: they owe 169.25, the utility holds 500.
    expect(await screen.findByText("Amount due")).toBeInTheDocument();
    expect(screen.getByText("$169.25")).toBeInTheDocument();
    expect(screen.getByText("Deposit held")).toBeInTheDocument();
    expect(screen.getByText("$500.00")).toBeInTheDocument();
    // Said in words, because a reader seeing a $500 credit above a
    // $169.25 amount due will otherwise assume one should cancel the other.
    expect(screen.getByText(/Not counted against what is owed/i)).toBeInTheDocument();
  });

  it("says nothing about deposits on an account that holds none", async () => {
    routeGets(page({ balance: "40.00", openCount: 1, depositHeld: "0.00", data: [row()] }));
    renderTab();
    expect(await screen.findByText("Amount due")).toBeInTheDocument();
    expect(screen.queryByText("Deposit held")).toBeNull();
  });
});
