import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiClient } from "@/lib/api-client";
import { authDownload } from "../auth-download";

/**
 * The one place the app turns an authenticated file response into a
 * download. It had three copies before — the bills actions, the imports
 * page and the attachments tab — and the copies disagreed: one discarded
 * the failure reason entirely, and each assembled its own base URL.
 *
 * So the cases here are the ones the copies got wrong: the caller passes
 * an API-relative path and nothing else, the token is attached, and a
 * refusal arrives as something an operator can act on.
 */

const headersOnly = apiClient.getAuthHeadersOnly as unknown as ReturnType<typeof vi.fn>;
const fetchMock = vi.fn();
const click = vi.fn();

function ok() {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(["%PDF-"], { type: "application/pdf" }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  window.URL.createObjectURL = vi.fn(() => "blob:x");
  window.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(click);
  headersOnly.mockResolvedValue({ Authorization: "Bearer t" });
  fetchMock.mockResolvedValue(ok());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authDownload", () => {
  it("builds the URL from the API base, so no caller assembles one", async () => {
    await authDownload("/api/v1/bills/b1/document", "bill.pdf");

    expect(String(fetchMock.mock.calls[0][0])).toBe("http://api.test/api/v1/bills/b1/document");
  });

  it("attaches the auth header, which is why a plain anchor cannot do this", async () => {
    await authDownload("/api/v1/attachments/a1/download", "scan.png");

    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer t" });
  });

  it("names the file and releases the blob URL", async () => {
    await authDownload("/api/v1/bills/b1/document", "bill-B-1001.pdf");

    expect(click).toHaveBeenCalled();
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  /**
   * The reason this reads the body. A bill that cannot be produced
   * answers with the issuer fields still missing, and that list is the
   * only thing that tells the operator what to go and fill in.
   */
  it("surfaces the reason and the missing fields from a refusal", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        error: {
          code: "ISSUER_INCOMPLETE",
          message: "No issuer identity is configured",
          missing: ["utilityName", "remittanceCity"],
        },
      }),
    });

    await expect(authDownload("/api/v1/bills/b1/document", "bill.pdf")).rejects.toThrow(
      "No issuer identity is configured (utilityName, remittanceCity)",
    );
  });

  it("falls back to the status when the failure carries no JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    });

    await expect(authDownload("/api/v1/bills/b1/document", "bill.pdf")).rejects.toThrow(
      "Download failed (502)",
    );
  });

  it("does not hand the browser a file when the request failed", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });

    await expect(authDownload("/api/v1/bills/b1/document", "bill.pdf")).rejects.toThrow();
    expect(click).not.toHaveBeenCalled();
    expect(window.URL.createObjectURL).not.toHaveBeenCalled();
  });
});
