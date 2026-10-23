"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Asking why something is being held.
 *
 * In the app rather than in `window.prompt`, which is what this
 * replaced. The native box blocks the page, cannot be styled, is
 * suppressed outright by some browsers, and reads to an operator as
 * though the site is broken.
 *
 * The reason is also the only part of a hold that has to be any good.
 * It is what the next person — often days later, often somebody else —
 * has to act on, and a single-line native box does not invite more than
 * a word. A textarea does.
 *
 * Shared by the bill and the account, because the two holds mean
 * different things but the question is the same one.
 */
export function HoldReasonDialog({
  title,
  message,
  confirmLabel,
  placeholder,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  placeholder: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();

  return (
    <ConfirmDialog
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      cancelLabel="Cancel"
      // A hold nobody can explain is one nobody can clear, so the action
      // is unavailable until there is something to read — refused in the
      // API too, which this spares the operator discovering.
      confirmDisabled={trimmed.length === 0}
      destructive={false}
      onConfirm={() => onConfirm(trimmed)}
      onCancel={onCancel}
    >
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
          Reason
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder={placeholder}
          autoFocus
          style={{
            padding: "8px 10px",
            fontSize: 13,
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            color: "var(--text-primary)",
            fontFamily: "inherit",
            resize: "vertical",
            width: "100%",
          }}
        />
      </label>
    </ConfirmDialog>
  );
}
