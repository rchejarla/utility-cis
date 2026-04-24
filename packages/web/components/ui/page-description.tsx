"use client";

import { useEffect, useState, type ReactNode } from "react";

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(`cis_intro_hidden:${storageKey}`) === "1") {
      setVisible(false);
    }
  }, [storageKey]);

  if (!visible) return null;

  function hide() {
    if (typeof window !== "undefined") {
      localStorage.setItem(`cis_intro_hidden:${storageKey}`, "1");
    }
    setVisible(false);
  }

  return (
    <div
      role="note"
      aria-label="Page description"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        maxWidth: 720,
        padding: "10px 14px",
        margin: "0 0 16px",
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
