import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
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
