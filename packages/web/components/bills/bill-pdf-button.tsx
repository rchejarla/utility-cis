"use client";

import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import { authDownload, DownloadError } from "@/lib/auth-download";
import { useToast } from "@/components/ui/toast";

/**
 * The button that gets a bill as a PDF.
 *
 * One button, not two. Whether a PDF has been generated before is a fact
 * about our storage, not something a CSR should read off a row to know
 * which button to press — so this downloads, and generates first if
 * there is nothing to download.
 *
 * It fetches before generating, and that order is load-bearing.
 * Downloading is `accounts:VIEW` and generating is `accounts:EDIT`, so a
 * generate-first button would stop a read-only user from fetching a PDF
 * that already exists. Fetching first means they get it, and only the
 * genuinely-missing case reaches the write they cannot perform — where
 * the 403 is the right answer, said plainly. Only a 404 counts as "not
 * generated yet"; any other failure is reported rather than treated as a
 * cue to write.
 *
 * Regenerating is deliberately NOT here. It overwrites a copy that
 * cannot be recovered and is performed rarely, so it belongs behind the
 * row's More menu with the other exception handling, implemented once on
 * the page that owns the confirmation.
 *
 * Shared because the bills list, an account's AR tab and the bill's own
 * dialog all offer it — a CSR reaches for whichever screen they are on.
 * The portal download is not here: a different endpoint with a different
 * permission, sharing only the blob dance in `lib/auth-download`.
 */

interface BillPdfButtonProps {
  billId: string;
  billNumber: string;
  /** Refresh the caller's row once a document is generated. */
  onChanged?: () => void;
  /** A posted bill only; an unposted one has no document to offer. */
  disabled?: boolean;
  /**
   * Match the host's own action style — pills on the bills list, text
   * links on an account's AR tab. The same host-style override the
   * shared custom-fields section takes, and for the same reason: one
   * component in two screens that each settled on a different idiom.
   */
  variant?: "pill" | "link";
}

export function BillPdfButton({
  billId,
  billNumber,
  onChanged,
  disabled = false,
  variant = "pill",
}: BillPdfButtonProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const fileName = `bill-${billNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
  const path = `/api/v1/bills/${billId}/document`;

  async function get() {
    setBusy(true);
    try {
      try {
        await authDownload(path, fileName);
      } catch (err) {
        // 404 is not a failure here, it is "not generated yet".
        if (!(err instanceof DownloadError) || err.status !== 404) throw err;
        await apiClient.post(path, {});
        await authDownload(path, fileName);
        onChanged?.();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not get the bill PDF", "error");
    } finally {
      setBusy(false);
    }
  }

  if (disabled) return null;

  const pill: React.CSSProperties = {
    padding: "3px 8px",
    fontSize: 10,
    fontWeight: 600,
    background: "var(--info)18",
    color: "var(--info)",
    border: "1px solid var(--info)40",
    borderRadius: "var(--radius)",
  };
  const link: React.CSSProperties = {
    padding: 0,
    marginLeft: 10,
    fontSize: 12,
    fontWeight: 500,
    background: "none",
    color: "var(--accent-primary)",
    border: "none",
    textDecoration: "underline",
  };

  return (
    <button
      onClick={() => void get()}
      disabled={busy}
      title="Download the bill as a PDF, generating it if it has not been generated yet"
      style={{
        ...(variant === "pill" ? pill : link),
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
        fontFamily: "inherit",
        whiteSpace: "nowrap",
      }}
    >
      {busy ? "…" : "PDF"}
    </button>
  );
}
