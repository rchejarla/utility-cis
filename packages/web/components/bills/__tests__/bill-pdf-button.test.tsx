import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { BillPdfButton } from "../bill-pdf-button";

/**
 * One button that gets a bill as a PDF, generating it if there is
 * nothing stored yet.
 *
 * The order is what these cases pin: it fetches BEFORE it generates.
 * That is what lets a read-only user download a PDF that already
 * exists, since generating is `accounts:EDIT` and downloading is
 * `accounts:VIEW` — a generate-first button would refuse them outright.
 * And only a 404 means "not generated yet": any other status is a
 * failure to report, not a cue to write.
 */

const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;
const headersOnly = apiClient.getAuthHeadersOnly as unknown as ReturnType<typeof vi.fn>;
const fetchMock = vi.fn();

const pdf = () => ({
  ok: true,
  status: 200,
  blob: async () => new Blob(["%PDF-"], { type: "application/pdf" }),
});
const notGenerated = () => ({
  ok: false,
  status: 404,
  json: async () => ({ error: { code: "NOT_GENERATED" } }),
});

function renderButton(props: Partial<Parameters<typeof BillPdfButton>[0]> = {}) {
  return render(
    <ToastProvider>
      <BillPdfButton billId="bill-1" billNumber="BILL-202610-0001000-00" {...props} />
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

describe("BillPdfButton", () => {
  it("downloads an existing PDF without writing anything", async () => {
    renderButton();

    await userEvent.click(screen.getByRole("button", { name: "PDF" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/v1/bills/bill-1/document")),
      ).toBe(true),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("generates the PDF when there is none, then downloads it", async () => {
    fetchMock.mockResolvedValueOnce(notGenerated()).mockResolvedValue(pdf());
    post.mockResolvedValue({ id: "doc-1" });
    const onChanged = vi.fn();
    renderButton({ onChanged });

    await userEvent.click(screen.getByRole("button", { name: "PDF" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/bills/bill-1/document", {}));
    // Fetched, generated, fetched again — the operator asked for the
    // bill, not for a confirmation that one now exists.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("names the file after the bill", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderButton();

    await userEvent.click(screen.getByRole("button", { name: "PDF" }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe("bill-BILL-202610-0001000-00.pdf");
  });

  it("treats any status other than 404 as a failure to report", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: { message: "The bill document store refused" } }),
    });
    renderButton();

    await userEvent.click(screen.getByRole("button", { name: "PDF" }));

    expect(await screen.findByText(/store refused/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("surfaces the fields a bill cannot be generated without", async () => {
    fetchMock.mockResolvedValue(notGenerated());
    post.mockRejectedValue(
      new Error("API error 422: Account 0001004-00 has no billing address (billingAddress)"),
    );
    renderButton();

    await userEvent.click(screen.getByRole("button", { name: "PDF" }));

    expect(await screen.findByText(/billingAddress/)).toBeInTheDocument();
  });

  it("offers nothing on an unposted bill", () => {
    renderButton({ disabled: true });

    expect(screen.queryByRole("button", { name: "PDF" })).not.toBeInTheDocument();
  });
});
