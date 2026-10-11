"use client";

import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import { authDownload } from "@/lib/auth-download";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * The actions for one bill's PDF: produce it, download it, replace it.
 *
 * Shared because the bills list and an account's AR tab both offer them,
 * on rows of different shapes — a CSR on a call reaches for whichever
 * screen they are already on. The portal's download is deliberately not
 * here: it is a different endpoint with a different permission, and the
 * only thing it would share is the blob dance, which lives in
 * `lib/auth-download`.
 *
 * Which buttons appear is decided by state, not by a label that changes
 * meaning: Generate when there is nothing to download, Download when
 * there is, and Re-render only alongside an existing document, because
 * re-rendering nothing is just generating.
 */

interface BillDocumentActionsProps {
  billId: string;
  billNumber: string;
  /** Null when no PDF has been produced for this bill yet. */
  document: { generatedAt: string } | null;
  /**
   * `accounts:EDIT`. Producing a document writes — a row, and an object
   * in the tenant's store — so a user who may only look at accounts gets
   * no button when there is nothing to download.
   */
  canProduce: boolean;
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
  document: doc,
  canProduce,
  onChanged,
  disabled = false,
  variant = "pill",
}: BillDocumentActionsProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"generate" | "download" | "replace" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const fileName = `bill-${billNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;

  async function download() {
    setBusy("download");
    try {
      await authDownload(`/api/v1/bills/${billId}/document`, fileName);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not download the bill", "error");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Generate then download, because an operator who asked for a bill
   * wants the bill, not a confirmation that one now exists. The POST is
   * idempotent, so a second click costs a lookup rather than a render.
   */
  async function generate() {
    setBusy("generate");
    try {
      await apiClient.post(`/api/v1/bills/${billId}/document`, {});
      await authDownload(`/api/v1/bills/${billId}/document`, fileName);
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not produce the bill", "error");
    } finally {
      setBusy(null);
    }
  }

  async function replace() {
    setConfirming(false);
    setBusy("replace");
    try {
      await apiClient.post(`/api/v1/bills/${billId}/document?force=true`, {});
      toast(`Bill ${billNumber} was produced again`, "success");
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not re-render the bill", "error");
    } finally {
      setBusy(null);
    }
  }

  if (disabled) return null;

  return (
    <>
      {doc ? (
        <>
          <DocBtn
            variant={variant}
            tone="var(--info)"
            busy={busy === "download"}
            onClick={() => void download()}
            title={`Produced ${doc.generatedAt.slice(0, 10)}`}
          >
            {busy === "download" ? "…" : "PDF"}
          </DocBtn>
          {canProduce && (
            <DocBtn
              variant={variant}
              tone="var(--text-muted)"
              busy={busy === "replace"}
              onClick={() => setConfirming(true)}
              title="Replace the stored PDF"
            >
              {busy === "replace" ? "…" : "Re-render"}
            </DocBtn>
          )}
        </>
      ) : (
        canProduce && (
          <DocBtn
            variant={variant}
            tone="var(--info)"
            busy={busy === "generate"}
            onClick={() => void generate()}
            title="Produce the PDF and download it"
          >
            {busy === "generate" ? "…" : "Generate PDF"}
          </DocBtn>
        )
      )}

      {confirming && (
        <ConfirmDialog
          title={`Produce ${billNumber} again?`}
          /*
           * Both sentences are here because operators expect the wrong
           * thing otherwise. "Re-render" sounds like it might recalculate
           * the bill, and it does not; and it overwrites rather than
           * keeping the old copy, which is the part that cannot be
           * undone.
           */
          message={
            "This does not change what is owed — nothing about the bill is recalculated. " +
            "It replaces the stored PDF with a freshly produced one; the previous copy is not kept. " +
            "Use it when the bill's own details have been corrected, or after a template change."
          }
          confirmLabel="Produce again"
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
