"use client";

import { usePathname } from "next/navigation";
import { useTheme } from "@/lib/theme-provider";
import { GlobalSearch } from "./ui/global-search";

function getBreadcrumbs(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return ["Home"];
  return segments.map((seg) =>
    seg
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

interface TopbarProps {
  compact?: boolean;
}

export function Topbar({ compact = false }: TopbarProps) {
  const pathname = usePathname();
  const { mode, toggle } = useTheme();

  const breadcrumbs = getBreadcrumbs(pathname);
  const effectiveMode = mode === "system"
    ? (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : mode;

  if (compact) {
    return (
      <header
        style={{
          height: "56px",
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: "12px",
          flexShrink: 0,
        }}
      >
        {/* App title on mobile */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: "var(--accent-primary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontWeight: "bold",
              fontSize: 13,
              flexShrink: 0,
            }}
          >
            U
          </div>
          <span
            style={{
              color: "var(--text-primary)",
              fontWeight: 600,
              fontSize: 15,
            }}
          >
            Utility CIS
          </span>
        </div>

        {/* Theme toggle */}
        <button
          onClick={toggle}
          title={`Switch to ${effectiveMode === "dark" ? "light" : "dark"} mode`}
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "var(--radius)",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-secondary)",
            transition: "all 0.15s ease",
            flexShrink: 0,
          }}
        >
          {effectiveMode === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </header>
    );
  }

  return (
    <header
      style={{
        height: "56px",
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 24px",
        gap: "16px",
        flexShrink: 0,
      }}
    >
      {/* Breadcrumb */}
      <nav style={{ display: "flex", alignItems: "center", gap: "6px", flex: 1 }}>
        {breadcrumbs.map((crumb, index) => (
          <span key={index} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {index > 0 && (
              <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>
                /
              </span>
            )}
            <span
              style={{
                color:
                  index === breadcrumbs.length - 1
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                fontSize: "13px",
                fontWeight: index === breadcrumbs.length - 1 ? "500" : "400",
              }}
            >
              {crumb}
            </span>
          </span>
        ))}
      </nav>

      {/* Global search — opens a Cmd/Ctrl+K overlay that queries the
          full-text search endpoint across customers, premises, accounts,
          and meters. The overlay itself is inside GlobalSearch. */}
      <GlobalSearch />

      {/* Theme toggle */}
      <button
        onClick={toggle}
        title={`Switch to ${effectiveMode === "dark" ? "light" : "dark"} mode`}
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "var(--radius)",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-secondary)",
          transition: "all 0.15s ease",
          flexShrink: 0,
        }}
      >
        {effectiveMode === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>

      {/* User menu placeholder */}
      <button
        style={{
          width: "32px",
          height: "32px",
          borderRadius: "50%",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-secondary)",
          fontSize: "13px",
          fontWeight: "600",
          flexShrink: 0,
        }}
        title="User menu"
      >
        A
      </button>
    </header>
  );
}
