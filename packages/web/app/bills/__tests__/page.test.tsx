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
 * One button answers "give me the bill", because whether a PDF was
 * produced before is a fact about our storage and not something a CSR
 * should read off a row. The order inside it is what these cases pin:
 * fetch first, produce only on a 404. A produce-first button would stop
 * a read-only user from downloading a PDF that already exists, since
 * producing is `accounts:EDIT` and downloading is `accounts:VIEW`.
 *
 * Regenerate is separate because it overwrites a copy that cannot be
 * recovered, and it is absent for a user who may only look.
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
    ...over,
  };
}

/** A response for the download fetch: the PDF, or a status. */
function pdfResponse() {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(["%PDF-"], { type: "application/pdf" }),
  };
}

function notProduced() {
  return { ok: false, status: 404, json: async () => ({ error: { code: "NOT_GENERATED" } }) };
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
  it("downloads an existing PDF without producing anything", async () => {
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValue(pdfResponse());
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "PDF" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/v1/bills/bill-1/document")),
      ).toBe(true),
    );
    // The point of fetching first: no write happens for a bill that
    // already has one, so a read-only user can still get it.
    expect(post).not.toHaveBeenCalled();
    // And the bytes must not go through the JSON client, which would try
    // to parse a PDF as JSON.
    expect(get.mock.calls.every(([u]) => !String(u).includes("/document"))).toBe(true);
  });

  it("names the downloaded file after the bill", async () => {
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValue(pdfResponse());
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "PDF" }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe("bill-B-1001.pdf");
    click.mockRestore();
  });

  /** The whole reason there is only one button. */
  it("generates the PDF on a 404 and then downloads it", async () => {
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValueOnce(notProduced()).mockResolvedValue(pdfResponse());
    post.mockResolvedValue({ id: "doc-1" });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "PDF" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/bills/bill-1/document", {}),
    );
    // Fetched, produced, fetched again — the operator asked for the
    // bill, not for a confirmation that one now exists.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces the missing issuer fields when a bill cannot be generated", async () => {
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValue(notProduced());
    post.mockRejectedValue(
      new Error("API error 422: No issuer identity is configured (remittanceCity)"),
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "PDF" }));

    expect(await screen.findByText(/remittanceCity/)).toBeInTheDocument();
  });

  it("reports a failed download rather than trying to generate over it", async () => {
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        error: { code: "STORAGE_UNAVAILABLE", message: "The bill document store refused" },
      }),
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "PDF" }));

    expect(await screen.findByText(/store refused/i)).toBeInTheDocument();
    // Only a 404 means "not produced yet"; a 502 must not trigger a write.
    expect(post).not.toHaveBeenCalled();
  });

  /**
   * What stays on the row, and what does not.
   *
   * Take payment and PDF are the two acts a CSR performs on nearly every
   * call. The rest is exception handling — rarer, and mostly
   * irreversible — so a row of six buttons buried the common ones among
   * the consequential ones.
   */
  it("keeps only Take payment and PDF inline, with the rest behind More", async () => {
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValue(pdfResponse());
    renderPage();

    expect(await screen.findByRole("button", { name: "Take payment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PDF" })).toBeInTheDocument();

    for (const buried of ["Reverse charge", "Waive", "Write off", "Regenerate PDF"]) {
      expect(screen.queryByRole("menuitem", { name: buried })).not.toBeInTheDocument();
    }
  });

  it("puts the exception handling in the More menu", async () => {
    get.mockResolvedValue(payload([bill()]));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /More actions/ }));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    for (const item of ["Reverse charge", "Waive", "Write off", "Regenerate PDF"]) {
      expect(screen.getByRole("menuitem", { name: item })).toBeInTheDocument();
    }
  });

  it("confirms a regenerate from the menu, denying what it does not do", async () => {
    get.mockResolvedValue(payload([bill()]));
    post.mockResolvedValue({ id: "doc-1" });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /More actions/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Regenerate PDF" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/does not change what is owed/i)).toBeInTheDocument();
    expect(screen.getByText(/previous copy is not kept/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Generate again" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/bills/bill-1/document?force=true", {}),
    );
  });

  /**
   * The menu is not merely a different place to put the same buttons —
   * each item keeps the rule that decided whether it was offered at all.
   * A settled charge has nothing left to forgive.
   */
  it("omits Waive and Write off once the charge is settled", async () => {
    get.mockResolvedValue(
      payload([bill({ charge: { entryId: "le-1", openAmount: "0.00", reversed: false } })]),
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /More actions/ }));

    await screen.findByRole("menu");
    expect(screen.getByRole("menuitem", { name: "Reverse charge" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Waive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Write off" })).not.toBeInTheDocument();
  });

  it("offers no menu at all to a user who can only look", async () => {
    vi.spyOn(permModule, "usePermission").mockReturnValue({
      canView: true,
      canCreate: false,
      canEdit: false,
      canDelete: false,
    });
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValue(pdfResponse());
    renderPage();

    // The download is a read, so it stays; there is nothing to put in a
    // menu, so no empty trigger appears.
    expect(await screen.findByRole("button", { name: "PDF" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More actions/ })).not.toBeInTheDocument();
  });

  /**
   * A bill is a calculation until it is posted. Offering its document
   * would promise a PDF the API refuses to make, with a 409.
   */
  it("offers no PDF action on an unposted bill", async () => {
    get.mockResolvedValue(payload([bill({ postedAt: null, charge: null })]));
    renderPage();

    expect(await screen.findByRole("button", { name: "Post" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "PDF" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
  });
});
