import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import LedgerIntegrityPage from "../page";

/**
 * The value of this page is that its three outcomes are distinguishable.
 * "No drift" and "nothing was checked" return the same empty drift list
 * from the API, and a screen that renders both as green would turn a
 * blind check into a clean bill of health. These tests pin that apart.
 */

function renderPage() {
  return render(
    <ToastProvider>
      <LedgerIntegrityPage />
    </ToastProvider>,
  );
}

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Ledger integrity page", () => {
  it("reports health with the number of accounts it examined", async () => {
    get.mockResolvedValue({ ok: true, checked: 1234, drift: [] });
    renderPage();

    const panel = await screen.findByRole("status");
    expect(panel).toHaveTextContent("In balance");
    // The count is the evidence, so it has to be on screen — not just "ok".
    expect(panel).toHaveTextContent("All 1,234 accounts match the ledger");
  });

  it("does NOT report health when nothing was checked", async () => {
    // Same empty drift list, same ok flag the API would send; only the
    // population differs. This must not read as healthy.
    get.mockResolvedValue({ ok: true, checked: 0, drift: [] });
    renderPage();

    const panel = await screen.findByRole("alert");
    expect(panel).toHaveTextContent("Inconclusive");
    expect(panel).toHaveTextContent("No accounts were checked");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/accounts match the ledger/)).toBeNull();
  });

  it("lists each drifting account with stored, ledger and signed difference", async () => {
    get.mockResolvedValue({
      ok: false,
      checked: 50,
      drift: [
        { accountId: "a1", accountNumber: "0001000-00", cached: "999.99", ledger: "31.41", field: "balance" },
        { accountId: "a2", accountNumber: "0001001-00", cached: "10.00", ledger: "60.00", field: "balance" },
      ],
    });
    renderPage();

    const panel = await screen.findByRole("alert");
    expect(panel).toHaveTextContent("2 of 50 accounts do not match the ledger");

    expect(screen.getByText("0001000-00")).toBeInTheDocument();
    expect(screen.getByText("$999.99")).toBeInTheDocument();
    expect(screen.getByText("$31.41")).toBeInTheDocument();
    // 999.99 - 31.41 = 968.58, stored claims more owed than the ledger.
    expect(screen.getByText("+$968.58")).toBeInTheDocument();
    // 10.00 - 60.00 = -50.00, stored claims less. Sign must survive.
    expect(screen.getByText("−$50.00")).toBeInTheDocument();
  });

  it("links a drifting account straight to its AR tab", async () => {
    get.mockResolvedValue({
      ok: false,
      checked: 3,
      drift: [{ accountId: "a1", accountNumber: "0001000-00", cached: "5.00", ledger: "0.00", field: "balance" }],
    });
    renderPage();

    const link = await screen.findByRole("link", { name: "0001000-00" });
    expect(link).toHaveAttribute("href", "/accounts/a1?tab=ar");
  });

  it("surfaces a failed check instead of showing stale health", async () => {
    get.mockRejectedValue(new Error("boom"));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("The check did not run")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("calls the reconciliation endpoint", async () => {
    get.mockResolvedValue({ ok: true, checked: 1, drift: [] });
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/ar/reconciliation"));
  });

  it("names which of the two caches drifted", async () => {
    // Balance owed and deposit held are different figures with different
    // meanings. A row that did not say which would leave the reader to
    // guess -- and the deposit is the one holding thousands.
    get.mockResolvedValue({
      ok: false,
      checked: 8,
      drift: [
        { accountId: "a1", accountNumber: "0001001-00", cached: "123.45", ledger: "500.00", field: "deposit" },
        { accountId: "a2", accountNumber: "0001003-00", cached: "10.00", ledger: "0.00", field: "balance" },
      ],
    });
    renderPage();

    expect(await screen.findByText("Deposit held")).toBeInTheDocument();
    expect(screen.getByText("Balance owed")).toBeInTheDocument();
  });
});
