"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { Topbar } from "./topbar";

/**
 * Chrome for the platform operator's screens.
 *
 * It is `app-shell` without the sidebar, and deliberately the *same*
 * `Topbar` — an earlier version of this file hand-built its own header
 * bar, which promptly drifted: different elements in a different order
 * from the one every other screen uses. A second header is a second
 * thing to keep in step, so `Topbar` took a `variant` instead and drops
 * only the controls that mean nothing outside a tenant (global search
 * over that tenant's data, its notification bell, its settings page).
 *
 * There is no side navigation because there is one screen above
 * tenants, and a nav of one item is furniture.
 *
 * What it does not mount is `AuthPermissionProvider`. That fetches
 * `/api/v1/auth/me`, which answers 403 for a platform token and then
 * falls back to granting every permission so a transient failure cannot
 * black out the UI — so the client-side gating it provided here would be
 * fabricated. The authority on these screens is being the platform
 * actor, enforced server-side by `{ platform: true }`.
 */
export function PlatformShell({ children }: { children: React.ReactNode }) {
  const [actor, setActor] = useState<{ name: string; email: string } | null>(null);

  useEffect(() => {
    // Identity belongs to the chrome, not to a page: it is a property of
    // the session rather than of what is being shown.
    apiClient
      .get<{ actor: { name: string; email: string } | null }>("/api/v1/platform/me")
      .then((res) => setActor(res.actor ?? null))
      .catch(() => setActor(null));
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* WCAG 2.4.1 Bypass Blocks — skip link, visible on focus */}
      <a
        href="#main-content"
        style={{
          position: "absolute",
          left: "-9999px",
          top: "8px",
          zIndex: 9999,
          padding: "8px 16px",
          background: "var(--accent-primary, #2563eb)",
          color: "#fff",
          textDecoration: "none",
          borderRadius: "6px",
          fontSize: "13px",
          fontWeight: 500,
        }}
        onFocus={(e) => {
          e.currentTarget.style.left = "8px";
        }}
        onBlur={(e) => {
          e.currentTarget.style.left = "-9999px";
        }}
      >
        Skip to main content
      </a>

      <Topbar variant="platform" identity={actor} />

      <main id="main-content" tabIndex={-1} style={{ flex: 1, overflow: "auto", padding: "24px" }}>
        {/* Centred: with no sidebar there is nothing anchoring the layout
            to the left, so full-bleed content strands itself in one
            corner of a wide monitor. */}
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>{children}</div>
      </main>
    </div>
  );
}
