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
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        marginBottom: "24px",
        gap: "16px",
      }}
    >
      <div>
        <h1
          style={{
            fontSize: "22px",
            fontWeight: "600",
            color: "var(--text-primary)",
            margin: "0 0 4px",
            lineHeight: "1.3",
          }}
        >
          {title}
        </h1>
        {/* Signature gradient underline beneath every page title — one of
            the few places the indigo→violet→cyan accent gradient appears
            in the light theme, so the brand shows without decorating
            every surface. */}
        <div
          aria-hidden
          style={{
            height: "2px",
            width: "32px",
            borderRadius: "2px",
            background: "var(--accent-gradient)",
            margin: subtitle ? "0 0 6px" : "0",
          }}
        />
        {subtitle && (
          <p
            style={{
              fontSize: "14px",
              color: "var(--text-secondary)",
              margin: 0,
              lineHeight: "1.4",
            }}
          >
            {subtitle}
          </p>
        )}
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
              padding: "8px 16px",
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
              padding: "8px 16px",
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
