"use client";

import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import {
  authDownload,
  authFetchFile,
  handToViewer,
  DownloadError,
} from "@/lib/auth-download";
import { useToast } from "@/components/ui/toast";

/**
 * The button that shows a customer their bill.
 *
 * It opens the PDF in a new tab for the browser's own viewer, rather
 * than saving a file — a CSR on a call wants to read the bill out, and
 * "View bill" would be a mis-promise if it only ever downloaded. From
 * the viewer the operator can still print or save it.
 *
 * One button, not two. Whether a PDF has been generated before is a fact
 * about our storage, not something a CSR should read off a row to know
 * which button to press — so this fetches, and generates first if there
 * is nothing to fetch.
 *
 * That order is load-bearing. Fetching is `accounts:VIEW` and generating
 * is `accounts:EDIT`, so a generate-first button would stop a read-only
 * user from seeing a bill that already has a PDF. Fetching first means
 * they get it, and only the genuinely-missing case reaches the write they
 * cannot perform — where the 403 is the right answer, said plainly. Only
 * a 404 counts as "not generated yet"; any other failure is reported
 * rather than treated as a cue to write.
 *
 * Regenerating is deliberately NOT here. It overwrites a copy that
 * cannot be recovered and is performed rarely, so it belongs behind the
 * row's More menu with the other exception handling, implemented once on
 * the page that owns the confirmation.
 */

interface BillPdfButtonProps {
  billId: string;
  billNumber: string;
  /** Refresh the caller's row once a document is generated. */
  onChanged?: () => void;
  /** A posted bill only; an unposted one has no document to offer. */
  disabled?: boolean;
  /**
   * Which surface this is on, which decides the route and whether
   * generating is permitted at all.
   *
   * On `"portal"` the customer reads their own bill through
   * `/portal/api/bills/:id/document`, and a missing document is simply
   * reported: generating is `accounts:EDIT`, which no portal token
   * holds, so a fetch-then-generate fallback there would turn "not
   * ready yet" into a 403 and show the customer an authorization error
   * for a bill that is legitimately theirs.
   */
  surface?: "staff" | "portal";
}

export function BillPdfButton({
  billId,
  billNumber,
  onChanged,
  disabled = false,
  surface = "staff",
}: BillPdfButtonProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const fileName = `bill-${billNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
  const path =
    surface === "portal"
      ? `/portal/api/bills/${billId}/document`
      : `/api/v1/bills/${billId}/document`;

  /** The bytes, generating them first if none are stored yet. */
  async function fetchOrGenerate(): Promise<Blob> {
    try {
      return await authFetchFile(path);
    } catch (err) {
      // 404 is not a failure here, it is "not generated yet".
      if (!(err instanceof DownloadError) || err.status !== 404) throw err;
      if (surface === "portal") {
        // Not "try again later": nothing will produce it in the
        // meantime. `generateBillDocument` has exactly one caller — the
        // staff `POST`, on `accounts:EDIT` — so until someone here
        // presses PDF on this bill there is no document and no process
        // that will make one. Telling the customer to wait sends them
        // away for something that is never coming, so the message
        // offers the only route that works.
        throw new Error(
          "This bill is not available to download. Please contact us for a copy.",
        );
      }
      await apiClient.post(path, {});
      const file = await authFetchFile(path);
      onChanged?.();
      return file;
    }
  }

  async function view() {
    // Opened here, synchronously, while the click is still the active
    // user gesture — after the await a popup blocker would swallow it.
    const tab = window.open("", "_blank");
    setBusy(true);
    try {
      const file = await fetchOrGenerate();
      if (tab) {
        handToViewer(tab, file);
      } else {
        // Blocked, or no window to open into. Saving the file is a worse
        // answer than viewing it, but a far better one than nothing.
        await authDownload(path, fileName);
      }
    } catch (err) {
      tab?.close();
      toast(err instanceof Error ? err.message : "Could not get the bill", "error");
    } finally {
      setBusy(false);
    }
  }

  if (disabled) return null;

  /*
   * One look, everywhere a bill is listed.
   *
   * There was a second, `variant="link"`, for the account's AR tab,
   * whose rows then carried an underlined "View bill" beside three
   * un-underlined text buttons — and with no left margin on the first of
   * them, so it rendered as "View billWaive". That tab now offers these
   * acts the way the bills list does, which left this variant with no
   * caller.
   */
  const pill: React.CSSProperties = {
    padding: "3px 8px",
    fontSize: 10,
    fontWeight: 600,
    // `var(--info)18` does not mean "--info at 0x18 alpha": var()
    // substitutes a whole token, so the result was two tokens and the
    // declaration was dropped, leaving the pill with no tint and no
    // border. color-mix is the form that works, and the one
    // settings/bill-production already uses.
    background: "color-mix(in srgb, var(--info) 9%, transparent)",
    color: "var(--info)",
    border: "1px solid color-mix(in srgb, var(--info) 25%, transparent)",
    borderRadius: "var(--radius)",
  };
  return (
    <button
      onClick={() => void view()}
      disabled={busy}
      title="Open the bill as a PDF, generating it if it has not been generated yet"
      style={{
        ...pill,
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
        fontFamily: "inherit",
        whiteSpace: "nowrap",
      }}
    >
      {busy ? "…" : "View bill"}
    </button>
  );
}
