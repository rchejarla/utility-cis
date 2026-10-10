import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import PaymentsPage from "../page";

/**
 * The page exists to answer "what did we take, and does it match the
 * deposit". So the cases that matter are the ones about that figure:
 * it opens on today, it reflects the filter rather than the page, and it
 * still counts a payment that was later reversed — because the money was
 * in that day's deposit even though the cheque bounced later.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "p1",
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

function payload(rows: unknown[], totalReceived = "41.50") {
  return {
    data: rows,
    meta: { total: rows.length, page: 1, limit: 25, pages: 1 },
    totalReceived,
  };
}

function renderPage() {
  return render(
    <ToastProvider>
      <PaymentsPage />
    </ToastProvider>,
  );
}

const urls = () => get.mock.calls.map(([u]) => String(u));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Payments page", () => {
  it("opens on today, because that is the question being asked", async () => {
    get.mockResolvedValue(payload([]));
    renderPage();

    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await waitFor(() =>
      expect(urls().some((u) => u.includes(`from=${iso}`) && u.includes(`to=${iso}`))).toBe(true),
    );
  });

  it("shows the amount taken as the headline figure", async () => {
    get.mockResolvedValue(payload([row()], "1234.50"));
    renderPage();
    expect(await screen.findByText("$1,234.50")).toBeInTheDocument();
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

    expect(await screen.findByText("$61.50")).toBeInTheDocument();
    expect(screen.getByText("reversed")).toBeInTheDocument();
    expect(screen.getByText(/still counted here/i)).toBeInTheDocument();
  });

  it("shows a payment's account, tender and reference", async () => {
    get.mockResolvedValue(payload([row()]));
    renderPage();
    expect(await screen.findByText("0001000-00")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Check")).toBeInTheDocument();
    expect(screen.getByText("CHQ-8841")).toBeInTheDocument();
  });

  it("links a payment to the account's AR tab, where the entry lives", async () => {
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
    get.mockResolvedValue(payload([], "0.00"));
    renderPage();
    expect(await screen.findByText(/No payments in this range/)).toBeInTheDocument();
  });
});
