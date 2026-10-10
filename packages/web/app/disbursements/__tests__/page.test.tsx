import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import DisbursementsPage from "../page";

/**
 * Money paid out. The mirror of Receipts, and the question that had no
 * answer before: a refund was visible on one account's AR tab and
 * nowhere tenant-wide, so "what did we pay out today" could not be
 * asked.
 *
 * The cases that matter are the ones about the figure being tied out
 * against a cheque run, and about not confusing the two kinds — a
 * credit refund hands back an overpayment, a deposit return releases
 * collateral, and they discharge different liabilities.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "r1",
    amount: "200.00",
    source: "CREDIT",
    tender: "CHECK",
    effectiveDate: "2026-07-02",
    externalRef: "CHQ-7001",
    memo: null,
    reversed: false,
    account: { id: "acc1", accountNumber: "0001000-00", customerName: "Ada Lovelace" },
    ...over,
  };
}

function payload(
  rows: unknown[],
  totalPaidOut = "200.00",
  subtotals: Record<string, string> = { CREDIT: totalPaidOut, DEPOSIT: "0.00" },
) {
  return {
    data: rows,
    meta: { total: rows.length, page: 1, limit: 25, pages: 1 },
    totalPaidOut,
    subtotals,
  };
}

function renderPage() {
  return render(
    <ToastProvider>
      <DisbursementsPage />
    </ToastProvider>,
  );
}

const urls = () => get.mock.calls.map(([u]) => String(u));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Disbursements page", () => {
  it("opens on today, because that is the question being asked", async () => {
    get.mockResolvedValue(payload([]));
    renderPage();

    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await waitFor(() =>
      expect(urls().some((u) => u.includes(`from=${iso}`) && u.includes(`to=${iso}`))).toBe(true),
    );
  });

  it("reads from the disbursements endpoint, never the receipts one", async () => {
    get.mockResolvedValue(payload([]));
    renderPage();
    await waitFor(() =>
      expect(urls().some((u) => u.startsWith("/api/v1/disbursements?"))).toBe(true),
    );
    // Mixing directions on one request is what this screen exists to avoid.
    expect(urls().some((u) => u.includes("/receipts"))).toBe(false);
  });

  it("shows what left as the headline figure", async () => {
    get.mockResolvedValue(payload([row()], "1234.50"));
    renderPage();
    expect(await screen.findByTestId("disbursement-total")).toHaveTextContent("$1,234.50");
  });

  it("splits credit refunds from deposit returns", async () => {
    get.mockResolvedValue(
      payload(
        [row(), row({ id: "r2", source: "DEPOSIT", amount: "500.00", externalRef: "CHQ-DEP" })],
        "700.00",
        { CREDIT: "200.00", DEPOSIT: "500.00" },
      ),
    );
    renderPage();

    expect(await screen.findByTestId("disbursement-total")).toHaveTextContent("$700.00");
    const split = screen.getByTestId("disbursement-split");
    expect(split).toHaveTextContent("Credit refunds $200.00");
    expect(split).toHaveTextContent("Deposit returns $500.00");
  });

  /**
   * A day with no deposit returns must say so. A line that vanishes at
   * zero cannot be told from a screen that never looked — the same
   * failure as a reconciliation reporting clean because it saw nothing.
   */
  it("states a zero for the kind that paid out nothing", async () => {
    get.mockResolvedValue(payload([row()], "200.00", { CREDIT: "200.00", DEPOSIT: "0.00" }));
    renderPage();
    const split = await screen.findByTestId("disbursement-split");
    expect(split).toHaveTextContent("Deposit returns $0.00");
  });

  it("tags a deposit return, so it is not read as refunding an overpayment", async () => {
    get.mockResolvedValue(
      payload([row({ source: "DEPOSIT" })], "200.00", { CREDIT: "0.00", DEPOSIT: "200.00" }),
    );
    renderPage();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Deposit return")).toBeInTheDocument();
  });

  /**
   * A refund with no credits behind it cannot be produced by the
   * service, so it means a hand-written row. Saying "Unknown" is the
   * point: defaulting it to a credit refund would put money in the wrong
   * column of a reconciliation.
   */
  it("says Unknown rather than guessing a kind", async () => {
    get.mockResolvedValue(
      payload([row({ source: null })], "200.00", { CREDIT: "0.00", DEPOSIT: "0.00" }),
    );
    renderPage();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Unknown")).toBeInTheDocument();
  });

  it("still counts a reversed refund, and marks the row", async () => {
    // A cheque written on the 2nd and voided later still left on the
    // 2nd, and the 2nd's cheque run has to agree.
    get.mockResolvedValue(
      payload(
        [row({ reversed: true }), row({ id: "r2", amount: "50.00", externalRef: "CHQ-2" })],
        "250.00",
      ),
    );
    renderPage();

    expect(await screen.findByTestId("disbursement-total")).toHaveTextContent("$250.00");
    expect(screen.getByText("reversed")).toBeInTheDocument();
    expect(screen.getByText(/still counted here/i)).toBeInTheDocument();
  });

  it("links a disbursement to the account's AR tab, where the entry lives", async () => {
    get.mockResolvedValue(payload([row()]));
    renderPage();
    const link = await screen.findByRole("link", { name: "0001000-00" });
    expect(link).toHaveAttribute("href", "/accounts/acc1?tab=ar");
  });

  it("sends the tender filter", async () => {
    get.mockResolvedValue(payload([]));
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: /Paid by/ }));
    await userEvent.click(screen.getByText("Check"));

    await waitFor(() => expect(urls().some((u) => u.includes("tender=CHECK"))).toBe(true));
  });

  it("renders the issue date without a timezone shift", async () => {
    get.mockResolvedValue(payload([row({ effectiveDate: "2026-07-02" })]));
    renderPage();
    // Not 07/01: UTC-midnight parsing would move it back a day.
    expect(await screen.findByText("07/02/2026")).toBeInTheDocument();
  });

  it("says the range paid out nothing rather than showing a bare table", async () => {
    get.mockResolvedValue(payload([], "0.00", { CREDIT: "0.00", DEPOSIT: "0.00" }));
    renderPage();
    expect(await screen.findByText(/Nothing was paid out in this range/)).toBeInTheDocument();
  });
});
