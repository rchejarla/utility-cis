"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional form fields rendered between the message and the action buttons. */
  children?: ReactNode;
}

/**
 * WCAG 2.1 AA conformant confirmation dialog.
 * - role="dialog" + aria-modal="true" + aria-labelledby + aria-describedby
 * - Escape key dismisses
 * - Focus is moved into the dialog on mount and restored on unmount
 * - Focus is trapped within the dialog (Tab cycles through focusable children)
 * - Backdrop click dismisses
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmDisabled = false,
  destructive = true,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const reactId = useId();
  const titleId = `cd-title-${reactId}`;
  const descId = `cd-desc-${reactId}`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // If the dialog has form fields (children), focus the first one so
    // the user can type immediately. Otherwise fall back to the Cancel
    // button, which is the safer default for a plain destructive prompt.
    const firstField = dialogRef.current?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea',
    );
    (firstField ?? cancelBtnRef.current)?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "24px",
          maxWidth: "420px",
          width: "100%",
          boxShadow: "0 16px 48px rgba(0,0,0,0.45)",
        }}
      >
        <h2
          id={titleId}
          style={{
            margin: 0,
            fontSize: "16px",
            fontWeight: 600,
            color: "var(--text-primary)",
            marginBottom: "8px",
          }}
        >
          {title}
        </h2>
        <p
          id={descId}
          style={{
            margin: 0,
            fontSize: "13px",
            color: "var(--text-secondary)",
            marginBottom: children ? "16px" : "20px",
            lineHeight: 1.5,
          }}
        >
          {message}
        </p>
        {children && <div style={{ marginBottom: "20px" }}>{children}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={onCancel}
            style={{
              minHeight: "36px",
              padding: "6px 14px",
              fontSize: "13px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            style={{
              minHeight: "36px",
              padding: "6px 14px",
              fontSize: "13px",
              background: destructive ? "var(--danger)" : "var(--accent-primary)",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius)",
              cursor: confirmDisabled ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              opacity: confirmDisabled ? 0.7 : 1,
              fontWeight: 500,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
