import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import * as permModule from "@/lib/use-permission";
import ReceiptsPage from "../page";

/**
 * The page exists to answer "what did we take, and does it match the
 * bank". So the cases that matter are the ones about that figure: it
 * opens on today, it reflects the filter rather than the page, it counts
 * a payment that was later reversed — because the money was in that
 * day's deposit even though the cheque bounced later — and it counts a
 * security deposit, because that was in the same till.
 *
 * The one a reader must never get wrong is the kind of each row. A
 * deposit shown as a payment is a wrong answer to "have they paid?", so
 * the Kind column is never hidden and a deposit is tagged.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "p1",
    type: "PAYMENT",
    amount: "41.50",
    tender: "CHECK",
    effectiveDate: "2026-06-30",
    externalRef: "CHQ-8841",
    memo: null,
    reversed: false,
    account: { id: "acc1", accountNumber: "0001000-00", customerName: "Ada Lovelace" },
    ...over,
  };
}

function payload(
  rows: unknown[],
  totalReceived = "41.50",
  subtotals: Record<string, string> = { PAYMENT: totalReceived, DEPOSIT: "0.00" },
) {
  return {
    data: rows,
    meta: { total: rows.length, page: 1, limit: 25, pages: 1 },
    totalReceived,
    subtotals,
  };
}

function renderPage() {
  return render(
    <ToastProvider>
      <ReceiptsPage />
    </ToastProvider>,
  );
}

const urls = () => get.mock.calls.map(([u]) => String(u));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Receipts page", () => {
  it("opens on today, because that is the question being asked", async () => {
    get.mockResolvedValue(payload([]));
    renderPage();

    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await waitFor(() =>
      expect(urls().some((u) => u.includes(`from=${iso}`) && u.includes(`to=${iso}`))).toBe(true),
    );
  });

  it("reads from the receipts endpoint, not the payments one", async () => {
    get.mockResolvedValue(payload([]));
    renderPage();
    await waitFor(() => expect(urls().some((u) => u.startsWith("/api/v1/receipts?"))).toBe(true));
    expect(urls().some((u) => u.startsWith("/api/v1/payments"))).toBe(false);
  });

  it("shows the amount taken as the headline figure", async () => {
    get.mockResolvedValue(payload([row()], "1234.50"));
    renderPage();
    // By testid, not by text: on a day of payments only, the combined
    // total and the "Payments" subtotal are the same string, and an
    // assertion that cannot tell them apart would pass on either.
    expect(await screen.findByTestId("receipt-total")).toHaveTextContent("$1,234.50");
  });

  /**
   * The reason the screen was renamed. A deposit taken at the counter
   * went into the same till and onto the same bank slip, so the headline
   * figure has to contain it or it cannot be tied out.
   */
  it("counts a deposit in the headline figure, and splits it out beneath", async () => {
    get.mockResolvedValue(
      payload(
        [row(), row({ id: "d1", type: "DEPOSIT", amount: "750.00", externalRef: "DEP-1" })],
        "791.50",
        { PAYMENT: "41.50", DEPOSIT: "750.00" },
      ),
    );
    renderPage();

    expect(await screen.findByTestId("receipt-total")).toHaveTextContent("$791.50");
    const split = screen.getByTestId("receipt-split");
    expect(split).toHaveTextContent("Payments $41.50");
    expect(split).toHaveTextContent("Deposits $750.00");
  });

  it("tags a deposit row, so it is not read as a bill paid", async () => {
    get.mockResolvedValue(
      payload([row({ id: "d1", type: "DEPOSIT", amount: "750.00" })], "750.00", {
        PAYMENT: "0.00",
        DEPOSIT: "750.00",
      }),
    );
    renderPage();
    expect(await screen.findByText("Deposit")).toBeInTheDocument();
  });

  /**
   * A day with no deposits must say so. If the line vanished at zero, a
   * reader could not tell "we took none" from a screen that never looked
   * — the same failure as a reconciliation reporting clean because it
   * saw nothing.
   */
  it("states a zero for the kind that took nothing, rather than hiding it", async () => {
    get.mockResolvedValue(payload([row()], "41.50", { PAYMENT: "41.50", DEPOSIT: "0.00" }));
    renderPage();
    const split = await screen.findByTestId("receipt-split");
    expect(split).toHaveTextContent("Deposits $0.00");
  });

  it("still counts a reversed payment, and marks the row", async () => {
    // A cheque banked on the 30th and bounced later was in the 30th's
    // deposit. Netting it out would stop this agreeing with the bank.
    // 41.50 reversed + 20.00 good = 61.50, so the total provably
    // contains the reversed one rather than merely coinciding with it.
    get.mockResolvedValue(
      payload(
        [row({ reversed: true }), row({ id: "p2", amount: "20.00", externalRef: "CHQ-2" })],
        "61.50",
      ),
    );
    renderPage();

    expect(await screen.findByTestId("receipt-total")).toHaveTextContent("$61.50");
    expect(screen.getByText("reversed")).toBeInTheDocument();
    expect(screen.getByText(/still counted here/i)).toBeInTheDocument();
  });

  it("shows a receipt's account, tender and reference", async () => {
    get.mockResolvedValue(payload([row()]));
    renderPage();
    expect(await screen.findByText("0001000-00")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Check")).toBeInTheDocument();
    expect(screen.getByText("CHQ-8841")).toBeInTheDocument();
  });

  it("links a receipt to the account's AR tab, where the entry lives", async () => {
    get.mockResolvedValue(payload([row()]));
    renderPage();
    const link = await screen.findByRole("link", { name: "0001000-00" });
    expect(link).toHaveAttribute("href", "/accounts/acc1?tab=ar");
  });

  it("sends the tender filter", async () => {
    get.mockResolvedValue(payload([]));
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: /Tender/ }));
    await userEvent.click(screen.getByText("Cash"));

    await waitFor(() => expect(urls().some((u) => u.includes("tender=CASH"))).toBe(true));
  });

  it("sends the kind filter, so one type can be read alone", async () => {
    get.mockResolvedValue(payload([]));
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: /Kind/ }));
    await userEvent.click(screen.getByText("Deposit"));

    await waitFor(() => expect(urls().some((u) => u.includes("type=DEPOSIT"))).toBe(true));
  });

  it("searches by cheque or reference", async () => {
    get.mockResolvedValue(payload([]));
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText("Search reference"), "CHQ-8841");
    await waitFor(() => expect(urls().some((u) => u.includes("search=CHQ-8841"))).toBe(true), {
      timeout: 2000,
    });
  });

  it("renders a date without a timezone shift", async () => {
    get.mockResolvedValue(payload([row({ effectiveDate: "2026-06-30" })]));
    renderPage();
    // Not 06/29: UTC-midnight parsing would move it back a day.
    expect(await screen.findByText("06/30/2026")).toBeInTheDocument();
  });

  it("says the range is empty rather than showing a bare table", async () => {
    get.mockResolvedValue(payload([], "0.00", { PAYMENT: "0.00", DEPOSIT: "0.00" }));
    renderPage();
    expect(await screen.findByText(/No money received in this range/)).toBeInTheDocument();
  });
});

/**
 * Reversing from the receipts row.
 *
 * Tying out a day is when an NSF cheque or a keying error surfaces, and
 * the screen marked reversed rows while offering no way to make one.
 *
 * Reverse, not refund: §3.5 keeps the acts apart, and the dialog says so
 * in words, because the two are easy to confuse at exactly this moment.
 */
describe("Receipts page — reversing a receipt", () => {
  const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

  it("offers Reverse on a receipt that has not been reversed", async () => {
    get.mockResolvedValue(payload([row()]));
    renderPage();
    expect(await screen.findByRole("button", { name: /^reverse$/i })).toBeInTheDocument();
  });

  it("offers no Reverse on an already-reversed receipt", async () => {
    // reverseEntry refuses a second reversal, so a button could only
    // produce an error.
    get.mockResolvedValue(payload([row({ reversed: true })]));
    renderPage();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^reverse$/i })).toBeNull();
  });

  it("names the act and says what it is not, before doing it", async () => {
    get.mockResolvedValue(payload([row()]));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /^reverse$/i }));
    expect(screen.getByText(/nothing is deleted/i)).toBeInTheDocument();
    // The distinction that matters at this moment.
    expect(screen.getByText(/not to give money back, which is a refund/i)).toBeInTheDocument();
  });

  it("posts the reversal against the entry, not the account", async () => {
    get.mockResolvedValue(payload([row()]));
    post.mockResolvedValue({ balance: "25.00", dependentFees: [] } as never);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /^reverse$/i }));
    await userEvent.click(screen.getByRole("button", { name: /reverse entry/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![0]).toBe("/api/v1/ledger-entries/p1/reverse");
  });

  /**
   * The gate, which the rest of this file cannot see: vitest.setup.ts
   * mocks usePermission to all-allowed, so every case above would pass
   * with no gate at all. Narrowed here to VIEW only.
   */
  it("hides Reverse from a subject without payments:EDIT", async () => {
    vi.spyOn(permModule, "usePermission").mockReturnValue({
      canView: true,
      canCreate: false,
      canEdit: false,
      canDelete: false,
    });
    try {
      get.mockResolvedValue(payload([row()]));
      renderPage();
      expect(await screen.findByRole("table")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^reverse$/i })).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  /**
   * §6.6: a fee assessed on a reversed entry is reported and never
   * reversed with it. If the toast does not say so, the operator assumes
   * the NSF fee went too.
   */
  it("says dependent fees still stand", async () => {
    get.mockResolvedValue(payload([row()]));
    post.mockResolvedValue({ balance: "40.00", dependentFees: [{ id: "f1" }] } as never);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /^reverse$/i }));
    await userEvent.click(screen.getByRole("button", { name: /reverse entry/i }));

    expect(await screen.findByText(/1 fee assessed on this entry still stands/i)).toBeInTheDocument();
  });
});
