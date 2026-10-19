"use client";

import { useTheme } from "@/lib/theme-provider";

/**
 * Light/dark switch, in one place.
 *
 * `Topbar` carried two byte-identical copies of this button — one for
 * its compact layout, one for its full one — and the platform chrome
 * needed a third. Three copies of a control is how two of them end up
 * looking slightly different.
 */

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

export function ThemeToggle() {
  const { mode, toggle } = useTheme();

  // "system" is a real stored value, so resolve it to what the viewer is
  // actually looking at before choosing which icon to offer.
  const effectiveMode =
    mode === "system"
      ? typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : mode;

  return (
    <button
      onClick={toggle}
      title={`Switch to ${effectiveMode === "dark" ? "light" : "dark"} mode`}
      aria-label={`Switch to ${effectiveMode === "dark" ? "light" : "dark"} mode`}
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
  );
}
