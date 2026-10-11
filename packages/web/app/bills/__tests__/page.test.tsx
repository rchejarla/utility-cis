import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import * as permModule from "@/lib/use-permission";
import BillsPage from "../page";

/**
 * The bill-document actions on the tenant-wide bill list.
 *
 * What a reader must not get wrong is which act each button performs.
 * Downloading a stored PDF is a read; producing one writes a row and an
 * object in the tenant's store; replacing one overwrites a copy that
 * cannot be recovered. So each has its own button, chosen by whether a
 * document exists rather than by one label that changes meaning, and the
 * two that write are absent for a user who may only look at accounts.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;
const headersOnly = apiClient.getAuthHeadersOnly as unknown as ReturnType<typeof vi.fn>;

function bill(over: Record<string, unknown> = {}) {
  return {
    id: "bill-1",
    billNumber: "B-1001",
    billDate: "2026-03-01",
    dueDate: "2026-03-31",
    periodStart: "2026-02-01",
    periodEnd: "2026-02-28",
    total: "107.50",
    postedAt: "2026-03-01",
    billingCycleName: "Residential",
    account: { id: "acc-1", accountNumber: "A-900", customerName: "Jane Smith" },
    charge: { entryId: "le-1", openAmount: "107.50", reversed: false },
    document: null,
    ...over,
  };
}

function payload(rows: unknown[]) {
  return { data: rows, meta: { total: rows.length, page: 1, limit: 25, pages: 1 } };
}

function renderPage() {
  return render(
    <ToastProvider>
      <BillsPage />
    </ToastProvider>,
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  // jsdom implements neither of these; the download turns bytes into a
  // blob URL and clicks a synthesised anchor.
  window.URL.createObjectURL = vi.fn(() => "blob:bill");
  window.URL.revokeObjectURL = vi.fn();
  headersOnly.mockResolvedValue({ Authorization: "Bearer t" });
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    blob: async () => new Blob(["%PDF-"], { type: "application/pdf" }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // clearAllMocks resets calls but leaves a spy's implementation in
  // place, so the permission spy below would otherwise make every later
  // case read-only.
  vi.restoreAllMocks();
});

describe("Bills page — bill document actions", () => {
  it("downloads a stored PDF from the bill's document endpoint", async () => {
    get.mockResolvedValue(payload([bill({ document: { generatedAt: "2026-03-02T10:00:00Z" } })]));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "PDF" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).endsWith("/api/v1/bills/bill-1/document"),
        ),
      ).toBe(true),
    );
    // The bytes must not be fetched through the JSON client, which would
    // try to parse a PDF as JSON.
    expect(get.mock.calls.every(([u]) => !String(u).includes("/document"))).toBe(true);
  });

  it("names the downloaded file after the bill", async () => {
    get.mockResolvedValue(payload([bill({ document: { generatedAt: "2026-03-02T10:00:00Z" } })]));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "PDF" }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe("bill-B-1001.pdf");
    click.mockRestore();
  });

  it("offers Generate instead of Download when no PDF exists, and POSTs", async () => {
    get.mockResolvedValue(payload([bill({ document: null })]));
    post.mockResolvedValue({ id: "doc-1" });
    renderPage();

    expect(screen.queryByRole("button", { name: "PDF" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Generate PDF" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/bills/bill-1/document", {}),
    );
  });

  it("downloads the PDF it just generated, because that is what was asked for", async () => {
    get.mockResolvedValue(payload([bill({ document: null })]));
    post.mockResolvedValue({ id: "doc-1" });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Generate PDF" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).endsWith("/api/v1/bills/bill-1/document"),
        ),
      ).toBe(true),
    );
  });

  it("surfaces the missing issuer fields when a bill cannot be produced", async () => {
    get.mockResolvedValue(payload([bill({ document: null })]));
    post.mockRejectedValue(
      new Error("API error 422: No issuer identity is configured (remittanceCity)"),
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Generate PDF" }));

    expect(await screen.findByText(/remittanceCity/)).toBeInTheDocument();
  });

  /**
   * Replacing a stored PDF cannot be undone, and "re-render" reads to an
   * operator as though it might recalculate the bill. The confirmation
   * has to deny that and say the old copy is gone.
   */
  it("confirms before replacing a stored PDF, and says what it does not do", async () => {
    get.mockResolvedValue(payload([bill({ document: { generatedAt: "2026-03-02T10:00:00Z" } })]));
    post.mockResolvedValue({ id: "doc-1" });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Re-render" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/does not change what is owed/i)).toBeInTheDocument();
    expect(screen.getByText(/previous copy is not kept/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Produce again" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/bills/bill-1/document?force=true", {}),
    );
  });

  it("hides both writing actions from a user who may only view accounts", async () => {
    vi.spyOn(permModule, "usePermission").mockReturnValue({
      canView: true,
      canCreate: false,
      canEdit: false,
      canDelete: false,
    });
    get.mockResolvedValue(payload([bill({ document: { generatedAt: "2026-03-02T10:00:00Z" } })]));
    renderPage();

    // The read stays available; neither write does.
    expect(await screen.findByRole("button", { name: "PDF" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Re-render" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate PDF" })).not.toBeInTheDocument();
  });

  /**
   * A bill is a calculation until it is posted. Offering its document
   * would promise a PDF the API refuses to make, with a 409.
   */
  it("offers nothing on an unposted bill", async () => {
    get.mockResolvedValue(payload([bill({ postedAt: null, charge: null, document: null })]));
    renderPage();

    expect(await screen.findByRole("button", { name: "Post" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate PDF" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "PDF" })).not.toBeInTheDocument();
  });
});
