import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import BillsPage from "../page";

/**
 * What matters on this page is that posted state is visible and that the
 * Post action is offered only where it can succeed. Posting is the
 * transition from "calculated" to "owed", and a screen that blurs the two
 * is the reason the action previously lived on the AR tab, which by
 * definition cannot show an unposted bill.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "b1",
    billNumber: "BILL-0001",
    billDate: "2026-06-30",
    dueDate: "2026-07-30",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    total: "64.20",
    postedAt: null,
    billingCycleName: "Residential 1",
    account: { id: "acc1", accountNumber: "0001000-00", customerName: "Ada Lovelace" },
    charge: null,
    ...over,
  };
}

function page(rows: unknown[], meta?: Partial<Record<string, number>>) {
  return {
    data: rows,
    meta: { total: rows.length, page: 1, limit: 25, pages: 1, ...meta },
  };
}

function renderPage() {
  return render(
    <ToastProvider>
      <BillsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Bills page", () => {
  it("shows a bill with its account, customer and total", async () => {
    get.mockResolvedValue(page([row({ postedAt: "2026-06-30" })]));
    renderPage();

    expect(await screen.findByText("BILL-0001")).toBeInTheDocument();
    expect(screen.getByText("0001000-00")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("$64.20")).toBeInTheDocument();
  });

  it("opens the bill itself, not the account, when the bill number is clicked", async () => {
    // A bill number is what a caller reads out, so the lookup has to land
    // on the bill. Linking to the account page would make the operator
    // find the bill a second time.
    get.mockResolvedValue(page([row({ postedAt: "2026-06-30" })]));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "BILL-0001" }));
    await waitFor(() =>
      expect(get.mock.calls.some(([url]) => String(url) === "/api/v1/bills/b1")).toBe(true),
    );
  });

  it("still links the account number to the account", async () => {
    get.mockResolvedValue(page([row()]));
    renderPage();
    const link = await screen.findByRole("link", { name: "0001000-00" });
    expect(link).toHaveAttribute("href", "/accounts/acc1");
  });

  it("marks an unposted bill as not posted and offers Post", async () => {
    get.mockResolvedValue(page([row({ postedAt: null })]));
    renderPage();

    expect(await screen.findByText("Not posted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post" })).toBeInTheDocument();
  });

  it("does NOT offer Post on a bill that is already posted", async () => {
    get.mockResolvedValue(page([row({ postedAt: "2026-06-30" })]));
    renderPage();

    expect(await screen.findByText("Posted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post" })).toBeNull();
  });

  it("posts a bill and reloads, so the row's status cannot go stale", async () => {
    get.mockResolvedValue(page([row({ postedAt: null })]));
    post.mockResolvedValue({});
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Post" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/bills/b1/post", {}));
    // Two GETs: the initial load and the reload after posting. Without the
    // reload the row would still read "Not posted" after succeeding.
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("sends the bill-number search to the API", async () => {
    get.mockResolvedValue(page([]));
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText("Search bill number"), "BILL-0001");

    await waitFor(
      () =>
        expect(
          get.mock.calls.some(([url]) => String(url).includes("search=BILL-0001")),
        ).toBe(true),
      { timeout: 2000 },
    );
  });

  it("requests only unposted bills when the status filter is set", async () => {
    get.mockResolvedValue(page([]));
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: /Status/ }));
    await userEvent.click(screen.getByText("Not posted"));

    await waitFor(() =>
      expect(get.mock.calls.some(([url]) => String(url).includes("posted=false"))).toBe(true),
    );
  });

  it("does not send a posted filter by default, so nothing is hidden", async () => {
    get.mockResolvedValue(page([]));
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get.mock.calls.every(([url]) => !String(url).includes("posted="))).toBe(true);
  });

  it("renders a date-only value without a timezone shift", async () => {
    get.mockResolvedValue(page([row({ dueDate: "2026-07-30" })]));
    renderPage();
    // Not 07/29: parsing as UTC midnight and formatting locally would
    // move the date back a day west of Greenwich.
    expect(await screen.findByText("07/30/2026")).toBeInTheDocument();
  });

  it("shows what is still owed on the bill, which is not its total", async () => {
    get.mockResolvedValue(
      page([
        row({
          postedAt: "2026-06-30",
          total: "64.20",
          charge: { entryId: "e1", openAmount: "15.00", reversed: false },
        }),
      ]),
    );
    renderPage();
    expect(await screen.findByText("$64.20")).toBeInTheDocument();
    expect(screen.getByText("$15.00")).toBeInTheDocument();
  });

  it("takes a payment against the ACCOUNT, not the bill", async () => {
    // recordPayment is account-scoped and §6.3 allocates oldest-first, so
    // the request must carry the account id and no bill id at all.
    get.mockResolvedValue(
      page([row({ postedAt: "2026-06-30", charge: { entryId: "e1", openAmount: "15.00", reversed: false } })]),
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /take payment/i }));
    const amount = await screen.findByLabelText(/amount/i);
    await userEvent.type(amount, "15.00");
    await userEvent.click(screen.getByRole("button", { name: /record payment/i }));

    await waitFor(() =>
      expect(
        post.mock.calls.some(([url]) => String(url) === "/api/v1/accounts/acc1/payments"),
      ).toBe(true),
    );
    const body = post.mock.calls.find(([u]) => String(u).includes("/payments"))?.[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("billId");
  });

  it("reverses the bill's charge entry, not the bill", async () => {
    // Reversal is entry-level. There is no void and no unpost.
    get.mockResolvedValue(
      page([row({ postedAt: "2026-06-30", charge: { entryId: "e1", openAmount: "64.20", reversed: false } })]),
    );
    post.mockResolvedValue({});
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /^reverse$/i }));
    // The confirm has to separate the three acts of §3.5, or an operator
    // reverses a charge they merely meant to forgive.
    expect(screen.getByText(/nothing is deleted/i)).toBeInTheDocument();
    expect(screen.getByText(/waive it instead/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /reverse charge/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/ledger-entries/e1/reverse", {}),
    );
  });

  it("offers no Reverse on a charge already reversed", async () => {
    get.mockResolvedValue(
      page([row({ postedAt: "2026-06-30", charge: { entryId: "e1", openAmount: "0.00", reversed: true } })]),
    );
    renderPage();
    expect(await screen.findByText("Reversed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^reverse$/i })).toBeNull();
  });

  it("offers neither payment nor reverse on an unposted bill", async () => {
    // Nothing is owed yet, so there is nothing to pay or reverse.
    get.mockResolvedValue(page([row({ postedAt: null, charge: null })]));
    renderPage();
    expect(await screen.findByRole("button", { name: "Post" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /take payment/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^reverse$/i })).toBeNull();
  });

  it("says the queue is clear rather than showing a bare empty state", async () => {
    get.mockResolvedValue(page([]));
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: /Status/ }));
    await userEvent.click(screen.getByText("Not posted"));

    await waitFor(() =>
      expect(screen.getByText(/Every bill has been posted/)).toBeInTheDocument(),
    );
  });
});
