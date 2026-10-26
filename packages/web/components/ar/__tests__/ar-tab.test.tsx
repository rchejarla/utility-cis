import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    billId: null,
    assessedOnBillNumber: null,
    assessedOnBillId: null,
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

    // Both money columns, not just the charged one: an unapplied credit
    // is not owed either, and a bare figure under "Still owed" says it
    // is. This asserted one match before the open-amount column picked
    // up the convention.
    const table = await screen.findByRole("table");
    expect(within(table).getAllByText("($25.00)")).toHaveLength(2);
  });

  /**
   * The per-entry column says "Open", not "Still owed".
   *
   * It holds `openAmount` — what is left of *this* entry — and it sat
   * two inches under a card labelled "Amount due", which is the whole
   * account. Two different questions in nearly the same words, and a
   * reader took the column for the account's balance. "Open" matches
   * both the card beside it ("Open items") and the ledger's own
   * vocabulary, so the two visibly refer to one thing at two scales.
   *
   * The Bills page keeps "Still owed" for a *bill*, where it sits next
   * to Total and spec 23 argues for it.
   */
  it("names the per-entry column for what it holds, not for the account's balance", async () => {
    routeGets(page({ balance: "40.00", openCount: 1, data: [row()] }));
    renderTab();

    const table = await screen.findByRole("table");
    expect(within(table).getByText("Open")).toBeInTheDocument();
    expect(within(table).queryByText("Still owed")).not.toBeInTheDocument();
    // Charged stays: a $40 charge with $15 left is not a $15 charge.
    expect(within(table).getByText("Charged")).toBeInTheDocument();
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

  /**
   * Which bill a late fee punishes.
   *
   * A fee has no bill of its own, so the bill column was blank on the
   * one row where a customer most wants an answer — and the per-bill
   * ladder can raise three of them in a single sweep, leaving a CSR
   * three "Late payment fee" rows that differ only in their memo.
   */
  it("says which bill a fee was raised on, where the fee has no bill of its own", async () => {
    routeGets(page({
        balance: "20.00",
        openCount: 2,
        data: [
          row({
            id: "f1",
            type: "FEE",
            amount: "10.00",
            openAmount: "10.00",
            reasonLabel: "Late payment fee",
            billNumber: null,
            billId: null,
            assessedOnBillNumber: "BILL-202608-1",
            assessedOnBillId: "b-aug",
          }),
          row({
            id: "f2",
            type: "FEE",
            amount: "10.00",
            openAmount: "10.00",
            reasonLabel: "Late payment fee",
            billNumber: null,
            billId: null,
            assessedOnBillNumber: "BILL-202609-1",
            assessedOnBillId: "b-sep",
          }),
        ],
      }),
    );
    renderTab();

    const table = await screen.findByRole("table");
    expect(within(table).getByText("for BILL-202608-1")).toBeInTheDocument();
    expect(within(table).getByText("for BILL-202609-1")).toBeInTheDocument();
  });

  /**
   * The bill a row belongs to, in its own column.
   *
   * It lived inside the Detail cell, joined with the tender, the due
   * date and the memo in 12px muted grey — present, and not findable by
   * someone scanning for a bill number, which is what a CSR holds on a
   * call.
   *
   * The column carries two different relationships and has to keep them
   * apart: a BILL_CHARGE **came from** a bill, a FEE was **raised on**
   * one and belongs to no bill of its own. So the second reads "for
   * <number>", which under a heading of "Bill" says what it means
   * without a sentence. A bare number in both places would assert the
   * first where the truth is the second.
   */
  it("gives the bill its own column, keeping 'came from' apart from 'raised on'", async () => {
    routeGets(page({
        balance: "40.00",
        openCount: 2,
        data: [
          row({ id: "c1", billNumber: "BILL-202610-1" }),
          row({
            id: "f1",
            type: "FEE",
            reasonLabel: "Late payment fee",
            billNumber: null,
            assessedOnBillNumber: "BILL-202608-1",
          }),
          row({ id: "p1", type: "PAYMENT", amount: "-20.00", billNumber: null, tender: "CHECK" }),
        ],
      }),
    );
    renderTab();

    const table = await screen.findByRole("table");
    expect(within(table).getByText("Bill")).toBeInTheDocument();
    expect(within(table).getByText("BILL-202610-1")).toBeInTheDocument();
    expect(within(table).getByText("for BILL-202608-1")).toBeInTheDocument();
    // A payment belongs to no bill either way, and says so rather than
    // leaving a cell that reads as missing data.
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
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

/**
 * A deposit row, which is where the open-item columns are easiest to
 * misread. The utility HOLDS the money; nothing about it is owed.
 */
describe("ArTab — a deposit row does not read as a debt", () => {
  const DEPOSIT_ROW = row({
    id: "d1",
    type: "DEPOSIT",
    amount: "-750.00",
    openAmount: "-750.00",
    settled: false,
    dueDate: null,
    billNumber: null,
    tender: "CHECK",
  });

  it("shows the still-owed figure in brackets, not as a bare amount", async () => {
    routeGets(page({ balance: "0.00", openCount: 0, depositHeld: "750.00", data: [DEPOSIT_ROW] }));
    renderTab();
    const table = await screen.findByRole("table");
    // Both columns bracketed: ($750.00) charged, ($750.00) still owed.
    // Bare "$750.00" in the second column reads as the customer owing
    // it, which is the opposite of what a deposit is.
    expect(within(table).getAllByText("($750.00)")).toHaveLength(2);
    expect(within(table).queryByText("$750.00")).toBeNull();
  });

  it("names the act instead of printing the raw enum", async () => {
    routeGets(page({ balance: "0.00", openCount: 0, depositHeld: "750.00", data: [DEPOSIT_ROW] }));
    renderTab();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Deposit taken")).toBeInTheDocument();
    expect(within(table).queryByText("DEPOSIT")).toBeNull();
  });

  it("still shows a real debit as owed, unbracketed", async () => {
    routeGets(page({ balance: "40.00", openCount: 1, depositHeld: "0.00", data: [row()] }));
    renderTab();
    const table = await screen.findByRole("table");
    // A charge IS owed, so it must not pick up the credit convention.
    expect(within(table).getAllByText("$40.00")).toHaveLength(2);
    expect(within(table).queryByText("($40.00)")).toBeNull();
  });
});

/**
 * The bill as a document, offered where staff already are when a
 * customer phones about one. A ledger entry exists only once its bill is
 * posted, so there is no unposted case to guard against here.
 */
describe("ArTab — the bill's PDF", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    // Viewing a bill opens a tab; jsdom's window.open returns null, so
    // without this the case would exercise the download fallback rather
    // than the viewer path.
    vi.stubGlobal("open", vi.fn(() => ({ location: { href: "" }, close: vi.fn() })));
    window.URL.createObjectURL = vi.fn(() => "blob:bill");
    window.URL.revokeObjectURL = vi.fn();
    vi.mocked(apiClient.getAuthHeadersOnly).mockResolvedValue({ Authorization: "Bearer t" });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(["%PDF-"], { type: "application/pdf" }),
    });
  });

  it("downloads a bill charge's stored PDF from the bill's own endpoint", async () => {
    routeGets(
      page({
        balance: "40.00",
        openCount: 1,
        data: [
          row({
            billId: "bill-9",
          }),
        ],
      }),
    );
    renderTab();

    await userEvent.click(await screen.findByRole("button", { name: "View bill" }));

    // The bill, not the ledger entry: a document belongs to the bill.
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/v1/bills/bill-9/document")),
    ).toBe(true);
  });

  it("offers nothing on a row that charged no bill", async () => {
    routeGets(
      page({
        balance: "0.00",
        depositHeld: "750.00",
        data: [row({ id: "d1", type: "DEPOSIT", billNumber: null, billId: null })],
      }),
    );
    renderTab();

    await screen.findByRole("table");
    // View bill is the only bill-scoped action this tab renders, so it is
    // the whole of the claim. There was a second assertion here about a
    // `button` named "Regenerate": nothing in the AR tab has ever offered
    // regeneration — it lives on the Bills screen behind a menu — so it
    // guarded a feature that does not exist here and could not fail.
    expect(screen.queryByRole("button", { name: "View bill" })).not.toBeInTheDocument();
  });
});

/**
 * The whole tab is one card, not a bare table on the page.
 *
 * Every other tab on this account draws a `--bg-card` panel — DataTable
 * for Agreements and Audit, ContactsTab for Contacts — and AR and Bills
 * were the only two that did not, so on the light theme they were the
 * page's indigo-grey all the way down while their siblings were white.
 *
 * The card goes around the *whole* tab, not around the table alone. The
 * three figures and the unposted-bills note are a reading of the ledger
 * below them, and the acts change it; floated above an isolated table
 * they read as page furniture that happens to sit nearby. Bills takes
 * the same shape — see the matching cases in bills-tab.test.tsx.
 */
describe("ArTab — the card it sits on", () => {
  it("puts the ledger on a card", async () => {
    routeGets(page({ data: [row()], balance: "40.00", openCount: 1 }));
    renderTab();
    const panel = (await screen.findByRole("table")).parentElement!;
    expect(panel).toHaveStyle({ background: "var(--bg-card)" });
  });

  it("puts the empty state on it too, rather than floating it on the page", async () => {
    routeGets(page());
    renderTab();
    const empty = await screen.findByText(/no ledger activity yet/i);
    expect(empty.parentElement).toHaveStyle({ background: "var(--bg-card)" });
  });

  it("holds the figures and the acts inside that same card", async () => {
    routeGets(page({ data: [row()], balance: "40.00", openCount: 1 }));
    renderTab();
    const card = (await screen.findByRole("table")).parentElement!;
    expect(card).toContainElement(screen.getByText("Amount due"));
    expect(card).toContainElement(screen.getByText("Open item"));
    expect(card).toContainElement(screen.getByRole("button", { name: /record payment/i }));
  });

  it("holds the unposted-bills note inside it too", async () => {
    // The note explains the figure above it and the rows below it, so it
    // is the last thing that should be floating loose on the page.
    routeGets(page({ data: [row()], balance: "40.00", openCount: 1 }), [
      { id: "b1", billNumber: "B-9", periodStart: "", periodEnd: "", dueDate: "", total: "10.00" },
    ]);
    renderTab();
    const card = (await screen.findByRole("table")).parentElement!;
    expect(card).toContainElement(await screen.findByText(/not yet owed/i));
  });
});
