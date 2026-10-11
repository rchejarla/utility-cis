import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { BillDocumentActions } from "../bill-document-actions";

/**
 * The shared bill-document actions, tested where they live rather than
 * through each host screen.
 *
 * Two things here are load-bearing and easy to break by accident. The
 * download fetches before it generates, which is what lets a read-only
 * user get a PDF that already exists. And Regenerate is offered only
 * where a caller asks for it — the bills list deliberately shows the
 * download alone, so the act a CSR performs most is not buried among
 * six buttons.
 */

const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;
const headersOnly = apiClient.getAuthHeadersOnly as unknown as ReturnType<typeof vi.fn>;
const fetchMock = vi.fn();

const pdf = () => ({
  ok: true,
  status: 200,
  blob: async () => new Blob(["%PDF-"], { type: "application/pdf" }),
});
const missing = () => ({
  ok: false,
  status: 404,
  json: async () => ({ error: { code: "NOT_GENERATED" } }),
});

function renderActions(props: Partial<Parameters<typeof BillDocumentActions>[0]> = {}) {
  return render(
    <ToastProvider>
      <BillDocumentActions
        billId="bill-1"
        billNumber="BILL-202610-0001000-00"
        canGenerate
        {...props}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  window.URL.createObjectURL = vi.fn(() => "blob:bill");
  window.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  headersOnly.mockResolvedValue({ Authorization: "Bearer t" });
  fetchMock.mockResolvedValue(pdf());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BillDocumentActions", () => {
  it("fetches an existing PDF without writing anything", async () => {
    renderActions();

    await userEvent.click(screen.getByRole("button", { name: "PDF" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/v1/bills/bill-1/document")),
      ).toBe(true),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("generates on a 404 and then fetches again", async () => {
    fetchMock.mockResolvedValueOnce(missing()).mockResolvedValue(pdf());
    post.mockResolvedValue({ id: "doc-1" });
    renderActions();

    await userEvent.click(screen.getByRole("button", { name: "PDF" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/bills/bill-1/document", {}));
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("treats any status other than 404 as a failure to report", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: { message: "The bill document store refused" } }),
    });
    renderActions();

    await userEvent.click(screen.getByRole("button", { name: "PDF" }));

    expect(await screen.findByText(/store refused/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("confirms before replacing a stored PDF, denying what it does not do", async () => {
    post.mockResolvedValue({ id: "doc-1" });
    renderActions();

    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/does not change what is owed/i)).toBeInTheDocument();
    expect(screen.getByText(/previous copy is not kept/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Generate again" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/bills/bill-1/document?force=true", {}),
    );
  });

  it("omits Regenerate where the caller does not ask for it", () => {
    renderActions({ regenerate: false });

    expect(screen.getByRole("button", { name: "PDF" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
  });

  it("omits Regenerate for a user who may not generate", () => {
    renderActions({ canGenerate: false });

    expect(screen.getByRole("button", { name: "PDF" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
  });

  it("offers nothing at all on an unposted bill", () => {
    renderActions({ disabled: true });

    expect(screen.queryByRole("button", { name: "PDF" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
  });
});
