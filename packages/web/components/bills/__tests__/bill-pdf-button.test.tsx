import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { BillPdfButton } from "../bill-pdf-button";

/**
 * One button that shows a customer their bill, generating the PDF if
 * there is nothing stored yet.
 *
 * Three things here are easy to break by accident. It opens a viewer
 * rather than saving a file, because the label promises viewing. The tab
 * is opened synchronously, before the fetch, or a popup blocker
 * swallows it silently. And it fetches BEFORE it generates, which is
 * what lets a read-only user see a bill that already has a PDF, since
 * generating is `accounts:EDIT` and fetching is `accounts:VIEW`.
 */

const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;
const headersOnly = apiClient.getAuthHeadersOnly as unknown as ReturnType<typeof vi.fn>;
const fetchMock = vi.fn();
const openMock = vi.fn();

let tab: { location: { href: string }; close: ReturnType<typeof vi.fn> };

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
  tab = { location: { href: "" }, close: vi.fn() };
  openMock.mockReturnValue(tab);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("open", openMock);
  window.URL.createObjectURL = vi.fn(() => "blob:bill");
  window.URL.revokeObjectURL = vi.fn();
  headersOnly.mockResolvedValue({ Authorization: "Bearer t" });
  fetchMock.mockResolvedValue(pdf());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BillPdfButton", () => {
  it("opens an existing bill in a viewer without writing anything", async () => {
    renderButton();

    await userEvent.click(screen.getByRole("button", { name: "View bill" }));

    await waitFor(() => expect(tab.location.href).toBe("blob:bill"));
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/v1/bills/bill-1/document")),
    ).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  /**
   * The tab must be opened while the click is still the active user
   * gesture. Opening it after the fetch resolves is what popup blockers
   * stop, and they do it silently.
   */
  it("opens the tab before fetching, not after", async () => {
    let openedBeforeFetch = false;
    fetchMock.mockImplementation(async () => {
      openedBeforeFetch = openMock.mock.calls.length > 0;
      return pdf();
    });
    renderButton();

    await userEvent.click(screen.getByRole("button", { name: "View bill" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(openedBeforeFetch).toBe(true);
  });

  it("generates the PDF when there is none, then shows it", async () => {
    fetchMock.mockResolvedValueOnce(notGenerated()).mockResolvedValue(pdf());
    post.mockResolvedValue({ id: "doc-1" });
    const onChanged = vi.fn();
    renderButton({ onChanged });

    await userEvent.click(screen.getByRole("button", { name: "View bill" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/bills/bill-1/document", {}));
    await waitFor(() => expect(tab.location.href).toBe("blob:bill"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("saves the file when the tab was blocked, rather than doing nothing", async () => {
    openMock.mockReturnValue(null);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderButton();

    await userEvent.click(screen.getByRole("button", { name: "View bill" }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe("bill-BILL-202610-0001000-00.pdf");
  });

  it("closes the tab it opened when the bill cannot be had", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: { message: "The bill document store refused" } }),
    });
    renderButton();

    await userEvent.click(screen.getByRole("button", { name: "View bill" }));

    expect(await screen.findByText(/store refused/i)).toBeInTheDocument();
    // A blank tab left behind reads as a broken app.
    expect(tab.close).toHaveBeenCalled();
    // Only a 404 means "not generated yet".
    expect(post).not.toHaveBeenCalled();
  });

  it("surfaces the fields a bill cannot be generated without", async () => {
    fetchMock.mockResolvedValue(notGenerated());
    post.mockRejectedValue(
      new Error("API error 422: Account 0001004-00 has no billing address (billingAddress)"),
    );
    renderButton();

    await userEvent.click(screen.getByRole("button", { name: "View bill" }));

    expect(await screen.findByText(/billingAddress/)).toBeInTheDocument();
  });

  it("offers nothing on an unposted bill", () => {
    renderButton({ disabled: true });

    expect(screen.queryByRole("button", { name: "View bill" })).not.toBeInTheDocument();
  });
});

/**
 * The same button on the customer's own side of the app.
 *
 * It reads a different route and, crucially, never generates: producing
 * a document is `accounts:EDIT`, which no portal token holds, so the
 * staff fetch-then-generate fallback would answer a customer with an
 * authorization error for a bill that is legitimately theirs.
 */
describe("BillPdfButton on the portal", () => {
  it("reads the portal route, not the staff one", async () => {
    renderButton({ surface: "portal" });

    await userEvent.click(screen.getByRole("button", { name: "View bill" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/portal/api/bills/bill-1/document",
    );
  });

  it("never asks for a document to be generated", async () => {
    fetchMock.mockResolvedValue(notGenerated());

    renderButton({ surface: "portal" });
    await userEvent.click(screen.getByRole("button", { name: "View bill" }));

    await waitFor(() => expect(screen.getByText(/not available/i)).toBeInTheDocument());
    expect(post).not.toHaveBeenCalled();
  });

  it("does not promise the bill will turn up on its own", async () => {
    // Nothing generates a document except a staff member pressing PDF:
    // `generateBillDocument` has one caller, and it is `accounts:EDIT`.
    // So "try again later" — which this said until 2026-10-22 — sends the
    // customer away to wait for something that is never coming. The
    // message has to offer the one thing that does work: asking us.
    fetchMock.mockResolvedValue(notGenerated());

    renderButton({ surface: "portal" });
    await userEvent.click(screen.getByRole("button", { name: "View bill" }));

    const msg = await screen.findByText(/not available/i);
    expect(msg).toHaveTextContent(/contact us/i);
    expect(msg).not.toHaveTextContent(/try again/i);
  });
});
