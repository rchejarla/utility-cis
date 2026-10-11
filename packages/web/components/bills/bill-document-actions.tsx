"use client";

import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import { authDownload, DownloadError } from "@/lib/auth-download";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * The actions for one bill's PDF: get it, and replace it.
 *
 * Shared because the bills list and an account's AR tab both offer them,
 * on rows of different shapes — a CSR on a call reaches for whichever
 * screen they are already on. The portal's download is deliberately not
 * here: it is a different endpoint with a different permission, and the
 * only thing it would share is the blob dance, which lives in
 * `lib/auth-download`.
 *
 * **One button for "give me the bill", not two.** Whether a PDF has been
 * produced before is a fact about our storage, not something a CSR
 * should have to read off a row before knowing which button to press.
 * So PDF downloads, and produces first if there is nothing to download.
 *
 * It fetches before producing, and that order is what keeps the
 * permission split honest. Downloading is `accounts:VIEW` and producing
 * is `accounts:EDIT`, so a POST-first button would stop a read-only user
 * from fetching a PDF that already exists. Fetching first means they get
 * it, and only the genuinely-missing case reaches the write they cannot
 * perform — where the 403 is the right answer, said plainly.
 *
 * Nothing here needs to know in advance whether a document exists, which
 * is why no row carries that state. A row that did would also be wrong
 * the moment someone produced the PDF in another tab.
 */

interface BillDocumentActionsProps {
  billId: string;
  billNumber: string;
  /**
   * `accounts:EDIT`. Producing a document writes — a row, and an object
   * in the tenant's store — so a user who may only look at accounts
   * gets no Regenerate, and a plain download that finds nothing says so
   * rather than silently failing to produce one.
   */
  canGenerate: boolean;
  /** Refresh the caller's row once a document appears or is replaced. */
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

export function BillDocumentActions({
  billId,
  billNumber,
  canGenerate,
  onChanged,
  disabled = false,
  variant = "pill",
}: BillDocumentActionsProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"download" | "replace" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const fileName = `bill-${billNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
  const path = `/api/v1/bills/${billId}/document`;

  async function download() {
    setBusy("download");
    try {
      try {
        await authDownload(path, fileName);
      } catch (err) {
        // 404 is not a failure here, it is "not produced yet".
        if (!(err instanceof DownloadError) || err.status !== 404) throw err;
        await apiClient.post(path, {});
        await authDownload(path, fileName);
        onChanged?.();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not get the bill PDF", "error");
    } finally {
      setBusy(null);
    }
  }

  async function replace() {
    setConfirming(false);
    setBusy("replace");
    try {
      await apiClient.post(`${path}?force=true`, {});
      toast(`Bill ${billNumber} was generated again`, "success");
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not generate the bill again", "error");
    } finally {
      setBusy(null);
    }
  }

  if (disabled) return null;

  return (
    <>
      <DocBtn
        variant={variant}
        tone="var(--info)"
        busy={busy === "download"}
        onClick={() => void download()}
        title="Download the bill as a PDF, generating it if it has not been generated yet"
      >
        {busy === "download" ? "…" : "PDF"}
      </DocBtn>
      {canGenerate && (
        <DocBtn
          variant={variant}
          tone="var(--text-muted)"
          busy={busy === "replace"}
          onClick={() => setConfirming(true)}
          title="Replace the stored PDF with a freshly generated one"
        >
          {busy === "replace" ? "…" : "Regenerate"}
        </DocBtn>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Generate ${billNumber} again?`}
          /*
           * Both sentences are here because operators expect the wrong
           * thing otherwise. "Generate again" sounds like it might
           * recalculate the bill, and it does not; and it overwrites
           * rather than keeping the old copy, which is the part that
           * cannot be undone.
           */
          message={
            "This does not change what is owed — nothing about the bill is recalculated. " +
            "It replaces the stored PDF with a freshly generated one; the previous copy is not kept. " +
            "Use it when the bill's own details have been corrected, or after a template change."
          }
          confirmLabel="Generate again"
          destructive={false}
          onConfirm={() => void replace()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

function DocBtn({
  children,
  tone,
  busy,
  title,
  variant,
  onClick,
}: {
  children: React.ReactNode;
  tone: string;
  busy: boolean;
  title: string;
  variant: "pill" | "link";
  onClick: () => void;
}) {
  const pill: React.CSSProperties = {
    padding: "3px 8px",
    fontSize: 10,
    fontWeight: 600,
    background: `${tone}18`,
    color: tone,
    border: `1px solid ${tone}40`,
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
      onClick={onClick}
      disabled={busy}
      title={title}
      style={{
        ...(variant === "pill" ? pill : link),
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
        fontFamily: "inherit",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}
