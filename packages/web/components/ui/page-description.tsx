"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface PageDescriptionProps {
  /**
   * Unique key used to persist the user's dismissal in localStorage.
   * Use a short, stable identifier per page — e.g. `rate-schedules`,
   * `commodities`, `service-holds`. Collisions across pages share
   * dismissal state, so pick something specific.
   */
  storageKey: string;
  children: ReactNode;
}

/**
 * Subtle, dismissible page-level description.
 *
 * Visible on first visit so new operators get context on non-obvious
 * concepts (versioning, billing semantics, SLA breach calc, etc.).
 * Power users dismiss with "Hide" and never see it again for that
 * page — the choice is persisted per-browser in localStorage keyed by
 * `storageKey`. Matches the Stripe / Linear pattern of ambient,
 * opt-out help rather than modal onboarding.
 *
 * Place immediately below PageHeader. Width is capped around 720px
 * for comfortable line length; visually it's a muted paragraph with
 * a thin accent rail rather than a bordered card, so it doesn't
 * compete with data cards below.
 */
export function PageDescription({ storageKey, children }: PageDescriptionProps) {
  // Start visible on server + initial client render to avoid hydration
  // mismatch; the mount effect then flips to hidden if the user has
  // previously dismissed this page's intro.
  const [visible, setVisible] = useState(true);
  /** The page header's help slot, found after mount (the header renders first). */
  const [slot, setSlot] = useState<Element | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSlot(document.querySelector("[data-page-help-slot]"));
    try {
      if (localStorage.getItem(`cis_intro_hidden:${storageKey}`) === "1") {
        setVisible(false);
      }
    } catch {
      // Storage blocked: the description simply stays open.
    }
  }, [storageKey]);

  function hide() {
    if (typeof window !== "undefined") {
      localStorage.setItem(`cis_intro_hidden:${storageKey}`, "1");
    }
    setVisible(false);
  }

  function show() {
    if (typeof window !== "undefined") {
      localStorage.removeItem(`cis_intro_hidden:${storageKey}`);
    }
    setVisible(true);
  }

  if (!visible) {
    /*
     * Collapsed: a small "Help" link so dismissal is reversible. It goes
     * into the page header's slot beside the title when there is one, so
     * a dismissed description costs no height at all — it used to keep a
     * full row of its own for a single dashed button. Rendered in place
     * only on a page without a PageHeader.
     */
    const button = (
      <button
        type="button"
        onClick={show}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "1px 6px",
          fontSize: 11,
          background: "transparent",
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontFamily: "inherit",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
        title="Show page help"
        aria-label="Show page help"
      >
        <span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>ⓘ</span>
        Help
      </button>
    );
    if (slot) return createPortal(button, slot);
    return <div style={{ margin: "0 0 10px" }}>{button}</div>;
  }

  return (
    <div
      role="note"
      aria-label="Page description"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        width: "100%",
        padding: "6px 12px",
        margin: "0 0 12px",
        borderLeft: "3px solid var(--accent-primary)",
        background: "transparent",
        fontSize: 13,
        color: "var(--text-secondary)",
        lineHeight: 1.55,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      <button
        type="button"
        onClick={hide}
        style={{
          flexShrink: 0,
          padding: "2px 8px",
          fontSize: 11,
          background: "transparent",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontFamily: "inherit",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
        title="Hide this description for this page"
      >
        Hide
      </button>
    </div>
  );
}
