"use client";

import Link from "next/link";
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Single primary action — backwards-compatible shortcut. */
  action?: { label: string; href?: string; onClick?: () => void };
  /** Free-form action slot for custom button groups (e.g. destructive
   *  lifecycle buttons that don't fit the primary-action style). When
   *  set, takes precedence over `action`. */
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, action, actions }: PageHeaderProps) {
  return (
    /*
     * Compact since 2026-11-27: the title, its count and the page-help
     * affordance share one line. Stacked — title, underline, subtitle, then
     * a help button on a row of its own — they pushed a list's first row
     * about 300px down the screen before any data.
     */
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "14px",
        gap: "16px",
      }}
    >
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          columnGap: "12px",
          rowGap: "2px",
          minWidth: 0,
        }}
      >
        <h1
          style={{
            fontSize: "20px",
            fontWeight: "600",
            color: "var(--text-primary)",
            margin: 0,
            lineHeight: "1.3",
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            style={{
              fontSize: "13px",
              color: "var(--text-secondary)",
              margin: 0,
              lineHeight: "1.4",
            }}
          >
            {subtitle}
          </p>
        )}
        {/* Where a collapsed PageDescription puts its "Help" link. */}
        <span data-page-help-slot style={{ display: "inline-flex", alignSelf: "center" }} />
        {/* Signature gradient underline beneath every page title — one of
            the few places the indigo→violet→cyan accent gradient appears
            in the light theme, so the brand shows without decorating
            every surface. Positioned in the header's bottom margin, so it
            costs no height of its own. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            bottom: "-5px",
            height: "2px",
            width: "32px",
            borderRadius: "2px",
            background: "var(--accent-gradient)",
          }}
        />
      </div>

      {actions ? (
        <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>{actions}</div>
      ) : action && (
        action.href ? (
          <Link
            href={action.href}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 14px",
              borderRadius: "var(--radius)",
              background: "var(--accent-primary)",
              color: "#fff",
              fontSize: "13px",
              fontWeight: "500",
              textDecoration: "none",
              whiteSpace: "nowrap",
              flexShrink: 0,
              transition: "opacity 0.15s ease",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "0.88")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "1")}
          >
            {action.label}
          </Link>
        ) : (
          <button
            onClick={action.onClick}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 14px",
              borderRadius: "var(--radius)",
              background: "var(--accent-primary)",
              color: "#fff",
              fontSize: "13px",
              fontWeight: "500",
              border: "none",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
              fontFamily: "inherit",
              transition: "opacity 0.15s ease",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "0.88")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "1")}
          >
            {action.label}
          </button>
        )
      )}
    </div>
  );
}
